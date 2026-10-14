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

/**
 * The request catalog (multiRequest: "catalog"): in a session with several
 * requests, each earlier request appears as its request and one catalog entry
 * in place of its calls. An entry is what the request left in the Dataflow:
 * the functions it registered or changed, as signatures and then source; the
 * operators it created, changed or deleted, as the canonical operator blocks
 * `show operator` prints, with every column; the results it showed; and its
 * answer. Entries read two saved snapshots, the state the request inherited
 * and the state it left, so a finished request's entry never changes and the
 * conversation prefix stays cacheable.
 * Design: docs/native-multi-request-design.md.
 */

import type { CatalogSource, ReActStep } from "../types/agent";
import type { OperatorInfo } from "../types/execution";
import type { NativeOpView } from "./native/catalog";
import { columnsFromInput, describeOperator, inlineCode, operatorBlock } from "./native/observation-format";
import type { DataflowActionsResult } from "./tools/dataflow-actions";
import type { GraphChangeReceipt } from "./tools/graph-edits";
import type { SnapshotData, WorkflowSnapshotStorage } from "./workflow-snapshot-storage";

export interface SessionRequest {
  messageId: string;
  /** Task number: the order the request was asked in the session, from 1. */
  number: number;
  steps: ReActStep[];
}

const completed = (info: OperatorInfo | undefined): info is OperatorInfo =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);

/** The requests on the visible path, in the order they were asked. */
export function sessionRequests(steps: readonly ReActStep[], numbers?: ReadonlyMap<string, number>): SessionRequest[] {
  const requests: SessionRequest[] = [];
  const byMessage = new Map<string, SessionRequest>();
  for (const step of steps) {
    let request = byMessage.get(step.messageId);
    if (!request) {
      request = { messageId: step.messageId, number: 0, steps: [] };
      byMessage.set(step.messageId, request);
      requests.push(request);
    }
    request.steps.push(step);
  }
  requests.forEach((request, i) => (request.number = numbers?.get(request.messageId) ?? i + 1));
  return requests;
}

function receipts(steps: readonly ReActStep[]): DataflowActionsResult[] {
  return steps.flatMap(step =>
    (step.toolResults ?? [])
      .map(result => result.output as DataflowActionsResult | undefined)
      .filter((output): output is DataflowActionsResult => output?.kind === "dataflow-actions")
  );
}

/** Operators a request's committed edits touched, in first-edit order. A
 * call's edits apply together or not at all, so a rejected edit touched nothing. */
function editOrder(steps: readonly ReActStep[]): string[] {
  const order = new Set<string>();
  for (const receipt of receipts(steps))
    for (const item of receipt.actions) {
      if (item.action.type !== "edit" || item.status !== "ok") continue;
      for (const change of (item.output as { changes?: GraphChangeReceipt[] } | undefined)?.changes ?? [])
        if (change.change === "operator" && change.action !== "unchanged") order.add(change.operator_id);
    }
  return [...order];
}

/** Results the request displayed with `show result`, in first-shown order. */
export function shownResults(steps: readonly ReActStep[]): string[] {
  const shown = new Set<string>();
  for (const receipt of receipts(steps))
    for (const item of receipt.actions) {
      if (item.action.type !== "retrieve") continue;
      for (const entry of ((item.output as any)?.results ?? []) as Array<{ status?: string; operator_id?: string }>)
        if (entry.status === "ok" && entry.operator_id) shown.add(entry.operator_id);
    }
  return [...shown];
}

/** The final reply: the reply without the tool that ended the request. A
 * request that failed or was stopped has none. */
export function answerOf(steps: readonly ReActStep[]): string | undefined {
  const last = steps[steps.length - 1];
  return last?.role === "agent" && last.isEnd && !last.endReason && !last.toolCalls?.length && last.content?.trim()
    ? last.content
    : undefined;
}

/** A setting value as a statement spells it. */
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
    return registered
      ? { entry: registered.entry, settings: registered.settings ?? {} }
      : { entry: view.type, settings: view.properties };
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

