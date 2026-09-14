/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * RESULT SELECTION — which operator results to ship to the model, at what
 * fidelity (`resultSelection: "rule"`).
 *
 * The agent wrote the parameters; the data wrote the results. Ship a result
 * only where the data, not the parameters, decided it. Native operators make
 * this decidable per type (catalog.ts `rowEffect`), and the engine's
 * per-table statistics say whether the data actually moved.
 *
 *   full    schema + stats + sample      Scan, Aggregate, Join, UDF outputs;
 *                                        the INPUT of any Aggregate / Join /
 *                                        UDF (its grain is what the consumer
 *                                        depends on, and this table is the
 *                                        last place it is visible); every
 *                                        frontier operator (no consumer yet —
 *                                        the table the agent is about to act
 *                                        on); anything errored or non-native.
 *   count   `Output Table: N rows (from M)`  Filter, Distinct, Union, Limit
 *                                        whose output feeds a row-preserving
 *                                        operator or another row-dropper.
 *   header  operator + Properties only   Project, Sort; Compute whose new /
 *                                        replaced columns have the same null
 *                                        and distinct counts as before.
 *
 * Between two shipped tables the operators fuse into one stage from the
 * agent's point of view: it sees the stage's input, the stage's output, and
 * one count per row-set change inside.
 */

import type { OperatorInfo } from "../../types/execution";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";

export type ResultShape = "full" | "count" | "header";

export interface ShapeDecision {
  shape: ResultShape;
  /** Compute only: which columns' null/distinct counts moved, rendered on the count line. */
  note?: string;
  /** `scoped` selection, full shape only: the columns whose statistics and
   *  sample values render (the `Output Table` line and the Schema line stay
   *  complete). An empty list drops the stats block. Undefined = every column. */
  columns?: string[];
  /** `scoped` selection, full shape only: the share (0..1) of the arm's
   *  per-operator result character budget (`maxOperatorResultCharLimit`) the
   *  sample may use. 1 = the whole budget (no extra cap), 0 = counts and
   *  annotations only, no rows. Undefined = the whole budget. */
  budget?: number;
  /** `scoped` selection: render the complete `Schema:` line, so the column
   *  inventory stays visible when the stats block is scoped to a few columns. */
  schemaLine?: boolean;
}

/** Consumers whose result depends on the grain of their input table. */
const GRAIN_SENSITIVE = new Set(["Aggregate", "Join", "UDF"]);

interface ColFacts {
  nulls?: number;
  distinct?: number;
  min?: string;
  max?: string;
}

function parseFacts(text: string | undefined): ColFacts | undefined {
  if (!text) return undefined;
  const n = /null=(\d+)/.exec(text);
  const d = /distinct=(\d+)/.exec(text);
  const mn = /\bmin=([^,]+)/.exec(text);
  const mx = /\bmax=([^,]+)/.exec(text);
  return {
    nulls: n ? Number(n[1]) : undefined,
    distinct: d ? Number(d[1]) : undefined,
    min: mn ? mn[1].trim() : undefined,
    max: mx ? mx[1].trim() : undefined,
  };
}

/** `files` of a Scan as a list of path patterns. */
function scanFiles(op: OperatorPredicate): string[] {
  const f = op.nativeOp?.properties?.files;
  return Array.isArray(f) ? f.map(String) : typeof f === "string" ? [f] : [];
}

/** True when `path` is `pattern` or matches it as a glob (`*`, `?`, `**`). */
function globCovers(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!/[*?[]/.test(pattern)) return false;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*") +
      "$"
  );
  return re.test(path);
}

/**
 * PROBE RETIREMENT — a `preview` Scan exists to inspect a file before its real
 * Scan. Once a real Scan covers the same file(s) and nothing reads the preview,
 * its raw lines are spent: render the header only, pointing at the real Scan.
 * An errored preview nobody reads collapses the same way, carrying the error's
 * first line. Independent of `resultSelection` (it is about probes, not about
 * what the data decided), so LATEST and DELTA both apply it.
 */
