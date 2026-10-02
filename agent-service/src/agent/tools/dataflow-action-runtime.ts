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
import { selectNativeObservation, type NativeObservation } from "../native/evidence";
import { retrievalOptions } from "../native/retrieval";
import { nativeCheckLines } from "../native/checks";
import { planGraphEdit, inspectGraph, missingGraphInputs } from "./graph-edits";
import { runDataflowActions, type DataflowActionsResult } from "./dataflow-actions";
import { formatOperatorResult } from "./result-formatting";
import type { ToolContext } from "./workflow-crud-tools";

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
  const retrieved = new Map<number, { operatorId: string; info: OperatorInfo; observation: NativeObservation }>();
  const current = (id: string) => storage.getOperatorResult(stepId, id);
  const errorText = (id: string, info: OperatorInfo) =>
    formatOperatorResult(id, info, state, {
      nativeEvidence: { ...options, workflow: state.getWorkflowContent(), resolveInput: current },
    });

  await runDataflowActions(result, async (action, index) => {
    assertCurrent();
    if (action.type === "inspect") {
      if (action.target === "graph") return { status: "ok", output: inspectGraph(state.getWorkflowContent()) };
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
      const op = state.getOperator(action.operator_id);
      if (!op) throw new Error(`Operator ${action.operator_id} does not exist.`);
      const info = current(action.operator_id);
      if (!info)
        throw new Error(
          `No current result for ${action.operator_id}. Use execute after creating or editing its dataflow.`
        );
      if (info.error) throw new Error(errorText(action.operator_id, info));
      if (!["Completed", "CompletedFromCache"].includes(info.state))
        throw new Error(`Result for ${action.operator_id} is ${info.state}; use execute to obtain a completed result.`);
      if (action.columns) {
        const names = new Set((info.resultSchema ?? []).map(c => c.name));
        const unknown = action.columns.filter(name => !names.has(name));
        if (unknown.length)
          throw new Error(
            `Unknown result columns: ${unknown.join(", ")}. Inspect the result schema before selecting columns.`
          );
      }
      const observation = selectNativeObservation({
        ...retrievalOptions(settings, action.view),
        columns: action.columns,
        op,
        info,
        workflow: state.getWorkflowContent(),
        resolveInput: current,
      });
      retrieved.set(index, { operatorId: action.operator_id, info, observation });
      return {
        status: "ok",
        output: {
          operator_id: action.operator_id,
          revision: op.nativeOp?.revision,
          result_version: info.resultVersion?.id,
          view: action.view,
          ...(action.columns
            ? {
                columns: action.columns,
                ...(action.view === "sample_stats"
                  ? {
                      unavailable_profiles: action.columns.filter(
                        name => !Object.hasOwn(info.tableProfile?.columns ?? {}, name)
                      ),
                    }
                  : {}),
              }
            : {}),
          table: observation.table,
          evidence: observation.selected.filter(id => id.startsWith("data.") || id.startsWith("flow.")),
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
