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

import {
  renderRecords,
  restrictRecords,
  renderTable,
  displayValue,
  observationFormat,
  formatCount,
  type FrozenRecords,
  type ObservationFormatOptions,
} from "./observation-format";
import type { OperatorInfo, ResultVersion } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { NATIVE_BY_TYPE } from "./catalog";
import type { ProfileColumn, ProfileScalar } from "./profiles";
import { nativeWitnessSchema, type NativeWitness } from "./profiles";
import { boundInputs, downstreamRelevantColumns } from "./evidence-lineage";
import type { RetrievalView } from "../../types/agent";
import { compactNativeObservation, type NativeColumnCount, type NativeUpstreamIdentity } from "./evidence-compaction";

export interface NativeEvidenceContext {
  op: OperatorPredicate;
  info: OperatorInfo;
  /** The event's immutable DAG, never a later live definition. */
  workflow: WorkflowContent;
  resolveInput: (id: string) => OperatorInfo | undefined;
  /** Explicit inspection scope; this is not a materialized-table projection. */
  columns?: readonly string[];
  /** The name shown for an operator of `workflow` when the model knows it by
   * another one (a fork of an earlier task's version). */
  displayName?: (id: string) => string;
}

export interface NativeEvidenceFact {
  id: string;
  family: "data" | "flow";
  kind: "measurement";
  text: string;
  priority: number;
  columnCount?: NativeColumnCount;
  coveredCount?: NativeColumnCount;
  upstream?: NativeUpstreamIdentity;
}

export interface NativeObservationOptions extends ObservationFormatOptions {
  data: boolean;
  flow: boolean;
  maxChars: number;
  maxRows?: number;
  detail?: "shape" | "sample";
  columns?: readonly string[];
  view?: RetrievalView;
  dataMaxChars?: number;
  flowMaxChars?: number;
  /** false leaves upstream summaries out of the flow selection, so the
   * operator's own facts get the whole budget (execute receipts). */
  upstream?: boolean;
}

/** The line that marks flow facts left out for the budget. */
export const FLOW_OMITTED_NOTICE = "- note: flow facts omitted (budget).";

/** Audit metadata is not appended to model text. Full version references are
 * retained here; short prefixes in text are display labels, not cache keys. */
export interface NativeObservation {
  version: 1 | 2;
  /** Frozen encoded records; historical restriction never reads a newer result. */
  records?: FrozenRecords;
  resultVersion: string | null;
  inputs: ResultVersion["inputs"];
  options: NativeObservationOptions;
  text: string;
  table?: {
    totalRows: number | null;
    returnedRows: number;
    totalColumns: number;
    columnsShown: number;
    complete: boolean;
  };
  selected: string[];
  /** Atomic render units retained for monotone historical compaction. */
  chunks: Array<{ id: string; text: string; members?: string[]; upstream?: NativeUpstreamIdentity }>;
  omitted: Array<{
    id: string;
    reason: "budget" | "disabled" | "unavailable" | "redundant_complete_table" | "redundant_displayed_fact";
  }>;
}

const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const record = (x: unknown): Record<string, any> =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : {};
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const json = (x: unknown) => JSON.stringify(x);
const fraction = (n: number, d: number) => `${n}/${d}${d === 0 ? " (no rows)" : ""}`;
const scalarText = (x: ProfileScalar) => (x.type === "int64" ? x.value : json(x.value));
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A frequent value in a statistics row is clipped here: it names a category,
 * and one long text value would otherwise crowd the columns after it out of
 * the shared statistics budget. Ranges are never clipped. */
const VALUE_CHARS = 40;

/** Validate optional diagnostics separately: bad examples must never suppress
 * valid counts. They describe a bounded subset, not the complete key domain. */
function witnesses(value: unknown, width: number, rows: number, minimum = 1): NativeWitness[] {
  if (!Array.isArray(value) || value.length > 3 || !width) return [];
  const parsed = value.map(v => nativeWitnessSchema.safeParse(v));
  if (parsed.some(p => !p.success)) return [];
  const examples = parsed.map(p => p.data!);
  return examples.every(
    w => w.values.length === Math.min(width, 8) && (width <= 8 || w.truncated) && w.count >= minimum && w.count <= rows
  ) && examples.reduce((n, w) => n + w.count, 0) <= rows
    ? examples
    : [];
}

function witnessText(example: NativeWitness, key = false): string {
  const values = example.values.map(v => (v === null ? "null" : scalarText(v)));
  return `${key ? `[${values.join(", ")}]` : values[0]}${example.truncated ? " (clipped)" : ""} × ${example.count}`;
}

/** Declared dependencies only: no SQL/source parsing or benchmark vocabulary. */
function declaredColumns(op: OperatorPredicate): string[] {
  const p = op.nativeOp?.properties ?? {};
  const result = [...names(p.keep), ...names(p.drop), ...names(p.groupBy), ...names(p.partitionBy), ...names(p.index)];
  for (const value of [p.column, p.values, p.columns, p.nameColumn, p.valueColumn])
    if (typeof value === "string") result.push(value);
  result.push(...names(p.into));
  if (op.nativeOp?.type === "Unpivot")
    result.push(String(p.nameColumn ?? "variable"), String(p.valueColumn ?? "value"));
  result.push(...Object.keys(record(p.values)), ...Object.keys(record(p.rename)), ...names(p.columns));
  result.push(...names(Object.values(record(p.rename))));
  for (const item of Array.isArray(p.columns) ? p.columns : []) {
    const c = record(item);
    for (const value of [c.column, c.col, c.as]) if (typeof value === "string") result.push(value);
    result.push(...names(c.inputs));
  }
  for (const item of [
    ...(Array.isArray(p.by) ? p.by : []),
    ...(Array.isArray(p.orderBy) ? p.orderBy : []),
    ...(Array.isArray(p.aggregations) ? p.aggregations : []),
  ]) {
    const c = record(item);
    for (const value of [c.col, c.as]) if (typeof value === "string") result.push(value);
  }
  if (typeof p.on === "string") result.push(p.on);
  for (const key of Array.isArray(p.on) ? p.on : []) result.push(...(typeof key === "string" ? [key] : names(key)));
  return result;
}

/** Columns a filter/map function actually read, recorded by the runtime. Known
 * only once the operator has executed; ranking degrades gracefully before. */
function measuredColumns(info: OperatorInfo | undefined): string[] {
  const operations = record(info?.tableProfile?.native?.operations);
  return [
    ...names(operations.predicateColumns),
    ...Object.values(record(operations.columnDependencies)).flatMap(value => names(value)),
  ];
}

function relevance(context: NativeEvidenceContext): Set<string> {
  return downstreamRelevantColumns(context, op => [
    ...declaredColumns(op),
    ...measuredColumns(context.resolveInput(op.operatorID)),
  ]);
}

function validProfile(info: OperatorInfo): boolean {
  return (
    !!info.resultVersion?.complete &&
    !info.error &&
    !!info.tableProfile &&
    info.tableProfile.status !== "unavailable" &&
    info.tableProfile.resultVersion === info.resultVersion.id
  );
}

/** Raw-line columns describe file layout, not the parsed data's distribution. */
function isRawLineTable(op: OperatorPredicate, info: OperatorInfo): boolean {
  if (op.nativeOp?.type === "Scan" && Number(op.nativeOp.properties.preview ?? 0) > 0) return true;
  const columns = Object.keys(info.tableProfile?.columns ?? {});
  const transportColumns = new Set(["file", "line_no", "line", "sheet", "row_no", "table"]);
  return columns.includes("line") && columns.every(name => transportColumns.has(name));
}

