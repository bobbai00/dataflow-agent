/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * A completed task's entry: the request, the changes the task made to the
 * dataflow, and the answer. Built once when the task is sealed and never
 * rewritten, so the entries of a session form a prefix that a provider's
 * prompt cache can reuse, and each entry keeps the definitions that later
 * tasks may need to read (a convention hidden in a `def` two hops upstream
 * decided a whole 16-turn cascade in the university task).
 */
import type { ReActStep } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import type { WorkflowState } from "../workflow-state";
import { nativeBatchResults } from "../tools/native-batch-tools";
import type { TaskHistory } from "./task-history";

export type ChangeStatus = "added" | "modified" | "restored" | "deleted" | "failed";

export interface TaskChange {
  status: ChangeStatus;
  id: string;
  /** The statement as written, whitespace-collapsed. */
  statement: string;
  /** The author's one-sentence doc of a custom operator. */
  doc?: string;
  /** Function bodies, only when the statement has functions and no doc. */
  functions?: string[];
  rows?: number;
  columns?: string[];
  /** `EMPTY`, `failed: <reason>`, a restore's verification, … */
  flag?: string;
  /** For a modification: the task whose definition this one replaced. */
  replaces?: number;
}

export interface TaskEntry {
  task: number;
  request: string;
  changes: TaskChange[];
  answer: string;
  /** Tables observed in the task whose sample rows contain the answer's numbers. */
  from: string[];
}

const REQUEST_LIMIT = 1500;
const ANSWER_LIMIT = 1500;
const STATEMENT_LIMIT = 400;
const FUNCTION_LINES = 8;

export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

/** Numbers as the judge reads them: decimals, and integers of two or more digits. */
export function answerNumbers(answer: string): Set<string> {
  return new Set((answer.match(/-?\d+\.\d+|-?\d{2,}/g) ?? []).map(n => n.replace(/^-?0+(?=\d)/, m => m)));
}

function cellForms(value: unknown): string[] {
  if (typeof value !== "number" || Number.isNaN(value)) return [];
  const forms = new Set<string>([String(value)]);
  for (const digits of [2, 3, 4]) forms.add(value.toFixed(digits));
  if (Number.isInteger(value)) forms.add(String(value));
  return [...forms];
}

/** Tables whose sampled cells contain at least one number of the answer. */
export function answerSources(
  answer: string,
  observed: string[],
  results: ReadonlyMap<string, OperatorInfo>
): string[] {
  const numbers = answerNumbers(answer);
  if (!numbers.size) return [];
  const sources: string[] = [];
  for (const id of new Set(observed)) {
    const rows = (results.get(id)?.result ?? []) as Array<Record<string, unknown>>;
    const cells = new Set(rows.flatMap(row => Object.values(row ?? {}).flatMap(cellForms)));
    if ([...numbers].some(n => cells.has(n))) sources.push(id);
  }
  return sources;
}

function statementOf(op: OperatorPredicate | undefined, fallback: string): string {
  return clip(op?.nativeOp?.source ?? fallback, STATEMENT_LIMIT);
}

export interface BuildTaskEntryInput {
  task: number;
  /** Every step of the task, in order (the user request first). */
  steps: ReActStep[];
  /** Results at the end of the task, by operator id. */
  results: ReadonlyMap<string, OperatorInfo>;
  state: WorkflowState;
  history?: TaskHistory;
}

/** Fold the task's dataflow receipts into one change per operator: the last
 * status wins, a failure counts only for an id that never landed. */
