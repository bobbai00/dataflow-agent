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

import type { OperatorInfo } from "../types/execution";
import type { ReActStep } from "../types/agent";
import type { WorkflowContent } from "../types/workflow";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { compileNativeOp, nativeRevision } from "./native/codegen";
import { NATIVE_BY_TYPE, nativeOperatorName, type NativeOpView } from "./native/catalog";
import { executionFingerprints, workflowExecutionPlan } from "./native/result-versions";
import { inspectGraph, missingGraphInputs, type GraphEditPlan } from "./tools/graph-edits";
import { asDataflowActionsResult } from "./tools/dataflow-actions";

/** Addresses the existing snapshot tree; no separate task catalog is stored. */
export interface HistoricalTask {
  taskId: number;
  stepId: string;
  request: string;
  answer: string;
  /** Existing receipts, used only when a task overview is explicitly requested. */
  steps?: readonly Pick<ReActStep, "id" | "toolResults">[];
}

export interface StateQuery {
  task_id: number | null;
  operator_id: string | null;
  include_implementation: boolean;
}

interface StateVersion {
  task_id: number;
  operator_id: string;
  deleted?: boolean;
  expression?: string;
  type?: string;
  description?: unknown;
  revision?: string;
  subgraph_hash?: string;
  inputs?: string[];
  ports?: { inputs: string[]; outputs: string[] };
  connections?: string[];
  result?: { available: boolean; state: string; rows?: number; result_version?: string; producing_step?: string };
  implementation?: unknown;
  input_definitions?: StateVersion[];
}

/** Successful actions describe activity, not proof that a read caused an answer.
 * Keep each read's original identity: its version may differ from task-end state. */
function taskActivity(task: HistoricalTask) {
  let hasReceipts = false;
  const changed = new Set<string>();
  const localReads = new Set<string>();
  const retrieved: Record<string, unknown>[] = [];
  for (const step of task.steps ?? []) {
    for (const receipt of step.toolResults ?? []) {
      const result = asDataflowActionsResult(receipt.output);
      if (!result) continue;
      hasReceipts = true;
      for (const item of result.actions) {
        if (item.status !== "ok" || !item.output || typeof item.output !== "object") continue;
        const output = item.output as Record<string, any>;
        if (item.action.type === "edit" || item.action.type === "fork") {
          for (const op of output.operators ?? []) if (typeof op.id === "string") changed.add(op.id);
        }
        if (item.action.type === "retrieve" && typeof output.operator_id === "string") {
          const read: Record<string, unknown> = { operator_id: output.operator_id, read_at_step: step.id };
          for (const key of ["historical_state", "revision", "result_version", "superseded_in_call"])
            if (output[key] !== undefined) read[key] = output[key];
          retrieved.push(read);
          if (!output.historical_state) localReads.add(output.operator_id);
        }
      }
    }
  }
  return { hasReceipts, changed, localReads, retrieved };
}

function describeStateOperator(
  storage: WorkflowSnapshotStorage,
  task: HistoricalTask,
  workflow: WorkflowContent,
  operatorId: string,
  includeImplementation: boolean,
  graph: ReturnType<typeof inspectGraph>,
  hashes?: ReturnType<typeof fingerprints>
): StateVersion {
  const op = workflow.operators.find(o => o.operatorID === operatorId)!;
  const info = storage.getResolvedOperatorResult(task.stepId, op.operatorID);
  const node = graph.operators.find(o => o.id === op.operatorID);
  const functions = op.nativeOp?.functions ?? {};
  const callback = op.nativeOp?.properties.func ?? op.nativeOp?.properties.code ?? null;
  return {
    task_id: task.taskId,
    operator_id: op.operatorID,
    type: node?.type,
    description: op.nativeOp?.properties.doc,
    expression: op.nativeOp?.source,
    revision: op.nativeOp?.revision,
    subgraph_hash: hashes?.get(op.operatorID)?.subgraphHash,
    inputs: op.nativeOp?.inputs,
    ports: node?.ports,
    connections: graph.edges.filter(
      edge => edge.startsWith(`${op.operatorID}.`) || edge.includes(` -> ${op.operatorID}.`)
    ),
    result: {
      available: completed(info?.value),
      state: info?.value.state ?? "unavailable",
      rows: info?.value.totalRowCount,
      result_version: info?.value.resultVersion?.id,
      producing_step: info?.sourceStepId,
    },
    ...(includeImplementation
      ? {
          implementation: op.nativeOp
            ? {
                functions,
                ...(Object.values(functions).includes(callback as string) ? {} : { callback }),
              }
            : { code: op.operatorProperties.code ?? null },
        }
      : {}),
  };
}