function fullColumn(info: OperatorInfo, c: ProfileColumn): boolean {
  const coverage = info.tableProfile?.coverage;
  return (
    validProfile(info) &&
    count(info.totalRowCount) &&
    c.rowsProcessed === info.totalRowCount &&
    coverage?.expectedWorkers !== null &&
    coverage?.expectedWorkers === coverage?.receivedWorkers
  );
}

function columnScope(info: OperatorInfo, c: ProfileColumn): string {
  return fullColumn(info, c)
    ? `full=${c.rowsProcessed} rows`
    : `partial prefix=${c.rowsProcessed}/${info.totalRowCount ?? "?"} rows`;
}

function hasColumnObservations(info: OperatorInfo, c: ProfileColumn): boolean {
  return c.rowsProcessed > 0 || info.totalRowCount === 0;
}

function columnCount(info: OperatorInfo, column: string, c: ProfileColumn): NativeColumnCount {
  return {
    column,
    resultVersion: info.resultVersion!.id,
    scope: columnScope(info, c),
    rows: c.rowsProcessed,
    nulls: c.nullCount,
    nonnull: c.nonnullCount,
    distinct: c.distinctCount,
  };
}

/** A join key or group key written as one value. */
function keyText(example: NativeWitness): string {
  const values = example.values.map(v => (v === null ? "null" : scalarText(v)));
  return values.length === 1 ? values[0] : `[${values.join(", ")}]`;
}

/** A group key that pools rows whose identifying column differs (a beach name
 * used in two towns). The runtime reports it only for a column that names
 * entities, never for an outcome such as a violation flag. One line. */
function aggregateSemantics(context: NativeEvidenceContext, operations: Record<string, any>): Array<[string, string]> {
  const keys = names(context.op.nativeOp!.properties.groupBy);
  return (Array.isArray(operations.keyDependencies) ? operations.keyDependencies.map(record) : [])
    .filter(d => typeof d.column === "string" && count(d.split) && count(d.groups) && d.split > 0)
    .slice(0, 1)
    .map(d => {
      const example = record(d.example);
      const key = names(example.key);
      return [
        `flow.aggregate.key.${d.column}`,
        `grouping by ${keys.map(k => json(k)).join(", ")} pools rows with different ${json(d.column)} values in ${formatCount(d.split)} of ${formatCount(d.groups)} groups, e.g. ${json(key.length === 1 ? key[0] : key)}: ${names(
          example.values
        )
          .map(v => json(v))
          .join(", ")}${count(d.groupsWith) && d.groupsWith > d.groups ? `; grouped by ${[...keys, d.column].map(k => json(k)).join(", ")} there are ${formatCount(d.groupsWith)} groups (now ${formatCount(d.groups)})` : ""}.`,
      ];
    });
}

/** Repeats in a column whose values otherwise identify rows, on rows that also
 * agree on their numbers: one entity listed more than once. */
function repeatedText(r: Record<string, any>, consequence: string): string | undefined {
  if (
    typeof r.outputColumn !== "string" ||
    ![r.rows, r.distinct, r.repeatedValues].every(count) ||
    r.repeatedValues < 1 ||
    r.repeatedValues > r.rows - r.distinct
  )
    return undefined;
  const examples = witnesses(r.examples, 1, r.rows, 2);
  const measures = names(r.sameMeasures);
  const same = measures.length ? ` with the same ${measures.map(name => json(name)).join(", ")}` : "";
  return `${json(r.outputColumn)} repeats ${formatCount(r.repeatedValues)} values${same} (${formatCount(r.rows)} rows, ${formatCount(r.distinct)} distinct)${
    examples.length
      ? `, e.g. ${examples
          .slice(0, 2)
          .map(e => witnessText(e))
          .join("; ")}`
      : ""
  }; ${consequence}.`;
}

/** Records listed once by each of several source files (needs the scan's file column). */
function repeatedRecordsText(type: string, operations: Record<string, any>): string | undefined {
  const r = record(operations.repeatedRecords);
  if (!count(r.rows) || !count(r.of) || !count(r.records) || r.rows > r.of) return undefined;
  const ignoring = names(r.ignoring).length
    ? ` apart from ${names(r.ignoring)
        .map(n => json(n))
        .join(", ")}`
    : "";
  return `${formatCount(r.rows)} of ${formatCount(r.of)} input rows are ${formatCount(r.records)} records each listed once by ${count(r.sources) ? `${r.sources} different sources` : "several sources"}${ignoring}, e.g. ${json(String(r.example ?? ""))}; ${type === "Aggregate" ? "the aggregate counts" : "a sum, mean or count counts"} every copy.`;
}

/** A result value: integers with separators, decimals to 6 significant digits (formatCount prints only counts). */
const valueText = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? Number.isInteger(v)
      ? v.toLocaleString("en-US")
      : String(Number(v.toPrecision(6)))
    : json(v);

/** What leaving rows out changes in an aggregate: each changed output (ungrouped), or how many groups change. */
function changeText(change: Record<string, any>, how: string): string {
  const outputs = Array.isArray(change.outputs) ? change.outputs.map(record) : [];
  if (outputs.length)
    return `${how}: ${outputs
      .slice(0, 2)
      .map(o => `${json(o.output)} = ${valueText(o.then)} (now ${valueText(o.now)})`)
      .join(", ")}`;
  if (count(change.changedGroups) && count(change.groups))
    return `${how}, ${formatCount(change.changedGroups)} of ${formatCount(change.groups)} groups change`;
  return "";
}

/** Several files listing the same record: a metro area in each of its states' files. */
function fileCopiesText(c: Record<string, any>, where: string): string | undefined {
  if (!count(c.rows) || !count(c.of) || !count(c.records) || !count(c.files)) return undefined;
  const span = count(c.minSources) && count(c.maxSources) && c.maxSources > c.minSources ? `${c.minSources}–${c.maxSources}` : `${c.maxSources ?? 2}`;
  const files = names(c.exampleFiles);
  return `${formatCount(c.rows)} of ${formatCount(c.of)} rows ${where} are ${formatCount(c.records)} records listed in ${span} of the ${formatCount(c.files)} files, e.g. ${json(String(c.example ?? ""))}${files.length ? ` in ${files.join(" and ")}` : ""}; a sum, count or mean over these rows counts each copy.`;
}

/** Rows a dedupe dropped that were not duplicates: two stations under one ID, or rows with an empty key. */
function dedupeText(d: Record<string, any>, what: string): string | undefined {
  const keys = names(d.columns);
  if (!keys.length || !count(d.removed)) return undefined;
  const parts: string[] = [];
  const examples = Array.isArray(d.examples) ? d.examples.map(record) : [];
  if (count(d.differ) && d.differ > 0) {
    const e = examples[0];
    const detail = e
      ? `, e.g. ${json(names(e.key).length === 1 ? names(e.key)[0] : names(e.key))}: ${Object.entries(record(e.values))
          .map(([column, values]) => `${json(column)} ${(Array.isArray(values) ? values : []).map(v => json(v)).join(" / ")}`)
          .join(", ")}`
      : "";
    parts.push(`${formatCount(d.differ)} whose ${keys.map(k => json(k)).join(", ")} repeats with different values in other columns${detail}`);
  }
  if (count(d.emptyKeyRemoved) && d.emptyKeyRemoved > 0)
    parts.push(`${formatCount(d.emptyKeyRemoved)} with an empty ${keys.map(k => json(k)).join(", ")}, collapsed into one`);
  return parts.length ? `${what} on ${keys.map(k => json(k)).join(", ")} removed ${formatCount(d.removed)} rows, among them ${parts.join("; ")}.` : undefined;
}