/** A docstring as an entry quotes it: one paragraph, at most this long. */
const DOCSTRING_CHARS = 300;

/** The functions section: one signature line per public function the request
 * registered or changed, then the source of every binding it registered or
 * changed, in definition order and once, as the request left it. With
 * `catalogSource: "docstring"` a documented function is its signature and
 * docstring, a private helper its signature; source remains for the rest
 * (an undocumented function, imports, constants), and `show function` reads
 * any source on demand. */
function functionsSection(start: SnapshotData, end: SnapshotData, source: CatalogSource = "full"): string {
  const before = start.workflow.nativeNamespace?.bindings ?? {};
  const namespace = end.workflow.nativeNamespace;
  const cells = namespace?.cells ?? [];
  const seen = new Set<string>();
  const changed = Object.values(namespace?.bindings ?? {})
    .filter(binding => before[binding.name]?.source !== binding.source)
    // Binding cells are numbered from 1, as error locations show them.
    .map(binding => ({ binding, at: Math.max(0, (cells[binding.cell - 1] ?? "").indexOf(binding.source)) }))
    .sort((a, b) => a.binding.cell - b.binding.cell || a.at - b.at || a.binding.name.localeCompare(b.binding.name))
    .map(({ binding }) => binding);
  const compact = source === "docstring";
  const api: string[] = [];
  const helpers: string[] = [];
  // Bindings whose source the entry leaves to `show function`.
  const described = new Set<string>();
  for (const binding of changed) {
    const fn = namespace?.functions[binding.name];
    if (binding.kind !== "function" || !fn) continue;
    if (!fn.exported) {
      if (compact) {
        helpers.push(inlineCode(`${fn.name}${fn.signature}`));
        described.add(binding.name);
      }
      continue;
    }
    const paragraph = fn.doc.replace(/\s+/g, " ").trim();
    const doc = compact
      ? paragraph.length > DOCSTRING_CHARS
        ? `${paragraph.slice(0, DOCSTRING_CHARS - 1)}…`
        : paragraph
      : fn.doc.split("\n")[0].trim();
    api.push(`- ${inlineCode(`${fn.name}${fn.signature}`)}${doc ? ` — ${doc}` : ""}`);
    if (compact && doc) described.add(binding.name);
  }
  // One statement can bind several names; its source is shown once.
  const sources = changed
    .filter(binding => !described.has(binding.name))
    .filter(binding => {
      const key = `${binding.cell}\u0000${binding.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(binding => binding.source.trimEnd());
  if (!sources.length && !api.length && !helpers.length) return "";
  // Multi-line definitions are set apart; one-line imports and constants stay together.
  const code = sources.reduce(
    (text, source, i) =>
      i === 0 ? source : text + (source.includes("\n") || sources[i - 1].includes("\n") ? "\n\n" : "\n") + source,
    ""
  );
  const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map(run => run.length + 1)));
  return [
    "functions:",
    ...api,
    ...(helpers.length ? [`helpers: ${helpers.join(", ")}`] : []),
    ...(sources.length ? [`${fence}python`, code, fence] : []),
    ...(described.size ? ["`show function <name>` reads a function's source."] : []),
  ].join("\n");
}

/** The registered function an operator calls: its entry, or a filter's predicate. */
function functionOf(view: NativeOpView): string | undefined {
  const predicate =
    view.type === "Filter" ? (view.properties.registered as { entry?: unknown } | undefined)?.entry : undefined;
  return view.registeredName ?? (typeof predicate === "string" ? predicate : undefined);
}

export const opening = (request: SessionRequest) =>
  request.steps.find(step => step.role === "user" && step.isBegin) ?? request.steps[0];

const entryCache = new WeakMap<WorkflowSnapshotStorage, Map<string, string>>();

/**
 * The catalog entries of `requests`, in order. An entry depends only on the
 * requests up to its own and the snapshots they left, so each is rendered
 * once per storage and reused on every later call.
 */
export function requestEntries(
  storage: WorkflowSnapshotStorage,
  requests: readonly SessionRequest[],
  source: CatalogSource = "full"
): string[] {
  let cache = entryCache.get(storage);
  if (!cache) entryCache.set(storage, (cache = new Map()));
  let key = `${source}\n`;
  return requests.map((request, index) => {
    key += `${request.number}:${request.messageId}:${request.steps[request.steps.length - 1]?.id}\n`;
    let entry = cache.get(key);
    if (entry === undefined) cache.set(key, (entry = renderRequestEntry(storage, requests, index, source)));
    return entry;
  });
}

/** One earlier request's catalog entry; `requestEntries` caches them. */
export function renderRequestEntry(
  storage: WorkflowSnapshotStorage,
  requests: readonly SessionRequest[],
  index: number,
  source: CatalogSource = "full"
): string {
  const request = requests[index];
  // A request owns no snapshot, so it resolves to the state it inherited.
  const start = storage.getAssociatedSnapshot(opening(request)?.id);
  const end = storage.getAssociatedSnapshot(request.steps[request.steps.length - 1]?.id);
  const answer = answerOf(request.steps);
  const before = new Map(start.workflow.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op]));
  const after = new Map(end.workflow.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op]));
  const edited = editOrder(request.steps);
  // Each earlier request's operator revisions as it left them.
  const earlier = requests.slice(0, index).map(r => ({
    number: r.number,
    revisions: new Map(
      storage
        .getAssociatedSnapshot(r.steps[r.steps.length - 1]?.id)
        .workflow.operators.map(op => [op.operatorID, op.nativeOp?.revision])
    ),
  }));
  // Functions the session started with appear in no entry.
  const initial = storage.getAssociatedSnapshot(opening(requests[0])?.id).workflow.nativeNamespace?.bindings ?? {};
  const bindings = end.workflow.nativeNamespace?.bindings ?? {};
  const functions = functionsSection(start, end, source);
  const blocks: string[] = [];
  const deleted: string[] = [];
  for (const id of edited) {
    const was = before.get(id);
    const op = after.get(id);
    if (!op) {
      // Removing an operator affects later reuse; one that came and went within the request does not.
      if (was) deleted.push(id);
      continue;
    }
    if (was && was.nativeOp!.revision === op.nativeOp!.revision) continue;
    let state = was ? "updated" : "created";
    if (was) {
      // An update that brings back an earlier task's definition says so.
      const restored = [...earlier].reverse().find(r => r.revisions.get(id) === op.nativeOp!.revision);
      const moved = settingsChange(was.nativeOp!, op.nativeOp!);
      if (restored) state = `updated: restored task ${restored.number}'s version`;
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
    // Said once: an operator's own doc is part of its statement, and a
    // function's signature and docstring are in the entry of the task that
    // registered or last changed it.
    if (op.nativeOp!.doc !== undefined && block.description === op.nativeOp!.doc) delete block.description;
    const fn = functionOf(op.nativeOp!);
    if (fn && block.signature !== undefined && bindings[fn]?.source !== initial[fn]?.source) {
      delete block.signature;
      if (op.nativeOp!.doc === undefined) delete block.description;
    }
    for (const input of block.inputs ?? []) {
      if (input.id === "unconnected" || edited.includes(input.id)) continue;
      // An input this request did not touch names the earliest task whose end
      // left that same definition.
      const revision = after.get(input.id)?.nativeOp?.revision;
      const origin = revision && earlier.find(r => r.revisions.get(input.id) === revision);
      if (origin) input.taskId = origin.number;
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
    blocks.push(operatorBlock(block));
  }
  const shown = shownResults(request.steps);
  return [
    `## Task ${request.number} (${answer !== undefined ? "answered" : "incomplete"})`,
    ...(functions ? [functions] : []),
    ...(blocks.length ? ["operators:", ...blocks] : []),
    ...(deleted.length ? [`deleted: ${deleted.map(inlineCode).join(", ")}`] : []),
    ...(!functions && !blocks.length && !deleted.length ? ["No functions or operators changed."] : []),
    ...(shown.length ? [`shown: ${shown.map(inlineCode).join(", ")}`] : []),
    `answer: ${answer ?? "No completed answer."}`,
  ].join("\n");
}
