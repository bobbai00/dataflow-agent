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
 * dataflow, the rows of the tables it read, and the answer. Built once when
 * the task is sealed and never rewritten, so the entries of a session form a
 * prefix that a provider's prompt cache can reuse, and each entry keeps what
 * later tasks come back for: the definitions (a convention hidden in a `def`
 * two hops upstream decided a whole 16-turn cascade in the university task)
 * and the numbers (half of all turns in trial 5 opened with an observe-only
 * call that re-read tables an earlier task had already shown).
 */
import type { ReActStep } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import type { WorkflowState } from "../workflow-state";
import { TOOL_NAME_DATAFLOW, asNativeBatchResult, nativeBatchResults } from "../tools/native-batch-tools";
import { getVisibleResultHeaders } from "../tools/tools-utility";
import type { TaskHistory } from "./task-history";
import { ownFlags } from "./flags";
import { renderRegisteredOperators } from "./registered-operators";
import type { DefinitionRegistry } from "./definition-registry";

export type ChangeStatus = "added" | "modified" | "restored" | "deleted" | "failed";

export interface TaskChange {
  status: ChangeStatus;
  id: string;
  /** The statement as written, whitespace-collapsed. */
  statement: string;
  /** The author's one-sentence doc of a custom operator. */
  doc?: string;
  /** The bodies of the functions the statement uses. */
  functions?: string[];
  rows?: number;
  columns?: string[];
  /** Columns with missing values and how many, over the whole table. */
  missing?: Array<[string, number]>;
  /** Every value of a column with few distinct values, with its count, over the whole table. */
  values?: Array<[string, Array<[string, number]>]>;
  /** `EMPTY`, `failed: <reason>`, a restore's verification, … */
  flag?: string;
  /** Contract flags this table's own operator raised (inherited ones are implied by lineage). */
  flags?: string[];
  /** For a modification: the task whose definition this one replaced. */
  replaces?: number;
  /** The step (dataflow call) that last landed this change, counted from 0 within the task. */
  call?: number;
  /** That step's stated description, when the tool asks for one. */
  step?: string;
}

/** The rows of a table the task observed, as the model saw them. */
export interface TaskTable {
  id: string;
  total: number;
  /** Every row is shown: the table is small and the engine held all of it. */
  complete: boolean;
  /** The rows as a TSV block (header, then `index<TAB>cells`). */
  text: string;
  /** Literal NULL/NaN strings look like missing scalars in the TSV display. */
  literalNullLikeValues?: boolean;
  /** The earlier task whose entry shows these same rows; the block is then not repeated. */
  sameAs?: number;
}

export interface TaskEntry {
  task: number;
  request: string;
  changes: TaskChange[];
  /** Tables the task observed, answer-bearing ones first. */
  tables: TaskTable[];
  answer: string;
  /** Tables observed in the task whose sample rows contain the answer's numbers. */
  from: string[];
}

const STATEMENT_LIMIT = 400;
/** A function longer than this keeps its first lines and says how many were cut. */
const FUNCTION_LINES = 80;
const STEP_LIMIT = 400;
/** A column is listed with its values when it has at most this many distinct ones. */
const FEW_VALUES = 5;
const VALUE_COLUMNS = 4;
/** A table with at most this many rows is kept whole; a larger one keeps its first rows. */
export const COMPLETE_ROWS = 20;
export const SAMPLE_ROWS = 3;
/** Characters of table rows an entry may hold; tables past the budget are listed without rows. */
export const TABLE_CHARS = 4000;
const CELL_CHARS = 60;

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

function renderCell(value: unknown): string {
  if (value === null || value === undefined || value === "NULL") return "NaN";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
  return flat.length <= CELL_CHARS ? flat : flat.slice(0, CELL_CHARS - 1) + "…";
}

/** The rows in the layout every observation uses: a header line, then one line
 * per row starting with its index. */
export function renderRows(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const headers = getVisibleResultHeaders(rows[0]);
  const lines = [`\t${headers.join("\t")}`];
  rows.forEach((row, i) => {
    const index = typeof row.__row_index__ === "number" ? row.__row_index__ : i;
    lines.push(`${index}\t${headers.map(h => renderCell(row[h])).join("\t")}`);
  });
  return lines.join("\n");
}

/** The rows an entry keeps for a table: the whole table when it is small and
 * the engine held every row, otherwise its first rows. Nothing for a failed
 * table or one whose rows were never fetched. */