/** Rows marked as excluded (Case_excluded = 'Yes') that a result still reads. */
function excludedText(x: Record<string, any>, how: string): string | undefined {
  if (typeof x.column !== "string" || !count(x.rows) || !count(x.of)) return undefined;
  const examples = names(x.examples);
  const change = x.change ? changeText(record(x.change), "without them") : "";
  return `${formatCount(x.rows)} of ${formatCount(x.of)} rows ${how} have ${json(x.column)} = ${json(String(x.mark ?? ""))}${examples.length ? ` (${examples.map(e => json(e)).join(", ")})` : ""}${change ? `; ${change}` : ""}.`;
}

/** Findings inside a Python step: keys that match only once written alike, dedupes that drop non-duplicates,
 * the same record in several files the function read, repeated header columns it never read. */
function processEventTexts(operations: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const raw of Array.isArray(record(operations.process).events) ? record(operations.process).events : []) {
    const e = record(raw);
    const at = count(e.line) ? `inside the function, ${count(e.cell) ? `definition cell ${e.cell}, ` : ""}line ${e.line}: ` : "inside the function: ";
    const ins: number[] = Array.isArray(e.in) ? e.in : [];
    if ((e.op === "merge" || e.op === "map") && e.issue === "near-miss keys" && count(e.near) && count(e.unmatched)) {
      const pairs = (Array.isArray(e.pairs) ? e.pairs : []).filter((p: unknown) => Array.isArray(p) && p.length === 2);
      lines.push(
        `${at}${e.op === "merge" ? "a merge" : "a lookup with .map"}${typeof e.key === "string" ? ` on ${json(e.key)}` : ""} found no match for ${formatCount(e.unmatched)} of ${formatCount(e.keys)} keys; ${formatCount(e.near)} of them match a key on the other side once case, spacing and punctuation are ignored, e.g. ${pairs
          .slice(0, 2)
          .map(([a, b]: [unknown, unknown]) => `${json(a)} ~ ${json(b)}`)
          .join("; ")}.`
      );
    } else if (e.op === "dedupe" && e.issue === "differs") {
      const text = dedupeText(e, "drop_duplicates");
      if (text) lines.push(`${at}${text}`);
    } else if (e.op === "read" && e.issue === "copies") {
      const text = fileCopiesText(e, "of the files the function read");
      if (text) lines.push(text);
    } else if (e.op === "read" && e.issue === "unread twins" && typeof e.file === "string") {
      const members = (Array.isArray(e.columns) ? e.columns : Array.isArray(e.positions) ? e.positions : []).map((m: unknown) =>
        typeof m === "number" ? `column ${m}` : json(m)
      );
      const unread = (Array.isArray(e.unread) ? e.unread : []).map((m: unknown) => (typeof m === "number" ? `column ${m}` : json(m)));
      lines.push(
        `${json(e.file)} has ${members.length} columns labelled ${json(e.label)} (${members.join(", ")}); the function never read ${unread.join(", ")}.`
      );
    } else if (e.op === "concat" && e.issue === "duplicates")
      lines.push(
        `${at}concatenating ${ins.length} tables: ${e.rows} of ${e.of} rows are ${e.records} records each listed once by several of the tables, e.g. ${json(e.example)}; a sum, count or mean counts each copy.`
      );
    else if (e.op === "merge" && e.issue === "empty") lines.push(`${at}a merge of ${ins.join(" and ")} rows returned 0 rows.`);
    else if ((e.op === "filter" || e.op === "query") && e.issue === "empty") lines.push(`${at}a row selection kept 0 of ${ins[0]} rows.`);
  }
  return lines;
}

/** Consumes structured, version-bound profiles only. No execution, hidden
 * fetch, human-stat-string parsing, or inference of Python semantics. */
export function collectNativeEvidence(context: NativeEvidenceContext): {
  facts: NativeEvidenceFact[];
  omissions: string[];
} {
  const result = collectLocalEvidence(context);
  // Graph dependencies remain known across a custom function even though its
  // row/column mapping is opaque. Report ancestor execution facts, not an
  // inferred correspondence between the ancestor's rows and this output.
  const queue = boundInputs(context).map(input => ({
    input,
    depth: 1,
    opaque: context.op.nativeOp?.type === "Process",
  }));
  const seen = new Set([context.op.operatorID]);
  const summaries: NativeEvidenceFact[] = [];
  for (let visited = 0; queue.length && visited < 32; visited++) {
    const { input, depth, opaque } = queue.shift()!;
    const { op, info } = input;
    if (seen.has(op.operatorID)) continue;
    seen.add(op.operatorID);
    const view = op.nativeOp!;
    const p = view.properties;
    const semantic: Record<string, string> = {
      Project: `Project selection/rename=${json(p)}; rows preserved`,
      Aggregate: `Aggregate group keys=${json(p.groupBy ?? [])}`,
      Join: `Join type=${p.type ?? "inner"}, keys=${json(p.on ?? [])}`,
      Filter: `Filter predicate columns=${json(names(record(info.tableProfile?.native?.operations).predicateColumns))}`,
      Distinct: `Distinct keys=${p.columns === undefined ? "whole row" : json(p.columns)}`,
      Limit: `Limit n=${p.n}, offset=${p.offset ?? 0}`,
      Union: "Union concatenates inputs without deduplication",
      Unpivot: `Unpivot columns=${json(p.columns ?? [])}`,
      Pivot: `Pivot index=${json(p.index ?? [])}, key=${json(p.columns)}`,
      Window: `Window partition keys=${json(p.partitionBy ?? [])}, order=${json(p.orderBy ?? [])}`,
      Process: `Python step ${view.registeredName ?? "process"}`,
    };
    // Continue past nearby projections to find measured conversion losses.
    // The graph walk and the number of displayed summaries stay bounded.
    const local = collectLocalEvidence(input);
    const losses = local.facts.filter(f => f.id.startsWith("flow.cast.") && f.priority === 100);
    if (losses.length) semantic.Cast = "Cast produced nulls for values it could not convert";
    if (semantic[view.type]) {
      // A summary without a measurement restates the definition; skip it.
      const measurements = local.facts
        .filter(f => f.family === "flow" && f.kind === "measurement" && f.priority >= 94)
        .sort((a, b) => b.priority - a.priority)
        .slice(
          0,
          view.type === "Join" ? 3 : ["Aggregate", "Cast", "Window", "Filter", "Process"].includes(view.type) ? 2 : 1
        );
      const version = info.resultVersion!;
      if (measurements.length)
        summaries.push({
          id: `flow.upstream.${op.operatorID}.${version.id}`,
          family: "flow",
          kind: "measurement",
          text: `Flow upstream ${op.operatorID}: ${semantic[view.type]}. ${measurements.map(f => f.text.replace(/^Flow measurement: /, "")).join(" ")}${opaque ? " Before custom processing; row/column correspondence to this output unknown." : ""}`,
          priority: (losses.length ? 101 : 98) - depth / 10,
          upstream: {
            operatorId: op.operatorID,
            resultVersion: version.id,
            factIds: measurements.map(fact => fact.id),
            description: semantic[view.type],
            ...(opaque ? { scope: "Before custom processing; row/column correspondence to this output unknown." } : {}),
          },
        });
    }
    if (depth < 8)
      queue.push(
        ...boundInputs(input).map(next => ({
          input: next,
          depth: depth + 1,
          opaque: opaque || view.type === "Process",
        }))
      );
    else if (view.inputs.length) result.omissions.push("upstream_depth_bound");
  }
  result.facts.push(...summaries.sort((a, b) => b.priority - a.priority).slice(0, 3));
  if (queue.length || summaries.length > 3) result.omissions.push("upstream_summary_bound");
  return result;
}

