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
 * The task catalog: the block a request sees instead of the earlier requests
 * when its sender names the earlier tasks it builds on (sendMessage
 * `contextTasks`). It is rendered once from the graph as the request starts:
 * every earlier task in order, with what it asked, how it changed the dataflow
 * (operators it created, set again or deleted) and what it answered; the
 * tasks the request builds on in detail (each changed table's statement and
 * columns, what the task saw of it when it displayed it, or else its rows,
 * its function, the earlier tables it read, the whole answer), then the
 * tables their tables are built from. A change counts when a table's
 * statement or the source of a definition its function reaches changed.
 */

import type { ReActStep } from "../types/agent";
import type { OperatorInfo } from "../types/execution";
import { nativeAssignmentText, type NativeOpView } from "./native/catalog";
import {
  columnEntries,
  inlineCode,
  type ObservationFormatOptions,
  renderRecords,
  shapeText,
} from "./native/observation-format";
import type { RegisteredFunction, RegisteredNamespace } from "./native/registered";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";

export interface SessionRequest {
  messageId: string;
  /** Task number: the order the request was asked in the session, from 1. */
  number: number;
  steps: ReActStep[];
}

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

/** The final reply: the reply without the tool that ended the request. A
 * request that failed or was stopped has none. */
function answerOf(steps: readonly ReActStep[]): string | undefined {
  const last = steps[steps.length - 1];
  return last?.role === "agent" && last.isEnd && !last.endReason && !last.toolCalls?.length && last.content?.trim()
    ? last.content
    : undefined;
}

const opening = (request: SessionRequest) =>
  request.steps.find(step => step.role === "user" && step.isBegin) ?? request.steps[0];

/** A table this small is shown whole; larger ones show three rows. */
const WHOLE_TABLE_ROWS = 12;

const completed = (info: OperatorInfo | undefined): info is OperatorInfo =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);

const lastStep = (request: SessionRequest): ReActStep | undefined => request.steps[request.steps.length - 1];

/** A request's own text, without the "[Task N]" label. */
const requestText = (request: SessionRequest) =>
  (opening(request)?.content ?? "").replace(/\[Task \d+\]\s*/, "").trim();

/** What a table's value depends on, as text: its statement and the source of
 * every definition its function reaches, imports aside. Rewriting an import
 * line or registering an unrelated function changes a table's revision (its
 * cells), not this. */
function definitionText(id: string, view: NativeOpView, namespace: RegisteredNamespace | undefined): string {
  const parts = [nativeAssignmentText(id, view) ?? JSON.stringify({ type: view.type, inputs: view.inputs })];
  const registration = view.properties?.registered as
    | { entry?: unknown; lambda?: unknown; names?: unknown }
    | undefined;
  if (namespace && registration) {
    const pending =
      typeof registration.lambda === "string"
        ? [...((registration.names as string[] | undefined) ?? [])]
        : registration.entry !== undefined
          ? [String(registration.entry)]
          : [];
    const reached = new Set<string>();
    while (pending.length) {
      const name = pending.pop()!;
      const binding = namespace.bindings[name];
      if (reached.has(name) || !binding) continue;
      reached.add(name);
      pending.push(...(binding.references ?? []));
    }
    for (const name of [...reached].sort())
      if (namespace.bindings[name].kind !== "import") parts.push(namespace.bindings[name].source);
  }
  return parts.join("\n");
}

