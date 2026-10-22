/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { AgentSettings, RetrievalView } from "../../types/agent";
import { registeredReferenceText } from "../prompts";
import type { ExecutionRunMetrics, OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { WorkflowState } from "../workflow-state";
import { editVersionInfo, type SnapshotEdit, type WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { FLOW_OMITTED_NOTICE, selectNativeObservation, type NativeObservation } from "../native/evidence";
import { resultScope } from "../native/result-scope";
import { nativeAssignmentText } from "../native/catalog";
import { flowObservationOptions, retrievalOptions } from "../native/retrieval";
import { observationFormat, describeOperator, topologicalOperators, columnEntries } from "../native/observation-format";
import { constantColumnLines, nativeAdjustmentLines, nativeCheckLines } from "../native/checks";
import { edgeEnds, editVersions, planRegisteredGraphEdit, inspectGraph, missingGraphInputs } from "./graph-edits";
import { inspectRegisteredNamespace, inspectRegisteredSchema, registeredInspectionName } from "./registered-inspection";
import { EMPTY_DATAFLOW_ERROR, runDataflowActions, type DataflowActionsResult } from "./dataflow-actions";
import { formatOperatorResult } from "./result-formatting";
import type { ToolContext } from "./workflow-crud-tools";

export interface DataflowActionRuntime {
  state: WorkflowState;
  storage: WorkflowSnapshotStorage;
  stepId: string;
  settings: AgentSettings;
  context: ToolContext;
  execute: (operatorIds?: readonly string[], onExecution?: (run: ExecutionRunMetrics) => void) => Promise<void>;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  /** Who made the call's edits: the agent, or the user from the canvas. */
  author?: SnapshotEdit["author"];
}

/** Every operator upstream of `id` in this workflow. */
function ancestorsOf(workflow: WorkflowContent, id: string): Set<string> {
  const byId = new Map(workflow.operators.map(op => [op.operatorID, op]));
  const seen = new Set<string>();
  const pending = [...(byId.get(id)?.nativeOp?.inputs ?? [])].filter(Boolean);
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(byId.get(next)?.nativeOp?.inputs ?? []).filter(Boolean));
  }
  return seen;
}

/** Shape and columns of a completed result, for inspection receipts. */
function resultSummary(info: OperatorInfo | undefined) {
  if (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)) return {};
  return {
    rows: info.totalRowCount ?? info.outputTuples,
    ...(info.resultSchema ? { columns: info.resultSchema.map(c => `${c.name}:${c.type}`) } : {}),
  };
}

/** Resolve actions against one owned snapshot. Edits advance its graph;
 * execute fills its results; retrieval freezes text at the point it was read. */
