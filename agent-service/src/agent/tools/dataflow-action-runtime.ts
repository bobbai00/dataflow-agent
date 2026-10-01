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
import { WorkflowState } from "../workflow-state";
import type { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { selectNativeObservation } from "../native/evidence";
import { nativeCheckLines } from "../native/checks";
import { planGraphEdit, inspectGraph, missingGraphInputs } from "./graph-edits";
import { runDataflowActions, type DataflowActionsResult } from "./dataflow-actions";
import { formatOperatorResult } from "./result-formatting";
import type { ToolContext } from "./workflow-crud-tools";
import { inspectState, forkState, historicalTask, readForkResult, type HistoricalTask } from "../state-history";

export interface DataflowActionRuntime {
  state: WorkflowState;
  storage: WorkflowSnapshotStorage;
  stepId: string;
  settings: AgentSettings;
  context: ToolContext;
  execute: () => Promise<void>;
  edited: (ids: string[]) => void;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  historicalTasks?: readonly HistoricalTask[];
}

/** Resolve actions against one owned snapshot. Edits advance its graph;
 * execute fills its results; retrieval freezes text at the point it was read. */
export async function executeDataflowActionBatch(
  result: DataflowActionsResult,
  runtime: DataflowActionRuntime
): Promise<void> {
  const { state, storage, stepId, context, signal } = runtime;
  const settings = { ...runtime.settings };
  const options = {
    data: settings.dataEvidence,
    flow: settings.flowEvidence,
    maxChars: settings.maxOperatorResultCharLimit,
    maxRows: settings.maxResultRows,
  };
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (!runtime.isCurrent()) throw new DOMException("The active workflow changed during this action.", "AbortError");
  };
  const retrieved = new Map<number, { operatorId: string; info: OperatorInfo }>();
  const savedReads = new Set<number>();
  const forkReads = new Map<number, { operatorId: string; info: OperatorInfo }>();
  const current = (id: string) => storage.getOperatorResult(stepId, id);
  const errorText = (id: string, info: OperatorInfo) =>
    formatOperatorResult(id, info, state, {
      nativeEvidence: { ...options, workflow: state.getWorkflowContent(), resolveInput: current },
    });

  await runDataflowActions(result, async (action, index) => {
    assertCurrent();
    if (action.type === "inspect") {
      if (action.target === "graph") return { status: "ok", output: inspectGraph(state.getWorkflowContent()) };
      if (action.target === "state") {
        if (!settings.stateHistory) throw new Error("Historical state tools are disabled.");
        return { status: "ok", output: inspectState(storage, runtime.historicalTasks ?? [], action) };
      }
      const op = state.getOperator(action.operator_id);
      if (!op) throw new Error(`Operator ${action.operator_id} does not exist.`);
      const view = op.nativeOp;
      return {
        status: "ok",
        output: {
          id: op.operatorID,
          type: view?.type ?? op.operatorType,
          revision: view?.revision,
          expression: view?.source,
          ports: inspectGraph(state.getWorkflowContent()).operators.find(item => item.id === op.operatorID)?.ports,
          connections: inspectGraph(state.getWorkflowContent()).edges.filter(
            edge => edge.startsWith(`${op.operatorID}.`) || edge.includes(` -> ${op.operatorID}.`)
          ),
          description: view?.properties.doc,
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
      const plan = await planGraphEdit(state.getWorkflowContent(), action.changes, context);
      assertCurrent();
      state.setWorkflowContent(plan.workflow);
      storage.updatePendingWorkflow(stepId, plan.workflow);
      const accepted = plan.operators.map(op => op.id);
      storage.clearNativeRejectedEdits(stepId, accepted);
      runtime.edited(accepted.filter(id => !!state.getOperator(id)));
      result.operators.push(...plan.operators);
      const { workflow: _workflow, ...output } = plan;
      return { status: "ok", output };
    }
    if (action.type === "execute") {
      const operators = state.getAllOperators();
      if (!operators.length) throw new Error("The dataflow is empty. Add an operator before execute.");
      const missing = missingGraphInputs(state.getWorkflowContent());
      if (missing.length)
        throw new Error(
          `Unconnected required inputs: ${missing.join(", ")}. Create edges or delete unused operators before execute.`
        );
      let failure: string | undefined;
      try {
        await runtime.execute();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      assertCurrent();
      storage.restoreNativeRejectedEdits(stepId);
      const outcomes = operators.map(op => {
        const info = current(op.operatorID);
        if (!info || !["Completed", "CompletedFromCache"].includes(info.state) || info.error)
          return {
            id: op.operatorID,
            status: "error",
            message: info?.error ? errorText(op.operatorID, info) : "No completed result was returned by the engine.",
          };
        return {
          id: op.operatorID,
          status: "ok",
          rows: info.totalRowCount ?? info.outputTuples,
          ...(settings.nativeChecks ? { checks: nativeCheckLines(op, info) } : {}),
        };
      });
      return {
        status: failure || outcomes.some(o => o.status === "error") ? "error" : "ok",
        output: { operators: outcomes, ...(failure ? { error: failure } : {}) },
      };
    }
    if (action.type === "retrieve") {
      let workflow = state.getWorkflowContent();
      let resultStep = stepId;
      let operatorId = action.operator_id;
      let historical: { task_id: number; operator_id: string } | undefined;
      if (action.task_id !== undefined) {
        if (!settings.stateHistory) throw new Error("Historical state tools are disabled.");
        const task = historicalTask(runtime.historicalTasks ?? [], action.task_id);
        resultStep = task.stepId;
        workflow = storage.getWorkflow(resultStep);
        historical = { task_id: task.taskId, operator_id: operatorId };
        savedReads.add(index);
      } else if (!current(operatorId)) {
        const saved = readForkResult(workflow, storage, operatorId, stepId);
        if (saved) {
          historical = { task_id: saved.taskId, operator_id: saved.operatorId };
          forkReads.set(index, { operatorId, info: saved.info });
          workflow = saved.workflow;
          resultStep = saved.stepId;
          operatorId = saved.operatorId;
          savedReads.add(index);
        }
      }
      const op = workflow.operators.find(op => op.operatorID === operatorId);
      if (!op) throw new Error(`Operator ${action.operator_id} does not exist.`);
      const info = storage.getOperatorResult(resultStep, operatorId);
      if (!info)
        throw new Error(
          historical
            ? `No saved result for ${operatorId} at task ${historical.task_id}. Fork its definition and execute if recomputation is appropriate.`
            : `No current result for ${action.operator_id}. Use execute after creating or editing its dataflow.`
        );
      if (info.error)
        throw new Error(historical ? `Saved execution failed: ${info.error}` : errorText(action.operator_id, info));
      if (!["Completed", "CompletedFromCache"].includes(info.state))
        throw new Error(`Result for ${action.operator_id} is ${info.state}; use execute to obtain a completed result.`);
      const observation = selectNativeObservation({
        ...options,
        op,
        info,
        workflow,
        resolveInput: id => storage.getOperatorResult(resultStep, id),
      });
      if (!historical) retrieved.set(index, { operatorId: action.operator_id, info });
      return {
        status: "ok",
        output: {
          operator_id: action.operator_id,
          revision: op.nativeOp?.revision,
          result_version: info.resultVersion?.id,
          ...(historical ? { historical_state: historical } : {}),
          text: observation.text,
        },
      };
    }
    return { status: "ok", output: action.content };
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
  storage.captureNativeObservations(stepId, result.observe, options);
}
