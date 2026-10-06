/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { z } from "zod";
import { tool } from "ai";
import { createErrorResult, formatExecuteOperatorResult, getVisibleResultHeaders } from "./tools-utility";
import type { WorkflowState } from "../workflow-state";
import { getBackendConfig } from "../../api/backend-api";
import { env } from "../../config/env";
import type { LogicalPlan, LogicalLink } from "../../api/execution-api";
import type { OperatorInfo, SyncExecutionResult } from "../../types/execution";
import { annotateMissingPath } from "../util/missing-path-hint";
import type { OperatorPredicate, OperatorLink } from "../../types/workflow";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { partitionOpsByIndependence, type PartitionGroup } from "../util/subdag-partition";
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import { createLogger } from "../../logger";
import { prepareStructuredExecutionResult } from "../native/execution-transport";
import { orderedResultIds } from "../native/result-versions";

const log = createLogger("ExecutionTools");

export const TOOL_NAME_EXECUTE_OPERATOR = "executeOperator";

export interface ExecutionConfig {
  userToken: string;
  workflowId: number;
  computingUnitId?: number;
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  executionTimeoutMs?: number;
  structuredResults?: boolean;
}

/**
 * FIFO async lock used to serialize workflow executions per workflow id.
 *
 * `acquire()` resolves with a release function once prior holders have
 * released. Callers must invoke the release in a `finally` to avoid
 * deadlocking subsequent waiters.
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void;
    const currentQueue = this.queue;

    this.queue = new Promise<void>(resolve => {
      release = resolve;
    });

    await currentQueue;

    return release!;
  }
}

const workflowMutexes = new Map<number, AsyncMutex>();

function getWorkflowMutex(workflowId: number): AsyncMutex {
  let mutex = workflowMutexes.get(workflowId);
  if (!mutex) {
    mutex = new AsyncMutex();
    workflowMutexes.set(workflowId, mutex);
  }
  return mutex;
}

interface WorkflowValidationResult {
  isValid: boolean;
  errors: Record<string, Record<string, string>>;
}

interface OperatorValidation {
  isValid: boolean;
  messages: Record<string, string>;
}

function validateOperatorSchema(operatorType: string, operatorProperties: Record<string, any>): OperatorValidation {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  const validation = metadataStore.validateOperatorProperties(operatorType, operatorProperties);
  return validation.isValid ? { isValid: true, messages: {} } : { isValid: false, messages: validation.messages };
}

function validateOperatorConnection(operatorId: string, workflowState: WorkflowState): OperatorValidation {
  const operator = workflowState.getOperator(operatorId);
  if (!operator) {
    return { isValid: false, messages: { error: `Operator ${operatorId} not found` } };
  }

  const numInputLinksByPort = new Map<string, number>();
  const allLinks = workflowState.getAllLinks();

  for (const link of allLinks) {
    if (link.target.operatorID === operatorId) {
      const portID = link.target.portID;
      numInputLinksByPort.set(portID, (numInputLinksByPort.get(portID) ?? 0) + 1);
    }
  }

  let satisfyInput = true;
  let violationMessage = "";

  for (const port of operator.inputPorts) {
    const portNumInputs = numInputLinksByPort.get(port.portID) ?? 0;

    if (port.disallowMultiInputs) {
      if (portNumInputs !== 1) {
        satisfyInput = false;
        violationMessage += `${port.displayName ?? port.portID} requires 1 input, has ${portNumInputs}. `;
      }
    } else {
      if (portNumInputs < 1) {
        satisfyInput = false;
        violationMessage += `${port.displayName ?? port.portID} requires at least 1 input, has ${portNumInputs}. `;
      }
    }
  }

  return satisfyInput
    ? { isValid: true, messages: {} }
    : { isValid: false, messages: { inputs: violationMessage.trim() } };
}

function combineValidations(...validations: OperatorValidation[]): OperatorValidation {
  let isValid = true;
  let messages: Record<string, string> = {};

  for (const validation of validations) {
    if (!validation.isValid) {
      isValid = false;
      messages = { ...messages, ...validation.messages };
    }
  }

  return { isValid, messages };
}

function validateWorkflow(
  workflowState: WorkflowState,
  operators: readonly OperatorPredicate[] = workflowState.getAllEnabledOperators()
): WorkflowValidationResult {
  const errors: Record<string, Record<string, string>> = {};

  for (const operator of operators) {
    const schemaValidation = validateOperatorSchema(operator.operatorType, operator.operatorProperties);
    const connectionValidation = validateOperatorConnection(operator.operatorID, workflowState);
    const combined = combineValidations(schemaValidation, connectionValidation);

    if (!combined.isValid) {
      errors[operator.operatorID] = combined.messages;
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

function formatWorkflowValidationErrors(validationResult: WorkflowValidationResult): string {
  if (validationResult.isValid) return "";

  const lines: string[] = ["Workflow validation failed:"];
  for (const [operatorId, fieldErrors] of Object.entries(validationResult.errors)) {
    lines.push(`  Operator ${operatorId}:`);
    for (const [field, message] of Object.entries(fieldErrors)) {
      lines.push(`    - ${field}: ${message}`);
    }
  }
  return lines.join("\n");
}

/** Test seam: the shipped plan is the contract with the execution service,
 *  and its SIZE is load-bearing (see execution-subdag.test.ts). */
