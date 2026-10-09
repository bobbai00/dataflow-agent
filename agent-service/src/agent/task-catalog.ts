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
import type { TaskHistory } from "./task-history";
import type { SnapshotData, WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type { DataflowActionsResult } from "./tools/dataflow-actions";
import type { GraphChangeReceipt } from "./tools/graph-edits";
import type { NativeOpView } from "./native/catalog";
import { columnsFromInput, describeOperator, type OperatorBlock } from "./native/observation-format";

/**
 * The prior-task operator catalog on the registered protocol
 * (docs/observation-format/prior-task-operator-catalog-design.md): one entry
 * per finished task with the definitions it registered or changed, the
 * operators it created, changed or deleted as its endpoint saved them, and
 * its answer. Entries read saved snapshots only, so they never change.
 */

const completed = (info: OperatorInfo | undefined): info is OperatorInfo =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);

/** A setting value as the statement spells it. */
function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${pyLiteral(key)}: ${pyLiteral(item)}`)
      .join(", ")}}`;
  return String(value);
}

/** What an update changed when it kept the operator's function and inputs:
 * its settings, as `name old → new`. A registered call keeps its settings
 * beside its entry; a built-in keeps them as its properties. */
export function settingsChange(previous: NativeOpView, now: NativeOpView): string | undefined {
  if (previous.type !== now.type || JSON.stringify(previous.inputs) !== JSON.stringify(now.inputs)) return undefined;
  const call = (view: NativeOpView) => {
    const registered = view.properties.registered as { entry?: string; settings?: Record<string, unknown> } | undefined;
    if (registered) return { entry: registered.entry, settings: registered.settings ?? {} };
    return { entry: view.type, settings: view.properties };
  };
  const before = call(previous);
  const after = call(now);
  if (before.entry !== after.entry) return undefined;
  const names = [...new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])];
  const moved = names.filter(name => JSON.stringify(before.settings[name]) !== JSON.stringify(after.settings[name]));
  const value = (settings: Record<string, unknown>, name: string) =>
    Object.hasOwn(settings, name) ? pyLiteral(settings[name]) : "default";
  return moved.length
    ? moved.map(name => `${name} ${value(before.settings, name)} → ${value(after.settings, name)}`).join(", ")
    : undefined;
}

/** Operators a task's committed edits touched, in first-edit order. An edit
 * is atomic, so a rejected one touched nothing. */
export function taskEditOrder(task: TaskHistory): string[] {
  const order = new Set<string>();
  for (const step of task.steps)
    for (const tool of step.toolResults ?? []) {
      const receipt = tool.output as DataflowActionsResult | undefined;
      if (receipt?.kind !== "dataflow-actions") continue;
      for (const item of receipt.actions) {
        if (item.action.type !== "edit" || item.status !== "ok") continue;
        for (const change of (item.output as { changes?: GraphChangeReceipt[] } | undefined)?.changes ?? [])
          if (change.change === "operator" && change.action !== "unchanged") order.add(change.operator_id);
      }
    }
  return [...order];
}

/** The source of every binding the task registered or changed, in definition
 * order and once, as the task left it. One statement can bind several names. */