export function retiredPreviews(
  operators: readonly OperatorPredicate[],
  links: readonly OperatorLink[],
  getInfo: (opId: string) => OperatorInfo | undefined
): Map<string, ShapeDecision> {
  const out = new Map<string, ShapeDecision>();
  const hasConsumer = new Set(links.map(l => l.source.operatorID));
  const realScans = operators.filter(o => o.nativeOp?.type === "Scan" && !o.nativeOp.properties?.preview);
  for (const op of operators) {
    if (op.nativeOp?.type !== "Scan" || !op.nativeOp.properties?.preview || hasConsumer.has(op.operatorID)) continue;
    const info = getInfo(op.operatorID);
    if (info?.error) {
      out.set(op.operatorID, { shape: "header", note: `[ERROR] ${info.error.split("\n")[0].slice(0, 200)}` });
      continue;
    }
    const files = scanFiles(op);
    const by = realScans.find(r => files.length > 0 && files.every(f => scanFiles(r).some(pat => globCovers(pat, f))));
    if (by) out.set(op.operatorID, { shape: "header", note: `(preview superseded by scan \`${by.operatorID}\`)` });
  }
  return out;
}

export function selectResultShapes(
  operators: readonly OperatorPredicate[],
  links: readonly OperatorLink[],
  getInfo: (opId: string) => OperatorInfo | undefined
): Map<string, ShapeDecision> {
  const byId = new Map(operators.map(o => [o.operatorID, o]));
  const consumers = new Map<string, OperatorPredicate[]>();
  for (const l of links) {
    const tgt = byId.get(l.target.operatorID);
    if (!tgt) continue;
    const arr = consumers.get(l.source.operatorID) ?? [];
    arr.push(tgt);
    consumers.set(l.source.operatorID, arr);
  }

  const out = new Map<string, ShapeDecision>();
  for (const op of operators) {
    out.set(op.operatorID, decide(op, consumers.get(op.operatorID) ?? [], getInfo));
  }
  for (const [id, d] of retiredPreviews(operators, links, getInfo)) out.set(id, d);
  return out;
}

function decide(
  op: OperatorPredicate,
  consumers: OperatorPredicate[],
  getInfo: (opId: string) => OperatorInfo | undefined
): ShapeDecision {
  const nat = op.nativeOp;
  if (!nat) return { shape: "full" };
  const info = getInfo(op.operatorID);
  if (!info || info.error) return { shape: "full" };
  // Frontier: nothing consumes this table yet — it is what the agent acts on next.
  if (consumers.length === 0) return { shape: "full" };
  // A grain-sensitive consumer (or an opaque one) needs the whole input table.
  if (consumers.some(c => !c.nativeOp || GRAIN_SENSITIVE.has(c.nativeOp.type))) return { shape: "full" };

  switch (nat.type) {
    case "Scan":
    case "Aggregate":
    case "Join":
    case "UDF":
      return { shape: "full" };
    case "Filter":
    case "Distinct":
    case "Union":
    case "Unpivot":
    case "Limit":
      return { shape: "count" };
    case "Project":
    case "Sort":
      return { shape: "header" };
    case "Compute":
      return decideCompute(nat.properties, nat.inputs[0], info, getInfo);
    default:
      return { shape: "full" };
  }
}

function decideCompute(
  props: Record<string, unknown>,
  inputId: string | undefined,
  info: OperatorInfo,
  getInfo: (opId: string) => OperatorInfo | undefined
): ShapeDecision {
  const cols = Object.keys((props.columns as Record<string, unknown>) ?? {});
  const inInfo = inputId ? getInfo(inputId) : undefined;
  const notes: string[] = [];
  for (const c of cols) {
    const after = parseFacts(info.columnStats?.[c]);
    const before = parseFacts(inInfo?.columnStats?.[c]);
    if (!after) continue;
    if (!before) {
      // New column: its profile is new information — one line.
      notes.push(`"${c}": ${info.columnStats?.[c] ?? "new column"}`);
      continue;
    }
    const nullMoved = before.nulls !== undefined && after.nulls !== undefined && before.nulls !== after.nulls;
    const distinctMoved =
      before.distinct !== undefined && after.distinct !== undefined && before.distinct !== after.distinct;
    if (nullMoved || distinctMoved) {
      const parts: string[] = [];
      if (nullMoved) parts.push(`null ${before.nulls} → ${after.nulls}`);
      if (distinctMoved) parts.push(`distinct ${before.distinct} → ${after.distinct}`);
      notes.push(`"${c}": ${parts.join(", ")}`);
    }
  }
  if (notes.length === 0) return { shape: "header" };
  return { shape: "count", note: notes.join("; ") };
}