export function buildLogicalPlanForTest(workflowState: WorkflowState, opsToViewResult?: string[]): LogicalPlan {
  return buildLogicalPlan(workflowState, opsToViewResult);
}

function buildLogicalPlan(workflowState: WorkflowState, opsToViewResult?: string[]): LogicalPlan {
  // Prune to the upstream closure of the requested targets — ANY number of
  // them. This was previously gated on `length === 1`, so a step that touched
  // two connected operators (the common case under parallel tool calls) shipped
  // the ENTIRE workflow. Past ~200 KB of plan JSON the execution service
  // answers `400 Unable to process JSON`, nothing executes, and every operator
  // renders `(not executed)` — which the model reads as "my code produced
  // nothing" and rewrites in a loop until its step budget is gone.
  const targets = opsToViewResult && opsToViewResult.length > 0 ? opsToViewResult : undefined;

  let operatorsList: { operatorID: string; operatorType: string; [key: string]: any }[];
  let linksList: LogicalLink[];

  const getInputPortOrdinal = (operatorID: string, inputPortID: string): number => {
    const op = workflowState.getOperator(operatorID);
    if (!op) return 0;
    const idx = op.inputPorts.findIndex(port => port.portID === inputPortID);
    return idx >= 0 ? idx : 0;
  };

  const getOutputPortOrdinal = (operatorID: string, outputPortID: string): number => {
    const op = workflowState.getOperator(operatorID);
    if (!op) return 0;
    const idx = op.outputPorts.findIndex(port => port.portID === outputPortID);
    return idx >= 0 ? idx : 0;
  };

  if (targets) {
    const subDAG = workflowState.getSubDAGForTargets(targets);

    operatorsList = subDAG.operators.map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    linksList = subDAG.links.map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: { id: getOutputPortOrdinal(link.source.operatorID, link.source.portID), internal: false },
      toOpId: link.target.operatorID,
      toPortId: { id: getInputPortOrdinal(link.target.operatorID, link.target.portID), internal: false },
    }));
  } else {
    operatorsList = workflowState.getAllEnabledOperators().map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    linksList = workflowState.getAllLinks().map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: { id: getOutputPortOrdinal(link.source.operatorID, link.source.portID), internal: false },
      toOpId: link.target.operatorID,
      toPortId: { id: getInputPortOrdinal(link.target.operatorID, link.target.portID), internal: false },
    }));
  }

  let allOpsToView: string[];
  if (opsToViewResult && opsToViewResult.length > 0) {
    const operatorIds = new Set(operatorsList.map(op => op.operatorID));
    allOpsToView = opsToViewResult.filter(id => operatorIds.has(id));
  } else {
    allOpsToView = operatorsList
      .filter(op => !linksList.some(link => link.fromOpId === op.operatorID))
      .map(op => op.operatorID);
  }

  return {
    operators: operatorsList,
    links: linksList,
    opsToViewResult: allOpsToView,
    savedOutputs: Object.fromEntries(operatorsList.flatMap(op => {
      const saved = workflowState.getOperator(op.operatorID)?.savedResult;
      return saved ? [[op.operatorID, { executionId: saved.executionId, operatorId: saved.operatorId, outputPort: saved.outputPort }]] : [];
    })),
  };
}