export function entryTable(id: string, info: OperatorInfo | undefined): TaskTable | undefined {
  const held = info?.result as Array<Record<string, unknown>> | undefined;
  if (!info || info.error || !held?.length) return undefined;
  const total = info.totalRowCount ?? held.length;
  const complete = total <= COMPLETE_ROWS && held.length >= total;
  const rows = complete ? held : held.slice(0, SAMPLE_ROWS);
  const literalNullLikeValues = rows.some(row => Object.values(row).some(value => value === "NULL" || value === "NaN"));
  return { id, total, complete, text: renderRows(rows), ...(literalNullLikeValues ? { literalNullLikeValues } : {}) };
}

/** Missing counts and small value sets from the engine's whole-table profile.
 * Only a complete profile is used: a partial one would state wrong counts. */
export function profileFacts(info: OperatorInfo | undefined): Pick<TaskChange, "missing" | "values"> {
  const profile = info?.tableProfile;
  if (!profile || profile.status !== "available" || !profile.coverage.complete) return {};
  const columns = Object.entries(profile.columns ?? {}).filter(([name]) => !name.startsWith("__"));
  const missing = columns
    .filter(([, c]) => c.nullCount > 0)
    .map(([name, c]) => [name, c.nullCount] as [string, number]);
  const values = columns
    .filter(([, c]) => {
      // Categories, not numbers: a count per value of a numeric column is noise.
      if (c.type !== "str" && c.type !== "bool") return false;
      const f = c.frequencies;
      return f && !f.truncated && f.otherCount === 0 && f.values.length >= 2 && f.values.length <= FEW_VALUES;
    })
    .slice(0, VALUE_COLUMNS)
    .map(
      ([name, c]) =>
        [name, c.frequencies!.values.map(v => [String(v.value.value), v.count] as [string, number])] as [
          string,
          Array<[string, number]>,
        ]
    );
  return { ...(missing.length ? { missing } : {}), ...(values.length ? { values } : {}) };
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
  /** Lean entries: probes keep one line, only answer sources keep rows, a
   * function body is shown once per session. */
  lean?: boolean;
}

/** Fold the task's dataflow receipts into one change per operator: the last
 * status wins, a failure counts only for an id that never landed. */