const fingerprints = (workflow: WorkflowContent) => executionFingerprints(workflowExecutionPlan(workflow));
const completed = (info: OperatorInfo | undefined) =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state) && Array.isArray(info.result);

export function historicalTask(tasks: readonly HistoricalTask[], taskId: number): HistoricalTask {
  const task = tasks.find(t => t.taskId === taskId);
  if (!task)
    throw new Error(
      `Task ${taskId} has no completed historical state. Inspect state with null task_id and operator_id to list completed tasks.`
    );
  return task;
}

/** Reads always resolve against the requested completed task, never HEAD. */
export function inspectState(storage: WorkflowSnapshotStorage, tasks: readonly HistoricalTask[], query: StateQuery) {
  if (query.task_id === null && query.operator_id === null)
    return { tasks: tasks.map(t => ({ task_id: t.taskId, request: t.request, answer: t.answer })) };
  const selected = query.task_id === null ? tasks : [historicalTask(tasks, query.task_id)];
  if (query.operator_id === null) {
    const task = selected[0];
    const workflow = storage.getWorkflow(task.stepId);
    const graph = inspectGraph(workflow);
    const activity = taskActivity(task);
    const relevant = new Set([...activity.changed, ...activity.localReads]);
    const nodes = graph.operators.filter(op => !activity.hasReceipts || relevant.has(op.id));
    return {
      task_id: task.taskId,
      request: task.request,
      answer: task.answer,
      scope: activity.hasReceipts ? "task_activity" : "whole_graph_no_action_receipts",
      note: "Definitions and row counts are at task completion. Retrieved records below identify earlier reads, not answer dependencies. Inspect a specific operator for its expression and immediate input definitions; follow input IDs to explore further.",
      total_operator_count: graph.operators.length,
      omitted_operator_count: graph.operators.length - nodes.length,
      changed_operators: [...activity.changed],
      retrieved: activity.retrieved,
      operators: nodes.map(node => {
        const detail = describeStateOperator(storage, task, workflow, node.id, query.include_implementation, graph);
        return {
          id: node.id,
          type: node.type,
          description: detail.description,
          inputs: detail.inputs,
          result: { available: detail.result!.available, state: detail.result!.state, rows: detail.result!.rows },
          ...(query.include_implementation
            ? { expression: detail.expression, implementation: detail.implementation }
            : {}),
        };
      }),
      edges: graph.edges.filter(edge => nodes.some(node => edge.includes(` -> ${node.id}.`))),
      unconnected_inputs: graph.unconnected_inputs.filter(port => nodes.some(node => port.startsWith(`${node.id}.`))),
    };
  }
  let seen = false;
  const operatorId = query.operator_id;
  const versions = selected.flatMap<StateVersion>(task => {
    const workflow = storage.getWorkflow(task.stepId);
    const op = workflow.operators.find(o => o.operatorID === query.operator_id);
    if (!op) {
      if (query.task_id !== null)
        throw new Error(
          `Operator ${query.operator_id} did not exist at task ${task.taskId}. Inspect that task's graph to find its operators.`
        );
      return seen ? [{ task_id: task.taskId, operator_id: operatorId, deleted: true }] : [];
    }
    seen = true;
    const graph = inspectGraph(workflow);
    const hashes = fingerprints(workflow);
    const inputs = new Set(
      workflow.links.filter(link => link.target.operatorID === operatorId).map(link => link.source.operatorID)
    );
    return [
      {
        ...describeStateOperator(storage, task, workflow, operatorId, query.include_implementation, graph, hashes),
        input_definitions: [...inputs].map(id =>
          describeStateOperator(storage, task, workflow, id, query.include_implementation, graph, hashes)
        ),
      },
    ];
  });
  if (!seen) throw new Error(`No completed task contains operator ${query.operator_id}. Inspect a task's graph first.`);
  return { operator_id: query.operator_id, versions };
}

/** Clone definitions and incoming edges as one atomic plan. Every dependency
 * gets a new ID: no historical node accidentally binds a mutable live parent.
 * Saved result observations retain their original identities and are read via
 * stateOrigin. Execution of the clone produces new, normally validated results. */