/* ============================================================================
 *  SCOPED SELECTION (`resultSelection: "scoped"`)
 *
 *  The rule above decides WHETHER a table ships (full / count / header). The
 *  scoped selection also decides HOW MUCH of a shipped table: which columns
 *  carry statistics and sample values, and how many sample rows — from the
 *  operator's type and from the columns its own parameters and its consumers'
 *  parameters name. A Filter on `year` ships its row count, the complete
 *  Schema line and the `year` column's statistics; a Compute ships three rows
 *  of source column next to new column; an Aggregate ships its whole table
 *  (≤ 20 rows); a Scan or UDF ships everything.
 *
 *  Decided once per event and never revised in place — an append-only prompt
 *  is what the provider's prefix cache credits. The DELTA renderer also ships
 *  an upstream-caused re-execution as one `profileDiff` line instead of the
 *  table again.
 * ========================================================================= */

/** Share of the per-operator result character budget the sample may use, per
 *  type. Scales with the arm's `maxOperatorResultCharLimit` instead of fixing
 *  a row count: a scan keeps the whole budget, a compute a third of it (enough
 *  rows to check the expression), a filter none (its count and the predicate
 *  column's statistics are the evidence). 0 = counts and annotations only. */
const SCOPED_BUDGET: Record<string, number> = {
  Scan: 1,
  UDF: 1,
  Aggregate: 1,
  Distinct: 1,
  Limit: 1,
  Join: 0.3,
  Compute: 0.3,
  Unpivot: 0.2,
  Sort: 0.2,
  Filter: 0,
  Project: 0,
  Union: 0,
};
/** A Filter whose predicate matches text shows a few surviving rows. */
const TEXT_FILTER_BUDGET = 0.2;

/** Types whose table IS the summary: small, every column, no scoping. */
const WHOLE_TABLE = new Set(["Scan", "UDF", "Aggregate", "Distinct", "Limit"]);

const IDENT_RE = /"([^"]+)"|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

/** Column names an SQL expression mentions, among `known`. String literals are
 *  blanked first so `'web fraud'` never reads as a column. */
