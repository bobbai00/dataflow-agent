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

import { isDeepStrictEqual } from "node:util";
import type { TaskHistory, TaskRecord } from "./task-history";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type { DataflowActionsResult } from "./tools/dataflow-actions";
import type { GraphChangeReceipt, GraphForkReceipt } from "./tools/graph-edits";
import {
  describeOperator,
  restrictRecords,
  topologicalOperators,
  type OperatorBlock,
} from "./native/observation-format";
import { nativeOperatorName } from "./native/catalog";
import { workflowFingerprints } from "./native/result-versions";
import { catalogResultSummary } from "./native/catalog-summary";
import { resultScope } from "./native/result-scope";
import { readForkResult } from "./state-history";
import { splitVersionCommands } from "./state-ledger";

export interface TaskFork extends GraphForkReceipt {
  collapsed_operator_ids: string[];
}

interface Edit {
  id: string;
  kind: string;
  state: string;
  created: boolean;
  modified: boolean;
  fork?: TaskFork;
}
const edgeTarget = (edge?: string) => edge?.match(/->\s*([A-Za-z_]\w*)\./)?.[1];

/** Read successful action receipts in execution order. This is a complete
 * definition/input delta, including work outside the final answer lineage.
 * Repeated IDs keep their first committed position and their final definition. */
