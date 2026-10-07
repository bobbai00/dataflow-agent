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

import { effectLine } from "../native/effect-receipt";
import type { AgentSettings } from "../../types/agent";
import { nativeReferenceText } from "../prompts";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { WorkflowState } from "../workflow-state";
import type { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { selectNativeObservation, type NativeObservation } from "../native/evidence";
import { resultScope } from "../native/result-scope";
import { inspectTask, type TaskHistory, type TaskReference } from "../task-history";
import { flowObservationOptions, retrievalOptions } from "../native/retrieval";
import {
  observationFormat,
  describeOperator,
  topologicalOperators,
  type OperatorBlock,
  columnEntries,
} from "../native/observation-format";
import { loadedRevision, originTask } from "../state-ledger";
import { nativeAdjustmentLines, nativeCheckLines } from "../native/checks";
import { composeAnswerParts, parseAnswerFromParts, statedDecimals } from "../native/answer";
import { inspectGraph, missingGraphInputs } from "./graph-edits";
import { planVersionedGraphEdit } from "./versioned-graph-edits";
import { runDataflowActions, type DataflowActionsResult } from "./dataflow-actions";
import { formatOperatorResult } from "./result-formatting";
import type { ToolContext } from "./workflow-crud-tools";
import {
  inspectState,
  inspectTaskSubgraph,
  forkState,
  historicalTask,
  readForkResult,
  type HistoricalTask,
} from "../state-history";
import { executionNotes, provenanceLines, taskLedger } from "../state-ledger";
import { displayedOperatorId, parseOperatorReference, resolveSavedOperator } from "../saved-versions";

export interface DataflowActionRuntime {
  state: WorkflowState;
  storage: WorkflowSnapshotStorage;
  stepId: string;
  settings: AgentSettings;
  context: ToolContext;
  execute: (operatorIds?: readonly string[]) => Promise<void>;
  edited: (ids: string[]) => void;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  historicalTasks?: readonly HistoricalTask[];
  taskHistory?: readonly TaskHistory[];
  /** HEAD when the current request arrived; the ledger's "before" (`stateLedger`). */
  taskBaseStepId?: string;
  /** Tasks completed before this conversation (loaded state); the ledger numbers after them. */
  taskNumberOffset?: number;
  /** The requests of the session so far: an answer composed from a table follows the decimal rule they state. */
  requestTexts?: readonly string[];
  taskChanges?: ReadonlyMap<string, string>;
  /** The number of the current task as the session counts it (loaded tasks included). */
  taskNumber?: number;
  /** HEAD when the first request arrived: the loaded state, if any. */
  loadedStepId?: string;
  retainResults?: () => Promise<void>;
  readResult?: (op: OperatorPredicate, info: OperatorInfo, columns?: string[], requireComplete?: boolean) => Promise<OperatorInfo>;
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

/** Exact source-to-copy mapping, including a fork that was later changed. */
const forkOrigin = (op: OperatorPredicate) =>
  op.stateOrigin ? `fork of ${op.stateOrigin.operatorId} (version at end of task ${op.stateOrigin.taskId})` : undefined;

/** A saved graph uses original IDs; a fork's observation uses the IDs of
 * the copies the model can inspect. Follow only this fork's input branch. */
function forkNames(workflow: WorkflowContent, operatorId: string, savedStep: string): Map<string, string> {
  const names = new Map<string, string>();
  const byId = new Map(workflow.operators.map(item => [item.operatorID, item]));
  for (const pending = [operatorId]; pending.length; ) {
    const item = byId.get(pending.pop()!);
    if (item?.stateOrigin?.stepId !== savedStep || names.has(item.stateOrigin.operatorId)) continue;
    names.set(item.stateOrigin.operatorId, item.operatorID);
    pending.push(...(item.nativeOp?.inputs ?? []));
  }
  return names;
}

/** Resolve actions against one owned snapshot. Edits advance its graph;
 * execute fills its results; retrieval freezes text at the point it was read. */
export async function executeDataflowActionBatch(
  result: DataflowActionsResult,
  runtime: DataflowActionRuntime
): Promise<void> {
  const { state, storage, stepId, context, signal } = runtime;
  const settings = { ...runtime.settings };
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
  const retrieved = new Map<number, { operatorId: string; info: OperatorInfo; observation: NativeObservation }>();
  const currentReads = new Map<string, { operatorId: string; info: OperatorInfo; observation: NativeObservation; actionIndex: number }>();
  const savedReads = new Set<number>();
  const forkReads = new Map<number, { operatorId: string; info: OperatorInfo }>();
  const current = (id: string) => storage.getOperatorResult(stepId, id);
  const references: TaskReference[] | undefined = settings.stateHistory ? (result.references = []) : undefined;
  const recordReference = (
    operatorId: string,
    kind: TaskReference["kind"],
    actionIndex: number,
    savedTaskId?: number,
    savedStepId?: string
  ) => {
    if (!references) return;
    let workflow = savedStepId ? storage.getWorkflow(savedStepId) : state.getWorkflowContent();
    let readStep = savedStepId ?? stepId;
    let id = operatorId;
    const retained = workflow.operators.find(op => op.operatorID === id)?.savedResult;
    if (retained && !savedStepId) {
      workflow = storage.getWorkflow(retained.stepId);
      readStep = retained.stepId;
      id = retained.operatorId;
      savedTaskId = retained.taskId;
    }
    const fork = !savedStepId && !current(id) ? readForkResult(workflow, storage, id, stepId) : undefined;
    if (fork) {
      workflow = fork.workflow;
      readStep = fork.stepId;
      id = fork.operatorId;
      savedTaskId = fork.taskId;
    }
    const op = workflow.operators.find(o => o.operatorID === id);
    const info = storage.getOperatorResult(readStep, id);
    if (
      (kind === "compute" || kind === "read") &&
      (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state))
    )
      return;
    const producingStepId = storage.getResolvedOperatorResult(readStep, id)?.sourceStepId;
    references.push({
      actionIndex,
      kind,
      operatorId: id,
      readStepId: readStep,
      ...(op?.nativeOp?.revision ? { operatorRevision: op.nativeOp.revision } : {}),
      ...(info?.resultVersion?.subgraphHash ? { subgraphHash: info.resultVersion.subgraphHash } : {}),
      ...(info?.resultVersion?.id ? { resultVersion: info.resultVersion.id } : {}),
      ...(producingStepId ? { producingStepId } : {}),
      ...(savedTaskId ? { savedTaskId } : {}),
    });
  };
  const recordVersions = (versions: Array<{ task: number; id: string; sourceId?: string }>, index: number) => {
    for (const version of versions) {
      const task = historicalTask(runtime.historicalTasks ?? [], version.task);
      recordReference(version.sourceId ?? version.id, "definition", index, task.taskId, task.stepId);
    }
  };
  const ledgerContext = {
    storage,
    baseStepId: runtime.taskBaseStepId,
    historicalTasks: runtime.historicalTasks ?? [],
    taskNumberOffset: runtime.taskNumberOffset,
    loadedStepId: runtime.loadedStepId,
    settings: result.format,
    currentStepId: stepId,
    taskChanges: runtime.taskChanges,
  };
  const block = (
    op: import("../../types/workflow").OperatorPredicate,
    extra: Parameters<typeof describeOperator>[2] = {}
  ) => {
    const origin = originTask(ledgerContext, op.operatorID, op.nativeOp?.revision);
    // A fork of an earlier task's version shows that task's saved result until it runs.
    const saved = current(op.operatorID)
      ? undefined
      : readForkResult(state.getWorkflowContent(), storage, op.operatorID, stepId);
    const info = current(op.operatorID) ?? saved?.info;
    const scopeWorkflow = saved?.workflow ?? state.getWorkflowContent();
    const scopeOp = saved ? scopeWorkflow.operators.find(item => item.operatorID === saved.operatorId)! : op;
    const names = saved ? forkNames(state.getWorkflowContent(), op.operatorID, saved.stepId) : undefined;
    const scope =
      extra.scope ??
      resultScope(
        scopeOp,
        scopeWorkflow,
        saved ? id => storage.getOperatorResult(saved.stepId, id) : current,
        id => names?.get(id) ?? displayedOperatorId(scopeWorkflow, id),
        !result.saved_versions
      );
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
    // Unchanged since it was loaded; an operator changed in this task has no origin yet.
    const loaded =
      !origin &&
      op.nativeOp?.revision !== undefined &&
      loadedRevision(ledgerContext, op.operatorID) === op.nativeOp.revision;
    const described = describeOperator(op, info, {
      ...result.format,
      stale,
      scope,
      ...(saved ? { savedBy: saved.taskId } : {}),
      ...(origin ? { origin: `task ${origin.taskId}` } : loaded ? { origin: "loaded" } : {}),
      ...extra,
    });
    return {
      ...described,
      id: displayedOperatorId(state.getWorkflowContent(), described.id),
      inputs: described.inputs?.map(input => ({
        ...input,
        id: displayedOperatorId(scopeWorkflow, input.id),
      })),
    };
  };
  const errorText = (id: string, info: OperatorInfo) =>
    formatOperatorResult(id, info, state, {
      nativeEvidence: { ...options, workflow: state.getWorkflowContent(), resolveInput: current },
    });

  await runDataflowActions(result, async (action, index) => {
    assertCurrent();
    if (action.type === "inspect") {
      if (action.target === "reference") {
        return {
          status: "ok",
          output: { text: nativeReferenceText(action, { ...settings, checks: settings.nativeChecks }) },
        };
      }
      if (action.target === "task") {
        if (!settings.stateHistory) throw new Error("Historical state tools are disabled.");
        const output = inspectTask(storage, runtime.taskHistory ?? [], action.task_id);
        references?.push({ actionIndex: index, kind: "consultation", operatorId: null, savedTaskId: action.task_id });
        const task = historicalTask(runtime.taskHistory ?? [], action.task_id);
        const selection = "operator_id" in action ? action.operator_id : null;
        const implementation = "include_implementation" in action && action.include_implementation;
        const view = "view" in action ? action.view : null;
        const roots =
          selection === null
            ? output.output_roots?.basis === "answer"
              ? output.output_roots.roots
              : []
            : (Array.isArray(selection) ? selection : [selection]).map(operator_id => ({
                operator_id,
                step_id: task.stepId,
                task_id: task.taskId,
              }));
        const groups = new Map<string, typeof roots>();
        for (const root of roots) groups.set(root.step_id, [...(groups.get(root.step_id) ?? []), root]);
        const dataflows = [...groups].map(([savedStep, selected]) => {
          const savedTask = { ...task, taskId: selected[0].task_id, stepId: savedStep };
          const graph = inspectTaskSubgraph(
            storage,
            savedTask,
            runtime.taskHistory ?? [],
            selected.map(root => root.operator_id),
            implementation,
            task.taskId
          );
          const workflow = storage.getWorkflow(savedStep);
          const selectedIds = new Set(graph.operators.map(op => op.operator_id));
          const observations =
            view === null
              ? []
              : graph.roots.map(id => {
                  const op = workflow.operators.find(op => op.operatorID === id)!;
                  const info = storage.getOperatorResult(savedStep, id);
                  if (
                    !info ||
                    info.error ||
                    !["Completed", "CompletedFromCache"].includes(info.state) ||
                    !Array.isArray(info.result)
                  )
                    return {
                      operator_id: id,
                      status: "unavailable",
                      text: `Result ${id} is unavailable in this saved version; fork and execute to recompute.`,
                    };
                  const observation = selectNativeObservation({
                    ...retrievalOptions(settings, view),
                    op,
                    info,
                    workflow,
                    resolveInput: input => storage.getOperatorResult(savedStep, input),
                  });
                  recordReference(id, "read", index, savedTask.taskId, savedStep);
                  return {
                    operator_id: id,
                    status: "available",
                    view,
                    table: observation.table,
                    text: observation.text,
                  };
                });
          return {
            ...graph,
            boundary_inputs: graph.boundary_inputs.map(input => {
              const savedWorkflow = storage.getWorkflow(input.step_id);
              const savedOp = savedWorkflow.operators.find(op => op.operatorID === input.operator_id)!;
              return {
                ...input,
                scope: resultScope(savedOp, savedWorkflow, id => storage.getOperatorResult(input.step_id, id)),
              };
            }),
            operator_blocks: graph.operators.map(node => {
              const op = workflow.operators.find(op => op.operatorID === node.operator_id)!;
              return describeOperator(op, storage.getOperatorResult(savedStep, op.operatorID), {
                ...result.format,
                scope: resultScope(op, workflow, id => storage.getOperatorResult(savedStep, id)),
                state: `saved by task ${savedTask.taskId}`,
                origin: forkOrigin(op),
                implementation,
                usedBy: workflow.operators
                  .filter(item => selectedIds.has(item.operatorID) && item.nativeOp?.inputs.includes(op.operatorID))
                  .map(item => item.operatorID),
              });
            }),
            observations,
          };
        });
        Object.assign(output, {
          selection_basis: selection === null ? (output.output_roots?.basis ?? "unknown") : "selected",
          dataflows,
          ...(roots.length
            ? {}
            : {
                note: "No confirmed answer roots were recorded. Select operator_id from the result-read candidates or operator index to inspect a saved branch; exploratory reads have not been expanded or retrieved.",
              }),
        });
        return { status: "ok", output };
      }
      if (action.target === "graph") {
        if (!("operator_ids" in action) && (settings.multiTask || settings.stateHistory))
          throw new Error(
            "Graph inspection in multi-task sessions requires operator_ids. Use the task index to inspect a saved task, or name current operators; the whole session graph is not returned."
          );
        const workflow = state.getWorkflowContent();
        const selected = "operator_ids" in action ? new Set(action.operator_ids) : undefined;
        if (selected)
          for (const id of selected)
            if (!state.getOperator(id)) throw new Error(`UNKNOWN_OPERATOR: ${id} does not exist in the current graph.`);
        const graph = inspectGraph(workflow);
        return {
          status: "ok",
          output: {
            ...graph,
            edges: selected
              ? graph.edges.filter(edge => [...selected].some(id => edge.includes(` -> ${id}.`)))
              : graph.edges,
            unconnected_inputs: selected
              ? graph.unconnected_inputs.filter(port => [...selected].some(id => port.startsWith(`${id}.`)))
              : graph.unconnected_inputs,
            operators: graph.operators
              .filter(item => !selected || selected.has(item.id))
              .map(item => ({ ...item, ...resultSummary(current(item.id)) })),
            operator_blocks: topologicalOperators(state.getAllOperators())
              .filter(op => !selected || selected.has(op.operatorID))
              .map(op => block(op, { definition: false })),
          },
        };
      }
      if (action.target === "state") {
        if (!settings.stateHistory) throw new Error("Historical state tools are disabled.");
        const output = inspectState(storage, runtime.historicalTasks ?? [], action);
        if (action.view !== null) {
          const task = historicalTask(runtime.historicalTasks ?? [], action.task_id!);
          const workflow = storage.getWorkflow(task.stepId);
          const operators = "operators" in output ? output.operators : [output];
          for (const operator of operators) {
            const op = workflow.operators.find(op => op.operatorID === operator.operator_id)!;
            const info = storage.getOperatorResult(task.stepId, operator.operator_id);
            const version = operator.versions[0];
            if (!version.result?.available || !info || info.error) {
              Object.assign(version, {
                observation: {
                  status: "unavailable",
                  message: info?.error
                    ? `- error RESULT_FAILED: task ${task.taskId}'s execution of \`${operator.operator_id}\` failed.`
                    : `result: not saved; roll it back as a copy and execute it to recompute.`,
                },
              });
              continue;
            }
            const observation = selectNativeObservation({
              ...retrievalOptions(settings, action.view),
              op,
              info,
              workflow,
              resolveInput: id => storage.getOperatorResult(task.stepId, id),
            });
            Object.assign(version, {
              observation: { view: action.view, table: observation.table, text: observation.text },
            });
          }
        }
        if (action.task_id !== null) {
          const task = historicalTask(runtime.historicalTasks ?? [], action.task_id);
          for (const id of Array.isArray(action.operator_id) ? action.operator_id : [action.operator_id])
            recordReference(id, action.view === null ? "consultation" : "read", index, task.taskId, task.stepId);
          const workflow = storage.getWorkflow(task.stepId);
          const histories = "operators" in output ? output.operators : [output];
          const requestedIds = new Set(histories.map(history => history.operator_id));
          const inputIds = new Set(histories.flatMap(history => history.versions[0]?.inputs ?? []));
          const selected = topologicalOperators(workflow.operators).filter(
            op => requestedIds.has(op.operatorID) || inputIds.has(op.operatorID)
          );
          Object.assign(output, {
            operator_blocks: selected.map(op =>
              describeOperator(op, storage.getOperatorResult(task.stepId, op.operatorID), {
                ...result.format,
                scope: resultScope(op, workflow, id => storage.getOperatorResult(task.stepId, id)),
                state: `saved by task ${task.taskId}`,
                origin: forkOrigin(op),
                implementation: action.include_implementation,
                usedBy: workflow.operators
                  .filter(item => item.nativeOp?.inputs.includes(op.operatorID))
                  .map(item => item.operatorID),
              })
            ),
            text: histories
              .flatMap(history =>
                history.versions.map(
                  version => (version as any).observation?.text ?? (version as any).observation?.message ?? ""
                )
              )
              .filter(Boolean)
              .join("\n\n"),
          });
        }
        return { status: "ok", output };
      }
      const op = state.getOperator(action.operator_id);
      if (!op) throw new Error(`Operator ${action.operator_id} does not exist.`);
      recordReference(action.operator_id, "consultation", index);
      const view = op.nativeOp;
      return {
        status: "ok",
        output: {
          operator_blocks: [
            block(op, {
              implementation: action.include_implementation,
              ...(op.stateOrigin ? { origin: forkOrigin(op) } : {}),
              usedBy: state
                .getAllOperators()
                .filter(item => item.nativeOp?.inputs.includes(op.operatorID))
                .map(item => item.operatorID),
            }),
          ],
          id: op.operatorID,
          type: view?.type ?? op.operatorType,
          revision: view?.revision,
          expression: view?.source,
          ports: inspectGraph(state.getWorkflowContent()).operators.find(item => item.id === op.operatorID)?.ports,
          connections: inspectGraph(state.getWorkflowContent()).edges.filter(
            edge => edge.startsWith(`${op.operatorID}.`) || edge.includes(` -> ${op.operatorID}.`)
          ),
          description: view?.properties.doc,
          ...resultSummary(current(op.operatorID)),
          ...(action.include_implementation
            ? {
                implementation: view
                  ? {
                      functions: view.functions ?? {},
                      callback: view.properties.func ?? view.properties.code ?? null,
                    }
                  : { code: op.operatorProperties.code ?? null },
              }
            : {}),
        },
      };
    }
    if (action.type === "read") {
      const selections = action.operator_ids.map(address => {
        const ref = parseOperatorReference(address);
        if (ref.taskId !== undefined) {
          if (!settings.stateHistory) throw new Error("Historical state tools are disabled.");
          return resolveSavedOperator(storage, runtime.historicalTasks ?? [], address, action.view !== null);
        }
        const op = state.getOperator(ref.operatorId);
        if (!op) throw new Error(`UNKNOWN_OPERATOR: no operator ${address}.`);
        const info = current(op.operatorID);
        if (action.view !== null && (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)))
          throw new Error(`RESULT_NOT_RUN: ${address} has no current completed result. Execute it, or use view=null for its definition.`);
        return { address, op, info, workflow: state.getWorkflowContent(), task: undefined };
      });
      const operatorBlocks: OperatorBlock[] = [];
      const observations: Array<{ operator_id: string; text: string }> = [];
      for (const selected of selections) {
        const { address, op, workflow, task } = selected;
        let info = selected.info;
        // Several tables share one columns list: each table keeps the columns
        // it has, and a table with none of them is an error.
        const schema = new Set(info?.resultSchema?.map(c => c.name) ?? []);
        const absent = schema.size ? (action.columns ?? []).filter(name => !schema.has(name)) : [];
        if (action.view !== null && info && action.columns && absent.length === action.columns.length)
          throw new Error(`UNKNOWN_COLUMN: ${address} has no columns ${absent.join(", ")}.`);
        const columns = action.columns ? action.columns.filter(name => !absent.includes(name)) : undefined;
        if (action.view === "full" && info && Array.isArray(info.result) && info.result.length < (info.totalRowCount ?? info.outputTuples) && runtime.readResult)
          info = await runtime.readResult(op, info, columns, false);
        const names = (id: string) => {
          const displayed = displayedOperatorId(workflow, id);
          return task && displayed === id ? `${id}@${task.taskId}` : displayed;
        };
        const selectedBlock = describeOperator({ ...op, operatorID: address }, info, {
          ...result.format, implementation: action.include_implementation,
          definition: true, definitionLimit: false,
          ...(task ? { state: "saved", savedBy: task.taskId } : {}),
        });
        selectedBlock.inputs = selectedBlock.inputs?.map(input => ({ ...input, id: names(input.id), taskId: undefined }));
        operatorBlocks.push(selectedBlock);
        recordReference(op.operatorID, action.view === null ? "definition" : "read", index, task?.taskId, task?.stepId);
        if (action.view !== null && info) {
          const observation = selectNativeObservation({
            ...retrievalOptions(settings, action.view), op, info, workflow,
            ...(columns ? { columns } : {}), displayName: names,
            resolveInput: id => task ? storage.getOperatorResult(task.stepId, id) : current(id),
          });
          const note = absent.length ? `\n${address} has no columns ${absent.join(", ")}; its other requested columns are shown.` : "";
          observations.push({operator_id:address,text:observation.text + note});
          if (!task && selected.info)
            currentReads.set(`${index}:${op.operatorID}`, {operatorId:op.operatorID,info:selected.info,observation,actionIndex:index});
        }
      }
      return { status: "ok", output: { operator_blocks: operatorBlocks, observations } };
    }
    if (action.type === "fork") {
      if (!settings.stateHistory) throw new Error("Historical state tools are disabled.");
      const plan = forkState(
        state.getWorkflowContent(),
        storage,
        runtime.historicalTasks ?? [],
        action.task_id,
        action.operator_id,
        action.new_operator_id
      );
      assertCurrent();
      state.setWorkflowContent(plan.workflow);
      storage.updatePendingWorkflow(stepId, plan.workflow);
      runtime.edited(plan.operators.map(op => op.id));
      recordVersions([{ task: action.task_id, id: action.operator_id }], index);
      result.operators.push(...plan.operators);
      const { workflow: _workflow, ...output } = plan;
      return { status: "ok", output };
    }
    if (action.type === "edit") {
      const before = state.getWorkflowContent();
      const plan = await planVersionedGraphEdit(
        before,
        action.changes,
        // Saved-versions sessions address versions as ID@task; the retired
        // fork/restore commands remain for legacy history sessions and replay.
        { ...context, settings, legacyVersionCommands: context.legacyVersionCommands || !result.saved_versions },
        storage,
        runtime.historicalTasks ?? []
      );
      const versions = plan.versions?.map(version => version.command) ?? [];
      const versionNotes = [...(plan.versions?.map(version => version.note) ?? []), ...(plan.notes ?? [])];
      const restoredIds = new Map<string, string>();
      for (const fork of plan.forks ?? [])
        for (const id of Object.values(fork.mapping)) restoredIds.set(id, `forked from task ${fork.task_id}`);
      for (const version of plan.versions ?? [])
        if (!version.command.as) restoredIds.set(version.command.id, version.state);
      assertCurrent();
      state.setWorkflowContent(plan.workflow);
      storage.updatePendingWorkflow(stepId, plan.workflow);
      const accepted = plan.operators.map(op => op.id);
      storage.clearNativeRejectedEdits(stepId, accepted);
      runtime.edited(accepted.filter(id => !!state.getOperator(id)));
      recordVersions(versions.map(v => ({ task: v.task, id: v.sourceId ?? v.id })), index);
      result.operators.push(...plan.operators);
      const { workflow: _workflow, ...output } = plan;
      const touched = new Set([...accepted, ...restoredIds.keys()]);
      const operatorBlocks: OperatorBlock[] = topologicalOperators(plan.workflow.operators)
        .filter(op => touched.has(op.operatorID) && !op.savedResult)
        .map(op => {
          const created = plan.changes.some(
            change => change.operator_id === op.operatorID && change.operation === "create_operator"
          );
          const updated = plan.changes.some(
            change => change.operator_id === op.operatorID && change.operation === "update_operator"
          );
          return block(op, {
            state: restoredIds.get(op.operatorID) ?? (created ? "created" : updated ? "updated" : "reconnected"),
            definition: restoredIds.has(op.operatorID),
            definitionLimit: true,
            stale: plan.invalidated_results.includes(op.operatorID),
          });
        });
      for (const deleted of plan.operators.filter(op => op.status === "deleted")) {
        const old = before.operators.find(op => op.operatorID === deleted.id);
        if (old)
          operatorBlocks.push({
            ...describeOperator(old, undefined, { state: "deleted", definition: false }),
            inputs: [],
            result: undefined,
          });
      }
      const provenance = settings.stateLedger
        ? provenanceLines(
            {
              storage,
              baseStepId: runtime.taskBaseStepId,
              historicalTasks: runtime.historicalTasks ?? [],
              taskNumberOffset: runtime.taskNumberOffset,
              loadedStepId: runtime.loadedStepId,
              settings: result.format,
              currentStepId: stepId,
            },
            plan,
            current
          )
        : [];
      const applied = plan.applied ?? plan.changes.length;
      return {
        status: "ok",
        output: {
          ...output,
          applied,
          operator_blocks: operatorBlocks,
          ...(versionNotes.length ? { version_notes: versionNotes } : {}),
          ...(provenance.length ? { provenance } : {}),
        },
      };
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
      if (!operators.length) throw new Error("The dataflow is empty. Add an operator before execute.");
      const missing = missingGraphInputs(scope);
      if (missing.length)
        throw new Error(
          `Unconnected required inputs: ${missing.join(", ")}. Create edges or delete unused operators before execute.`
        );
      let failure: string | undefined;
      try {
        await runtime.execute(action.operator_ids);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      assertCurrent();
      storage.restoreNativeRejectedEdits(stepId);
      const notes = settings.stateLedger
        ? executionNotes(
            state.getWorkflowContent(),
            current,
            operators.map(op => op.operatorID)
          )
        : new Map<string, string[]>();
      const lastTask = settings.stateHistory ? runtime.historicalTasks?.at(-1) : undefined;
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
        // An existing table that the last answered task saved: what this run changed.
        const effect = lastTask ? effectLine(`${op.operatorID}@${lastTask.taskId}`, storage.getOperatorResult(lastTask.stepId, op.operatorID), info) : undefined;
        const checks = [
          // An empty result is always worth a block, whatever else is enabled.
          ...(rows === 0 ? ["note: empty table."] : []),
          ...(effect ? [effect] : []),
          ...(settings.nativeChecks ? nativeCheckLines(op, info) : []),
          ...nativeAdjustmentLines(op, info),
          ...(notes.get(op.operatorID) ?? []),
        ];
        return {
          id: op.operatorID,
          status: "ok",
          state: info.state === "CompletedFromCache" || info.materialization?.cached ? "cached" : "executed",
          rows,
          ...(checks.length ? { checks } : {}),
        };
      });
      for (const outcome of outcomes)
        if (outcome.status === "ok") {
          recordReference(outcome.id, "compute", index);
          recordReference(outcome.id, "definition", index);
        }
      return {
        status: failure || outcomes.some(o => o.status === "error") ? "error" : "ok",
        output: {
          operators: outcomes.map(outcome => ({
            ...outcome,
            id: displayedOperatorId(workflow, outcome.id),
          })),
          // Blocks only for operators this call ran or failed: a cached
          // operator's notes and flow lines were shown when it ran, and
          // repeating them on every later execute only grows the context.
          // Operators that did not run are grouped by cause, without blocks.
          operator_blocks: topologicalOperators(operators)
            .filter(op => {
              const outcome = outcomes.find(item => item.id === op.operatorID)!;
              return outcome.state === "executed" || outcome.state === "failed";
            })
            .map(op => {
              const outcome = outcomes.find(item => item.id === op.operatorID)!;
              const info = current(op.operatorID);
              const flow =
                settings.flowEvidence && info && !info.error
                  ? selectNativeObservation({
                      ...flowObservationOptions(settings),
                      op,
                      info,
                      workflow,
                      resolveInput: current,
                    })
                      .chunks.filter(
                        chunk =>
                          chunk.id.startsWith("flow.") &&
                          chunk.id !== "flow.contract" &&
                          chunk.id !== "flow.omitted" &&
                          !chunk.upstream
                      )
                      .map(chunk => chunk.text)
                  : [];
              const issues = [
                ...("message" in outcome ? [outcome.message!] : []),
                ...("checks" in outcome ? (outcome.checks ?? []) : []).map(line =>
                  line.startsWith("- ") ? line : `- ${line}`
                ),
                ...flow,
              ];
              return block(op, {
                state: outcome.state,
                definition: false,
                issues,
                // Each executed selection reports its own facts once; reads
                // and edits expose ancestry without repeating it on every node.
                scope: resultScope(op, workflow, current, undefined, false),
              });
            }),
          ...(failure ? { error: failure } : {}),
        },
      };
    }
    if (action.type === "retrieve") {
      let workflow = state.getWorkflowContent();
      let resultStep = stepId;
      let operatorId = action.operator_id;
      let historical: { task_id: number; operator_id: string } | undefined;
      let copy: import("../../types/workflow").OperatorPredicate | undefined;
      // Sealed IDs of the saved subgraph → the copies' IDs, so the copy's
      // observation names its own inputs.
      const names = new Map<string, string>();
      if (!current(operatorId)) {
        const saved = readForkResult(workflow, storage, operatorId, stepId);
        if (saved) {
          historical = { task_id: saved.taskId, operator_id: saved.operatorId };
          forkReads.set(index, { operatorId, info: saved.info });
          copy = workflow.operators.find(item => item.operatorID === operatorId);
          for (const [original, name] of forkNames(workflow, operatorId, saved.stepId)) names.set(original, name);
          workflow = saved.workflow;
          resultStep = saved.stepId;
          operatorId = saved.operatorId;
          savedReads.add(index);
        }
      }
      const op = workflow.operators.find(op => op.operatorID === operatorId);
      if (!op) throw new Error(`UNKNOWN_OPERATOR: no operator \`${action.operator_id}\`.`);
      const info = storage.getOperatorResult(resultStep, operatorId);
      if (!info)
        throw new Error(
          historical
            ? `RESULT_NOT_RUN: task ${historical.task_id} saved no result for \`${operatorId}\`; execute the copy to compute it.`
            : block(op).state === "stale"
              ? `RESULT_STALE: \`${action.operator_id}\` changed after its last execution. Execute it, then retrieve.`
              : `RESULT_NOT_RUN: \`${action.operator_id}\` has not been executed. Execute it, then retrieve.`
        );
      const upstream = info.nativeError?.diagnostic.operatorId;
      if (info.error && upstream && upstream !== operatorId)
        throw new Error(
          `RESULT_NOT_RUN: \`${action.operator_id}\` did not run because upstream \`${upstream}\` failed. Repair it, execute, then retrieve.`
        );
      if (info.error)
        throw new Error(
          `RESULT_FAILED: the last execution of \`${action.operator_id}\` failed.\n${historical ? info.error : errorText(action.operator_id, info)}`
        );
      if (!["Completed", "CompletedFromCache"].includes(info.state))
        throw new Error(
          `RESULT_NOT_RUN: the result of \`${action.operator_id}\` is ${info.state}. Execute it, then retrieve.`
        );
      if (action.columns?.length) {
        const known = new Set((info.resultSchema ?? []).map(c => c.name));
        const unknown = action.columns.filter(name => known.size && !known.has(name));
        if (unknown.length)
          throw new Error(
            `UNKNOWN_COLUMN: \`${action.operator_id}\` has no column ${unknown.map(n => JSON.stringify(n)).join(", ")}. Its columns: ${columnEntries(info.resultSchema ?? [], observationFormat(result.format).columnsShown, false).join(", ")}.`
          );
      }
      const observation = selectNativeObservation({
        ...retrievalOptions(settings, action.view),
        ...(action.columns?.length ? { columns: action.columns } : {}),
        op,
        info,
        workflow,
        resolveInput: id => storage.getOperatorResult(resultStep, id),
        ...(names.size ? { displayName: (id: string) => names.get(id) ?? id } : {}),
      });
      recordReference(
        historical?.operator_id ?? action.operator_id,
        "read",
        index,
        historical?.task_id,
        historical ? resultStep : undefined
      );
      if (!historical) retrieved.set(index, { operatorId: action.operator_id, info, observation });
      return {
        status: "ok",
        output: {
          operator_blocks: [
            copy
              ? block(copy, { definition: false })
              : describeOperator({ ...op, operatorID: action.operator_id }, info, {
                  ...result.format,
                  definition: false,
                  scope: resultScope(op, workflow, id => storage.getOperatorResult(resultStep, id)),
                }),
          ],
          operator_id: action.operator_id,
          revision: op.nativeOp?.revision,
          result_version: info.resultVersion?.id,
          view: action.view,
          table: observation.table,
          evidence: observation.selected.filter(id => id.startsWith("data.") || id.startsWith("flow.")),
          ...(historical ? { historical_state: historical } : {}),
          text: observation.text,
        },
      };
    }
    // Answer. With `from`, the runtime composes the answer from an executed
    // table by a fixed mapping (see native/answer.ts): nothing is invented,
    // and a table that cannot be the answer is refused with the reason, so
    // the model writes the answer itself in its next call.
    let composed: { answer_from: string; answer: string } | undefined;
    if ("operator_ids" in action && action.operator_ids) {
      // Validate the entire declaration before recording any provenance.
      for (const id of action.operator_ids) {
        const ref = parseOperatorReference(id);
        if (ref.taskId !== undefined) {
          resolveSavedOperator(storage, runtime.historicalTasks ?? [], id, true);
          continue;
        }
        const op = state.getOperator(id);
        const info = current(id) ?? readForkResult(state.getWorkflowContent(), storage, id, stepId)?.info;
        if (
          !op ||
          !info ||
          info.error ||
          !["Completed", "CompletedFromCache"].includes(info.state) ||
          !Array.isArray(info.result)
        )
          throw new Error(
            `Answer operator ${id} has no completed result. Name an existing answer table and execute it if needed, or ${result.saved_versions ? "pass [] if no table was used" : "answer without operator_ids"}.`
          );
      }
      for (const id of action.operator_ids) {
        const ref = parseOperatorReference(id);
        const saved = ref.taskId === undefined ? undefined : resolveSavedOperator(storage, runtime.historicalTasks ?? [], id, true);
        recordReference(ref.operatorId, "read", index, saved?.task.taskId, saved?.task.stepId);
      }
    }
    if ("from" in action) {
      const parsed = parseAnswerFromParts(action.from);
      if ("error" in parsed) throw new Error(parsed.error);
      const tables = new Map<string, OperatorInfo>();
      for (const part of parsed.parts) {
        const ref = parseOperatorReference(part.id);
        const saved = ref.taskId === undefined ? undefined : resolveSavedOperator(storage, runtime.historicalTasks ?? [], part.id, true);
        const op = saved?.op ?? state.getOperator(ref.operatorId);
        let info = saved?.info ?? current(ref.operatorId);
        if (!op || !info) throw new Error(`answer_from: no table \`${part.id}\` with a matching completed result.`);
        if (part.selection && Array.isArray(info.result) && info.result.length < (info.totalRowCount ?? info.outputTuples) && runtime.readResult) {
          const projected = part.shape?.filter(item => item.column !== "*").map(item => item.column);
          const columns = projected?.length ? [...new Set([...projected, ...part.selection.by.map(key => key.column)])] : undefined;
          info = await runtime.readResult(op, info, columns, true);
        }
        tables.set(part.id, info);
      }
      const outcome = composeAnswerParts(parsed.parts, id => tables.get(id), {
        decimalRules: statedDecimals([...(runtime.requestTexts ?? [])]),
      });
      if ("reason" in outcome)
        throw new Error(
          `answer not composed: ${outcome.reason}. ${outcome.hint ?? "Write the final answer yourself."}`
        );
      for (const part of parsed.parts) {
        const ref = parseOperatorReference(part.id);
        const saved = ref.taskId === undefined ? undefined : resolveSavedOperator(storage, runtime.historicalTasks ?? [], part.id, true);
        recordReference(ref.operatorId, "read", index, saved?.task.taskId, saved?.task.stepId);
      }
      composed = { answer_from: parsed.parts.map(part => part.id).join(", "), answer: outcome.json };
    }
    // Saved versions are only as good as their retained materializations:
    // a task whose results were not retained says so in its boundary receipt.
    if (settings.stateHistory || result.saved_versions) {
      if (!runtime.retainResults)
        result.retention = "RETENTION_UNAVAILABLE: no engine connection retained this task's results; connecting them as inputs or paging them in full will fail.";
      else {
        try {
          await runtime.retainResults();
        } catch (error) {
          result.retention = `RETENTION_FAILED: ${error instanceof Error ? error.message : String(error)}. Connecting this task's results as inputs or paging them in full will fail.`;
        }
      }
    }
    if (settings.stateLedger) {
      // The answer is recorded in the step; the receipt carries the task's
      // ledger instead of echoing the answer a second time.
      const text = taskLedger(
        ledgerContext,
        state.getWorkflowContent(),
        current,
        runtime.taskNumber ?? (runtime.historicalTasks?.length ?? 0) + 1 + (runtime.taskNumberOffset ?? 0)
      );
      return { status: "ok", output: composed ? { composed: true, ...composed, text } : { recorded: true, text } };
    }
    return {
      status: "ok",
      output: composed ? { composed: true, ...composed } : "content" in action ? action.content : "",
    };
  });
  assertCurrent();
  // A later edit/execute in this batch may supersede a retrieved version.
  // Its text remains in the action receipt, but must not expose today's table.
  for (const item of result.actions) {
    if (item.action.type !== "retrieve" || item.status !== "ok") continue;
    const fork = forkReads.get(item.index);
    if (
      fork &&
      (current(fork.operatorId) ||
        readForkResult(state.getWorkflowContent(), storage, fork.operatorId, stepId)?.info !== fork.info)
    )
      (item.output as Record<string, unknown>).superseded_in_call = true;
    if (savedReads.has(item.index)) continue;
    if (current(item.action.operator_id) !== retrieved.get(item.index)?.info) {
      (item.output as Record<string, unknown>).superseded_in_call = true;
    }
  }
  for (const read of currentReads.values()) {
    if (current(read.operatorId) !== read.info) {
      const item = result.actions.find(item => item.index === read.actionIndex);
      if (item?.output) (item.output as Record<string,unknown>).superseded_in_call = true;
    }
  }
  const captures = [...retrieved.values(), ...currentReads.values()].filter(({operatorId,info}) => current(operatorId) === info);
  result.observe = [
    ...new Set(
      captures
        .map(({ operatorId }) => operatorId)
    ),
  ];
  storage.captureNativeObservations(
    stepId,
    result.observe,
    options,
    new Map(
      captures
        .map(({ operatorId, observation }) => [operatorId, observation])
    )
  );
}