/**
 * Build a LogicalPlan from an explicit subDAG (typically one produced
 * by `partitionOpsByIndependence`). Differs from `buildLogicalPlan` in
 * that the operator set is supplied externally rather than derived
 * from the WorkflowState's current state, so multiple disjoint
 * partition groups can each ship their own plan.
 */
function buildLogicalPlanFromSubDAG(
  workflowState: WorkflowState,
  subDAG: { operators: OperatorPredicate[]; links: OperatorLink[] },
  opsToView: string[]
): LogicalPlan {
  const getInputPortOrdinal = (operatorID: string, inputPortID: string): number => {
    const op = workflowState.getOperator(operatorID);
    if (!op) return 0;
    const idx = op.inputPorts.findIndex(port => port.portID === inputPortID);
    return idx >= 0 ? idx : 0;
  };
  const getOutputPortOrdinal = (operatorID: string, outputPortID: string): number => {
    const op = workflowState.getOperator(operatorID);
    if (!op) return 0;
    const idx = op.outputPorts.findIndex(port => port.portID === outputPortID);
    return idx >= 0 ? idx : 0;
  };

  const operatorsList = subDAG.operators.map(op => ({
    ...op.operatorProperties,
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    inputPorts: op.inputPorts,
    outputPorts: op.outputPorts,
  }));
  const linksList: LogicalLink[] = subDAG.links.map(link => ({
    fromOpId: link.source.operatorID,
    fromPortId: { id: getOutputPortOrdinal(link.source.operatorID, link.source.portID), internal: false },
    toOpId: link.target.operatorID,
    toPortId: { id: getInputPortOrdinal(link.target.operatorID, link.target.portID), internal: false },
  }));
  const opIds = new Set(operatorsList.map(op => op.operatorID));
  return {
    operators: operatorsList,
    links: linksList,
    opsToViewResult: opsToView.filter(id => opIds.has(id)),
    savedOutputs: Object.fromEntries(subDAG.operators.flatMap(op => {
      const saved = op.savedResult;
      return saved ? [[op.operatorID, { executionId: saved.executionId, operatorId: saved.operatorId, outputPort: saved.outputPort }]] : [];
    })),
  };
}

/** How long past the engine's own execution timeout the client keeps waiting:
 * the engine answers a timed-out run itself ("Timeout after N seconds") after
 * killing it, so the client deadline must come later. */
const EXECUTION_REQUEST_MARGIN_MS = 60_000;

/** Request options for an execution call. Bun's fetch drops any request older
 * than 240-300 s on a periodic sweep unless `timeout: false` (measured: a
 * never-answered request fails at 300 s with or without a longer signal, and
 * at our deadline with `timeout: false`). That cut every execution longer
 * than about four minutes short although the engine was given 10 minutes, and
 * left the run executing in the engine. The wait is now bounded by the
 * engine's timeout plus a margin, and by the caller's abort signal. */
export function executionRequestLimits(
  timeoutSeconds: number,
  abortSignal?: AbortSignal
): { signal: AbortSignal; timeout: false } {
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000 + EXECUTION_REQUEST_MARGIN_MS);
  return { signal: abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline, timeout: false };
}

