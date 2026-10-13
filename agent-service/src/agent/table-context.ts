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
 * The table context: a request that names the earlier tables it builds on
 * (sendMessage `contextTables`) sees, instead of the earlier requests, one
 * block rendered once from the graph as the request starts:
 * - the session's instructions (the first request's text);
 * - every table the earlier requests left in the graph, one line each, by
 *   the task that created it, so any of them can be built on by name;
 * - the named tables in full: the request and answer of the task that made
 *   each, its statement, the tables it reads (with their task and shape),
 *   its result with every column and a sample, and its function's source;
 * - with `upstream`, the tables the named ones are built from, back to the
 *   files, each as its statement and its function's source.
 * A named table set again by a later request says so; a change counts when
 * its statement or the source of a definition its function reaches changed.
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
import { answerOf, opening, type SessionRequest } from "./request-catalog";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";

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

export interface TableContextInput {
  storage: WorkflowSnapshotStorage;
  /** The earlier requests, in order. */
  requests: readonly SessionRequest[];
  /** The step whose snapshot is the state the new request starts from. */
  head: string | undefined;
  /** The tables (operator ids) the request builds on. */
  tables: readonly string[];
  /** Also show what the named tables are built from. */
  upstream?: boolean;
  options?: ObservationFormatOptions;
}

export function renderTableContext({
  storage,
  requests,
  head,
  tables,
  upstream = false,
  options = {},
}: TableContextInput): string {
  const now = storage.getAssociatedSnapshot(head).workflow;
  const views = new Map(now.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op.nativeOp!]));
  // Each table's task: the first earlier request whose end left it in the
  // graph; and the last one that changed its definition.
  const origin = new Map<string, number>();
  const lastSet = new Map<string, number>();
  const definition = new Map<string, string>();
  for (const request of requests) {
    const last = lastStep(request);
    if (!last) continue;
    const workflow = storage.getAssociatedSnapshot(last.id).workflow;
    for (const op of workflow.operators) {
      if (!origin.has(op.operatorID)) origin.set(op.operatorID, request.number);
      const text = op.nativeOp ? definitionText(op.operatorID, op.nativeOp, workflow.nativeNamespace) : "";
      if (!definition.has(op.operatorID) || definition.get(op.operatorID) !== text) {
        definition.set(op.operatorID, text);
        lastSet.set(op.operatorID, request.number);
      }
    }
  }
  const result = (id: string) => storage.getOperatorResult(head, id);
  const shape = (id: string) => {
    const info = result(id);
    return completed(info)
      ? shapeText(info.totalRowCount ?? info.outputTuples, (info.resultSchema ?? []).length)
      : "not run";
  };
  const byNumber = new Map(requests.map(request => [request.number, request]));
  const sections: string[] = [
    "## Context for this request",
    `Earlier requests are not shown. Below are the session's instructions, every table the earlier requests left in the graph, ${upstream ? "the tables picked for this request in full, and the tables they are built from" : "and the tables picked for this request in full"}. Build on any table by name; \`show result\`, \`show schema\` and \`show function\` read anything not shown.`,
  ];
  const first = requests[0];
  if (first) sections.push(`### Session instructions (task ${first.number})\n${requestText(first)}`);
  // Every table, one line each, by task.
  const listed = new Map<number, string[]>();
  for (const [id, view] of views) {
    const task = origin.get(id);
    if (task === undefined) continue;
    const call = `${view.registeredName ?? view.type.toLowerCase()}(${view.inputs.filter(Boolean).join(", ")})`;
    listed.set(task, [...(listed.get(task) ?? []), `${inlineCode(id)} = ${call} ${shape(id)}`]);
  }
  if (listed.size)
    sections.push(
      "### Tables in the graph\n" +
        [...listed.keys()]
          .sort((a, b) => a - b)
          .map(task => `- task ${task}: ${listed.get(task)!.join("; ")}`)
          .join("\n")
    );
  // The picked tables in full, grouped by the task that made them.
  const picked = [...new Set(tables)].filter(id => views.has(id) && origin.has(id));
  const missing = [...new Set(tables)].filter(id => !picked.includes(id));
  const byTask = new Map<number, string[]>();
  for (const id of picked) byTask.set(origin.get(id)!, [...(byTask.get(origin.get(id)!) ?? []), id]);
  const detail: string[] = [];
  for (const task of [...byTask.keys()].sort((a, b) => a - b)) {
    const request = byNumber.get(task);
    const lines = [`#### Task ${task}`];
    if (request && task !== first?.number) lines.push(`asked: ${requestText(request)}`);
    if (request) lines.push(`answered: ${answerLine(answerOf(request.steps))}`);
    for (const id of byTask.get(task)!) {
      const view = views.get(id)!;
      const changed = lastSet.get(id) !== task ? ` (last set in task ${lastSet.get(id)})` : "";
      lines.push(`- ${inlineCode(nativeAssignmentText(id, view) ?? id)}${changed}`);
      const inputs = view.inputs.filter(Boolean);
      if (inputs.length)
        lines.push(
          `  reads: ${inputs.map(input => `${inlineCode(input)} (${origin.has(input) ? `task ${origin.get(input)}, ` : ""}${shape(input)})`).join(", ")}`
        );
      const info = result(id);
      if (completed(info)) {
        const schema = info.resultSchema ?? [];
        lines.push(`  result: ${shape(id)}; columns: ${columnEntries(schema, 0).join(", ")}`);
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
      } else lines.push(`  result: ${result(id)?.error ? "failed" : "not run"}`);
      const fn = view.registeredName ? now.nativeNamespace?.functions[view.registeredName] : undefined;
      if (fn?.source) lines.push(...functionLines(fn));
    }
    detail.push(lines.join("\n"));
  }
  sections.push(
    "### Tables picked for this request\n" +
      (detail.length ? detail.join("\n\n") : "None.") +
      (missing.length ? `\nNot in the graph: ${missing.map(inlineCode).join(", ")}.` : "")
  );
  if (upstream) {
    // Every table the picked ones read, directly or not, back to the files.
    const ancestors: string[] = [];
    const seen = new Set(picked);
    const pending = [...picked];
    while (pending.length) {
      for (const input of views.get(pending.shift()!)?.inputs.filter(Boolean) ?? []) {
        if (seen.has(input) || !views.has(input)) continue;
        seen.add(input);
        ancestors.push(input);
        pending.push(input);
      }
    }
    const order = [...views.keys()];
    ancestors.sort((a, b) => (origin.get(a) ?? 0) - (origin.get(b) ?? 0) || order.indexOf(a) - order.indexOf(b));
    const shown = new Set(picked.map(id => views.get(id)!.registeredName).filter(Boolean));
    const lines: string[] = [];
    for (const id of ancestors) {
      const view = views.get(id)!;
      const task = origin.get(id);
      lines.push(
        `- ${inlineCode(nativeAssignmentText(id, view) ?? id)} (${task !== undefined ? `task ${task}, ` : ""}${shape(id)})`
      );
      const name = view.registeredName;
      const fn = name && !shown.has(name) ? now.nativeNamespace?.functions[name] : undefined;
      if (fn?.source) {
        shown.add(name!);
        lines.push(...functionLines(fn));
      }
    }
    if (lines.length)
      sections.push(
        "### What the picked tables are built from\nTheir upstream tables, back to the files: each one's statement, and its function's source when it is not shown above.\n" +
          lines.join("\n")
      );
  }
  return sections.join("\n\n");
}