export function taskDefinitions(start: SnapshotData, end: SnapshotData): string {
  const before = start.workflow.nativeNamespace?.bindings ?? {};
  const namespace = end.workflow.nativeNamespace;
  const cells = namespace?.cells ?? [];
  const seen = new Set<string>();
  const sources = Object.values(namespace?.bindings ?? {})
    .filter(binding => before[binding.name]?.source !== binding.source)
    // Binding cells are numbered from 1, as error locations show them.
    .map(binding => ({ binding, at: Math.max(0, (cells[binding.cell - 1] ?? "").indexOf(binding.source)) }))
    .sort((a, b) => a.binding.cell - b.binding.cell || a.at - b.at || a.binding.name.localeCompare(b.binding.name))
    .filter(({ binding }) => {
      const key = `${binding.cell}\u0000${binding.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ binding }) => binding.source.trimEnd());
  // Multi-line definitions are set apart; one-line imports and constants stay together.
  return sources.reduce(
    (text, source, i) =>
      i === 0 ? source : text + (source.includes("\n") || sources[i - 1].includes("\n") ? "\n\n" : "\n") + source,
    ""
  );
}

export function taskOperatorCatalog(
  storage: WorkflowSnapshotStorage,
  task: TaskHistory,
  earlierTasks: readonly TaskHistory[]
): { operator_changes: OperatorBlock[]; operator_deletions: OperatorBlock[]; definitions: string } {
  // The request owns no snapshot, so it resolves to the state the task inherited.
  const start = storage.getAssociatedSnapshot(task.steps[0]?.id);
  const end = storage.getAssociatedSnapshot(task.stepId);
  const before = new Map(start.workflow.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op]));
  const after = new Map(end.workflow.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op]));
  const edited = taskEditOrder(task);
  const earlier = earlierTasks.filter(t => t.taskId < task.taskId).sort((a, b) => a.taskId - b.taskId);
  const operator_changes: OperatorBlock[] = [];
  const operator_deletions: OperatorBlock[] = [];
  for (const id of edited) {
    const was = before.get(id);
    const op = after.get(id);
    if (!op) {
      // Removing an operator affects later reuse; one that came and went within the task does not.
      if (was) operator_deletions.push({ id, kind: describeOperator(was, undefined).kind, state: "deleted" });
      continue;
    }
    if (was && was.nativeOp!.revision === op.nativeOp!.revision) continue;
    let state = was ? "updated" : "created";
    if (was) {
      // An update that brings back an earlier task's definition is a restore.
      const restored = [...earlier]
        .reverse()
        .find(
          t =>
            storage.getWorkflow(t.stepId).operators.find(item => item.operatorID === id)?.nativeOp?.revision ===
            op.nativeOp!.revision
        );
      const moved = settingsChange(was.nativeOp!, op.nativeOp!);
      if (restored) state = `updated: restored task ${restored.taskId}'s version`;
      else if (moved) state = `updated: ${moved}`;
      else if (was.nativeOp!.source === op.nativeOp!.source)
        state = "updated: the definitions its function uses changed";
    }
    const info = end.results.get(id)?.info;
    const block = describeOperator(op, info, {
      state,
      columnsShown: 0,
      implementation: false,
      namespace: end.workflow.nativeNamespace,
      stale: !completed(info) && completed(start.results.get(id)?.info),
    });
    // An operator's own doc is part of its `set` statement; say it once.
    if (op.nativeOp!.doc !== undefined && block.description === op.nativeOp!.doc) delete block.description;
    for (const input of block.inputs ?? []) {
      if (input.id === "unconnected" || edited.includes(input.id)) continue;
      // An unchanged input is addressed by the earliest task that saved this
      // very result; equal rules alone do not establish equal data.
      const version = end.results.get(input.id)?.info.resultVersion;
      const saved =
        version &&
        earlier.find(
          t =>
            t.status === "answered" && storage.getOperatorResult(t.stepId, input.id)?.resultVersion?.id === version.id
        );
      if (saved) input.taskId = saved.taskId;
    }
    // Columns are listed where a chain starts; a later step says how its
    // columns differ from its first input's.
    const first = op.nativeOp!.inputs[0];
    const firstInfo = first ? end.results.get(first)?.info : undefined;
    if (completed(info) && completed(firstInfo)) {
      const relative = columnsFromInput(info.resultSchema ?? [], firstInfo.resultSchema ?? [], first, 0);
      if (relative) block.columnsFromInput = relative;
    }
    if (completed(info)) {
      const rows = info.totalRowCount ?? info.outputTuples;
      const note =
        rows === 0
          ? "empty table"
          : op.nativeOp!.type === "Limit" && completed(firstInfo)
            ? `limited table; its input has ${(firstInfo.totalRowCount ?? firstInfo.outputTuples).toLocaleString("en-US")} rows`
            : op.nativeOp!.type === "Aggregate" && rows === 1
              ? "one-row aggregate"
              : undefined;
      if (note) block.issues = [...(block.issues ?? []), `note: ${note}.`];
    }
    operator_changes.push(block);
  }
  return { operator_changes, operator_deletions, definitions: taskDefinitions(start, end) };
}