/** A registered function's source, fenced, under its signature. */
function functionLines(fn: RegisteredFunction): string[] {
  const fence = "`".repeat(Math.max(3, ...(fn.source.match(/`+/g) ?? []).map(run => run.length + 1)));
  return [`  function ${inlineCode(`${fn.name}${fn.signature}`)}:`, `${fence}python`, fn.source.trimEnd(), fence];
}

/** An answer as one line, clipped. */
function answerLine(text: string | undefined, limit = 300): string {
  const flat = (text ?? "No completed answer.").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The earlier tables a request's statements named (as inputs or with `show`), in first-mention order. */
function tablesRead(
  request: SessionRequest,
  views: ReadonlyMap<string, NativeOpView>,
  origin: ReadonlyMap<string, number>
): string[] {
  const read: string[] = [];
  for (const step of request.steps)
    for (const call of step.toolCalls ?? []) {
      const statements = typeof call.input?.statements === "string" ? call.input.statements : "";
      for (const line of statements.split("\n")) {
        const set = /^\s*set\s+[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\s*\((.*)\)\s*$/.exec(line);
        const shown = /^\s*show\s+(?:result|schema|operator)\s+(.+)$/.exec(line);
        const text = set ? set[1].split("lambda")[0] : shown ? shown[1] : "";
        for (const name of text.match(/\b[A-Za-z_]\w*\b/g) ?? [])
          if (views.has(name) && (origin.get(name) ?? Infinity) < request.number && !read.includes(name)) read.push(name);
      }
    }
  return read;
}

/** A full answer for a task the request builds on: kept whole up to this size. */
const DETAIL_ANSWER_CHARS = 3_000;
/** What a task the request builds on saw of one of its tables, kept up to this size. */
const OBSERVED_CHARS = 2_500;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** The last observation a request's `show result` returned for each table, as the model read it. */
function observedResults(request: SessionRequest): Map<string, string> {
  const seen = new Map<string, string>();
  for (const step of request.steps)
    for (const result of step.toolResults ?? []) {
      const output = result.output as any;
      for (const item of output?.kind === "dataflow-actions" ? (output.actions ?? []) : []) {
        if (item?.action?.type !== "retrieve" || item.status !== "ok") continue;
        for (const entry of (item.output?.results ?? []) as Array<{ status?: string; operator_id?: string; text?: string }>)
          if (entry.status === "ok" && entry.operator_id && typeof entry.text === "string" && entry.text.trim())
            seen.set(entry.operator_id, entry.text.trim());
      }
    }
  return seen;
}

export interface TaskCatalogInput {
  storage: WorkflowSnapshotStorage;
  /** The earlier requests, in order. */
  requests: readonly SessionRequest[];
  /** The step whose snapshot is the state the new request starts from. */
  head: string | undefined;
  /** The earlier tasks the request builds on, by number; shown in detail. */
  tasks: readonly number[];
  options?: ObservationFormatOptions;
}

export function renderTaskCatalog({ storage, requests, head, tasks, options = {} }: TaskCatalogInput): string {
  const now = storage.getAssociatedSnapshot(head).workflow;
  const views = new Map(now.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op.nativeOp!]));
  const result = (id: string) => storage.getOperatorResult(head, id);
  const shape = (id: string) => {
    if (!views.has(id)) return "no longer in the graph";
    const info = result(id);
    return completed(info)
      ? shapeText(info.totalRowCount ?? info.outputTuples, (info.resultSchema ?? []).length)
      : "not run";
  };
  const call = (view: NativeOpView) =>
    `${view.registeredName ?? view.type.toLowerCase()}(${view.inputs.filter(Boolean).join(", ")})`;
  const depends = new Set(tasks);
  const origin = new Map<string, number>();
  const lastSet = new Map<string, number>();
  const definition = new Map<string, string>();
  // Each task's changes to the dataflow, from the state it started from to the state it left.
  const changes = new Map<number, Array<{ id: string; kind: "created" | "set again" | "deleted"; view: NativeOpView }>>();
  for (const request of requests) {
    const start = storage.getAssociatedSnapshot(opening(request)?.id).workflow;
    const end = storage.getAssociatedSnapshot(lastStep(request)?.id).workflow;
    const before = new Map(start.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op.nativeOp!]));
    const list: Array<{ id: string; kind: "created" | "set again" | "deleted"; view: NativeOpView }> = [];
    for (const op of end.operators) {
      if (!op.nativeOp) continue;
      const text = definitionText(op.operatorID, op.nativeOp, end.nativeNamespace);
      if (!origin.has(op.operatorID)) origin.set(op.operatorID, request.number);
      const was = before.get(op.operatorID);
      if (!was) list.push({ id: op.operatorID, kind: "created", view: op.nativeOp });
      else if (definitionText(op.operatorID, was, start.nativeNamespace) !== text)
        list.push({ id: op.operatorID, kind: "set again", view: op.nativeOp });
      if (definition.get(op.operatorID) !== text) {
        definition.set(op.operatorID, text);
        lastSet.set(op.operatorID, request.number);
      }
    }
    const after = new Set(end.operators.map(op => op.operatorID));
    for (const [id, view] of before) if (!after.has(id)) list.push({ id, kind: "deleted", view });
    changes.set(request.number, list);
  }
  const first = requests[0];
  const named = [...depends].sort((a, b) => a - b);
  const sections: string[] = [
    "## Context for this request",
    "Earlier requests are not shown. Below are the session's instructions, then every earlier task: what it asked, how it changed the dataflow, and what it answered." +
      (named.length
        ? ` The tasks this request builds on (${named.join(", ")}) are shown in detail, followed by the tables their tables are built from.`
        : "") +
      " Build on any table by name; `show result`, `show schema` and `show function` read anything not shown." +
      (named.length
        ? " When a result one of those tasks needs is not in the graph, compute it again from that task's request and the files."
        : ""),
  ];
  if (first) sections.push(`### Session instructions (task ${first.number})\n${requestText(first)}`);
  const shownFunctions = new Set<string>();
  const detailed = new Set<string>();
  const seeds: string[] = [];
  const entries: string[] = [];
  for (const request of requests) {
    const dep = depends.has(request.number);
    const list = changes.get(request.number) ?? [];
    const lines = [`#### Task ${request.number}${dep ? "  (this request builds on it)" : ""}`];
    lines.push(`asked: ${request === first ? "the session instructions above" : requestText(request)}`);
    if (!list.length) lines.push("changed: nothing");
    else if (!dep)
      lines.push(
        `changed: ${list
          .map(change =>
            change.kind === "deleted"
              ? `deleted ${inlineCode(change.id)}`
              : `${change.kind === "set again" ? "set again " : ""}${inlineCode(change.id)} = ${call(change.view)} ${shape(change.id)}`
          )
          .join("; ")}`
      );
    else {
      lines.push("changed:");
      const seen = observedResults(request);
      for (const change of list) {
        if (change.kind === "deleted") {
          lines.push(`- deleted ${inlineCode(change.id)}`);
          continue;
        }
        const view = views.get(change.id);
        if (!view) {
          lines.push(`- ${inlineCode(nativeAssignmentText(change.id, change.view) ?? change.id)} (deleted by a later task)`);
          continue;
        }
        detailed.add(change.id);
        seeds.push(change.id);
        const later = lastSet.get(change.id) !== request.number ? ` (set again in task ${lastSet.get(change.id)})` : "";
        lines.push(`- ${inlineCode(nativeAssignmentText(change.id, view) ?? change.id)}${change.kind === "set again" ? " (set again here)" : ""}${later}`);
        const info = result(change.id);
        if (completed(info)) {
          lines.push(`  result: ${shape(change.id)}; columns: ${columnEntries(info.resultSchema ?? [], 0).join(", ")}`);
          const observed = seen.get(change.id);
          if (observed) {
            // What the task saw when it displayed the table: its records and statistics.
            lines.push(`  as task ${request.number} saw it:`);
            lines.push(...clip(observed, OBSERVED_CHARS).split("\n").filter(line => !line.startsWith("columns: ")).map(line => `    ${line}`));
          } else {
            // A table the task changed without displaying it shows its rows: a small table whole, a larger one a sample.
            const rows = info.totalRowCount ?? info.outputTuples ?? 0;
            const whole = rows <= WHOLE_TABLE_ROWS;
            const records = renderRecords(info, {
              ...options,
              view: whole ? "full" : "sample",
              maxChars: whole ? 2_000 : 1_000,
              maxRows: whole ? WHOLE_TABLE_ROWS : 3,
            });
            lines.push(
              ...records.text
                .split("\n")
                .filter(line => !line.startsWith("columns: "))
                .map(line => `  ${line}`)
            );
          }
        } else lines.push(`  result: ${result(change.id)?.error ? "failed" : "not run"}`);
        const name = view.registeredName;
        const fn = name && !shownFunctions.has(name) ? now.nativeNamespace?.functions[name] : undefined;
        if (fn?.source) {
          shownFunctions.add(name!);
          lines.push(...functionLines(fn));
        }
      }
    }
    if (dep) {
      const own = new Set(list.map(change => change.id));
      const read = tablesRead(request, views, origin).filter(id => !own.has(id));
      if (read.length) {
        lines.push(`read: ${read.map(id => `${inlineCode(id)} (task ${origin.get(id)}, ${shape(id)})`).join(", ")}`);
        seeds.push(...read);
      }
    }
    lines.push(`answered: ${answerLine(answerOf(request.steps), dep ? DETAIL_ANSWER_CHARS : 300)}`);
    entries.push(lines.join("\n"));
  }
  if (entries.length) sections.push(`### Earlier tasks\n${entries.join("\n\n")}`);
  // The tables the detailed ones are built from, and the tables those tasks read, back to the files.
  const ancestors: string[] = [];
  const seen = new Set(detailed);
  const pending: string[] = [];
  for (const id of seeds) {
    if (!detailed.has(id) && !seen.has(id)) {
      seen.add(id);
      ancestors.push(id);
    }
    pending.push(id);
  }
  while (pending.length)
    for (const input of views.get(pending.shift()!)?.inputs.filter(Boolean) ?? []) {
      if (seen.has(input) || !views.has(input)) continue;
      seen.add(input);
      ancestors.push(input);
      pending.push(input);
    }
  const order = [...views.keys()];
  ancestors.sort((a, b) => (origin.get(a) ?? 0) - (origin.get(b) ?? 0) || order.indexOf(a) - order.indexOf(b));
  const upstream: string[] = [];
  for (const id of ancestors) {
    const view = views.get(id)!;
    upstream.push(`- ${inlineCode(nativeAssignmentText(id, view) ?? id)} (task ${origin.get(id)}, ${shape(id)})`);
    const name = view.registeredName;
    const fn = name && !shownFunctions.has(name) ? now.nativeNamespace?.functions[name] : undefined;
    if (fn?.source) {
      shownFunctions.add(name!);
      upstream.push(...functionLines(fn));
    }
  }
  if (upstream.length)
    sections.push(
      "### What the detailed tasks' tables are built from\nEach table's statement, its task and shape, and its function's source when it is not shown above.\n" +
        upstream.join("\n")
    );
  return sections.join("\n\n");
}