export function collectTaskEdits(storage: WorkflowSnapshotStorage, task: TaskHistory) {
  const edits = new Map<string, Edit>();
  const forks: TaskFork[] = [];
  const deletions: OperatorBlock[] = [];
  for (const step of task.steps) {
    const snap = storage.hasSnapshotFor(step.id) ? storage.getAssociatedSnapshot(step.id) : undefined;
    const parent = snap?.parentId ? storage.getSnapshotById(snap.parentId)?.workflow : undefined;
    for (const tool of step.toolResults ?? []) {
      const receipt = tool.output as DataflowActionsResult | undefined;
      if (receipt?.kind !== "dataflow-actions") continue;
      for (const item of receipt.actions) {
        if (item.status !== "ok" || !["edit", "fork"].includes(item.action.type)) continue;
        const output = item.output as
          | {
              changes?: GraphChangeReceipt[];
              operators?: Array<{ id: string; op: string; status: string }>;
              operator_blocks?: OperatorBlock[];
              forks?: GraphForkReceipt[];
              mapping?: Record<string, string>;
            }
          | undefined;
        const blocks = new Map((output?.operator_blocks ?? []).map(block => [block.id, block]));
        const outcomes = new Map((output?.operators ?? []).map(op => [op.id, op]));
        const actionForks = [...(output?.forks ?? [])];
        // Older fork-in-edit receipts lack a mapping. Recover one only when
        // the root's saved proof still matches the entire copied DAG. The
        // original IDs come from stored origins, never from naming prefixes.
        if (item.action.type === "edit" && !output?.forks?.length && snap) {
          for (const command of splitVersionCommands(item.action.changes).versions) {
            if (!command.as || actionForks.some(fork => fork.new_operator_id === command.as)) continue;
            const root = snap.workflow.operators.find(op => op.operatorID === command.as);
            const origin = root?.stateOrigin;
            const proof = workflowFingerprints(snap.workflow).get(command.as);
            if (
              !origin ||
              origin.taskId !== command.task ||
              origin.operatorId !== command.id ||
              (!blocks.has(command.as) && !outcomes.has(command.as)) ||
              !proof ||
              proof.subgraphHash !== origin.subgraphHash
            )
              continue;
            const mapping: Record<string, string> = {};
            const seen = new Set<string>();
            const pending = [command.as];
            let valid = true;
            while (pending.length) {
              const id = pending.pop()!;
              if (seen.has(id)) continue;
              seen.add(id);
              const copy = snap.workflow.operators.find(op => op.operatorID === id);
              const source = copy?.stateOrigin;
              if (
                !source ||
                source.taskId !== origin.taskId ||
                source.stepId !== origin.stepId ||
                (mapping[source.operatorId] && mapping[source.operatorId] !== id)
              ) {
                valid = false;
                break;
              }
              mapping[source.operatorId] = id;
              pending.push(...(copy?.nativeOp?.inputs.filter(Boolean) ?? []));
            }
            if (valid)
              actionForks.push({
                task_id: origin.taskId,
                step_id: origin.stepId,
                operator_id: origin.operatorId,
                new_operator_id: command.as,
                mapping: Object.fromEntries(
                  topologicalOperators(snap.workflow.operators)
                    .filter(op => seen.has(op.operatorID))
                    .map(op => [op.stateOrigin!.operatorId, op.operatorID])
                ),
              });
          }
        }
        if (item.action.type === "fork" && output?.mapping) {
          const action = item.action;
          const origin = snap?.workflow.operators.find(op => op.operatorID === action.new_operator_id)?.stateOrigin;
          if (origin)
            actionForks.push({
              task_id: action.task_id,
              step_id: origin.stepId,
              operator_id: action.operator_id,
              new_operator_id: action.new_operator_id,
              mapping: output.mapping,
            });
        }
        const forkCopies = new Map<string, TaskFork>();
        for (const saved of actionForks) {
          const fork: TaskFork = { ...saved, mapping: { ...saved.mapping }, collapsed_operator_ids: [] };
          forks.push(fork);
          for (const id of Object.values(fork.mapping)) forkCopies.set(id, fork);
        }
        const changed = new Map<string, string>();
        const createdIds = new Set<string>();
        // Old version-in-edit execution applied forks ahead of ordinary
        // changes. New receipts include every fork at its command position.
        if (item.action.type === "edit" && output?.forks === undefined)
          for (const id of forkCopies.keys()) changed.set(id, "fork_operator");
        for (const change of output?.changes ?? []) {
          const id = change.operator_id ?? edgeTarget(change.edge);
          if (id && change.operation === "create_operator") createdIds.add(id);
          if (id && (!changed.has(id) || change.operation === "update_operator")) changed.set(id, change.operation);
          // Deleting a source also changes its surviving consumers' inputs.
          for (const edge of change.deleted_edges ?? []) {
            const target = edgeTarget(edge);
            if (target && target !== change.operator_id && !changed.has(target)) changed.set(target, "reconnect");
          }
          if (change.operation === "delete_operator" && id) {
            const old = parent?.operators.find(op => op.operatorID === id);
            deletions.push({
              id,
              kind:
                blocks.get(id)?.kind ??
                (old?.nativeOp ? nativeOperatorName(old.nativeOp.type) : (outcomes.get(id)?.op ?? "operator")),
              state: "deleted",
            });
          }
        }
        // Imported older receipts can lack ordered changes. Their explicit
        // blocks/outcomes are still committed facts, never model-written prose.
        for (const id of [...forkCopies.keys(), ...blocks.keys(), ...outcomes.keys()])
          if (!changed.has(id)) changed.set(id, "receipt");
        if (!changed.size && snap) {
          const old = new Map(parent?.operators.map(op => [op.operatorID, op]));
          for (const op of snap.workflow.operators)
            if (!isDeepStrictEqual(old.get(op.operatorID)?.nativeOp, op.nativeOp))
              changed.set(op.operatorID, old.has(op.operatorID) ? "update_operator" : "create_operator");
          for (const op of parent?.operators ?? [])
            if (!snap.workflow.operators.some(current => current.operatorID === op.operatorID)) {
              changed.set(op.operatorID, "delete_operator");
              deletions.push({
                id: op.operatorID,
                kind: op.nativeOp ? nativeOperatorName(op.nativeOp.type) : op.operatorType,
                state: "deleted",
              });
            }
        }
        for (const [id, operation] of changed) {
          const block = blocks.get(id);
          const outcome = outcomes.get(id);
          const previous = edits.get(id);
          const fork =
            forkCopies.get(id) ?? (createdIds.has(id) || operation === "create_operator" ? undefined : previous?.fork);
          const created =
            previous?.created ||
            createdIds.has(id) ||
            operation === "create_operator" ||
            block?.state === "created" ||
            outcome?.status === "added";
          const updated =
            operation === "update_operator" ||
            block?.state === "updated" ||
            block?.state === "reconnected" ||
            operation.includes("edge") ||
            operation === "reconnect";
          const state = fork
            ? `forked from task ${fork.task_id}`
            : created
              ? "created"
              : operation === "delete_operator"
                ? "deleted"
                : block?.state.startsWith("restored from task ")
                  ? block.state
                  : updated
                    ? previous?.state === "updated" || operation === "update_operator" || block?.state === "updated"
                      ? "updated"
                      : "reconnected"
                    : (block?.state ??
                      (item.action.type === "fork"
                        ? `forked from task ${item.action.task_id}`
                        : outcome?.status === "modified"
                          ? "updated"
                          : "updated"));
          edits.set(id, {
            id,
            kind: block?.kind ?? outcome?.op ?? previous?.kind ?? "operator",
            state,
            created: !!created,
            modified: !!previous?.modified || (!!previous?.fork && updated),
            fork,
          });
        }
      }
    }
  }
  return { edits, forks, deletions };
}

