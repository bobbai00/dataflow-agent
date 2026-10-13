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
 * The working set (AgentSettings.focusTasks): in a catalog session, the
 * earlier tasks the model is building on, shown in full before the current
 * request. The catalog entries are the directory, one line per operator; the
 * working set holds a few tasks with their request text, their functions with
 * source, their operators with every column and a sample, and their answers.
 *
 * Which tasks: the ones the model named with `focus task 3, 7` (kept in the
 * workflow content, so they are versioned with it and inherited by later
 * requests), plus the previous task, at most `focusTasks` of them; beyond the
 * limit, the tasks whose operators were used least recently drop out. The set
 * is rendered at every model call from the current graph, so a `focus`
 * statement takes effect at the next call.
 */

import type { ReActStep } from "../types/agent";
import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";
import type { NativeOpView } from "./native/catalog";
import { nativeAssignmentText, nativeOperatorName } from "./native/catalog";
import {
  columnEntries,
  inlineCode,
  type ObservationFormatOptions,
  renderRecords,
  shapeText,
} from "./native/observation-format";
import { answerOf, editOrder, functionsSection, opening, type SessionRequest } from "./request-catalog";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";

/** Characters the whole working set may take; samples go first when it is over. */
const WORKING_SET_CHARS = 16_000;
/** A table this small is shown whole; larger ones show three rows. */
const WHOLE_TABLE_ROWS = 12;

const completed = (info: OperatorInfo | undefined): info is OperatorInfo =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);

const lastStep = (request: SessionRequest) => request.steps[request.steps.length - 1];

/** The request that created each operator: the first whose end snapshot holds it. */
export function originTasks(requests: readonly SessionRequest[], storage: WorkflowSnapshotStorage): Map<string, number> {
  const origins = new Map<string, number>();
  for (const request of requests) {
    const last = lastStep(request);
    if (!last) continue;
    for (const op of storage.getAssociatedSnapshot(last.id).workflow.operators)
      if (!origins.has(op.operatorID)) origins.set(op.operatorID, request.number);
  }
  return origins;
}

/** Identifiers a request's statements mention. */
function mentioned(steps: readonly ReActStep[]): Set<string> {
  const names = new Set<string>();
  for (const step of steps)
    for (const call of step.toolCalls ?? []) {
      let input: unknown = (call as { input?: unknown }).input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          continue;
        }
      }
      const statements = (input as { statements?: unknown } | undefined)?.statements;
      if (typeof statements !== "string") continue;
      for (const match of statements.matchAll(/[A-Za-z_]\w*/g)) names.add(match[0]);
    }
  return names;
}

/**
 * The tasks the working set shows for the current request: the stored focus
 * plus the previous task, cut to `limit` by dropping the tasks used least
 * recently. A task's last use is the latest request that mentioned one of its
 * operators, or the request that focused it.
 */
export function effectiveFocus(
  requests: readonly SessionRequest[],
  storage: WorkflowSnapshotStorage,
  workflow: WorkflowContent,
  limit: number
): number[] {
  const current = requests[requests.length - 1]?.number ?? requests.length;
  if (current < 2 || limit <= 0) return [];
  const focus = workflow.nativeFocus;
  const stored = (focus?.tasks ?? []).filter(task => task >= 1 && task < current);
  const origin = originTasks(requests, storage);
  const lastUse = new Map<number, number>();
  for (const request of requests.slice(0, -1))
    for (const id of mentioned(request.steps)) {
      const task = origin.get(id);
      if (task !== undefined && task < request.number) lastUse.set(task, Math.max(lastUse.get(task) ?? 0, request.number));
    }
  for (const task of stored) lastUse.set(task, Math.max(lastUse.get(task) ?? 0, focus?.setIn ?? 0));
  const candidates = [...new Set([...stored, current - 1])];
  const use = (task: number) => Math.max(lastUse.get(task) ?? 0, task);
  return candidates
    .sort((a, b) => use(b) - use(a) || b - a)
    .slice(0, limit)
    .sort((a, b) => a - b);
}

interface RenderOptions extends ObservationFormatOptions {
  /** Show sample rows (dropped first when the set is over budget). */
  samples?: boolean;
}

/** The working set as one message, or "" when there is nothing to show. */
export function renderWorkingSet(
  storage: WorkflowSnapshotStorage,
  requests: readonly SessionRequest[],
  tasks: readonly number[],
  options: ObservationFormatOptions = {}
): string {
  if (!tasks.length) return "";
  const full = render(storage, requests, tasks, { ...options, samples: true });
  if (full.length <= WORKING_SET_CHARS) return full;
  const lean = render(storage, requests, tasks, { ...options, samples: false });
  return lean.length <= WORKING_SET_CHARS
    ? lean
    : `${lean.slice(0, WORKING_SET_CHARS)}\n… (the working set is over budget: focus fewer tasks)`;
}