function identifiersIn(expr: unknown, known: ReadonlySet<string>): string[] {
  if (typeof expr !== "string") return [];
  const out: string[] = [];
  const bare = expr.replace(/'(?:[^']|'')*'/g, " ");
  IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT_RE.exec(bare)) !== null) {
    const name = m[1] ?? m[2];
    if (name && known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** An operator's output columns, from its stats or, failing that, its sample. */
function columnsOf(info: OperatorInfo | undefined): string[] {
  if (!info) return [];
  const fromStats = info.columnStats ? Object.keys(info.columnStats).filter(k => !k.startsWith("__")) : [];
  if (fromStats.length > 0) return fromStats;
  const row = Array.isArray(info.result) ? info.result[0] : undefined;
  return row && typeof row === "object" ? Object.keys(row).filter(k => !k.startsWith("__")) : [];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The columns an operator's parameters name, resolved against `known` (the
 * columns of the table being described). `side: "reads"` = what it reads from
 * its input (scopes the INPUT table it consumes); `"all"` = reads and writes
 * (scopes its own output).
 */
export function referencedColumns(
  op: OperatorPredicate,
  known: ReadonlySet<string>,
  side: "all" | "reads" = "all"
): string[] {
  const nat = op.nativeOp;
  if (!nat) return [];
  const p = nat.properties ?? {};
  const out: string[] = [];
  const add = (...names: unknown[]) => {
    for (const n of names) if (typeof n === "string" && n && known.has(n) && !out.includes(n)) out.push(n);
  };
  switch (nat.type) {
    case "Filter":
      add(...identifiersIn(p.predicate, known));
      break;
    case "Compute": {
      const cols = (p.columns as Record<string, unknown> | undefined) ?? {};
      if (side === "all") add(...Object.keys(cols));
      for (const e of Object.values(cols)) add(...identifiersIn(e, known));
      break;
    }
    case "Join":
      for (const pair of Array.isArray(p.on) ? (p.on as unknown[]) : []) add(...strs(pair));
      break;
    case "Aggregate": {
      add(...strs(p.groupBy));
      for (const a of Array.isArray(p.aggregations) ? (p.aggregations as Array<Record<string, unknown>>) : []) {
        add(a?.col);
        if (side === "all") add(a?.as ?? (typeof a?.col === "string" ? `${String(a.fn)}_${a.col}` : "count"));
      }
      break;
    }
    case "Sort":
      for (const b of Array.isArray(p.by) ? (p.by as Array<Record<string, unknown>>) : []) add(b?.col);
      break;
    case "Distinct":
      add(...strs(p.columns));
      break;
    case "Project":
      if (side === "reads") {
        add(...strs(p.keep));
        add(...Object.keys((p.rename as Record<string, unknown> | undefined) ?? {}));
      }
      break;
    case "Unpivot":
      if (side === "reads") add(...strs(p.columns));
      else add(p.nameColumn ?? "variable", p.valueColumn ?? "value");
      break;
    default:
      break;
  }
  return out;
}

/** A Filter whose predicate matches text (a string literal): a few surviving
 *  rows show whether the match did what was meant. */
function matchesText(op: OperatorPredicate): boolean {
  const pred = op.nativeOp?.properties?.predicate;
  return typeof pred === "string" && /'[^']*'/.test(pred);
}

export function selectScopedShapes(
  operators: readonly OperatorPredicate[],
  links: readonly OperatorLink[],
  getInfo: (opId: string) => OperatorInfo | undefined
): Map<string, ShapeDecision> {
  const base = selectResultShapes(operators, links, getInfo);
  const byId = new Map(operators.map(o => [o.operatorID, o]));
  const consumers = new Map<string, OperatorPredicate[]>();
  for (const l of links) {
    const tgt = byId.get(l.target.operatorID);
    if (!tgt) continue;
    const arr = consumers.get(l.source.operatorID) ?? [];
    arr.push(tgt);
    consumers.set(l.source.operatorID, arr);
  }
  const out = new Map<string, ShapeDecision>();
  for (const op of operators) {
    const d: ShapeDecision = base.get(op.operatorID) ?? { shape: "full" };
    const nat = op.nativeOp;
    const info = getInfo(op.operatorID);
    // Only a shipped table (full shape) has an amount to decide; errors, code
    // operators, retired previews and count / header shapes pass through.
    if (!nat || !info || info.error || d.shape !== "full" || d.note) {
      out.set(op.operatorID, d);
      continue;
    }
    const budget = SCOPED_BUDGET[nat.type] ?? 1;
    if (WHOLE_TABLE.has(nat.type)) {
      out.set(op.operatorID, { ...d, budget });
      continue;
    }
    const own = new Set(columnsOf(info));
    const scope = referencedColumns(op, own, "all");
    // The next operators' own parameters say which columns of this table they
    // depend on — those carry statistics here too.
    for (const c of consumers.get(op.operatorID) ?? []) {
      for (const col of referencedColumns(c, own, "reads")) if (!scope.includes(col)) scope.push(col);
    }
    const share = nat.type === "Filter" && matchesText(op) ? TEXT_FILTER_BUDGET : budget;
    out.set(op.operatorID, { ...d, columns: scope, budget: share, schemaLine: true });
  }
  return out;
}

/**
 * One line saying what moved between two runs of the same operator: the row
 * count, then per column null / distinct / min / max, then columns that
 * appeared or vanished (at most four columns, then a count). Undefined when
 * nothing moved.
 */
export function profileDiff(prev: OperatorInfo, curr: OperatorInfo): string | undefined {
  const rows = (i: OperatorInfo) => (typeof i.totalRowCount === "number" ? i.totalRowCount : i.outputTuples);
  const parts: string[] = [];
  if (rows(prev) !== rows(curr)) parts.push(`rows ${rows(prev)} → ${rows(curr)}`);
  const pc = prev.columnStats ?? {};
  const cc = curr.columnStats ?? {};
  const cols = [...new Set([...Object.keys(pc), ...Object.keys(cc)])].filter(k => !k.startsWith("__"));
  const colParts: string[] = [];
  for (const c of cols) {
    if (!(c in pc)) {
      colParts.push(`+"${c}"`);
      continue;
    }
    if (!(c in cc)) {
      colParts.push(`-"${c}"`);
      continue;
    }
    const a = parseFacts(pc[c]);
    const b = parseFacts(cc[c]);
    const f: string[] = [];
    if (b?.nulls !== undefined && a?.nulls !== b.nulls) f.push(`null ${a?.nulls ?? "?"} → ${b.nulls}`);
    if (b?.distinct !== undefined && a?.distinct !== b.distinct)
      f.push(`distinct ${a?.distinct ?? "?"} → ${b.distinct}`);
    if (b?.min !== undefined && a?.min !== b.min) f.push(`min ${a?.min ?? "?"} → ${b.min}`);
    if (b?.max !== undefined && a?.max !== b.max) f.push(`max ${a?.max ?? "?"} → ${b.max}`);
    if (f.length > 0) colParts.push(`"${c}": ${f.join(", ")}`);
  }
  const MAX_COLS = 4;
  parts.push(...colParts.slice(0, MAX_COLS));
  const more = colParts.length - MAX_COLS;
  if (more > 0) parts.push(`… ${more} more column${more === 1 ? "" : "s"} changed`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}