/** Reuse only observations earned in this task and bound to its final result.
 * Turning catalog rows on never creates a new sample or executes an operator. */
export function taskCatalogRecords(
  storage: WorkflowSnapshotStorage,
  task: TaskHistory,
  ids: Iterable<string>,
  maxRows: number
): Record<string, string> {
  const records: Record<string, string> = Object.create(null);
  if (maxRows <= 0) return records;
  const workflow = storage.getWorkflow(task.stepId);
  const byId = new Map(workflow.operators.map(op => [op.operatorID, op]));
  for (const id of ids) {
    const current = storage.getOperatorResult(task.stepId, id);
    const saved = current ? undefined : readForkResult(workflow, storage, id, task.stepId);
    const info = current ?? saved?.info;
    if (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)) continue;
    const version = info.resultVersion;
    const sourceWorkflow = saved?.workflow ?? workflow;
    const sourceId = saved?.operatorId ?? id;
    const op = saved ? sourceWorkflow.operators.find(op => op.operatorID === sourceId) : byId.get(id);
    if (
      !version?.complete ||
      version.operatorRevision !== op?.nativeOp?.revision ||
      version.subgraphHash !== workflowFingerprints(sourceWorkflow).get(sourceId)?.subgraphHash
    )
      continue;
    for (const step of [...task.steps].reverse()) {
      if (!storage.hasSnapshotFor(step.id)) continue;
      const observation = storage.getAssociatedSnapshot(step.id).nativeObservations?.[id];
      if (!observation?.records || observation.resultVersion !== version.id) continue;
      const view = restrictRecords(observation.records, { maxRows, maxChars: observation.options.maxChars });
      if (view.returnedRows)
        records[id] = view.text
          .split("\n")
          .filter(line => !line.startsWith("columns: "))
          .join("\n");
      break;
    }
  }
  return records;
}

/** Render from this task's immutable endpoint only. A fork's proof covers its
 * whole copied branch, so edits to an ancestor prevent downstream collapsing. */