export async function executeDataflowActionBatch(
  result: DataflowActionsResult,
  runtime: DataflowActionRuntime
): Promise<void> {
  const { state, storage, stepId, context, signal } = runtime;
  const settings = { ...runtime.settings };
  // Sessions with several requests reuse functions and build on earlier
  // results: receipts name each function's signature and note degenerate columns.
  const multiRequest = (settings.multiRequest ?? "off") !== "off";
  result.format = observationFormat(settings);
  const options = {
    ...result.format,
    data: settings.dataEvidence,
    flow: settings.flowEvidence,
    maxChars: settings.maxOperatorResultCharLimit,
    maxRows: settings.maxResultRows,
  };
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (!runtime.isCurrent()) throw new DOMException("The active workflow changed during this action.", "AbortError");
  };
  const retrieved = new Map<string, { operatorId: string; info: OperatorInfo; observation: NativeObservation }>();
  const current = (id: string) => storage.getOperatorResult(stepId, id);
  const block = (op: OperatorPredicate, extra: Parameters<typeof describeOperator>[2] = {}) => {
    const info = current(op.operatorID);
    let stale = false;
    if (!info) {
      let snapshot = storage.getAssociatedSnapshot(stepId);
      while (snapshot.parentId) {
        const parent = storage.getSnapshotById(snapshot.parentId);
        if (!parent) break;
        if (parent.results.has(op.operatorID)) {
          stale = true;
          break;
        }
        snapshot = parent;
      }
    }
    return describeOperator(op, info, {
      ...result.format,
      namespace: state.getWorkflowContent().nativeNamespace,
      stale,
      scope: extra.scope ?? resultScope(op, state.getWorkflowContent(), current),
      ...extra,
    });
  };
  const errorText = (id: string, info: OperatorInfo) =>
    formatOperatorResult(id, info, state, {
      nativeEvidence: { ...options, workflow: state.getWorkflowContent(), resolveInput: current },
    });

  await runDataflowActions(result, async (action, index) => {
    assertCurrent();
    if (action.type === "inspect") {
      if (action.target === "reference") return { status: "ok", output: { text: registeredReferenceText(action) } };
      if (action.target === "namespace")
        return {
          status: "ok",
          output: inspectRegisteredNamespace(state.getWorkflowContent(), action.names, action.include_implementation),
        };
      const op = state.getOperator(action.operator_id);
      if (!op) throw new Error(`UNKNOWN_OPERATOR: no operator \`${action.operator_id}\`.`);
      if (action.target === "schema") {
        if (!current(op.operatorID) && block(op).state === "stale")
          throw new Error(`RESULT_STALE: \`${op.operatorID}\` changed since it was computed.`);
        return {
          status: "ok",
          output: inspectRegisteredSchema(op, current(op.operatorID), action.offset, action.limit),
        };
      }
      const view = op.nativeOp;
      const registeredName = registeredInspectionName(op);
      const graph = inspectGraph(state.getWorkflowContent());
      return {
        status: "ok",
        output: {
          operator_blocks: [
            block(op, {
              implementation: action.include_implementation,
              usedBy: state
                .getAllOperators()
                .filter(item => item.nativeOp?.inputs.includes(op.operatorID))
                .map(item => item.operatorID),
            }),
          ],
          id: op.operatorID,
          type: view?.registeredName ?? view?.type ?? op.operatorType,
          revision: view?.revision,
          expression: view ? nativeAssignmentText(op.operatorID, view) : undefined,
          ports: graph.operators.find(item => item.id === op.operatorID)?.ports,
          connections: graph.edges.filter(edge => Object.values(edgeEnds(edge)).includes(op.operatorID)),
          description:
            view?.doc ??
            (registeredName
              ? state.getWorkflowContent().nativeNamespace?.functions[registeredName]?.doc
              : view?.properties.doc),
          ...(registeredName
            ? { signature: state.getWorkflowContent().nativeNamespace?.functions[registeredName]?.signature }
            : {}),
          ...resultSummary(current(op.operatorID)),
          ...(action.include_implementation && registeredName
            ? { implementation: inspectRegisteredNamespace(state.getWorkflowContent(), [registeredName], true) }
            : {}),
        },
      };
    }
    if (action.type === "edit") {
      const before = state.getWorkflowContent();
      const plan = await planRegisteredGraphEdit(before, action.python, action.changes, context);
      assertCurrent();
      state.setWorkflowContent(plan.workflow);
      // One version per edit; the step's snapshot is the last of them.
      const versions = storage.recordEdits(stepId, editVersions(before, plan, runtime.author)).map(editVersionInfo);
      result.operators.push(...plan.operators);
      const { workflow: _workflow, edits: _edits, ...planned } = plan;
      const output = { ...planned, versions };
      if (multiRequest && output.registrations)
        output.registrations = output.registrations.map(registration => ({
          ...registration,
          signature: plan.workflow.nativeNamespace?.functions[registration.name]?.signature ?? "",
        }));
      return { status: "ok", output };
    }
    if (action.type === "execute") {
      const workflow = state.getWorkflowContent();
      if (action.operator_ids) {
        const invalid = action.operator_ids.filter(id => !state.getOperator(id) || state.getOperator(id)?.isDisabled);
        if (invalid.length)
          throw new Error(`Unknown or disabled execution targets: ${invalid.join(", ")}. No execution was started.`);
      }
      const scope = action.operator_ids ? { ...workflow, ...state.getSubDAGForTargets(action.operator_ids) } : workflow;
      const operators = scope.operators;
      if (!operators.length) throw new Error(EMPTY_DATAFLOW_ERROR);
      const missing = missingGraphInputs(scope);
      if (missing.length)
        throw new Error(
          `Unconnected required inputs: ${missing.join(", ")}. Restate those operators with every input, or delete them, before execute.`
        );
      let failure: string | undefined;
      const executionRuns: ExecutionRunMetrics[] = [];
      try {
        await runtime.execute(action.operator_ids, run => executionRuns.push(run));
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      assertCurrent();
      const outcomes = operators.map(op => {
        const info = current(op.operatorID);
        if (!info || !["Completed", "CompletedFromCache"].includes(info.state) || info.error) {
          const failed =
            !!info?.error && (!info.nativeError || info.nativeError.diagnostic.operatorId === op.operatorID);
          const culprit = info?.nativeError?.diagnostic.operatorId;
          const reads =
            culprit && culprit !== op.operatorID ? ancestorsOf(workflow, op.operatorID).has(culprit) : false;
          return {
            id: op.operatorID,
            status: "error",
            state: failed ? "failed" : "not run",
            ...(failed
              ? { message: errorText(op.operatorID, info!) }
              : {
                  cause: culprit
                    ? reads
                      ? `upstream \`${culprit}\` failed`
                      : `the run stopped when \`${culprit}\` failed; they do not read from it`
                    : failure
                      ? "the execution ended before they ran"
                      : "the engine returned no result for them",
                }),
          };
        }
        const rows = info.totalRowCount ?? info.outputTuples;
        const checks = [
          // An empty result is always worth a block, whatever else is enabled.
          ...(rows === 0 ? ["note: empty table."] : []),
          ...(settings.nativeChecks ? nativeCheckLines(op, info) : []),
          ...nativeAdjustmentLines(op, info),
          ...(multiRequest
            ? constantColumnLines(
                op,
                info,
                (op.nativeOp?.inputs ?? []).map(id => current(id))
              )
            : []),
        ];
        return {
          id: op.operatorID,
          status: "ok",
          state: info.state === "CompletedFromCache" || info.materialization?.cached ? "cached" : "executed",
          rows,
          ...(checks.length ? { checks } : {}),
        };
      });
      return {
        status: failure || outcomes.some(o => o.status === "error") ? "error" : "ok",
        output: {
          operators: outcomes,
          // Retain real per-request telemetry in saved traces, including
          // failed groups. The receipt intentionally omits it.
          execution_runs: executionRuns,
          // Blocks only for operators this call ran or failed: a cached
          // operator's notes and flow lines were shown when it ran.
          operator_blocks: topologicalOperators(operators)
            .filter(op => {
              const outcome = outcomes.find(item => item.id === op.operatorID)!;
              return outcome.state === "executed" || outcome.state === "failed";
            })
            .map(op => {
              const outcome = outcomes.find(item => item.id === op.operatorID)!;
              const info = current(op.operatorID);
              const observation =
                settings.flowEvidence && info && !info.error
                  ? selectNativeObservation({
                      ...flowObservationOptions(settings),
                      op,
                      info,
                      workflow,
                      resolveInput: current,
                    })
                  : undefined;
              // The operator's own measurements; its contract is not repeated
              // here. The receipt renderer shares facts already printed.
              const own = (id: string) => id.startsWith("flow.") && id !== "flow.contract" && id !== "flow.omitted";
              const ownFlow = observation
                ? {
                    resultVersion: observation.resultVersion,
                    chunks: observation.chunks.filter(chunk => own(chunk.id) && !chunk.upstream),
                  }
                : undefined;
              const flow =
                observation && ownFlow
                  ? [
                      ...ownFlow.chunks.flatMap(chunk => chunk.text.split("\n")).filter(Boolean),
                      ...(observation.omitted.some(item => item.reason === "budget" && own(item.id))
                        ? [FLOW_OMITTED_NOTICE]
                        : []),
                    ]
                  : [];
              const issues = [
                ...("message" in outcome ? [outcome.message!] : []),
                ...("checks" in outcome ? (outcome.checks ?? []) : []).map(line =>
                  line.startsWith("- ") ? line : `- ${line}`
                ),
                ...flow,
              ];
              return {
                ...block(op, {
                  state: outcome.state,
                  definition: false,
                  issues,
                  // Each executed selection reports its own facts once.
                  scope: resultScope(op, workflow, current, undefined, false),
                }),
                ...(ownFlow ? { flow_observation: ownFlow } : {}),
              };
            }),
          ...(failure ? { error: failure } : {}),
        },
      };
    }
    // Retrieve: each target has its own status, so a failed one does not hide the others.
    const readOne = (operatorId: string, view: RetrievalView, columns?: string[]) => {
      const workflow = state.getWorkflowContent();
      const op = workflow.operators.find(op => op.operatorID === operatorId);
      if (!op) throw new Error(`UNKNOWN_OPERATOR: no operator \`${operatorId}\`.`);
      const info = current(operatorId);
      if (!info)
        throw new Error(
          block(op).state === "stale"
            ? `RESULT_STALE: \`${operatorId}\` changed after it was computed, and its execution did not complete.`
            : `RESULT_NOT_RUN: \`${operatorId}\` has no result; its execution did not complete.`
        );
      const upstream = info.nativeError?.diagnostic.operatorId;
      if (info.error && upstream && upstream !== operatorId)
        throw new Error(`RESULT_NOT_RUN: \`${operatorId}\` did not run because upstream \`${upstream}\` failed.`);
      if (info.error)
        throw new Error(
          `RESULT_FAILED: the last execution of \`${operatorId}\` failed.\n${errorText(operatorId, info)}`
        );
      if (!["Completed", "CompletedFromCache"].includes(info.state))
        throw new Error(`RESULT_NOT_RUN: the result of \`${operatorId}\` is ${info.state}.`);
      if (columns?.length) {
        const known = new Set((info.resultSchema ?? []).map(c => c.name));
        const unknown = columns.filter(name => known.size && !known.has(name));
        if (unknown.length)
          throw new Error(
            `UNKNOWN_COLUMN: \`${operatorId}\` has no column ${unknown.map(n => JSON.stringify(n)).join(", ")}. Its columns: ${columnEntries(info.resultSchema ?? [], observationFormat(result.format).columnsShown, false).join(", ")}. \`show schema ${operatorId}\` lists the exact names.`
          );
      }
      const observation = selectNativeObservation({
        ...retrievalOptions(settings, view),
        ...(columns?.length ? { columns } : {}),
        op,
        info,
        workflow,
        resolveInput: current,
      });
      retrieved.set(`${index}:${operatorId}`, { operatorId, info, observation });
      return {
        operator_blocks: [
          describeOperator(op, info, {
            ...result.format,
            namespace: workflow.nativeNamespace,
            definition: false,
            scope: resultScope(op, workflow, current),
          }),
        ],
        operator_id: operatorId,
        revision: op.nativeOp?.revision,
        result_version: info.resultVersion?.id,
        view,
        table: observation.table,
        evidence: observation.selected.filter(id => id.startsWith("data.") || id.startsWith("flow.")),
        text: observation.text,
        observation,
      };
    };
    const results: Array<Record<string, unknown>> = [];
    for (const operatorId of action.operator_ids) {
      try {
        results.push({ status: "ok", ...readOne(operatorId, action.view, action.columns) });
      } catch (error) {
        results.push({
          operator_id: operatorId,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { status: results.some(entry => entry.status === "error") ? "error" : "ok", output: { results } };
  });
  assertCurrent();
  // A later edit or execute in this call may supersede a retrieved version.
  // Its text remains in the receipt, but must not stand for today's table.
  for (const item of result.actions) {
    if (item.action.type !== "retrieve") continue;
    for (const output of ((item.output as any)?.results ?? []) as Array<Record<string, unknown>>) {
      const id = String(output.operator_id);
      if (output.status === "ok" && current(id) !== retrieved.get(`${item.index}:${id}`)?.info)
        output.superseded_in_call = true;
    }
  }
  const fresh = [...retrieved.values()].filter(({ operatorId, info }) => current(operatorId) === info);
  result.observe = [...new Set(fresh.map(({ operatorId }) => operatorId))];
  storage.captureNativeObservations(
    stepId,
    result.observe,
    options,
    new Map(fresh.map(({ operatorId, observation }) => [operatorId, observation]))
  );
}