function collectLocalEvidence(context: NativeEvidenceContext): {
  facts: NativeEvidenceFact[];
  omissions: string[];
} {
  const { op, info, resolveInput, workflow } = context;
  const view = op.nativeOp;
  const version = info.resultVersion;
  const facts: NativeEvidenceFact[] = [];
  const omissions: string[] = [];
  const add = (
    id: string,
    family: NativeEvidenceFact["family"],
    kind: NativeEvidenceFact["kind"],
    text: string,
    priority: number,
    metadata: Pick<NativeEvidenceFact, "columnCount" | "coveredCount"> = {}
  ) =>
    facts.push({
      id,
      family,
      kind,
      text: `${family === "flow" ? "Flow" : "Data"} ${kind}: ${text}`,
      priority,
      ...metadata,
    });
  if (
    info.error ||
    !view ||
    !version?.complete ||
    version.operatorId !== op.operatorID ||
    version.operatorRevision !== view.revision
  ) {
    return { facts, omissions: ["result_binding_unavailable"] };
  }
  const def = NATIVE_BY_TYPE.get(view.type);
  if (!def) return { facts, omissions: ["operator_contract_unavailable"] };
  const p = view.properties;
  const relevant = relevance(context);
  const profile = validProfile(info) ? info.tableProfile : undefined;
  // Preview columns describe transport, not the parsed dataset. Their
  // distributions displace the raw records needed to choose parsing options.
  // Raw-line tables (a preview, or rows of a lines-format read) describe the
  // file's layout, not the parsed dataset; their distributions only displace
  // what is needed to choose parse options. That holds for the operators that
  // pass such a table on unchanged, not just the scan itself.
  const rawPreview = isRawLineTable(op, info);
  if (!profile) omissions.push("profile_unavailable");

  if (profile) {
    // The table's own column order: a lexical order let the budget cut every
    // late-alphabet column of a fresh scan, before any consumer names one.
    const order = new Map((info.resultSchema ?? []).map((c, i) => [c.name, i]));
    const position = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER;
    for (const [name, c] of Object.entries(profile.columns).sort(
      ([a], [b]) => position(a) - position(b) || lexical(a, b)
    )) {
      if (rawPreview || !hasColumnObservations(info, c)) continue;
      if (context.columns?.length && !context.columns.includes(name)) continue;
      const priority = relevant.has(name) ? 85 : 80;
      const scope = columnScope(info, c);
      add(
        `data.column.${name}.counts`,
        "data",
        "measurement",
        `${json(name)} (${scope}): null=${fraction(c.nullCount, c.rowsProcessed)}, nonnull=${c.nonnullCount}; distinct(nonnull)=${c.distinctCount ?? "unknown"}.`,
        priority,
        { columnCount: columnCount(info, name, c) }
      );
      if (c.min && c.max)
        add(
          `data.column.${name}.range`,
          "data",
          "measurement",
          `${json(name)} (${scope}): range=[${scalarText(c.min)}, ${scalarText(c.max)}].`,
          priority - 23
        );
      if (c.frequencies?.values.length) {
        const f = c.frequencies;
        const compactCategory = !f.truncated && f.values.length <= 8 && c.nonnullCount >= 2 * f.values.length;
        add(
          `data.column.${name}.values`,
          "data",
          "measurement",
          `${json(name)} (${scope}): ${f.truncated ? "top values (not exhaustive)" : "nonnull values"}=${f.values.map(v => `${scalarText(v.value)}:${v.count}`).join(", ")}; other=${f.otherCount}.`,
          priority - 20 + (compactCategory ? 8 : 0)
        );
      }
    }
    const s = profile.structure;
    const scope = profile.coverage.complete
      ? "full table"
      : `partial prefix=${profile.coverage.rowsProcessed}/${info.totalRowCount ?? "?"} rows`;
    if (
      !rawPreview &&
      !context.columns?.length &&
      ((s.duplicateRows ?? 0) > 0 || (s.allNullRows ?? 0) > 0 || s.allNullColumns.length)
    ) {
      add(
        "data.structure",
        "data",
        "measurement",
        `${scope}: duplicate rows=${s.duplicateRows ?? "unknown"}, all-null rows=${s.allNullRows ?? "unknown"}, all-null columns=${json(s.allNullColumns)}.`,
        82
      );
    }
    omissions.push(...profile.omissions);
  }

  // Operator contracts restate what the operator name and its definition say;
  // flow lines report only what was measured.

  const inputs = view.inputs.map(resolveInput);
  const inputsMatch =
    version.inputs.length === view.inputs.length &&
    inputs.every((input, i) => {
      const ref = version.inputs[i];
      const inputOp = workflow.operators.find(o => o.operatorID === view.inputs[i]);
      return (
        !!input &&
        !input.error &&
        input.resultVersion?.complete &&
        ref.inputIndex === i &&
        ref.operatorId === view.inputs[i] &&
        ref.resultVersion === input.resultVersion.id &&
        ref.outputPort === input.resultVersion.outputPort &&
        input.resultVersion.workflowId === version.workflowId &&
        inputOp?.nativeOp?.revision === input.resultVersion.operatorRevision
      );
    });
  if (!inputsMatch) omissions.push("input_versions_unavailable");
  const n = profile?.native;
  const inputRows = inputs.map(input => input?.totalRowCount);
  const outputRows = info.totalRowCount;
  const operational =
    inputsMatch &&
    n?.operatorType === view.type &&
    json(n.inputOperators) === json(view.inputs) &&
    count(outputRows) &&
    outputRows === n.outputRows &&
    profile?.rowCount === outputRows &&
    n.inputRows?.length === inputs.length &&
    inputRows.every((rows, i) => count(rows) && rows === n.inputRows![i]) &&
    (n.rowEffect === undefined || n.rowEffect === def.rowEffect);
  if (!operational) return { facts, omissions: [...new Set([...omissions, "operational_metadata_unavailable"])] };
  const ns = inputRows as number[];
  const out = outputRows as number;
  const operations = n!.operations ?? {};
  if (view.type === "Filter") {
    const { keptRows, rejectedRows, nullPredicates } = operations;
    if (
      count(keptRows) &&
      count(rejectedRows) &&
      count(nullPredicates) &&
      keptRows === out &&
      keptRows + rejectedRows === ns[0] &&
      nullPredicates <= rejectedRows
    ) {
      // Kept and rejected counts restate the row counts unless a None
      // verdict dropped rows.
      if (nullPredicates > 0)
        add(
          "flow.filter",
          "flow",
          "measurement",
          `Filter kept=${fraction(out, ns[0])}, rejected=${rejectedRows}, null predicates=${nullPredicates} (a None verdict drops the row).`,
          96
        );
      // Rejected values written like what the condition looks for. The runtime
      // blames each rejected row on the column its condition read last (the
      // part of `a and b` that failed) and matches the values to the
      // condition's literals or kept values with case, spacing, punctuation
      // and leading zeros ignored. Values the condition was written to drop
      // never match, so this line is rare.
      for (const entry of (Array.isArray(operations.filterNearMisses) ? operations.filterNearMisses : []).map(record)) {
        const column = entry.column;
        const values = (Array.isArray(entry.values) ? entry.values : [])
          .map(record)
          .filter(
            v =>
              typeof v.value === "string" &&
              typeof v.counterpart === "string" &&
              count(v.rows) &&
              v.rows > 0 &&
              ["literal", "kept", "contains"].includes(v.how)
          );
        if (typeof column !== "string" || !values.length || values.reduce((n, v) => n + v.rows, 0) > rejectedRows)
          continue;
        if (context.columns?.length && !context.columns.includes(column)) continue;
        const groups = new Map<string, Array<Record<string, any>>>();
        for (const v of values)
          groups.set(json([v.how, v.counterpart]), [...(groups.get(json([v.how, v.counterpart])) ?? []), v]);
        for (const [key, group] of groups) {
          const [how, counterpart] = JSON.parse(key) as [string, string];
          const listed = group
            .map(v => `${json(v.value)}${v.valueClipped ? " (clipped)" : ""} × ${formatCount(v.rows)}`)
            .join("; ");
          const reference = `${json(counterpart)}${group[0].counterpartClipped ? " (clipped)" : ""}`;
          add(
            `flow.filter.near.${column}.${key}`,
            "flow",
            "measurement",
            how === "contains"
              ? `${json(column)} values the condition rejected contain its literal ${reference}: ${listed}.`
              : `${json(column)} values the condition rejected equal ${how === "literal" ? "its literal" : "the kept value"} ${reference} except for case, spacing or punctuation: ${listed}.`,
            97
          );
        }
      }
      // A condition that looks for literals kept nothing: the values that reached
      // its furthest test are the evidence (dates written 8/25/2002 never split to
      // "07"; Quincy's beaches are named "Wollaston @ …", not "Wollaston Beach").
      const none = record(operations.filterNoMatch);
      const literals = names(none.literals);
      const seen = witnesses(none.seen, 1, rejectedRows);
      // A near miss on the same column already names the value and its literal.
      const named = facts.some(f => f.id.startsWith(`flow.filter.near.${none.column}.`));
      if (out === 0 && rejectedRows > 0 && typeof none.column === "string" && literals.length && seen.length && !named)
        add(
          "flow.filter.none",
          "flow",
          "measurement",
          `no row passed the condition's test for ${literals.map(l => json(l)).join(", ")}; ${json(none.column)} values that reached it: ${seen.map(w => witnessText(w)).join("; ")}.`,
          98
        );
    } else omissions.push("invalid_filter_counters");
  } else if (view.type === "Aggregate") {
    const size = record(operations.groupSizes);
    const emptyGroups = out === 0 && ns[0] === 0 && size.min === null && size.max === null;
    if (
      operations.groupCount === out &&
      size.total === ns[0] &&
      (emptyGroups ||
        (count(size.min) &&
          count(size.max) &&
          size.min <= size.max &&
          size.max <= ns[0] &&
          out > 0 &&
          size.min * out <= ns[0] &&
          size.max * out >= ns[0]))
    ) {
      // Group sizes and non-null counts restate the result; what is measured
      // beyond them is a key that pools entities and rows read more than once.
      aggregateSemantics(context, operations).forEach(([id, text]) => add(id, "flow", "measurement", text, 97));
      for (const [i, raw] of (Array.isArray(operations.repeatedInput) ? operations.repeatedInput : []).entries()) {
        const text = repeatedText(record(raw), "this aggregate's sum, count and mean count each repeat");
        if (text) add(`flow.aggregate.repeated.${i}`, "flow", "measurement", text, 97);
      }
      const copies = record(operations.copiesInput);
      if (count(copies.rows) && count(copies.records) && count(copies.of)) {
        const span = count(copies.minCopies) && count(copies.maxCopies) && copies.maxCopies > copies.minCopies ? `${copies.minCopies}–${copies.maxCopies}` : `${copies.maxCopies ?? 2}`;
        const change = changeText(record(copies.change), "counting each record once");
        add(
          "flow.aggregate.copies",
          "flow",
          "measurement",
          `${formatCount(copies.rows)} of ${formatCount(copies.of)} rows read here are ${formatCount(copies.records)} records repeated ${span} times (identical in every column; the input comes from several sources), e.g. ${json(String(copies.example ?? ""))}${change ? `; ${change}` : ""}.`,
          98
        );
      }
      const excluded = excludedText(record(operations.excludedInput), "read here");
      if (excluded) add("flow.aggregate.excluded", "flow", "measurement", excluded, 98);
    } else omissions.push("invalid_aggregate_counters");
  } else if (view.type === "Join") {
    const join = record(operations.join);
    const type = p.type ?? "inner";
    if (type === "cross") {
      // Valid cross join counters only restate the product of the input rows.
      if (
        !(
          join.type === "cross" &&
          join.leftRows === ns[0] &&
          join.rightRows === ns[1] &&
          count(ns[0] * ns[1]) &&
          join.matchedOutputRows === out &&
          out === ns[0] * ns[1]
        )
      )
        omissions.push("invalid_join_counters");
    } else {
      const sides = [record(join.left), record(join.right)];
      // Semi and anti joins keep left rows once each: the matched or the unmatched ones.
      const membership = type === "semi" || type === "anti";
      const valid =
        join.type === type &&
        join.nullsEqual === (p.nullsEqual ?? false) &&
        join.validate === (p.validate ?? "many_to_many") &&
        count(join.matchedOutputRows) &&
        sides.every(
          (s, i) =>
            [
              "rows",
              "eligibleRows",
              "nullKeyRows",
              "distinctKeys",
              "matchedRows",
              "unmatchedRows",
              "matchedKeys",
              "unmatchedKeys",
              "maxMultiplicity",
            ].every(k => count(s[k])) &&
            s.rows === ns[i] &&
            s.nullKeyRows <= s.rows &&
            s.eligibleRows === (join.nullsEqual ? s.rows : s.rows - s.nullKeyRows) &&
            s.matchedRows + s.unmatchedRows === s.rows &&
            s.matchedRows <= s.eligibleRows &&
            s.matchedKeys + s.unmatchedKeys === s.distinctKeys &&
            s.distinctKeys <= s.eligibleRows &&
            s.matchedKeys <= s.matchedRows &&
            s.maxMultiplicity <= s.eligibleRows &&
            (membership ? i === 1 || s.matchedRows === join.matchedOutputRows : s.matchedRows <= join.matchedOutputRows)
        ) &&
        sides[0].matchedKeys === sides[1].matchedKeys &&
        (membership
          ? out === (type === "semi" ? sides[0].matchedRows : sides[0].unmatchedRows)
          : join.matchedOutputRows +
              (["left", "full"].includes(type as string) ? sides[0].unmatchedRows : 0) +
              (["right", "full"].includes(type as string) ? sides[1].unmatchedRows : 0) ===
            out);
      // Matched and unmatched counts are what a join is written to do. Two
      // things are not: keys that differ only in how they are written, and a
      // join that matched no key at all.
      if (valid && !membership) {
        const width = typeof p.on === "string" ? 1 : Array.isArray(p.on) ? p.on.length : 0;
        const near = record(join.nearMisses);
        const pairs = (Array.isArray(near.pairs) ? near.pairs : [])
          .map(record)
          .map(pair => [
            witnesses([pair.left], width, sides[0].rows)[0],
            witnesses([pair.right], width, sides[1].rows)[0],
          ])
          .filter((pair): pair is [NativeWitness, NativeWitness] => !!pair[0] && !!pair[1]);
        if (
          count(near.keys) &&
          count(near.rows) &&
          near.keys > 0 &&
          pairs.length &&
          near.keys <= sides[0].unmatchedKeys
        )
          add(
            "flow.join.near",
            "flow",
            "measurement",
            `${formatCount(near.keys)} left key${near.keys === 1 ? "" : "s"} (${formatCount(near.rows)} row${near.rows === 1 ? "" : "s"}) ${near.keys === 1 ? "matches" : "match"} a right key only when case, spacing, punctuation and leading zeros are ignored: ${pairs.map(([l, r]) => `${keyText(l)} ~ ${keyText(r)}`).join("; ")}.`,
            97
          );
        const none = record(join.noMatch);
        const left = witnesses([none.left], width, sides[0].rows)[0];
        const right = witnesses([none.right], width, sides[1].rows)[0];
        if (sides[0].matchedKeys === 0 && sides[0].rows > 0 && sides[1].rows > 0 && left && right)
          add(
            "flow.join.none",
            "flow",
            "measurement",
            `the join matched no keys; left keys look like ${keyText(left)}, right keys like ${keyText(right)}.`,
            98
          );
      } else if (!valid) omissions.push("invalid_join_counters");
    }
  } else if (view.type === "Union") {
    const sum = ns.reduce((a, b) => a + b, 0);
    const aligned = Array.isArray(operations.alignedMissingColumns) ? operations.alignedMissingColumns : [];
    if (count(sum) && sum === out) {
      // Row counts that add up restate the inputs; columns filled with null do not.
      if (aligned.some((columns: unknown) => Array.isArray(columns) && columns.length))
        add(
          "flow.union",
          "flow",
          "measurement",
          `Union input rows=${json(ns)}, sum=${sum}, output=${out}; aligned missing columns by port=${json(operations.alignedMissingColumns ?? "unknown")}.`,
          94
        );
    } else omissions.push("invalid_union_counters");
  } else if (view.type === "Window") {
    const window = record(operations.window);
    if (
      out === ns[0] &&
      count(window.partitions) &&
      count(window.tieRows) &&
      (out === 0 ? window.partitions === 0 : window.partitions >= 1 && window.partitions <= out) &&
      window.tieRows <= out - window.partitions
    ) {
      // Without ties the line restates the row and partition counts.
      if (window.tieRows > 0)
        add(
          "flow.window",
          "flow",
          "measurement",
          `Window preserved=${out} rows; partitions=${window.partitions}, ties beyond first=${window.tieRows}.`,
          94
        );
    } else omissions.push("invalid_window_counters");
  } else if (view.type === "Unpivot") {
    const x = record(operations.unpivot),
      columns = names(p.columns);
    if (
      columns.length > 0 &&
      new Set(columns).size === columns.length &&
      x.selectedColumns === columns.length &&
      count(ns[0] * columns.length) &&
      out === ns[0] * columns.length &&
      count(x.nullCells) &&
      x.nullCells <= out
    ) {
      // Without null cells the line restates the row counts.
      if (x.nullCells > 0)
        add(
          "flow.unpivot",
          "flow",
          "measurement",
          `Unpivot output=${ns[0]}*${columns.length}=${out} rows; retained null cells=${x.nullCells}.`,
          94
        );
    } else omissions.push("invalid_unpivot_counters");
  } else if (view.type === "Pivot") {
    const x = record(operations.pivot);
    if (
      [x.uniquePairs, x.indexGroups, x.generatedColumns, x.missingCells].every(count) &&
      x.uniquePairs === ns[0] &&
      x.indexGroups === out &&
      out <= ns[0] &&
      x.generatedColumns <= ns[0] &&
      (ns[0] === 0 ? out === 0 && x.generatedColumns === 0 : out > 0 && x.generatedColumns > 0) &&
      (names(p.index).length > 0 || out === (ns[0] ? 1 : 0)) &&
      count(out * x.generatedColumns) &&
      x.missingCells + x.uniquePairs === out * x.generatedColumns
    ) {
      // A pivot that fills every cell restates its shape.
      if (x.missingCells > 0)
        add(
          "flow.pivot",
          "flow",
          "measurement",
          `Pivot unique pairs=${x.uniquePairs}, index groups=${out}, generated columns=${x.generatedColumns}, absent cells=${x.missingCells} (filled null, separate from null input values).`,
          94
        );
    } else omissions.push("invalid_pivot_counters");
  } else if (["Distinct", "Limit"].includes(view.type)) {
    // Retained and removed rows restate the input and output row counts.
    if (!(count(operations.removedRows) && operations.removedRows + out === ns[0]))
      omissions.push("invalid_removal_counters");
    else if (view.type === "Distinct") {
      const text = dedupeText(record(operations.dedupeDifferences), "distinct");
      if (text) add("flow.distinct.differs", "flow", "measurement", text, 97);
    }
  } else if (view.type === "Scan") {
    const scan = record(operations.scan);
    if (
      typeof scan.preview === "boolean" &&
      count(scan.resolvedFiles) &&
      count(scan.selectedFiles) &&
      count(scan.omittedFiles) &&
      scan.selectedFiles + scan.omittedFiles === scan.resolvedFiles
    ) {
      // File coverage, previews and header findings are shown with the scan's
      // result in every setting (result-scope.ts); only empty sources remain.
      const copies = fileCopiesText(record(operations.fileCopies), "of this table");
      if (copies && !scan.preview) add("flow.scan.copies", "flow", "measurement", copies, 97);
      for (const [i, source] of (Array.isArray(scan.sources) ? scan.sources : []).entries()) {
        const s = record(source);
        if (typeof s.path === "string" && s.outputRows === 0 && !scan.preview)
          add(
            `flow.scan.empty.${i}`,
            "flow",
            "measurement",
            `Scan: source ${json(s.path.split(/[\\/]/).pop())} has no data rows (sizeBytes=${s.sizeBytes ?? "unknown"}).`,
            97
          );
      }
    } else omissions.push("scan_coverage_unavailable");
  }
  // Repeats in a Python step's output column whose values otherwise identify
  // rows: rows that a later sum, count or mean takes more than once.
  if (view.type === "Process")
    for (const [i, raw] of (Array.isArray(operations.repeatedValues) ? operations.repeatedValues : []).entries()) {
      const r = record(raw);
      const created = count(r.inputRepeated) && r.inputRepeated === 0 && typeof r.inputColumn === "string";
      const text = repeatedText(
        r,
        `${created ? "this step created them; " : ""}a sum, count or mean over these rows counts each repeat`
      );
      if (text) add(`flow.process.repeated.${i}`, "flow", "measurement", text, 95);
    }
  if (view.type === "Process")
    processEventTexts(operations).forEach((text, i) => add(`flow.process.event.${i}`, "flow", "measurement", text, 96));
  if (view.type === "Project") {
    const dropped = record(operations.excludedDropped);
    const text = excludedText(dropped, "of the input");
    if (text && typeof dropped.column === "string")
      add(
        "flow.project.excluded",
        "flow",
        "measurement",
        `this step drops ${json(dropped.column)}, but ${text.charAt(0).toLowerCase()}${text.slice(1, -1)}; those rows stay in the table, no longer marked.`,
        97
      );
  }
  // The same record listed by several source files (a metro area in each state's file).
  if (view.type === "Aggregate" || view.type === "Process") {
    const text = repeatedRecordsText(view.type, operations);
    if (text) add("flow.records.repeated", "flow", "measurement", text, 97);
  }
  // Values a cast could not convert became null; with errors="raise" the cast fails instead.
  if (view.type === "Cast" && ns[0] === out)
    for (const [name, failures] of Object.entries(record(operations.conversionFailures))) {
      if (!count(failures) || failures === 0 || failures > ns[0] || p.errors !== "null") continue;
      const sample = record(record(operations.conversionFailureExamples)[name]);
      const examples = witnesses(sample.examples, 1, failures);
      const complete =
        examples.length &&
        count(sample.otherCount) &&
        examples.reduce((sum, w) => sum + w.count, sample.otherCount) === failures;
      add(
        `flow.cast.${name}`,
        "flow",
        "measurement",
        `${json(name)} could not be converted in ${formatCount(failures)} of ${formatCount(ns[0])} rows${complete ? `, e.g. ${examples.map(w => witnessText(w)).join("; ")}` : ""}; those cells are now null.`,
        100
      );
    }
  return { facts, omissions: [...new Set(omissions)] };
}

