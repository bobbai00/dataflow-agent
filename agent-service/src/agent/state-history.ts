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
import type { WorkflowContent } from "../types/workflow";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { compileNativeOp, nativeRevision } from "./native/codegen";
import { NATIVE_BY_TYPE, nativeAssignmentText, nativeOperatorName, type NativeOpView } from "./native/catalog";
import { executionFingerprints, workflowExecutionPlan } from "./native/result-versions";
import { edgeEnds, inspectGraph, missingGraphInputs, type GraphEditPlan } from "./tools/graph-edits";

/** Addresses the existing snapshot tree; no separate task catalog is stored. */
export interface HistoricalTask {
  taskId: number;
  stepId: string;
  request: string;
  answer: string;
}

export interface StateQuery {
  task_id: number | null;
  operator_id: string | string[];
  include_implementation: boolean;
}

export interface StateVersion {
  task_id: number;
  through_task_id?: number;
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
    expression: op.nativeOp ? nativeAssignmentText(op.operatorID, op.nativeOp) : undefined,
    revision: op.nativeOp?.revision,
    subgraph_hash: hashes?.get(op.operatorID)?.subgraphHash,
    inputs: op.nativeOp?.inputs,
    ports: node?.ports,
    connections: graph.edges.filter(edge => Object.values(edgeEnds(edge)).includes(op.operatorID)),
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

/** A task's answer branch, read from one immutable snapshot. Every ancestor
 * appears once, before its consumers; unrelated branches are never included. */
export function inspectSubgraph(
  storage: WorkflowSnapshotStorage,
  task: HistoricalTask,
  roots: readonly string[],
  includeImplementation: boolean
) {
  if (!roots.length || roots.some(id => !id.trim()) || new Set(roots).size !== roots.length)
    throw new Error("Inspect requires unique, nonempty subgraph roots.");
  const workflow = storage.getWorkflow(task.stepId);
  const byId = new Map(workflow.operators.map(op => [op.operatorID, op]));
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("Cannot inspect a cyclic saved subgraph.");
    const op = byId.get(id);
    if (!op) throw new Error(`Operator ${id} did not exist at task ${task.taskId}'s saved snapshot.`);
    visiting.add(id);
    for (const link of workflow.links.filter(link => link.target.operatorID === id)) visit(link.source.operatorID);
    if (op.nativeOp?.inputs.some(input => !input || !visited.has(input)))
      throw new Error(`Saved input bindings of ${id} are incomplete.`);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }
  for (const root of roots) visit(root);
  const selected = {
    ...workflow,
    operators: ordered.map(id => byId.get(id)!),
    links: workflow.links.filter(link => visited.has(link.source.operatorID) && visited.has(link.target.operatorID)),
  };
  const graph = inspectGraph(selected);
  if (graph.unconnected_inputs.length)
    throw new Error(`Saved input bindings are incomplete: ${graph.unconnected_inputs.join(", ")}.`);
  const hashes = fingerprints(selected);
  return {
    task_id: task.taskId,
    step_id: task.stepId,
    roots: [...roots],
    operators: ordered.map(id =>
      describeStateOperator(storage, task, selected, id, includeImplementation, graph, hashes)
    ),
    edges: graph.edges,
  };
}

export interface TaskInputReference {
  task_id: number;
  step_id: string;
  operator_id: string;
  type?: string;
  revision?: string;
  subgraph_hash?: string;
  result: NonNullable<StateVersion["result"]>;
  scope?: string[];
}

/** Collapse unchanged earlier computations at their saved input boundaries.
 * Compare whole incoming graphs and result identities, not just definitions:
 * changing an ancestor makes its unchanged consumers part of this task too. */
export function inspectTaskSubgraph(
  storage: WorkflowSnapshotStorage,
  task: HistoricalTask,
  tasks: readonly HistoricalTask[],
  roots: readonly string[],
  includeImplementation: boolean,
  requestingTaskId = task.taskId
) {
  const full = inspectSubgraph(storage, task, roots, includeImplementation);
  // A declared answer can read an older result directly, including through
  // a fork. Its saved computation is an input to the answering task.
  if (task.taskId < requestingTaskId) {
    return {
      ...full,
      task_id: requestingTaskId,
      representation: "task_local" as const,
      operators: [],
      edges: [],
      boundary_inputs: roots.map(operatorId => {
        const node = full.operators.find(op => op.operator_id === operatorId)!;
        return {
          task_id: task.taskId,
          step_id: task.stepId,
          operator_id: operatorId,
          type: node.type,
          revision: node.revision,
          subgraph_hash: node.subgraph_hash,
          result: node.result ?? { available: false, state: "unavailable" },
        } satisfies TaskInputReference;
      }),
      upstream_operator_count: full.operators.length,
    };
  }
  const workflow = storage.getWorkflow(task.stepId);
  const inputs = new Map<string, string[]>();
  for (const link of workflow.links) {
    const id = link.target.operatorID;
    inputs.set(id, [...(inputs.get(id) ?? []), link.source.operatorID]);
  }
  const byId = new Map(full.operators.map(op => [op.operator_id, op]));
  const earlier = tasks
    .filter(previous => previous.taskId < task.taskId)
    .sort((a, b) => a.taskId - b.taskId)
    .map(previous => {
      const workflow = storage.getWorkflow(previous.stepId);
      return { task: previous, hashes: fingerprints(workflow) };
    });
  const local = new Set<string>();
  const boundary = new Map<string, TaskInputReference>();
  function visit(id: string) {
    if (local.has(id) || boundary.has(id)) return;
    const node = byId.get(id)!;
    const current = storage.getOperatorResult(task.stepId, id);
    // Restoring a once-used rule still changes this task relative to its
    // immediate predecessor; do not collapse that edit into an older task.
    const unchanged = earlier.at(-1)?.hashes.get(id)?.subgraphHash === node.subgraph_hash;
    const owner =
      unchanged &&
      earlier.find(previous => {
        const hash = previous.hashes.get(id)?.subgraphHash;
        if (!hash || hash !== node.subgraph_hash) return false;
        const saved = storage.getOperatorResult(previous.task.stepId, id);
        return (
          completed(current) === completed(saved) &&
          (current?.resultVersion?.id ?? null) === (saved?.resultVersion?.id ?? null)
        );
      });
    if (owner) {
      const saved = storage.getResolvedOperatorResult(owner.task.stepId, id);
      boundary.set(id, {
        task_id: owner.task.taskId,
        step_id: owner.task.stepId,
        operator_id: id,
        type: node.type,
        revision: node.revision,
        subgraph_hash: node.subgraph_hash,
        result: {
          available: completed(saved?.value),
          state: saved?.value.state ?? "unavailable",
          rows: saved?.value.totalRowCount,
          result_version: saved?.value.resultVersion?.id,
          producing_step: saved?.sourceStepId,
        },
      });
      return;
    }
    for (const input of inputs.get(id) ?? []) visit(input);
    local.add(id);
  }
  for (const root of roots) visit(root);
  return {
    ...full,
    representation: "task_local" as const,
    operators: full.operators.filter(op => local.has(op.operator_id)),
    edges: full.edges.filter(edge => local.has(edgeEnds(edge).target)),
    boundary_inputs: [...boundary.values()],
    upstream_operator_count: full.operators.length,
  };
}