export function forkState(
  current: WorkflowContent,
  storage: WorkflowSnapshotStorage,
  tasks: readonly HistoricalTask[],
  taskId: number,
  operatorId: string,
  newId: string
): GraphEditPlan & { mapping: Record<string, string>; task_id: number; saved_result_available: boolean } {
  if (!/^[A-Za-z_]\w*$/.test(newId)) throw new Error("The new operator ID must be a Python identifier.");
  const task = historicalTask(tasks, taskId);
  const historical = storage.getWorkflow(task.stepId);
  const byId = new Map(historical.operators.map(o => [o.operatorID, o]));
  const historicalProofs = fingerprints(historical);
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("Cannot fork a cyclic historical graph.");
    const op = byId.get(id);
    if (!op) throw new Error(`Operator ${id} did not exist at task ${taskId}.`);
    if (!op.nativeOp || !NATIVE_BY_TYPE.has(op.nativeOp.type) || op.isDisabled)
      throw new Error(`Operator ${id} is not an enabled native operator and cannot be forked.`);
    if (!historicalProofs.has(id)) throw new Error(`Historical dependencies of ${id} are incomplete.`);
    visiting.add(id);
    for (const link of historical.links.filter(l => l.target.operatorID === id)) visit(link.source.operatorID);
    if (op.nativeOp.inputs.some(input => !input || !visited.has(input)))
      throw new Error(`Historical input bindings of ${id} are incomplete.`);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }
  visit(operatorId);
  const mapping = Object.fromEntries(ordered.map(id => [id, id === operatorId ? newId : `${newId}__${id}`]));
  const existing = new Set(current.operators.map(o => o.operatorID));
  for (const id of Object.values(mapping)) {
    if (existing.has(id)) throw new Error(`Operator ${id} already exists. Choose an unused new_operator_id.`);
    existing.add(id);
  }
  const copies = ordered.map(id => {
    const original = byId.get(id)!;
    const view = structuredClone(original.nativeOp!) as NativeOpView;
    view.inputs = view.inputs.map(input => mapping[input]);
    view.revision = nativeRevision(view);
    const compiled = compileNativeOp(view, mapping[id]);
    const { stateOrigin: _previousOrigin, ...template } = structuredClone(original);
    return {
      ...template,
      operatorID: mapping[id],
      operatorType: compiled.operatorType,
      nativeOp: view,
      customDisplayName: `${mapping[id]}: ${view.source ?? nativeOperatorName(view.type)}`,
      operatorProperties: { ...template.operatorProperties, code: compiled.code },
    };
  });
  const links = historical.links
    .filter(link => visited.has(link.target.operatorID))
    .map(link => ({
      linkID: `${mapping[link.source.operatorID]}.${link.source.portID}->${mapping[link.target.operatorID]}.${link.target.portID}`,
      source: { ...link.source, operatorID: mapping[link.source.operatorID] },
      target: { ...link.target, operatorID: mapping[link.target.operatorID] },
    }));
  let workflow: WorkflowContent = {
    ...structuredClone(current),
    operators: [...current.operators, ...copies],
    links: [...current.links, ...links],
    operatorPositions: {
      ...current.operatorPositions,
      ...Object.fromEntries(ordered.map((id, i) => [mapping[id], { x: 350, y: 100 + i * 100 }])),
    },
  };
  const proofs = fingerprints(workflow);
  workflow = {
    ...workflow,
    operators: workflow.operators.map(op => {
      const oldId = ordered.find(id => mapping[id] === op.operatorID);
      if (!oldId) return op;
      const hash = proofs.get(op.operatorID)?.subgraphHash;
      if (!hash) throw new Error(`Cannot bind the forked dependencies of ${oldId}.`);
      return { ...op, stateOrigin: { taskId, stepId: task.stepId, operatorId: oldId, subgraphHash: hash } };
    }),
  };
  return {
    workflow,
    task_id: taskId,
    mapping,
    saved_result_available: completed(storage.getOperatorResult(task.stepId, operatorId)),
    operators: copies.map(op => ({
      id: op.operatorID,
      op: nativeOperatorName(op.nativeOp.type),
      status: "added",
      message: `forked from task ${taskId}`,
    })),
    changes: copies.map(op => ({ operation: "fork_operator", operator_id: op.operatorID })),
    unconnected_inputs: missingGraphInputs(workflow),
    invalidated_results: [],
  };
}

/** A saved observation is valid only while the entire copied subgraph still
 * matches the fork. Never relabel its engine execution or result-version ID. */
export function readForkResult(
  workflow: WorkflowContent,
  storage: WorkflowSnapshotStorage,
  operatorId: string,
  currentStepId?: string
) {
  const origin = workflow.operators.find(op => op.operatorID === operatorId)?.stateOrigin;
  if (!origin || fingerprints(workflow).get(operatorId)?.subgraphHash !== origin.subgraphHash) return undefined;
  // Once a copied input has been executed, a missing descendant is not proof
  // that its saved observation still describes those new materializations.
  if (currentStepId) {
    const pending = [operatorId];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (storage.getOperatorResult(currentStepId, id)) return undefined;
      for (const link of workflow.links.filter(l => l.target.operatorID === id)) pending.push(link.source.operatorID);
    }
  }
  const info = storage.getOperatorResult(origin.stepId, origin.operatorId);
  if (!completed(info)) return undefined;
  return { ...origin, info: info!, workflow: storage.getWorkflow(origin.stepId) };
}