export function taskOperatorCatalog(
  storage: WorkflowSnapshotStorage,
  task: TaskHistory,
  delta: ReturnType<typeof collectTaskEdits>,
  roots: NonNullable<TaskRecord["output_roots"]>,
  statistics: boolean,
  earlierTasks: readonly TaskHistory[] = []
) {
  const workflow = storage.getWorkflow(task.stepId);
  const byId = new Map(workflow.operators.map(op => [op.operatorID, op]));
  const proofs = workflowFingerprints(workflow);
  const firstSnapshotStep = task.steps.find(step => storage.hasSnapshotFor(step.id));
  const firstSnapshot = firstSnapshotStep ? storage.getAssociatedSnapshot(firstSnapshotStep.id) : undefined;
  const before = firstSnapshot?.parentId ? storage.getSnapshotById(firstSnapshot.parentId) : undefined;
  const format = task.steps
    .flatMap(step => (step.toolResults ?? []).map(tool => tool.output as DataflowActionsResult))
    .filter(receipt => receipt?.kind === "dataflow-actions")
    .at(-1)?.format;
  const answerIds = new Set(
    roots.basis === "answer"
      ? roots.roots.filter(root => root.step_id === task.stepId).map(root => root.operator_id)
      : []
  );
  for (const fork of delta.forks) {
    const root = byId.get(fork.new_operator_id);
    const rootMatches = root?.stateOrigin?.stepId === fork.step_id && root.stateOrigin.operatorId === fork.operator_id;
    const reachable = new Set<string>();
    const pending = rootMatches ? [fork.new_operator_id] : [];
    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      pending.push(...(byId.get(id)?.nativeOp?.inputs.filter(Boolean) ?? []));
    }
    fork.collapsed_operator_ids = Object.entries(fork.mapping).flatMap(([source, id]) => {
      const op = byId.get(id);
      const origin = op?.stateOrigin;
      return reachable.has(id) &&
        id !== fork.new_operator_id &&
        !answerIds.has(id) &&
        !delta.edits.get(id)?.modified &&
        origin?.taskId === fork.task_id &&
        origin.stepId === fork.step_id &&
        origin.operatorId === source &&
        !!proofs.get(id) &&
        proofs.get(id)?.subgraphHash === origin.subgraphHash
        ? [id]
        : [];
    });
  }
  const blocks = [...delta.edits.values()].map((edit): OperatorBlock => {
    const op = byId.get(edit.id);
    if (!op) return { id: edit.id, kind: edit.kind, state: "deleted" };
    const origin = op.stateOrigin;
    const changedFork = edit.fork && (edit.modified || proofs.get(edit.id)?.subgraphHash !== origin?.subgraphHash);
    const state = `${edit.state}${changedFork ? "; updated" : ""}`;
    const saved = readForkResult(workflow, storage, edit.id, task.stepId);
    const info = storage.getOperatorResult(task.stepId, edit.id) ?? saved?.info;
    const previous = before?.results.get(edit.id)?.info;
    const block = describeOperator(op, info, {
      ...format,
      state,
      implementation: false,
      stale: !info && !!previous && !previous.error && ["Completed", "CompletedFromCache"].includes(previous.state),
      ...(saved ? { savedBy: saved.taskId } : {}),
      // Process opacity is explained once in the shared prompt. Keep concrete
      // structural facts (filters, limits and previews) in task catalog blocks.
      scope:
        op.nativeOp?.type === "Process"
          ? undefined
          : resultScope(
              op,
              workflow,
              id => storage.getOperatorResult(task.stepId, id),
              id => id,
              false
            ),
    });
    // Label an earlier address only when both its graph and materialization
    // match. Identical rules alone cannot establish that data are unchanged.
    for (const input of block.inputs ?? []) {
      const retained = workflow.operators.find(op => op.operatorID === input.id)?.savedResult;
      if (retained) {
        input.id = retained.operatorId;
        input.taskId = retained.taskId;
        continue;
      }
      if (delta.edits.has(input.id)) continue;
      const proof = proofs.get(input.id)?.subgraphHash;
      const version = storage.getOperatorResult(task.stepId, input.id)?.resultVersion?.id;
      if (!proof || !version) continue;
      const savedInput = [...earlierTasks].reverse().find(previous => {
        if (previous.taskId >= task.taskId || previous.status !== "answered") return false;
        const previousWorkflow = storage.getWorkflow(previous.stepId);
        return (
          storage.getOperatorResult(previous.stepId, input.id)?.resultVersion?.id === version &&
          workflowFingerprints(previousWorkflow).get(input.id)?.subgraphHash === proof
        );
      });
      if (savedInput) input.taskId = savedInput.taskId;
    }
    if (op.nativeOp?.type === "Process") {
      const signatures = Object.values(op.nativeOp.functions ?? {}).flatMap(body => {
        const signature = body.match(/^\s*(?:async\s+)?def\s+(\w+\s*\([\s\S]*?\))(?:\s*->[^:\n]+)?:/m)?.[1];
        return signature ? [signature.replace(/\s+/g, " ")] : [];
      });
      if (signatures.length) block.signature = signatures.join("; ");
    }
    if (info?.error)
      block.result =
        info.nativeError && info.nativeError.diagnostic.operatorId !== op.operatorID
          ? "not run (upstream failed)"
          : "failed";
    else if (statistics && info) {
      const original = saved?.workflow.operators.find(item => item.operatorID === saved.operatorId);
      block.result =
        catalogResultSummary(original?.nativeOp ?? op.nativeOp, info) +
        (saved ? ` (saved by task ${saved.taskId})` : "");
    }
    if (answerIds.has(edit.id)) block.answerSource = true;
    if (edit.fork) {
      block.origin = `${Object.entries(edit.fork.mapping).find(([, id]) => id === edit.id)?.[0] ?? edit.fork.operator_id} (version at end of task ${edit.fork.task_id})`;
      if (edit.id === edit.fork.new_operator_id && edit.fork.collapsed_operator_ids.length) {
        const ids = edit.fork.collapsed_operator_ids;
        const prefix = `${edit.id}__`;
        block.issues = [
          `copies ${ids.length} unchanged upstream ${ids.length === 1 ? "operator" : "operators"} from task ${edit.fork.task_id}${ids.every(id => id.startsWith(prefix)) ? ` (IDs prefixed ${prefix})` : ""}; inspect this root for the exact mapping and copied definitions.`,
        ];
      }
    }
    if (info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state)) {
      const note =
        info.totalRowCount === 0
          ? "empty table"
          : op.nativeOp?.type === "Aggregate" && info.totalRowCount === 1
            ? "one-row aggregate"
            : undefined;
      if (note) block.issues = [...(block.issues ?? []), `note: ${note}.`];
    }
    return block;
  });
  return { operator_changes: blocks, forks: delta.forks, operator_deletions: delta.deletions };
}