async function executeWorkflowHttp(
  config: ExecutionConfig,
  logicalPlan: LogicalPlan,
  options: { abortSignal?: AbortSignal } = {}
): Promise<SyncExecutionResult> {
  const backendConfig = getBackendConfig();

  const workflowId = config.workflowId;
  const computingUnitId = config.computingUnitId ?? 0;

  // In k8s each computing unit is a separate pod, so the endpoint varies per cuid.
  const executionEndpoint = env.EXECUTION_ENDPOINT_TEMPLATE
    ? env.EXECUTION_ENDPOINT_TEMPLATE.replace("{cuid}", String(computingUnitId))
    : backendConfig.executionEndpoint;

  const url = `${executionEndpoint}/api/execution/${workflowId}/${computingUnitId}/run`;

  const timeoutSeconds = config.executionTimeoutMs
    ? Math.ceil(config.executionTimeoutMs / 1000)
    : Math.ceil(DEFAULT_AGENT_SETTINGS.executionTimeoutMs / 1000);

  const request = {
    executionName: "agent-execution",
    ...(config.structuredResults ? { structuredResults: true } : {}),
    ...(Object.keys(logicalPlan.savedOutputs ?? {}).length ? { workflowSettings: { savedOutputs: logicalPlan.savedOutputs } } : {}),
    logicalPlan: {
      operators: logicalPlan.operators,
      links: logicalPlan.links,
      opsToViewResult: logicalPlan.opsToViewResult || [],
      opsToReuseResult: [],
    },
    targetOperatorIds: logicalPlan.opsToViewResult || [],
    timeoutSeconds,
    maxOperatorResultCharLimit: config.maxOperatorResultCharLimit ?? DEFAULT_AGENT_SETTINGS.maxOperatorResultCharLimit,
    maxOperatorResultCellCharLimit:
      config.maxOperatorResultCellCharLimit ?? DEFAULT_AGENT_SETTINGS.maxOperatorResultCellCharLimit,
  };

  log.debug(
    {
      url,
      maxOperatorResultCharLimit: request.maxOperatorResultCharLimit,
      maxOperatorResultCellCharLimit: request.maxOperatorResultCellCharLimit,
    },
    "executing workflow"
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.userToken}`,
      },
      body: JSON.stringify(request),
      ...executionRequestLimits(timeoutSeconds, options.abortSignal),
    } as RequestInit);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Execution request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = (await response.json()) as SyncExecutionResult;
    return config.structuredResults ? prepareStructuredExecutionResult(result, workflowId, logicalPlan) : result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    log.error({ err: error }, "execution failed");
    return {
      success: false,
      state: "Error",
      operators: {},
      errors: [error instanceof Error ? error.message : "Unknown error"],
    };
  }
}

function formatInputOutput(
  workflowState: WorkflowState,
  operatorId: string,
  opInfo: OperatorInfo,
  outputColumns: number
): string {
  const outputRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const outputLine = `Output Table: ${outputRows} rows, ${outputColumns} cols`;

  const inputShapes = opInfo.inputPortShapes;
  if (!inputShapes || inputShapes.length === 0) {
    return outputLine;
  }

  const inputLinks = workflowState.getAllLinks().filter(l => l.target.operatorID === operatorId);
  const portIndexToUpstream = new Map<number, string>();
  const op = workflowState.getOperator(operatorId);
  for (const link of inputLinks) {
    const portIdx = op?.inputPorts.findIndex(p => p.portID === link.target.portID) ?? -1;
    if (portIdx >= 0) {
      portIndexToUpstream.set(portIdx, link.source.operatorID);
    }
  }

  const inputPart = inputShapes
    .sort((a, b) => a.portIndex - b.portIndex)
    .map(p => {
      const name = portIndexToUpstream.get(p.portIndex) ?? `input${p.portIndex}`;
      const rowsPart = typeof p.rows === "number" ? `${p.rows} rows` : undefined;
      const colsPart = typeof p.columns === "number" ? `${p.columns} cols` : undefined;
      const shape = [rowsPart, colsPart].filter(Boolean).join(", ");
      return shape ? `${name} (${shape})` : name;
    })
    .join(", ");

  return `Inputs: ${inputPart}\n${outputLine}`;
}

/**
 * Persist every operator info that came back from the backend, errored or not.
 *
 * The snapshot storage carries errors via `OperatorInfo.error`; there is no
 * separate error axis. Persisting indiscriminately keeps the storage view of
 * the workflow consistent with the actual backend run — including
 * surface-level failures on sibling operators that share the same execution.
 */
/**
 * Forward each per-operator info the backend returned to `onResult`, but
 * skip *stub* entries: an `OperatorInfo` that carries neither a `result`
 * array nor an `error` string contributes no real information about the
 * operator's run. The backend emits these for ops it acknowledged but
 * could not materialize — typically a downstream op whose upstream
 * errored, e.g. legal-hard-2's `findMaxRate` after a buggy `metroStats`
 * rewrite.
 *
 * Persisting stubs is harmful because it overrides the snapshot's
 * inherited result (which, post tight-accuracy inheritance, has already
 * been gated on the operator and its upstream being unchanged from the
 * parent). Without this guard the model would see `(no result data)` in
 * place of a still-valid prior value and loop trying to fix an operator
 * that is fine — exactly the failure mode that caused
 * `DataflowSystemGPT5Mini` to burn 50 steps on legal-hard-2.
 *
 * Exported for unit tests; production callers go through the helpers
 * above (`executeOperatorAndFormat`, `executeWorkflowAndPersist`).
 */
export function persistOperatorResults(
  operators: Record<string, OperatorInfo> | undefined,
  onResult?: (operatorId: string, info: OperatorInfo) => void
): void {
  if (!onResult || !operators) return;
  for (const opId of orderedResultIds(operators)) {
    const info = operators[opId];
    if (!info) continue;
    const hasResult = info.result !== undefined && info.result !== null;
    const hasError = typeof info.error === "string" && info.error.length > 0;
    if (!hasResult && !hasError) continue;
    // A missing-file error is the one failure the agent cannot debug by
    // reading its own code: it has no way to list the filesystem. Attach the
    // real paths carrying that basename so one failure ends the search instead
    // of starting a guessing loop.
    onResult(opId, hasError ? { ...info, error: annotateMissingPath(info.error as string) } : info);
  }
}

function formatExecutionError(
  compilationErrors?: Record<string, string>,
  operatorErrors?: Array<{ operatorId: string; error: string }>,
  generalErrors?: string[]
): string {
  const lines: string[] = ["Execution failed due to the following error:"];

  if (compilationErrors && Object.keys(compilationErrors).length > 0) {
    lines.push("Compilation error:");
    for (const [key, value] of Object.entries(compilationErrors)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  if (operatorErrors && operatorErrors.length > 0) {
    lines.push("Execution error:");
    for (const { operatorId, error } of operatorErrors) {
      lines.push(`  ${operatorId}: ${error}`);
    }
  }

  if (generalErrors && generalErrors.length > 0) {
    lines.push("Error:");
    for (const error of generalErrors) {
      lines.push(`  ${error}`);
    }
  }

  return lines.join("\n");
}

function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const hasRowIndex = jsonResult.length > 0 && "__row_index__" in jsonResult[0];
  const headers = getVisibleResultHeaders(jsonResult[0]);
  if (headers.length === 0) return "";
  // Leading tab aligns headers with the index column (pandas __repr__ style).
  const headerLine = "\t" + headers.join("\t");

  const formattedRows: string[] = [];
  let prevIndex = -1;

  for (let i = 0; i < jsonResult.length; i++) {
    const row = jsonResult[i];
    const rowIndex = hasRowIndex ? (row["__row_index__"] as number) : i;

    if (prevIndex >= 0 && rowIndex > prevIndex + 1) {
      const dots = headers.map(() => "...").join("\t");
      formattedRows.push(`...\t${dots}`);
    }
    prevIndex = rowIndex;

    const cells = headers.map(h => {
      const val = row[h];
      if (val === null) return "NaN";
      if (val === undefined) return "";
      if (typeof val === "number" || typeof val === "boolean") return String(val);
      if (typeof val === "string") {
        if (val === "NULL") return "NaN";
        return val.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
      }
      return JSON.stringify(val);
    });
    formattedRows.push(`${rowIndex}\t${cells.join("\t")}`);
  }

  return [headerLine, ...formattedRows].join("\n");
}

export async function executeOperatorAndFormat(
  workflowState: WorkflowState,
  config: ExecutionConfig,
  operatorId: string,
  options: {
    abortSignal?: AbortSignal;
    onResult?: (operatorId: string, operatorInfo: OperatorInfo) => void;
    onResultLegacy?: (operatorId: string, backendStats?: Record<string, string>) => void;
  } = {}
): Promise<string> {
  // Serialize executions per workflow to avoid ConcurrentModificationException on the backend.
  const release = await getWorkflowMutex(config.workflowId).acquire();

  try {
    const logicalPlan = buildLogicalPlan(workflowState, [operatorId]);

    if (logicalPlan.operators.length === 0) {
      return createErrorResult("Cannot execute: workflow has no operators.");
    }

    // Only block on the target operator's validation errors; upstream issues will
    // surface as runtime errors that correctly identify the failing operator.
    const validationResult = validateWorkflow(workflowState);
    if (!validationResult.isValid) {
      const targetErrors = validationResult.errors[operatorId];
      if (targetErrors) {
        const lines = [`Operator ${operatorId}:`];
        for (const [field, message] of Object.entries(targetErrors)) {
          lines.push(`  - ${field}: ${message}`);
        }
        return createErrorResult(lines.join("\n"));
      }
    }

    const result: SyncExecutionResult = await executeWorkflowHttp(config, logicalPlan, {
      abortSignal: options.abortSignal,
    });

    if (!result.success) {
      const compilationErrors =
        result.state === "CompilationFailed" || result.state === "ValidationFailed"
          ? result.compilationErrors
          : undefined;

      const operatorErrors =
        result.state === "Failed"
          ? Object.entries(result.operators)
              .filter(([_, op]) => op.error)
              .map(([opId, op]) => ({ operatorId: opId, error: op.error! }))
          : undefined;

      const generalErrors = result.state === "Killed" ? ["Workflow execution was killed (timeout)."] : result.errors;

      const errorText = formatExecutionError(compilationErrors, operatorErrors, generalErrors);

      // Persist every per-op info the backend returned (including errors on
      // sibling operators), then synthesize one for the requested op if the
      // backend didn't surface it (e.g. compilation/validation failures where
      // `result.operators` is empty).
      persistOperatorResults(result.operators, options.onResult);
      if (options.onResult && !result.operators?.[operatorId]) {
        options.onResult(operatorId, {
          state: result.state,
          inputTuples: 0,
          outputTuples: 0,
          resultMode: "table",
          error: errorText,
        });
      }

      return createErrorResult(errorText);
    }

    const opInfo = result.operators[operatorId];
    if (!opInfo) {
      return createErrorResult(
        formatExecutionError(undefined, undefined, [`No result found for operator: ${operatorId}`])
      );
    }

    if (opInfo.error) {
      // Persist every op the backend reported (any sibling errors land too).
      persistOperatorResults(result.operators, options.onResult);
      return createErrorResult(formatExecutionError(undefined, [{ operatorId, error: opInfo.error }]));
    }

    if (!opInfo.result || !Array.isArray(opInfo.result)) {
      return "(no result data)";
    }

    const jsonArray = opInfo.result as Record<string, any>[];
    const headers = jsonArray.length > 0 ? getVisibleResultHeaders(jsonArray[0]) : [];
    const columns = headers.length;

    // Persist every per-op info — sibling errors included — so the snapshot
    // storage mirrors what the backend actually produced.
    persistOperatorResults(result.operators, options.onResult);

    let dataString = jsonToTableFormat(jsonArray);

    // Safety-net: TSV serialization may add padding beyond backend's raw-record budget.
    const charLimit = config.maxOperatorResultCharLimit ?? DEFAULT_AGENT_SETTINGS.maxOperatorResultCharLimit;

    if (dataString.length > charLimit) {
      const allLines = dataString.split("\n");
      const headerLine = allLines[0];
      const dataRows = allLines.slice(1);

      const reservedSize = headerLine.length + 1;

      const halfLimit = Math.floor((charLimit - reservedSize) / 2);

      let frontSize = 0;
      const frontRows: string[] = [];
      for (const row of dataRows) {
        const rowLen = row.length + 1;
        if (frontSize + rowLen > halfLimit && frontRows.length > 0) break;
        frontRows.push(row);
        frontSize += rowLen;
      }

      let backSize = 0;
      const backRows: string[] = [];
      for (let i = dataRows.length - 1; i >= frontRows.length; i--) {
        const rowLen = dataRows[i].length + 1;
        if (backSize + rowLen > halfLimit && backRows.length > 0) break;
        backRows.unshift(dataRows[i]);
        backSize += rowLen;
      }

      const keptRows = [...frontRows, ...backRows];
      dataString = [headerLine, ...keptRows].join("\n");
    }

    const shapeLine = formatInputOutput(workflowState, operatorId, opInfo, columns);

    const warningLines = opInfo.warnings?.map(w => w) ?? [];

    const metadataLines = [shapeLine, ...warningLines].filter(Boolean);

    const briefSummary = formatExecuteOperatorResult(operatorId);
    return [briefSummary, ...metadataLines, dataString].filter(Boolean).join("\n");
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw error;
    }
    return createErrorResult(`Execution failed: ${error.message || String(error)}`);
  } finally {
    release();
  }
}

/**
 * Execute the entire workflow once and persist every per-operator result
 * (errors included) via `onResult`. Used by `TexeraAgent.initialize()` to
 * baseline a freshly loaded workflow before any user turn, and by the
 * post-tool execution step that runs after a batch of createOrModifyOperator
 * tool calls in the same turn.
 *
 * When `opsToViewResult` has multiple entries with disjoint upstream
 * closures, each independent subDAG is shipped as its own sync execution
 * request — Amber's worker-supervisor scope is per-controller
 * (`AllForOneStrategy` in Controller.scala), so a failure in one
 * sub-execution cannot stop another. Single-op and single-group cases
 * fall through to the original one-request path.
 *
 * Returns a structured summary; never throws for backend failures, so the
 * caller can record a baseline step even when the run errored.
 */
export async function executeWorkflowAndPersist(
  workflowState: WorkflowState,
  config: ExecutionConfig,
  options: {
    abortSignal?: AbortSignal;
    onResult?: (operatorId: string, info: OperatorInfo) => void;
    opsToViewResult?: string[];
  } = {}
): Promise<{
  success: boolean;
  state: string;
  opCount: number;
  errorCount: number;
  errorText?: string;
}> {
  const release = await getWorkflowMutex(config.workflowId).acquire();

  try {
    const opsToView = options.opsToViewResult ?? [];
    const invalid = opsToView.filter(id => !workflowState.getOperator(id) || workflowState.getOperator(id)?.isDisabled);
    if (invalid.length) {
      return {
        success: false,
        state: "ValidationFailed",
        opCount: 0,
        errorCount: 0,
        errorText: `Unknown or disabled execution targets: ${invalid.join(", ")}.`,
      };
    }
    // Validate the same upstream closure that will be submitted. Unfinished
    // explorations outside it must not prevent this task from executing.
    const operators = opsToView.length ? workflowState.getSubDAGForTargets(opsToView).operators : undefined;
    const validationResult = validateWorkflow(workflowState, operators);
    if (!validationResult.isValid) {
      const errorText = formatWorkflowValidationErrors(validationResult);
      return { success: false, state: "ValidationFailed", opCount: 0, errorCount: 0, errorText };
    }

    // Multi-op case: partition into independent groups. Only switch to
    // the per-group execution path when partitioning actually yields
    // more than one group — a single group behaves identically to the
    // original code path, which we preserve below.
    if (opsToView.length > 1) {
      const groups = partitionOpsByIndependence(workflowState, opsToView);
      if (groups.length > 1) {
        return await executeGroupsSequentially(workflowState, config, groups, options);
      }
    }

    const logicalPlan = buildLogicalPlan(workflowState, opsToView);
    if (logicalPlan.operators.length === 0) {
      return { success: false, state: "Empty", opCount: 0, errorCount: 0, errorText: "Workflow has no operators." };
    }

    const result = await executeWorkflowHttp(config, logicalPlan, { abortSignal: options.abortSignal });
    persistOperatorResults(result.operators, options.onResult);

    const opCount = Object.keys(result.operators).length;
    const errorCount = Object.values(result.operators).filter(o => o.error).length;

    if (!result.success) {
      const compilationErrors =
        result.state === "CompilationFailed" || result.state === "ValidationFailed"
          ? result.compilationErrors
          : undefined;
      const operatorErrors =
        result.state === "Failed"
          ? Object.entries(result.operators)
              .filter(([_, op]) => op.error)
              .map(([opId, op]) => ({ operatorId: opId, error: op.error! }))
          : undefined;
      const generalErrors = result.state === "Killed" ? ["Workflow execution was killed (timeout)."] : result.errors;
      const errorText = formatExecutionError(compilationErrors, operatorErrors, generalErrors);
      return { success: false, state: result.state, opCount, errorCount, errorText };
    }

    return { success: true, state: result.state, opCount, errorCount };
  } finally {
    release();
  }
}

/**
 * Execute each partition group as its own sync request, sequentially.
 *
 * Sequential rather than parallel: each sync request opens its own
 * controller actor in Amber and the backend serializes them per
 * workflow anyway (we hold the per-workflow mutex from the caller).
 * Sequential execution also keeps per-group results streaming back
 * to `onResult` in a deterministic order, which simplifies the
 * snapshot the agent sees on its next turn.
 *
 * Per-group execution failure does NOT abort the remaining groups —
 * that's the whole point: independent ops should preserve their
 * results even when a sibling op errors. The aggregated summary
 * reports `success=false` if any group failed, but every group's
 * per-op `info` (including the failed one's `error` and the
 * succeeded ones' `result`) is persisted via `onResult`.
 */
async function executeGroupsSequentially(
  workflowState: WorkflowState,
  config: ExecutionConfig,
  groups: PartitionGroup[],
  options: {
    abortSignal?: AbortSignal;
    onResult?: (operatorId: string, info: OperatorInfo) => void;
  }
): Promise<{
  success: boolean;
  state: string;
  opCount: number;
  errorCount: number;
  errorText?: string;
}> {
  const mergedOps: Record<string, OperatorInfo> = {};
  const groupErrors: string[] = [];
  let anyFailure = false;
  let aggregateState = "Completed";

  for (let gi = 0; gi < groups.length; gi++) {
    if (options.abortSignal?.aborted) {
      const err = new Error("Execution aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }

    const group = groups[gi];
    const plan = buildLogicalPlanFromSubDAG(workflowState, group.subDAG, group.opsToView);
    if (plan.operators.length === 0) continue;

    log.info(
      { groupIndex: gi, totalGroups: groups.length, opsToView: group.opsToView },
      "Executing partition group"
    );

    try {
      const result = await executeWorkflowHttp(config, plan, { abortSignal: options.abortSignal });
      persistOperatorResults(result.operators, options.onResult);

      for (const [opId, info] of Object.entries(result.operators)) {
        mergedOps[opId] = info;
      }

      if (!result.success) {
        anyFailure = true;
        // Prefer "Failed" over more specific states when later groups
        // succeed — the agent's response surface mostly branches on
        // `result.success`, but the state string is shown in logs.
        if (aggregateState === "Completed") aggregateState = result.state;
        const compilationErrors =
          result.state === "CompilationFailed" || result.state === "ValidationFailed"
            ? result.compilationErrors
            : undefined;
        const operatorErrors =
          result.state === "Failed"
            ? Object.entries(result.operators)
                .filter(([_, op]) => op.error)
                .map(([opId, op]) => ({ operatorId: opId, error: op.error! }))
            : undefined;
        const generalErrors =
          result.state === "Killed" ? ["Workflow execution was killed (timeout)."] : result.errors;
        const text = formatExecutionError(compilationErrors, operatorErrors, generalErrors);
        if (text) groupErrors.push(text);
      }
    } catch (error: any) {
      if (error.name === "AbortError") throw error;
      anyFailure = true;
      if (aggregateState === "Completed") aggregateState = "Failed";
      const msg = error?.message || String(error);
      groupErrors.push(`Group ${gi + 1} (ops: ${group.opsToView.join(", ")}) failed: ${msg}`);
    }
  }

  const opCount = Object.keys(mergedOps).length;
  const errorCount = Object.values(mergedOps).filter(o => o.error).length;
  if (anyFailure) {
    return {
      success: false,
      state: aggregateState,
      opCount,
      errorCount,
      errorText: groupErrors.join("\n\n"),
    };
  }
  return { success: true, state: "Completed", opCount, errorCount };
}

export function createExecuteOperatorTool(
  workflowState: WorkflowState,
  getConfig: () => ExecutionConfig,
  onResult?: (operatorId: string, operatorInfo: OperatorInfo) => void
) {
  return tool({
    description:
      "Execute the workflow and get the specified operator's result. The execution result(if succeeded) includes the shape of the input tables(if any) and output table, and the records in the output table",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator ID to view result for."),
    }),
    execute: async (args: { operatorId: string }, options: { abortSignal?: AbortSignal }) => {
      const config = getConfig();
      return await executeOperatorAndFormat(workflowState, config, args.operatorId, { ...options, onResult });
    },
  });
}