function render(
  storage: WorkflowSnapshotStorage,
  requests: readonly SessionRequest[],
  tasks: readonly number[],
  options: RenderOptions
): string {
  const byNumber = new Map(requests.map(request => [request.number, request]));
  const current = requests[requests.length - 1];
  const head = lastStep(current)?.id;
  const now = storage.getAssociatedSnapshot(head).workflow;
  const nowOps = new Map(now.operators.map(op => [op.operatorID, op]));
  const origin = originTasks(requests, storage);
  const result = (id: string) => storage.getOperatorResult(head, id);
  const shape = (id: string) => {
    const info = result(id);
    return completed(info) ? shapeText(info.totalRowCount ?? info.outputTuples, (info.resultSchema ?? []).length) : "not run";
  };
  /** The request whose end snapshot first holds this revision of the operator. */
  const setIn = (id: string, revision: string | undefined, after: number) =>
    requests.find(r => {
      const last = lastStep(r);
      return (
        r.number > after &&
        last &&
        storage.getAssociatedSnapshot(last.id).workflow.operators.find(op => op.operatorID === id)?.nativeOp?.revision === revision
      );
    })?.number;
  const sections = [
    `## Working set: ${tasks.map(t => `task ${t}`).join(", ")}`,
    "The earlier tasks you are building on, in full, from the current graph. `focus task 3, 7` replaces this set from your next call; the entries above list every other task.",
  ];
  for (const task of tasks) {
    const request = byNumber.get(task);
    if (!request) continue;
    const start = storage.getAssociatedSnapshot(opening(request)?.id);
    const end = storage.getAssociatedSnapshot(lastStep(request)?.id);
    const endOps = new Map(end.workflow.operators.map(op => [op.operatorID, op]));
    const lines: string[] = [`### Task ${task}`];
    // The first request carries the session preamble before "[Task 1]"; the task text is what matters here.
    const text = opening(request)?.content?.trim();
    const taskText = text?.replace(/^[\s\S]*?\[Task \d+\]\s*/, "");
    if (taskText) lines.push(`request: ${taskText}`);
    const functions = functionsSection(start, end, "full");
    if (functions) lines.push(functions);
    const set = editOrder(request.steps).filter(id => endOps.has(id));
    const boundary = new Map<string, number>();
    const readers: string[] = [];
    if (set.length) lines.push("operators set here:");
    for (const id of set) {
      const atEnd = endOps.get(id)!.nativeOp!;
      const nowView = nowOps.get(id)?.nativeOp;
      const definition = nativeAssignmentText(id, atEnd) ?? id;
      let head_ = `- ${inlineCode(definition)}`;
      if (!nowView) head_ += " (deleted later)";
      else if (nowView.revision !== atEnd.revision) {
        const later = setIn(id, nowView.revision, task);
        head_ += ` (set again${later ? ` in task ${later}` : ""}: ${inlineCode(nativeAssignmentText(id, nowView) ?? id)})`;
      }
      lines.push(head_);
      const view: NativeOpView = nowView ?? atEnd;
      const inputs = view.inputs.filter(Boolean);
      if (inputs.length)
        lines.push(
          `  reads: ${inputs
            .map(input => {
              const from = origin.get(input);
              const elsewhere = from !== undefined && from !== task;
              if (elsewhere) boundary.set(input, from!);
              return `${inlineCode(input)}${elsewhere ? ` (task ${from}, ${shape(input)})` : ""}`;
            })
            .join(", ")}`
        );
      const info = result(id);
      const failed = !!info?.error;
      if (completed(info)) {
        const schema = info.resultSchema ?? [];
        lines.push(
          `  result: ${shapeText(info.totalRowCount ?? info.outputTuples, schema.length)}; columns: ${columnEntries(schema, 0).join(", ")}`
        );
        if (options.samples) {
          const rows = info.totalRowCount ?? info.outputTuples ?? 0;
          const whole = rows <= WHOLE_TABLE_ROWS;
          const records = renderRecords(info, {
            ...options,
            view: whole ? "full" : "sample",
            maxChars: whole ? 2_000 : 900,
            maxRows: whole ? WHOLE_TABLE_ROWS : 3,
          });
          // The result line above already lists every column.
          lines.push(
            ...records.text
              .split("\n")
              .filter(line => !line.startsWith("columns: "))
              .map(line => `  ${line}`)
          );
        }
      } else lines.push(`  result: ${failed ? "failed" : nowView ? "not run or stale" : "none"}`);
      for (const op of now.operators) {
        const from = origin.get(op.operatorID);
        if (from !== undefined && from > task && (op.nativeOp?.inputs ?? []).includes(id))
          readers.push(`${inlineCode(id)} → task ${from} (${inlineCode(op.operatorID)})`);
      }
    }
    const answer = answerOf(request.steps);
    lines.push(`answer: ${answer ?? "No completed answer."}`);
    if (boundary.size)
      lines.push(
        `reads from earlier tasks: ${[...boundary]
          .map(([id, from]) => `${inlineCode(id)} (task ${from}${tasks.includes(from) ? ", above" : `; focus task ${from} for its rule`})`)
          .join(", ")}`
      );
    if (readers.length) lines.push(`read by later tasks: ${[...new Set(readers)].join(", ")}`);
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/** For tests and receipts: a short name for an operator's kind. */
export const operatorKind = (view: NativeOpView) => view.registeredName ?? nativeOperatorName(view.type);