/** The record allocation is identical with either evidence switch. Each
 * enabled evidence family appends within its independent display budget. */
export function selectNativeObservation(context: NativeEvidenceContext & NativeObservationOptions): NativeObservation {
  const { op, info, data, flow } = context;
  const maxChars = Number.isFinite(context.maxChars) ? Math.max(0, Math.floor(context.maxChars)) : 2000;
  const format = observationFormat(context);
  const records = renderRecords(info, {
    ...format,
    maxChars,
    view: context.view,
    maxRows: context.view === "full" ? 0 : context.maxRows,
    columns: context.columns,
    detail: context.detail,
    preview: op.nativeOp?.type === "Scan" && Number(op.nativeOp.properties.preview ?? 0) > 0,
    // A table read from files keeps its first look whole up to the budget: a
    // value written differently from the first rows (a "Sept" among "Aug"
    // dates) is what that look is for.
    source: op.nativeOp?.type === "Scan" || info.resultVersion?.inputs?.length === 0,
    relevant: relevance(context),
  });
  const evidence = collectNativeEvidence(context);
  const result: NativeObservation = {
    version: 2,
    resultVersion: info.resultVersion?.id ?? null,
    inputs: structuredClone(info.resultVersion?.inputs ?? []),
    options: {
      ...format,
      data,
      flow,
      maxChars,
      maxRows: context.maxRows,
      detail: context.detail,
      columns: context.columns ? [...context.columns] : undefined,
      view: context.view,
      dataMaxChars: context.dataMaxChars,
      flowMaxChars: context.flowMaxChars,
    },
    text: "",
    records: records.frozen,
    table: {
      totalRows: records.totalRows,
      returnedRows: records.returnedRows,
      totalColumns: records.totalColumns,
      columnsShown: records.columnsShown,
      complete: records.complete,
    },
    selected: [records.complete ? "table.complete" : "table.records"],
    chunks: [{ id: records.complete ? "table.complete" : "table.records", text: records.text }],
    omitted: evidence.omissions.map(id => ({ id, reason: "unavailable" as const })),
  };
  const append = (
    id: string,
    text: string,
    budget: number,
    family: "data" | "flow",
    members?: string[],
    upstream?: NativeUpstreamIdentity
  ) => {
    const used = result.chunks
      .filter(c => c.id.startsWith(`${family}.`))
      .map(c => c.text)
      .join("\n").length;
    if (used + (used ? 1 : 0) + text.length > budget) {
      (members ?? [id]).forEach(id => result.omitted.push({ id, reason: "budget" }));
      return false;
    }
    result.chunks.push({ id, text, ...(members ? { members } : {}), ...(upstream ? { upstream } : {}) });
    if (id !== "data.status") result.selected.push(...(members ?? [id]));
    return true;
  };
  for (const fact of evidence.facts) {
    if (!(fact.family === "data" ? data : flow)) result.omitted.push({ id: fact.id, reason: "disabled" });
    else if (records.complete && fact.family === "data")
      result.omitted.push({ id: fact.id, reason: "redundant_complete_table" });
  }
  const dataBudget = Math.max(0, context.dataMaxChars ?? maxChars);
  let statisticsListAllColumns = false;
  if (data && records.complete)
    append("data.complete", "statistics: not shown; the complete records above show every value", dataBudget, "data");
  if (data && !records.complete) {
    const profile = validProfile(info) && evidence.facts.some(f => f.columnCount) ? info.tableProfile : undefined;
    const raw = isRawLineTable(op, info);
    if (raw || !profile || (profile.coverage.rowsProcessed === 0 && records.totalRows !== 0)) {
      append(
        "data.status",
        raw
          ? "statistics: unavailable for raw lines; parse them into columns first"
          : "statistics: unavailable for this result",
        dataBudget,
        "data"
      );
    } else {
      const candidates = evidence.facts
        .filter(f => f.columnCount && (!context.columns?.length || context.columns.includes(f.columnCount.column)))
        .sort((a, b) => b.priority - a.priority);
      const groups = new Map<number, NativeEvidenceFact[]>();
      for (const fact of candidates) {
        const rowCount = fact.columnCount!.rows;
        groups.set(rowCount, [...(groups.get(rowCount) ?? []), fact]);
      }
      for (const [rowCount, facts] of groups) {
        const full = profile.coverage.complete && rowCount === records.totalRows;
        const caption = (shown: number) =>
          `statistics: ${full ? "full table" : "partial profile"}, ${formatCount(rowCount)} of ${formatCount(records.totalRows)} rows, ${shown} of ${records.totalColumns} columns${full ? "" : " (values describe profiled rows only)"}`;
        const rows: string[][] = [];
        const members: string[] = [];
        const fields = ["column", "type", "nulls", "distinct", "values"];
        for (const fact of facts) {
          const c = fact.columnCount!;
          const column = profile.columns[c.column];
          // Bounds are actual observed values, not approximations: preserve
          // their precision so an equality filter can use them unchanged.
          const display = (v: ProfileScalar) => displayValue(v.value, v.type, format.tableFormat).text;
          const named = (v: ProfileScalar) => displayValue(v.value, v.type, format.tableFormat, VALUE_CHARS).text;
          const ranged = ["int64", "float64", "datetime"].includes(column.type) && column.min && column.max;
          let values = ranged ? `${display(column.min!)} to ${display(column.max!)}` : "";
          const frequencies = column.frequencies;
          if (frequencies?.values.length) {
            const shown = format.topValues > 0 ? frequencies.values.slice(0, format.topValues) : frequencies.values;
            const exhaustive =
              !frequencies.truncated && frequencies.otherCount === 0 && shown.length === frequencies.values.length;
            values =
              (values ? values + "; " : "") +
              `${exhaustive ? "all:" : "top:"} ${shown.map(item => `${named(item.value)} ${formatCount(item.count)}`).join("; ")}${exhaustive ? "" : `; other: ${formatCount(c.nonnull - shown.reduce((n, item) => n + item.count, 0))} (not exhaustive)`}`;
          }
          const row = [
            displayValue(c.column, "str", format.tableFormat).text,
            columnTypeName(column.type),
            formatCount(c.nulls),
            formatCount(c.distinct),
            values,
          ];
          const tentative = `${caption(rows.length + 1)}\n${renderTable(fields, [...rows, row], format.tableFormat)}`;
          const existing = result.chunks
            .filter(c => c.id.startsWith("data."))
            .map(c => c.text)
            .join("\n").length;
          if (tentative.length + existing + (existing ? 1 : 0) > dataBudget) {
            result.omitted.push({ id: fact.id, reason: "budget" });
            continue;
          }
          rows.push(row);
          members.push(fact.id);
          if (ranged) members.push(`data.column.${c.column}.range`);
          if (frequencies?.values.length && values) members.push(`data.column.${c.column}.values`);
        }
        if (rows.length) {
          if (
            append(
              `data.statistics.${rowCount}`,
              `${caption(rows.length)}\n${renderTable(fields, rows, format.tableFormat)}`,
              dataBudget,
              "data",
              members
            ) &&
            full &&
            rows.length === records.totalColumns &&
            records.columnsShown === records.totalColumns
          )
            statisticsListAllColumns = true;
        } else
          append(
            "data.status",
            `statistics: omitted (budget); ${formatCount(rowCount)} rows profiled`,
            dataBudget,
            "data"
          );
      }
      for (const fact of evidence.facts.filter(
        f => f.family === "data" && !f.columnCount && !/^data\.column\./.test(f.id)
      ))
        append(fact.id, `- note: ${fact.text.replace(/^Data \w+: /, "")}`, dataBudget, "data");
    }
  }
  // A view without the statistics table hides missing values whenever the rows
  // shown stop before the first null; with dataHygiene it names the columns
  // that hold them.
  if (format.dataHygiene && !data && !records.complete && validProfile(info) && !isRawLineTable(op, info)) {
    const withNulls = Object.entries(info.tableProfile!.columns)
      .filter(
        ([name, c]) =>
          count(c.nullCount) && c.nullCount > 0 && (!context.columns?.length || context.columns.includes(name))
      )
      .sort((a, b) => b[1].nullCount - a[1].nullCount);
    if (withNulls.length) {
      const processed = withNulls[0][1].rowsProcessed;
      const scope =
        processed === records.totalRows
          ? `of ${formatCount(processed)} rows`
          : `in ${formatCount(processed)} profiled rows`;
      const shown = withNulls.slice(0, 8).map(([name, c]) => `${json(name)} ${formatCount(c.nullCount)}`);
      const more = withNulls.length - shown.length;
      append(
        "data.nulls",
        `nulls (${scope}): ${shown.join(", ")}${more > 0 ? `, +${more} more columns` : ""}`,
        dataBudget,
        "data"
      );
    }
  }
  // The statistics rows name every column with its type; the `columns:` line
  // above the records then says nothing new.
  if (format.compactRecords && statisticsListAllColumns && result.chunks[0]?.text.startsWith("columns: ")) {
    result.chunks[0] = { ...result.chunks[0], text: result.chunks[0].text.split("\n").slice(1).join("\n") };
    result.records = { ...result.records!, schema: "" };
  }
  if (flow) {
    const budget = Math.max(0, context.flowMaxChars ?? maxChars);
    const facts = evidence.facts
      .filter(f => f.family === "flow" && (context.upstream !== false || !f.upstream))
      .sort((a, b) => b.priority - a.priority);
    const notice = FLOW_OMITTED_NOTICE;
    const allText = facts.map(fact => {
      const origin = fact.upstream && (context.displayName?.(fact.upstream.operatorId) ?? fact.upstream.operatorId);
      const text = fact.text.replace(/^Flow upstream [^:]+:\s*/, "").replace(/^Flow \w+:\s*/, "");
      return `- runtime stats${origin ? ` (${origin})` : ""}: ${text}`;
    });
    const needsNotice = allText.join("\n").length > budget;
    for (const [index, fact] of facts.entries()) {
      append(
        fact.id,
        allText[index],
        needsNotice ? Math.max(0, budget - notice.length - 1) : budget,
        "flow",
        undefined,
        fact.upstream
      );
    }
    if (needsNotice) append("flow.omitted", notice, budget, "flow");
  }
  result.text = result.chunks
    .map(c => c.text)
    .filter(Boolean)
    .join("\n");
  return result;
}