export function buildTaskEntry(input: BuildTaskEntryInput): TaskEntry {
  const { task, steps, results, state, history } = input;
  const request = steps.find(step => step.role === "user")?.content ?? "";
  const answer = steps.filter(step => step.role === "agent" && step.isEnd).at(-1)?.content ?? "";
  const provenance = history?.provenance();
  const landed = new Map<string, { status: ChangeStatus; attempted?: string; message?: string }>();
  const observed: string[] = [];
  for (const step of steps) {
    for (const batch of nativeBatchResults(step)) {
      observed.push(...batch.observe);
      for (const outcome of batch.operators) {
        const previous = landed.get(outcome.id);
        if (outcome.status === "added" || outcome.status === "modified") {
          const restored = outcome.op === "restore";
          landed.set(outcome.id, {
            status: restored ? "restored" : previous?.status === "added" ? "added" : outcome.status,
          });
        } else if (outcome.status === "deleted") landed.set(outcome.id, { status: "deleted" });
        else if (outcome.status === "error" && !previous)
          landed.set(outcome.id, {
            status: "failed",
            attempted: outcome.attempted?.source,
            message: outcome.message.split("\n")[0],
          });
      }
    }
  }
  const changes: TaskChange[] = [];
  for (const [id, fold] of landed) {
    const op = state.getOperator(id);
    const info = results.get(id);
    if (fold.status === "failed") {
      if (op) continue; // a later statement landed this id
      changes.push({
        status: "failed",
        id,
        statement: clip(fold.attempted ?? id, STATEMENT_LIMIT),
        flag: `failed: ${clip(fold.message ?? "rejected", 160)}`,
      });
      continue;
    }
    if (fold.status === "deleted") {
      changes.push({ status: "deleted", id, statement: `${id} deleted` });
      continue;
    }
    const change: TaskChange = { status: fold.status, id, statement: statementOf(op, id) };
    const doc = op?.nativeOp?.properties?.doc;
    if (typeof doc === "string" && doc) change.doc = doc;
    else if (op?.nativeOp?.functions && Object.keys(op.nativeOp.functions).length)
      change.functions = Object.values(op.nativeOp.functions).map(body =>
        body.split("\n").slice(0, FUNCTION_LINES).join("\n")
      );
    if (info?.totalRowCount !== undefined) change.rows = info.totalRowCount;
    if (info?.resultSchema?.length) change.columns = info.resultSchema.map(field => field.name);
    if (info?.error) change.flag = "failed: current result unavailable";
    else if (info?.totalRowCount === 0) change.flag = "EMPTY";
    if (info?.note) change.flag = change.flag ? `${change.flag}; ${info.note}` : info.note;
    if (fold.status === "modified") {
      const events = provenance?.get(id);
      const earlier = [events?.created ?? 0, ...(events?.edited ?? [])].filter(t => t > 0 && t < task);
      if (earlier.length) change.replaces = Math.max(...earlier);
    }
    changes.push(change);
  }
  return {
    task,
    request: clip(request, REQUEST_LIMIT),
    changes,
    answer: clip(answer, ANSWER_LIMIT),
    from: answerSources(answer, observed, results),
  };
}

function renderChange(change: TaskChange): string {
  const lines: string[] = [];
  const head = `  ${change.status.padEnd(8)} ${change.statement}`;
  const facts: string[] = [];
  if (change.rows !== undefined) facts.push(`rows=${change.rows}`);
  if (change.columns?.length)
    facts.push(`cols=${change.columns.slice(0, 8).join(",")}${change.columns.length > 8 ? ",…" : ""}`);
  if (change.replaces !== undefined) facts.push(`replaces task ${change.replaces}`);
  if (change.flag) facts.push(change.flag.startsWith("EMPTY") ? `⚠ ${change.flag}` : change.flag);
  lines.push(facts.length ? `${head}\n           → ${facts.join("; ")}` : head);
  if (change.doc) lines.push(`           doc: ${change.doc}`);
  for (const body of change.functions ?? []) lines.push(`           ${body.replace(/\n/g, "\n           ")}`);
  return lines.join("\n");
}

/** One entry as one message. The text is final once written. */
export function renderTaskEntry(entry: TaskEntry): string {
  const changes = entry.changes.length ? entry.changes.map(renderChange).join("\n") : "  (no change to the dataflow)";
  const from = entry.from.length ? entry.from.join(", ") : "unverified";
  return `## Task ${entry.task}\n${entry.request}\nChanges:\n${changes}\nAnswer: ${entry.answer || "(none)"}\n  from: ${from}`;
}

/** What the current task starts from: every current table with the task that
 * created it and the tasks that changed it, and every table that is empty or
 * failed right now. Rendered fresh each task, after the cached entries. */
export function renderLiveIndex(
  state: WorkflowState,
  results: ReadonlyMap<string, OperatorInfo>,
  history?: TaskHistory
): string {
  const provenance = history?.provenance();
  const operators = state.getAllOperators().filter(op => !op.taskSource);
  if (!operators.length) return "# Tables now\n(none yet)";
  const items = operators.map(op => {
    const events = provenance?.get(op.operatorID);
    const when = events
      ? `t${events.created}${events.edited.length ? `, edited t${events.edited.join(",t")}` : ""}`
      : "this task";
    return `${op.operatorID} (${when})`;
  });
  const alerts = operators.flatMap(op => {
    const info = results.get(op.operatorID);
    if (info?.error) return [`⚠ ${op.operatorID} failed; its dependents have no current result`];
    if (info?.totalRowCount === 0) return [`⚠ ${op.operatorID} has 0 rows; everything built on it is empty`];
    return [];
  });
  return ["# Tables now", items.join(" · "), ...alerts].join("\n");
}