export function historicalTask(tasks: readonly HistoricalTask[], taskId: number): HistoricalTask {
  const task = tasks.find(t => t.taskId === taskId);
  if (!task)
    throw new Error(
      `Task ${taskId} has no completed historical state. Use a completed task number from the conversation.`
    );
  return task;
}

/** Reads always resolve against the requested completed task, never HEAD. */
type OperatorHistory = { operator_id: string; versions: StateVersion[] };
export function inspectState(
  storage: WorkflowSnapshotStorage,
  tasks: readonly HistoricalTask[],
  query: StateQuery & { operator_id: string }
): OperatorHistory;
export function inspectState(
  storage: WorkflowSnapshotStorage,
  tasks: readonly HistoricalTask[],
  query: StateQuery & { operator_id: string[] }
): { operators: OperatorHistory[] };
export function inspectState(
  storage: WorkflowSnapshotStorage,
  tasks: readonly HistoricalTask[],
  query: StateQuery
): OperatorHistory | { operators: OperatorHistory[] };
export function inspectState(storage: WorkflowSnapshotStorage, tasks: readonly HistoricalTask[], query: StateQuery) {
  const ids = Array.isArray(query.operator_id) ? query.operator_id : [query.operator_id];
  if (
    !ids.length ||
    ids.length > 8 ||
    ids.some(id => typeof id !== "string" || !id.trim()) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Inspect requires one to eight unique operator IDs.");
  const selected = query.task_id === null ? tasks : [historicalTask(tasks, query.task_id)];
  // Compute each task's graph proof once when inspecting several operators.
  const snapshots = selected.map(task => {
    const workflow = storage.getWorkflow(task.stepId);
    return { task, workflow, graph: inspectGraph(workflow), hashes: fingerprints(workflow) };
  });
  const operators = ids.map(operatorId => {
    let seen = false;
    let previousKey: string | undefined;
    const versions: StateVersion[] = [];
    for (const { task, workflow, graph, hashes } of snapshots) {
      const op = workflow.operators.find(o => o.operatorID === operatorId);
      if (!op && query.task_id !== null)
        throw new Error(
          `Operator ${operatorId} did not exist at task ${task.taskId}. Use an operator ID from the conversation or inspect the current graph.`
        );
      if (!op && !seen) continue;
      const version: StateVersion = op
        ? {
            ...describeStateOperator(storage, task, workflow, operatorId, query.include_implementation, graph, hashes),
            input_definitions: [
              ...new Set(
                workflow.links.filter(link => link.target.operatorID === operatorId).map(link => link.source.operatorID)
              ),
            ].map(id =>
              describeStateOperator(storage, task, workflow, id, query.include_implementation, graph, hashes)
            ),
          }
        : { task_id: task.taskId, operator_id: operatorId, deleted: true };
      seen ||= !!op;
      // Outgoing edges, task IDs and a cache hit (same result, other engine
      // state) do not change this operator's computation. A changed ancestor
      // or result availability does change its version.
      const key = JSON.stringify([
        version.deleted,
        version.revision,
        version.subgraph_hash,
        version.result?.available,
        version.result?.rows,
        version.result?.result_version,
      ]);
      if (query.task_id === null && previousKey === key) versions.at(-1)!.through_task_id = task.taskId;
      else {
        versions.push(version);
        previousKey = key;
      }
    }
    if (!seen)
      throw new Error(
        `No completed task contains operator ${operatorId}. Use an operator ID from the conversation or inspect the current graph.`
      );
    return { operator_id: operatorId, versions };
  });
  return Array.isArray(query.operator_id) ? { operators } : operators[0];
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
      customDisplayName: `${mapping[id]}: ${view.source ?? view.registeredName ?? nativeOperatorName(view.type)}`,
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
      op: op.nativeOp.registeredName ?? nativeOperatorName(op.nativeOp.type),
      status: "added",
      message: `forked from task ${taskId}`,
    })),
    changes: copies.map(op => ({
      change: "operator" as const,
      operator_id: op.operatorID,
      operator: op.nativeOp.registeredName ?? nativeOperatorName(op.nativeOp.type),
      action: "created" as const,
    })),
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