function columnTypeName(type: string): string {
  return type === "unsupported" ? "unknown" : type;
}

/** Historical compaction is subtractive: it may drop rows or tail chunks,
 * never extract fresh profiles or use a later DAG to choose new evidence. */
export function restrictNativeObservation(
  observation: NativeObservation,
  limits: { maxChars?: number; maxRows?: number; detail?: "sample" | "shape" }
): string {
  if (observation.version === 2 && observation.records) {
    const budget =
      limits.maxChars && limits.maxChars > 0
        ? Math.min(observation.text.length, limits.maxChars)
        : observation.text.length;
    if (budget >= observation.text.length && !limits.maxRows && limits.detail !== "shape") return observation.text;
    const evidence = observation.chunks.filter(c => !c.id.startsWith("table."));
    const render = (cap: number) => {
      const records = restrictRecords(observation.records!, {
        maxChars: Math.min(cap, observation.options.maxChars),
        maxRows: limits.maxRows,
        detail: limits.detail === "shape" ? "shape" : undefined,
      });
      const chunks = [records.text];
      let retained = 0;
      // "The complete records above show every value" holds only while the
      // restricted records are still complete.
      for (const chunk of evidence.filter(c => c.id !== "data.complete" || records.complete)) {
        if ([...chunks, chunk.text].join("\n").length > cap) break;
        chunks.push(chunk.text);
        retained++;
      }
      return { text: chunks.filter(Boolean).join("\n"), retained };
    };
    let rendered = render(budget);
    if (rendered.retained < evidence.length) {
      const notice = "- note: evidence omitted (budget).";
      if (notice.length <= budget) {
        rendered = render(Math.max(0, budget - notice.length - 1));
        return [rendered.text, notice].filter(Boolean).join("\n");
      }
    }
    return rendered.text;
  }
  // A combined data+flow observation may legitimately exceed `options.maxChars`
  // (each family has its own budget); without an explicit limit it is kept whole.
  const recorded = Math.max(observation.options.maxChars, observation.text.length);
  const budget = limits.maxChars !== undefined && limits.maxChars > 0 ? Math.min(recorded, limits.maxChars) : recorded;
  const rowLimit = limits.maxRows && limits.maxRows > 0 ? Math.floor(limits.maxRows) : Infinity;
  if (budget >= observation.text.length && rowLimit === Infinity && limits.detail !== "shape") return observation.text;
  const chunks: string[] = [];
  let sampleRows = 0;
  for (const chunk of observation.chunks) {
    if (/^(sample|record)\./.test(chunk.id) && (limits.detail === "shape" || sampleRows++ >= rowLimit)) continue;
    let text = chunk.text;
    if (chunk.id === "table.complete") {
      const [schema, , ...rows] = text.split("\n");
      if (limits.detail === "shape") text = schema;
      else if (rowLimit < rows.length)
        text = [
          schema,
          `Sample from recorded table (${rowLimit}/${rows.length} rows):`,
          ...rows.slice(0, rowLimit),
        ].join("\n");
    }
    chunks.push(text);
  }
  const text = chunks.join("\n");
  if (text.length <= budget) return text;
  const notice = "Observation shortened; details omitted.";
  const selected: string[] = [];
  for (const chunk of chunks) {
    if ([...selected, chunk, notice].join("\n").length > budget) break;
    selected.push(chunk);
  }
  if (notice.length <= budget) return [...selected, notice].join("\n");
  return "[omitted]".length <= budget ? "[omitted]" : "…".slice(0, budget);
}
