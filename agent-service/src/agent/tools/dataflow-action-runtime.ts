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

import type { AgentSettings } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import type { WorkflowContent } from "../../types/workflow";
import { WorkflowState } from "../workflow-state";
import type { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { selectNativeObservation, type NativeObservation } from "../native/evidence";
import { flowObservationOptions, retrievalOptions } from "../native/retrieval";
import { observationFormat, describeOperator, topologicalOperators, type OperatorBlock, columnEntries } from "../native/observation-format";
import { loadedRevision, originTask } from "../state-ledger";
import { nativeAdjustmentLines, nativeCheckLines } from "../native/checks";
import { composeAnswerParts, parseAnswerFromParts, statedDecimals } from "../native/answer";
import { planGraphEdit, inspectGraph, missingGraphInputs } from "./graph-edits";
import { runDataflowActions, type DataflowActionsResult } from "./dataflow-actions";
import { formatOperatorResult } from "./result-formatting";
import type { ToolContext } from "./workflow-crud-tools";
import { inspectState, forkState, historicalTask, readForkResult, type HistoricalTask } from "../state-history";
import {
  executionNotes,
  provenanceLines,
  restoreCommands,
  splitVersionCommands,
  taskLedger,
  upstreamDrift,
} from "../state-ledger";

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
  const savedReads = new Set<number>();
  const forkReads = new Map<number, { operatorId: string; info: OperatorInfo }>();
  const current = (id: string) => storage.getOperatorResult(stepId, id);
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
      !origin && op.nativeOp?.revision !== undefined && loadedRevision(ledgerContext, op.operatorID) === op.nativeOp.revision;
    return describeOperator(op, info, {
      ...result.format,
      stale,
      ...(saved ? { savedBy: saved.taskId } : {}),
      ...(origin
        ? { origin: `task ${origin.taskId}` }
        : loaded
          ? { origin: "loaded" }
          : {}),
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
      if (action.target === "graph") {
        // The graph with what is known of every table: rows and columns of
        // completed results, so a listing is not followed by a schema read.
        const graph = inspectGraph(state.getWorkflowContent());
        return {
          status: "ok",
          output: {
            ...graph,
            operators: graph.operators.map(item => ({ ...item, ...resultSummary(current(item.id)) })),
            operator_blocks: topologicalOperators(state.getAllOperators()).map(op => block(op, { definition: false })),
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
                state: `saved by task ${task.taskId}`,
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
      const view = op.nativeOp;
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
      result.operators.push(...plan.operators);
      const { workflow: _workflow, ...output } = plan;
      return { status: "ok", output };
    }
    if (action.type === "edit") {
      // `update operator <id> from task <N>` expands into the saved
      // definition as an ordinary update (today's inputs stay); `fork operator
      // <id> from task <N> as <new_id>` adds a copied branch under the new ID.
      // The rest is the ordinary program.
      const before = state.getWorkflowContent();
      const { rest, versions } = splitVersionCommands(action.changes);
      const restoredIds = new Map<string, string>();
      const versionNotes: string[] = [];
      let program = rest;
      let working = state.getWorkflowContent();
      if (versions.length) {
        if (!settings.stateHistory)
          throw new Error("update operator … from task and fork operator need saved task versions (stateHistory).");
        const tasks = runtime.historicalTasks ?? [];
        const expanded: string[] = [];
        for (const command of versions) {
          const task = historicalTask(tasks, command.task);
          if (command.as) {
            const plan = forkState(working, storage, tasks, task.taskId, command.id, command.as);
            working = plan.workflow;
            for (const copied of plan.operators) restoredIds.set(copied.id, `forked from task ${task.taskId}`);
            result.operators.push(...plan.operators);
            const copiedInputs = Object.entries(plan.mapping)
              .filter(([from]) => from !== command.id)
              .map(([from, to]) => `${from} → ${to}`);
            versionNotes.push(
              `Forked ${command.id} from task ${task.taskId} as ${command.as}${copiedInputs.length ? ` with its task-${task.taskId} inputs (${copiedInputs.join(", ")})` : ""}; retrieve ${command.as} for the saved result, or execute it after changing it.`
            );
          } else {
            restoredIds.set(command.id, `restored from task ${task.taskId}`);
            const restored = restoreCommands(storage, task, working, command.id);
            expanded.push(restored.commands);
            const drift = restored.existed ? upstreamDrift(storage, task, working, command.id) : [];
            versionNotes.push(
              restored.existed
                ? `Restored ${command.id}'s task-${task.taskId} definition in place; its inputs are today's${drift.length ? ` (changed since task ${task.taskId}: ${drift.join(", ")})` : " (unchanged since then)"}. Dependents are invalidated; execute to recompute.`
                : `Re-created ${command.id} from its task-${task.taskId} definition${restored.restoredInputs.length ? ` with edges from ${restored.restoredInputs.join(", ")}` : ""}.`
            );
          }
        }
        program = [...expanded, rest].filter(text => text.trim()).join("\n");
        if (!program.trim()) {
          assertCurrent();
          state.setWorkflowContent(working);
          storage.updatePendingWorkflow(stepId, working);
          runtime.edited(result.operators.map(op => op.id).filter(id => !!state.getOperator(id)));
          return {
            status: "ok",
            output: {
              changes: [],
              applied: versions.length,
              unconnected_inputs: [],
              invalidated_results: [],
              version_notes: versionNotes,
              operator_blocks: topologicalOperators(working.operators)
                .filter(op => restoredIds.has(op.operatorID))
                .map(op => block(op, { state: restoredIds.get(op.operatorID), definitionLimit: true })),
            },
          };
        }
      }
      const plan = await planGraphEdit(working, program, context);
      assertCurrent();
      state.setWorkflowContent(plan.workflow);
      storage.updatePendingWorkflow(stepId, plan.workflow);
      const accepted = plan.operators.map(op => op.id);
      storage.clearNativeRejectedEdits(stepId, accepted);
      runtime.edited(accepted.filter(id => !!state.getOperator(id)));
      result.operators.push(...plan.operators);
      const { workflow: _workflow, ...output } = plan;
      const touched = new Set([...accepted, ...restoredIds.keys()]);
      const operatorBlocks: OperatorBlock[] = topologicalOperators(plan.workflow.operators)
        .filter(op => touched.has(op.operatorID))
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
      // A restore expands into an update (or a re-creation with its edges);
      // the receipt counts it once, as the restore.
      const restoredHere = (id?: string) => !!id && !!restoredIds.get(id)?.startsWith("restored from");
      const applied =
        plan.changes.filter(
          change => !restoredHere(change.operator_id) && !restoredHere(change.edge?.match(/-> ([^.]+)\./)?.[1])
        ).length + versions.length;
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
      const outcomes = operators.map(op => {
        const info = current(op.operatorID);
        if (!info || !["Completed", "CompletedFromCache"].includes(info.state) || info.error) {
          const failed = !!info?.error && (!info.nativeError || info.nativeError.diagnostic.operatorId === op.operatorID);
          const culprit = info?.nativeError?.diagnostic.operatorId;
          const reads = culprit && culprit !== op.operatorID ? ancestorsOf(workflow, op.operatorID).has(culprit) : false;
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
      return {
        status: failure || outcomes.some(o => o.status === "error") ? "error" : "ok",
        output: {
          operators: outcomes,
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
                        chunk.id.startsWith("flow.") && chunk.id !== "flow.contract" && chunk.id !== "flow.omitted" && !chunk.upstream
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
            return block(op, { state: outcome.state, definition: false, issues });
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
          const byId = new Map(workflow.operators.map(item => [item.operatorID, item]));
          copy = byId.get(operatorId);
          for (const pending = [operatorId]; pending.length; ) {
            const item = byId.get(pending.pop()!);
            if (item?.stateOrigin?.stepId !== saved.stepId || names.has(item.stateOrigin.operatorId)) continue;
            names.set(item.stateOrigin.operatorId, item.operatorID);
            pending.push(...(item.nativeOp?.inputs ?? []));
          }
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
        throw new Error(`RESULT_NOT_RUN: the result of \`${action.operator_id}\` is ${info.state}. Execute it, then retrieve.`);
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
    if ("from" in action) {
      const parsed = parseAnswerFromParts(action.from);
      if ("error" in parsed) throw new Error(parsed.error);
      for (const part of parsed.parts)
        if (!current(part.id) && !state.getOperator(part.id))
          throw new Error(`answer_from: no table \`${part.id}\`; write the final answer yourself.`);
      const outcome = composeAnswerParts(parsed.parts, current, {
        decimalRules: statedDecimals([...(runtime.requestTexts ?? [])]),
      });
      if ("reason" in outcome)
        throw new Error(
          `answer not composed: ${outcome.reason}. ${outcome.hint ?? "Write the final answer yourself."}`
        );
      composed = { answer_from: parsed.parts.map(part => part.id).join(", "), answer: outcome.json };
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
  result.observe = [
    ...new Set(
      [...retrieved.values()]
        .filter(({ operatorId, info }) => current(operatorId) === info)
        .map(({ operatorId }) => operatorId)
    ),
  ];
  storage.captureNativeObservations(
    stepId,
    result.observe,
    options,
    new Map(
      [...retrieved.values()]
        .filter(({ operatorId, info }) => current(operatorId) === info)
        .map(({ operatorId, observation }) => [operatorId, observation])
    )
  );
}