export function buildTaskEntry(input: BuildTaskEntryInput): TaskEntry {
  const { task, steps, results, state, history, lean } = input;
  const request = steps.find(step => step.role === "user")?.content ?? "";
  const answer = steps.filter(step => step.role === "agent" && step.isEnd).at(-1)?.content ?? "";
  const provenance = history?.provenance();
  // Lean entries: a table nothing reads and the answer did not come from is a
  // probe; a function body an earlier entry already shows is referenced.
  const readBy = new Map<string, number>();
  for (const op of state.getAllOperators())
    for (const upstream of op.nativeOp?.inputs ?? []) readBy.set(upstream, (readBy.get(upstream) ?? 0) + 1);
  const shownFunctions = new Map<string, { task: number; id: string }>();
  if (lean)
    for (const entry of history?.entries() ?? [])
      for (const change of entry.changes)
        for (const body of change.functions ?? [])
          if (!body.startsWith("# def ") && !shownFunctions.has(body))
            shownFunctions.set(body, { task: entry.task, id: change.id });
  const landed = new Map<
    string,
    { status: ChangeStatus; attempted?: string; message?: string; call: number; position: number; step?: string }
  >();
  const observed: string[] = [];
  let call = 0;
  let position = 0;
  for (const step of steps) {
    // The `reasoning` of each dataflow call (stable's dataflowReasoning) names its step.
    const reasons = (step.toolCalls ?? [])
      .filter(
        tc =>
          tc.toolName === TOOL_NAME_DATAFLOW &&
          asNativeBatchResult(step.toolResults?.find(tr => tr.toolCallId === tc.toolCallId)?.output)
      )
      .map(tc => {
        const reasoning = (tc.input as { reasoning?: unknown } | undefined)?.reasoning;
        return typeof reasoning === "string" && reasoning.trim() ? reasoning.trim() : undefined;
      });
    for (const [index, batch] of nativeBatchResults(step).entries()) {
      observed.push(...batch.observe);
      for (const outcome of batch.operators) {
        const previous = landed.get(outcome.id);
        // Each change belongs to the step that last landed it: the step that
        // produced its final definition. Earlier attempts leave no trace.
        const at = { call, position: position++, step: reasons[index] };
        if (outcome.status === "added" || outcome.status === "modified") {
          const restored = outcome.op === "restore";
          landed.set(outcome.id, {
            status: restored ? "restored" : previous?.status === "added" ? "added" : outcome.status,
            ...at,
          });
        } else if (outcome.status === "deleted") {
          // Added and removed within the task: no net change.
          if (previous?.status === "added") landed.delete(outcome.id);
          else landed.set(outcome.id, { status: "deleted", ...at });
        } else if (outcome.status === "error" && !previous)
          landed.set(outcome.id, {
            status: "failed",
            attempted: outcome.attempted?.source,
            message: outcome.message.split("\n")[0],
            ...at,
          });
      }
      call++;
    }
  }
  const from = answerSources(answer, observed, results);
  const changes: TaskChange[] = [];
  for (const [id, fold] of landed) {
    const op = state.getOperator(id);
    const info = results.get(id);
    const probe = lean === true && !(readBy.get(id) ?? 0) && !from.includes(id);
    if (fold.status === "failed") {
      if (op) continue; // a later statement landed this id
      changes.push({
        status: "failed",
        id,
        statement: clip(fold.attempted ?? id, STATEMENT_LIMIT),
        flag: `failed: ${clip(fold.message ?? "rejected", 160)}`,
        call: fold.call,
      });
      continue;
    }
    const placed = { call: fold.call, ...(fold.step ? { step: fold.step } : {}) };
    if (fold.status === "deleted") {
      changes.push({ status: "deleted", id, statement: `${id} deleted`, ...placed });
      continue;
    }
    const change: TaskChange = { status: fold.status, id, statement: statementOf(op, id), ...placed };
    const doc = op?.nativeOp?.properties?.doc;
    if (typeof doc === "string" && doc) change.doc = doc;
    // Bodies stay with the doc: a later task that revises or reproduces an
    // earlier formula needs the code, not only its one-sentence summary.
    if (op?.nativeOp?.functions && Object.keys(op.nativeOp.functions).length)
      change.functions = Object.entries(op.nativeOp.functions).map(([name, source]) => {
        const lines = source.split("\n");
        const body =
          lines.length <= FUNCTION_LINES
            ? source
            : [...lines.slice(0, FUNCTION_LINES), `# … ${lines.length - FUNCTION_LINES} more lines`].join("\n");
        const earlier = lean ? shownFunctions.get(body) : undefined;
        return earlier ? `# def ${name}: code as in task ${earlier.task} (${earlier.id})` : body;
      });
    if (info?.totalRowCount !== undefined) change.rows = info.totalRowCount;
    if (!probe) {
      if (info?.resultSchema?.length) change.columns = info.resultSchema.map(field => field.name);
      Object.assign(change, profileFacts(info));
    }
    if (info?.error) change.flag = "failed: current result unavailable";
    else if (info?.totalRowCount === 0) change.flag = "EMPTY";
    if (info?.note) change.flag = change.flag ? `${change.flag}; ${info.note}` : info.note;
    const flagged = ownFlags(id, info).filter(flag => flag.code !== "EMPTY");
    if (flagged.length) change.flags = flagged.map(flag => flag.text);
    if (fold.status === "modified") {
      const events = provenance?.get(id);
      const earlier = [events?.created ?? 0, ...(events?.edited ?? [])].filter(t => t > 0 && t < task);
      if (earlier.length) change.replaces = Math.max(...earlier);
    }
    changes.push(change);
  }
  const order = new Map([...landed].map(([id, fold]) => [id, fold.position]));
  changes.sort((a, b) => (a.call ?? 0) - (b.call ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  // The rows the task read, answer-bearing tables first. Rows an earlier entry
  // already shows, unchanged, are named rather than repeated; a table that does
  // not fit the entry's budget is listed by size alone. Lean entries keep rows
  // for the answer's sources only.
  const shown = new Map<string, { task: number; text: string }>();
  for (const entry of history?.entries() ?? [])
    for (const table of entry.tables) if (!table.sameAs) shown.set(table.id, { task: entry.task, text: table.text });
  const tables: TaskTable[] = [];
  let budget = TABLE_CHARS;
  for (const id of new Set([...from, ...observed])) {
    if (!state.getOperator(id)) continue;
    const table = entryTable(id, results.get(id));
    if (!table) continue;
    const earlier = shown.get(id);
    if (earlier && earlier.text === table.text) {
      tables.push({ ...table, text: "", sameAs: earlier.task });
      continue;
    }
    if (lean && !from.includes(id)) {
      tables.push({ ...table, text: "" });
      continue;
    }
    if (table.text.length > budget) {
      tables.push({ ...table, text: "" });
      continue;
    }
    budget -= table.text.length;
    tables.push(table);
  }
  // The request and the answer stay whole: a session's first request carries
  // the rules every later task inherits (cleaning, rounding, conventions), past
  // any fixed cut; clipping it at 1500 characters lost github's rounding rule.
  return { task, request: request.trim(), changes, tables, answer: answer.trim(), from };
}

function renderChange(change: TaskChange): string {
  const lines: string[] = [];
  const head = `  ${change.status.padEnd(8)} ${change.statement}`;
  const facts: string[] = [];
  if (change.rows !== undefined) facts.push(`rows=${change.rows}`);
  if (change.columns?.length) facts.push(`cols=${change.columns.join(",")}`);
  if (change.replaces !== undefined) facts.push(`replaces task ${change.replaces}`);
  if (change.flag) facts.push(change.flag.startsWith("EMPTY") ? `⚠ ${change.flag}` : change.flag);
  lines.push(facts.length ? `${head}\n           → ${facts.join("; ")}` : head);
  if (change.missing?.length)
    lines.push(`           missing: ${change.missing.map(([c, n]) => `${c}=${n}`).join(", ")}`);
  for (const [column, counts] of change.values ?? [])
    lines.push(`           values: ${column} = ${counts.map(([v, n]) => `${clip(v, 40)} ${n}`).join(" | ")}`);
  if (change.doc) lines.push(`           doc: ${change.doc}`);
  for (const text of change.flags ?? []) lines.push(`           ⚠ ${text}`);
  for (const body of change.functions ?? []) lines.push(`           ${body.replace(/\n/g, "\n           ")}`);
  return lines.join("\n");
}

function renderTable(table: TaskTable): string {
  const rows = `${table.total} row${table.total === 1 ? "" : "s"}`;
  if (table.sameAs) return `  ${table.id}: same rows as shown in task ${table.sameAs}`;
  if (!table.text) return `  ${table.id}: ${rows}, not shown here`;
  const size = table.complete ? `${rows}, complete` : `first ${SAMPLE_ROWS} of ${rows}`;
  return `  ${table.id} (${size}):\n${table.text.replace(/^/gm, "  ")}`;
}

/** With the definition registry, a function is shown by its signature line:
 * the body persists with the operator (shared functions), so calling it by
 * name needs no code, and `inspect` returns the exact body for a revision. */
function signatureOf(body: string): string {
  const lines = body.split("\n");
  const head = lines.find(line => /^\s*(async\s+)?def\s+/.test(line)) ?? lines[0];
  const count = lines.filter(line => line.trim() && !line.trim().startsWith("# …")).length;
  return `${head.trim()} … (${count} lines; inspect for the body)`;
}

/** One entry as one message. The text is final once written. */
export function renderTaskEntry(entry: TaskEntry, compact = false, options: { signatures?: boolean } = {}): string {
  if (compact) return renderCompactTaskEntry(entry, options.signatures === true);
  // Changes grouped by the step that produced them, steps in the order they
  // ran and numbered from 1. Without stated steps the changes stay flat.
  const stated = entry.changes.some(change => change.step);
  const lines: string[] = [];
  let current: number | undefined;
  let number = 0;
  for (const change of entry.changes) {
    if (stated && change.call !== current) {
      current = change.call;
      number++;
      lines.push(`  Step ${number}: ${change.step ? clip(change.step, STEP_LIMIT) : "(not described)"}`);
    }
    lines.push(stated ? renderChange(change).replace(/^/gm, "  ") : renderChange(change));
  }
  const changes = lines.length ? lines.join("\n") : "  (no change to the dataflow)";
  const tables = entry.tables.length ? `\nTables read:\n${entry.tables.map(renderTable).join("\n")}` : "";
  const from = entry.from.length ? entry.from.join(", ") : "unverified";
  return `## Task ${entry.task}\n${entry.request}\nChanges:\n${changes}${tables}\nAnswer: ${entry.answer || "(none)"}\n  from: ${from}`;
}

/** Sizes of a shortened entry (a context budget): characters kept of the
 * request, of each statement and of the answer. */
const INDEX_REQUEST_CHARS = 600;
const INDEX_STATEMENT_CHARS = 200;
const INDEX_ANSWER_CHARS = 500;

/** A completed task in a few lines, for a context budget: its request (the
 * whole of it with `keepRequest`, which the first task gets, since it states
 * the session's rules), each table it made with its statement, size, doc and
 * flag, and its answer. Exact excerpts, not a summary; `recall` returns the
 * full entry. */
export function renderIndexTaskEntry(entry: TaskEntry, keepRequest = false): string {
  const lines = [
    `## Task ${entry.task} (shortened for the context budget; recall ${entry.task} for the full entry)`,
    keepRequest ? entry.request : clip(entry.request, INDEX_REQUEST_CHARS),
  ];
  for (const change of entry.changes) {
    if (change.status === "failed") continue;
    const size = [
      change.rows !== undefined ? `rows=${change.rows}` : "",
      change.columns?.length ? `cols=${change.columns.length}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    // The doc is repeated only when the shown part of the statement lacks it.
    const statement = clip(change.statement, INDEX_STATEMENT_CHARS);
    const doc = change.doc && !statement.includes(change.doc) ? `; doc: ${clip(change.doc, 160)}` : "";
    lines.push(`${change.status} ${statement}${size ? `; ${size}` : ""}${doc}${change.flag ? `; ${change.flag}` : ""}`);
  }
  lines.push(`Answer: ${clip(entry.answer || "(none)", INDEX_ANSWER_CHARS)}`);
  return lines.join("\n");
}

/** A completed task in one line: its question, the tables it made and its answer. */
export function renderStubTaskEntry(entry: TaskEntry): string {
  const question =
    entry.request.split("\n").find(line => line.trim().startsWith("Question:")) ?? entry.request.split("\n")[0] ?? "";
  const tables = entry.changes.filter(change => change.status !== "failed").map(change => change.id);
  return `## Task ${entry.task} (recall ${entry.task}): ${clip(question.trim(), 200)} → tables ${
    tables.slice(0, 6).join(", ") || "none"
  }${tables.length > 6 ? ` (+${tables.length - 6})` : ""}; answer ${clip(entry.answer || "(none)", 160)}`;
}

/** Exact content with shared presentation, not a generated summary. Nothing
 * depends on a future task, so sealed entries stay a reusable cache prefix. */
function renderCompactTaskEntry(entry: TaskEntry, signatures = false): string {
  const lines = [`## Task ${entry.task}`, entry.request, "Changes:"];
  const schemas = new Map<string, string>();
  const functions = new Map<string, string>();
  let call: number | undefined;
  for (const change of entry.changes) {
    if (change.step && (call !== change.call || call === undefined))
      lines.push(`Step ${(change.call ?? 0) + 1}: ${change.step}`);
    call = change.call;
    const facts: string[] = [];
    if (change.rows !== undefined) facts.push(`rows=${change.rows}`);
    if (change.columns?.length) {
      const schema = JSON.stringify(change.columns);
      const prior = schemas.get(schema);
      facts.push(prior ? `cols=as ${prior}` : `cols=${change.columns.join(",")}`);
      if (!prior) schemas.set(schema, change.id);
    }
    if (change.replaces !== undefined) facts.push(`replaces task ${change.replaces}`);
    if (change.flag) facts.push(change.flag);
    lines.push(`${change.status} ${change.statement}${facts.length ? `; ${facts.join("; ")}` : ""}`);
    if (
      change.doc &&
      !change.statement.includes(`doc=${JSON.stringify(change.doc)}`) &&
      !change.statement.includes(`doc='${change.doc}'`)
    )
      lines.push(`doc: ${change.doc}`);
    for (const text of change.flags ?? []) lines.push(`⚠ ${text}`);
    for (const body of change.functions ?? []) {
      if (signatures) {
        lines.push(signatureOf(body));
        continue;
      }
      const prior = functions.get(body);
      lines.push(prior ? `function code as in ${prior}` : body);
      if (!prior) functions.set(body, change.id);
    }
    // The archive's row renderer shows a literal "NULL" as NaN, and a string
    // "NaN" looks like a missing scalar. Exact category facts disambiguate them.
    const ambiguousCategory = change.values?.some(([, counts]) =>
      counts.some(([value]) => value === "NULL" || value === "NaN")
    );
    const visible =
      !ambiguousCategory &&
      entry.tables.find(
        t =>
          t.id === change.id && t.complete && t.text && !t.literalNullLikeValues && !/[.…]{3}|…|truncated/.test(t.text)
      );
    if (!visible) {
      if (change.missing?.length) lines.push(`missing: ${change.missing.map(([c, n]) => `${c}=${n}`).join(", ")}`);
      for (const [column, counts] of change.values ?? [])
        lines.push(`values: ${column} = ${counts.map(([v, n]) => `${clip(v, 40)} ${n}`).join(" | ")}`);
    }
  }
  if (!entry.changes.length) lines.push("(no change to the dataflow)");
  if (entry.tables.length) lines.push("Tables read:");
  const shown: TaskTable[] = [];
  for (const table of entry.tables) {
    const [header, ...rows] = table.text.split("\n");
    const same =
      table.text &&
      shown.find(previous => {
        const [oldHeader, ...oldRows] = previous.text.split("\n");
        return header === oldHeader && rows.length <= oldRows.length && rows.every((r, i) => r === oldRows[i]);
      });
    if (same)
      lines.push(
        `${table.id}: ${table.total} rows${table.complete ? ", complete" : ", sample only"}; same displayed rows as ${same.id}${same.text.split("\n").length > rows.length + 1 ? ` (first ${rows.length})` : ""}`
      );
    else {
      lines.push(renderTable(table).replace(/^  /gm, ""));
      if (table.text) shown.push(table);
    }
  }
  lines.push(`Answer: ${entry.answer || "(none)"}`, `from: ${entry.from.join(", ") || "unverified"}`);
  return lines.join("\n");
}

/** Ancestors of an operator in the current graph, by the input ids its statement names. */
function ancestors(state: WorkflowState, id: string, seen = new Set<string>()): Set<string> {
  for (const input of state.getOperator(id)?.nativeOp?.inputs ?? []) {
    if (seen.has(input) || !state.getOperator(input)) continue;
    seen.add(input);
    ancestors(state, input, seen);
  }
  return seen;
}

/** What the current task starts from: every current table with the task that
 * created it, the tasks that changed it, and the latest task that changed
 * something upstream of it since (its rows in an earlier entry are then
 * outdated), and every table that is empty or failed right now. Rendered fresh
 * each task, after the cached entries. */
export function renderLiveIndex(
  state: WorkflowState,
  results: ReadonlyMap<string, OperatorInfo>,
  history?: TaskHistory,
  registry?: Pick<DefinitionRegistry, "liftedOperators">
): string {
  const provenance = history?.provenance();
  const operators = state.getAllOperators().filter(op => !op.taskSource);
  if (!operators.length) return "# Tables now\n(none yet)";
  const lastChange = (id: string) => {
    const events = provenance?.get(id);
    return events ? Math.max(events.created, ...events.edited) : 0;
  };
  const items = operators.map(op => {
    const events = provenance?.get(op.operatorID);
    if (!events) return `${op.operatorID} (this task)`;
    const own = lastChange(op.operatorID);
    const upstream = Math.max(0, ...[...ancestors(state, op.operatorID)].map(lastChange));
    const parts = [`t${events.created}`];
    if (events.edited.length) parts.push(`edited t${events.edited.join(",t")}`);
    if (upstream > own) parts.push(`recomputed t${upstream}`);
    return `${op.operatorID} (${parts.join(", ")})`;
  });
  const alerts = operators.flatMap(op => {
    const info = results.get(op.operatorID);
    if (info?.error) return [`⚠ ${op.operatorID} failed; its dependents have no current result`];
    if (info?.totalRowCount === 0) return [`⚠ ${op.operatorID} has 0 rows; everything built on it is empty`];
    return [];
  });
  return [
    "# Tables now",
    items.join(" · "),
    ...renderRegisteredOperators(state, undefined, registry),
    ...alerts,
    ...flagAlerts(operators, results),
  ].join("\n");
}

/** The contract flags current tables raised themselves, one line each, for a
 * task-start index; inherited copies are implied by lineage. A table nothing
 * reads is a probe or a report: its flags concern nothing downstream, and a
 * probe's "filter kept 0 rows" repeated in every prompt of a session was
 * noise (Survey, 2026-09-26). */
export function flagAlerts(
  operators: OperatorPredicate[],
  results: ReadonlyMap<string, OperatorInfo>,
  limit = 8
): string[] {
  const read = new Set(operators.flatMap(op => op.nativeOp?.inputs ?? []));
  return operators
    .filter(op => read.has(op.operatorID))
    .flatMap(op =>
      ownFlags(op.operatorID, results.get(op.operatorID))
        .filter(flag => flag.code !== "EMPTY")
        .map(flag => `⚠ ${op.operatorID}: ${flag.text}`)
    )
    .slice(0, limit);
}
