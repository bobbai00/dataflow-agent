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

import type { OperatorInfo, ResultVersion } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { NATIVE_BY_TYPE } from "./catalog";
import { scanLines } from "./checks";
import type { ProfileColumn, ProfileScalar } from "./profiles";
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
}

export interface NativeEvidenceFact {
  id: string;
  family: "data" | "flow";
  kind: "guarantee" | "measurement" | "warning";
  text: string;
  priority: number;
  columnCount?: NativeColumnCount;
  coveredCount?: NativeColumnCount;
  upstream?: NativeUpstreamIdentity;
}

export interface NativeObservationOptions {
  data: boolean;
  flow: boolean;
  maxChars: number;
  maxRows?: number;
  detail?: "shape" | "sample";
  columns?: readonly string[];
  view?: RetrievalView;
  dataMaxChars?: number;
  flowMaxChars?: number;
}

/** Audit metadata is not appended to model text. Full version references are
 * retained here; short prefixes in text are display labels, not cache keys. */
export interface NativeObservation {
  version: 1;
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
const fraction = (n: number, d: number) => `${n}/${d}${d === 0 ? " (undefined)" : ""}`;
const scalarText = (x: ProfileScalar) => (x.type === "int64" ? x.value : json(x.value));
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

/** Columns an operator reads, as declared or as measured at execution; a
 * map's pass-through columns are not reads. Undefined for a process, whose
 * reads are not known. */
function readColumns(op: OperatorPredicate, info: OperatorInfo | undefined): string[] | undefined {
  const type = op.nativeOp?.type;
  if (type === "Process") return undefined;
  const operations = record(info?.tableProfile?.native?.operations);
  if (type === "Map") return [...declaredColumns(op), ...names(operations.readColumns)];
  if (type === "Filter") return [...declaredColumns(op), ...names(operations.predicateColumns)];
  return declaredColumns(op);
}

/** Facts derived from an aggregate's meaning over the rows it reduced:
 *  - a distinct count of a column that is unique per input row counts rows,
 *    and the input has coarser columns that may be the intended unit;
 *  - the group key almost always determines a column but not in some groups
 *    (measured by the runtime), so those groups pool distinct entities;
 *  - low-cardinality columns that no operator on the way here has read,
 *    with their values over the rows being reduced (an unapplied flag). */
function aggregateSemantics(
  context: NativeEvidenceContext,
  input: OperatorInfo | undefined,
  rowsIn: number,
  operations: Record<string, any>
): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  const p = context.op.nativeOp!.properties;
  const keys = names(p.groupBy);
  const aggregations = (Array.isArray(p.aggregations) ? p.aggregations : []).map(record);
  const profile = input && validProfile(input) ? input.tableProfile! : undefined;
  if (profile) {
    const columns = Object.entries(profile.columns);
    for (const a of aggregations) {
      if (a.fn !== "count_distinct" || typeof a.col !== "string") continue;
      const c = profile.columns[a.col];
      if (!c || !fullColumn(input!, c) || c.distinctCount !== rowsIn || c.nullCount) continue;
      const coarser = columns
        .filter(([name, x]) => name !== a.col && !keys.includes(name) && x.type === "str" && fullColumn(input!, x))
        .filter(([, x]) => x.distinctCount !== null && x.distinctCount >= 2 && x.distinctCount * 2 <= rowsIn)
        .sort(([, x], [, y]) => x.distinctCount! - y.distinctCount!)
        .slice(0, 3);
      facts.push([
        `flow.aggregate.grain.${a.as}`,
        `${json(a.as)} = count_distinct(${json(a.col)}): ${json(a.col)} is unique on every one of the ${rowsIn} input rows, so it counts rows${coarser.length ? `; input columns with fewer values: ${coarser.map(([name, x]) => `${json(name)} (${x.distinctCount})`).join(", ")}` : ""}.`,
      ]);
    }
  }
  for (const d of Array.isArray(operations.keyDependencies) ? operations.keyDependencies.map(record) : []) {
    const example = record(d.example);
    facts.push([
      `flow.aggregate.key.${d.column}`,
      `group key ${json(keys)} determines ${json(d.column)} in most groups but not in ${d.split} of ${d.groups}: e.g. ${json(names(example.key).length === 1 ? names(example.key)[0] : example.key)} has ${json(d.column)} = ${names(
        example.values
      )
        .map(v => json(v))
        .join(", ")}; those rows are pooled into one group.`,
    ]);
  }
  // Columns never read on the way here: over the rows this aggregate reduces
  // when they are still in its input, else in the source they were dropped
  // from. Only flag-like columns (two or three values, repeated) qualify.
  const flagLike = (info: OperatorInfo, c: ProfileColumn, rows: number) =>
    rows >= 10 &&
    fullColumn(info, c) &&
    !!c.frequencies &&
    !c.frequencies.truncated &&
    !c.frequencies.otherCount &&
    c.frequencies.values.length >= 2 &&
    c.frequencies.values.length <= 3;
  const values = (c: ProfileColumn) => c.frequencies!.values.map(v => `${scalarText(v.value)}:${v.count}`).join(", ");
  if (profile) {
    const read = new Set<string>([...keys, ...aggregations.flatMap(a => (typeof a.col === "string" ? [a.col] : []))]);
    const sources: NativeEvidenceContext[] = [];
    const pending = [...boundInputs(context)];
    for (let seen = 0; pending.length && seen < 32; seen++) {
      const ancestor = pending.shift()!;
      const columns = readColumns(ancestor.op, ancestor.info);
      if (!columns) return facts;
      columns.forEach(name => read.add(name));
      if (ancestor.op.nativeOp?.type === "Scan" && !ancestor.op.nativeOp.properties.preview) sources.push(ancestor);
      pending.push(...boundInputs(ancestor));
    }
    const lines: Array<[string, string]> = [];
    for (const [name, c] of Object.entries(profile.columns))
      if (!read.has(name) && flagLike(input!, c, rowsIn))
        lines.push([
          `flow.aggregate.unread.${name}`,
          `input column ${json(name)} was read by no operator on the way here; over the ${rowsIn} rows reduced it is ${values(c)}.`,
        ]);
    for (const source of sources) {
      const sourceProfile = validProfile(source.info) ? source.info.tableProfile! : undefined;
      for (const [name, c] of Object.entries(sourceProfile?.columns ?? {}))
        if (!read.has(name) && !(name in profile.columns) && flagLike(source.info, c, source.info.totalRowCount ?? 0))
          lines.push([
            `flow.aggregate.dropped.${source.op.operatorID}.${name}`,
            `source \`${source.op.operatorID}\` column ${json(name)} (${values(c)}) was dropped on the way here without any operator reading it.`,
          ]);
    }
    facts.push(...lines.slice(0, 2));
  }
  return facts;
}

/** Consumes structured, version-bound profiles only. No execution, hidden
 * fetch, human-stat-string parsing, or inference of Python semantics. */
export function collectNativeEvidence(context: NativeEvidenceContext): {
  facts: NativeEvidenceFact[];
  omissions: string[];
} {
  const result = collectLocalEvidence(context);
  const queue = (context.op.nativeOp?.type === "Process" ? [] : boundInputs(context)).map(input => ({
    input,
    depth: 1,
  }));
  const seen = new Set([context.op.operatorID]);
  const summaries: NativeEvidenceFact[] = [];
  for (let visited = 0; queue.length && visited < 32; visited++) {
    const { input, depth } = queue.shift()!;
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
      Process: "Process row/column mapping unknown; upstream calculation summary stops here",
    };
    // Continue past nearby projections to find measured conversion losses.
    // The graph walk and the number of displayed summaries stay bounded.
    const local = collectLocalEvidence(input);
    const losses = local.facts.filter(f => f.id.startsWith("flow.cast.") && f.priority === 100);
    if (losses.length) semantic.Cast = "Cast produced nulls for values it could not convert";
    if (semantic[view.type]) {
      const measurements = local.facts
        .filter(f => f.family === "flow" && f.kind === "measurement" && f.priority >= 94)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, view.type === "Aggregate" || view.type === "Cast" ? 2 : 1);
      const version = info.resultVersion!;
      summaries.push({
        id: `flow.upstream.${op.operatorID}.${version.id}`,
        family: "flow",
        kind: measurements.length ? "measurement" : view.type === "Process" ? "warning" : "guarantee",
        text: `Flow upstream ${op.operatorID}: ${semantic[view.type]}.${measurements.length ? " " + measurements.map(f => f.text.replace(/^Flow measurement: /, "")).join(" ") : ""}`,
        priority: (losses.length ? 101 : 98) - depth / 10,
        upstream: { operatorId: op.operatorID, resultVersion: version.id },
      });
    }
    if (view.type === "Process") continue;
    if (depth < 8) queue.push(...boundInputs(input).map(next => ({ input: next, depth: depth + 1 })));
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

  const contract: Record<string, string> = {
    Scan: "source creation; preview is not the full parsed source",
    Project: `row identities preserved, same order; selection/rename=${json(p)}`,
    Cast: `row identities preserved, same order; declared casts=${json(p.columns ?? [])}; errors=${p.errors ?? "raise"}`,
    Map: `row identities preserved, same order; added=${json(names(record(info.tableProfile?.native?.operations).addedColumns))}; dropped=${json(names(record(info.tableProfile?.native?.operations).droppedColumns))}; dependencies measured from the columns the function read`,
    Filter: `stable subset of input rows; predicate columns=${json(names(record(info.tableProfile?.native?.operations).predicateColumns))}`,
    Aggregate: `one output row per group; group keys=${json(p.groupBy ?? [])}; null keys form a group`,
    Join: `declared ${p.type ?? "inner"} join; nullsEqual=${p.nullsEqual ?? false}; validate=${p.validate ?? "many_to_many"}; row order unspecified`,
    Union: "concatenation preserves all rows and input-port order; no deduplication",
    Distinct: `stable retained subset; keys=${p.columns === undefined ? "whole row" : json(p.columns)}; keep=${p.keep ?? "first"}`,
    Limit: `stable positional slice; offset=${p.offset ?? 0}, n=${p.n}; not a top-k claim without Sort`,
    Sort: `row identities preserved; stable sort by=${json(p.by ?? [])}; nulls=${p.nulls ?? "last"}`,
    Window: `row identities preserved, input order restored; partition keys=${json(p.partitionBy ?? [])}; stable order=${json(p.orderBy ?? [])}, nulls last; outputs=${json(p.columns ?? [])}`,
    Unpivot: `one output per input row then selected column, including null cells; value dependencies=${json(p.columns ?? [])}`,
    Pivot: `unique index/pivot-key pairs, no implicit aggregation; first-seen row/key order; dynamic column values depend on=${json(p.values)}`,
    Process: "row/column mapping unknown; equal row counts do not prove preservation",
  };
  // Contracts that only restate what the operator name says (a sort keeps
  // rows, a project keeps order) are not rendered. Author descriptions express
  // intent and cannot establish a guarantee about the computation.
  const RESTATES = new Set(["Scan", "Project", "Cast", "Union", "Distinct", "Limit", "Sort"]);
  if (contract[view.type] && !RESTATES.has(view.type))
    add(
      "flow.contract",
      "flow",
      view.type === "Process" ? "warning" : "guarantee",
      `${view.type}: ${contract[view.type]}.`,
      25
    );

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
    const input = inputs[0]!;
    if (validProfile(input))
      for (const name of names(operations.predicateColumns)) {
        if (context.columns?.length && !context.columns.includes(name)) continue;
        const before = own(input.tableProfile!.columns, name) ? input.tableProfile!.columns[name] : undefined;
        const after = own(profile!.columns, name) ? profile!.columns[name] : undefined;
        if (before && after && hasColumnObservations(input, before) && hasColumnObservations(info, after))
          add(
            `flow.filter.column.${name}`,
            "flow",
            "measurement",
            `predicate column ${json(name)}: input (${columnScope(input, before)}) null=${fraction(before.nullCount, before.rowsProcessed)}, distinct(nonnull)=${before.distinctCount ?? "unknown"}; output (${columnScope(info, after)}) null=${fraction(after.nullCount, after.rowsProcessed)}, distinct(nonnull)=${after.distinctCount ?? "unknown"}.`,
            88,
            { coveredCount: columnCount(info, name, after) }
          );
      }
    const { keptRows, rejectedRows, nullPredicates } = operations;
    if (
      count(keptRows) &&
      count(rejectedRows) &&
      count(nullPredicates) &&
      keptRows === out &&
      keptRows + rejectedRows === ns[0] &&
      nullPredicates <= rejectedRows
    ) {
      add(
        "flow.filter",
        "flow",
        "measurement",
        `Filter kept=${fraction(out, ns[0])}, rejected=${rejectedRows}, null predicates=${nullPredicates} (a None verdict drops the row).`,
        96
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
      add(
        "flow.aggregate",
        "flow",
        "measurement",
        `Aggregate groups=${out} from ${ns[0]} rows; group size min=${size.min ?? "undefined"}, max=${size.max ?? "undefined"}.`,
        96
      );
      for (const agg of Array.isArray(p.aggregations) ? p.aggregations : []) {
        const a = record(agg),
          denom = record(record(operations.aggregateNonNull)[a.as]);
        if (
          typeof a.as === "string" &&
          count(denom.total) &&
          denom.total <= ns[0] &&
          ((emptyGroups && denom.total === 0 && denom.min === null && denom.max === null) ||
            (count(denom.min) &&
              count(denom.max) &&
              denom.min <= denom.max &&
              denom.min * out <= denom.total &&
              denom.max * out >= denom.total))
        ) {
          add(
            `flow.aggregate.${a.as}`,
            "flow",
            "measurement",
            `${json(a.as)} ${a.fn === "count" && a.col === undefined ? "row denominator" : "nonnull"}=${fraction(denom.total, ns[0])}; per-group min=${denom.min ?? "undefined"}, max=${denom.max ?? "undefined"}; reducer=${a.fn}${a.fn === "first" ? " (first includes null)" : ""}.`,
            95
          );
        } else omissions.push("aggregate_denominator_unavailable");
      }
      aggregateSemantics(context, inputs[0], ns[0], operations).forEach(([id, text]) =>
        add(id, "flow", "measurement", text, 97)
      );
    } else omissions.push("invalid_aggregate_counters");
  } else if (view.type === "Join") {
    const join = record(operations.join);
    const type = p.type ?? "inner";
    if (type === "cross") {
      if (
        join.type === "cross" &&
        join.leftRows === ns[0] &&
        join.rightRows === ns[1] &&
        count(ns[0] * ns[1]) &&
        join.matchedOutputRows === out &&
        out === ns[0] * ns[1]
      )
        add("flow.join.cross", "flow", "measurement", `Cross join output=${ns[0]}*${ns[1]}=${out} rows.`, 96);
      else omissions.push("invalid_join_counters");
    } else {
      const sides = [record(join.left), record(join.right)];
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
            s.matchedRows <= join.matchedOutputRows
        ) &&
        sides[0].matchedKeys === sides[1].matchedKeys &&
        join.matchedOutputRows +
          (["left", "full"].includes(type as string) ? sides[0].unmatchedRows : 0) +
          (["right", "full"].includes(type as string) ? sides[1].unmatchedRows : 0) ===
          out;
      if (valid) {
        add(
          "flow.join.output",
          "flow",
          "measurement",
          `Join matched contribution=${join.matchedOutputRows} (sum L(k)*R(k)); output=${out}, including outer unmatched rows as declared.`,
          96
        );
        sides.forEach((s, i) =>
          add(
            `flow.join.${i}`,
            "flow",
            "measurement",
            `${i ? "right" : "left"} matched rows=${fraction(s.matchedRows, s.rows)}, unmatched rows=${s.unmatchedRows}; matched keys=${fraction(s.matchedKeys, s.distinctKeys)}, unmatched keys=${s.unmatchedKeys}; null-key rows=${s.nullKeyRows}, max eligible multiplicity=${s.maxMultiplicity}.`,
            95
          )
        );
      } else omissions.push("invalid_join_counters");
    }
  } else if (view.type === "Union") {
    const sum = ns.reduce((a, b) => a + b, 0);
    if (count(sum) && sum === out) {
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
      add(
        "flow.window",
        "flow",
        "measurement",
        `Window preserved=${out} rows; partitions=${window.partitions}, ties beyond first=${window.tieRows}.`,
        94
      );
      for (const item of Array.isArray(p.columns) ? p.columns : []) {
        const c = record(item);
        if (!["lag", "lead"].includes(c.fn) || typeof c.as !== "string") continue;
        const counter = record(record(window.outputs)[c.as]);
        if (
          count(counter.boundaryNulls) &&
          count(counter.nullOutputs) &&
          counter.boundaryNulls >= window.partitions &&
          counter.boundaryNulls <= counter.nullOutputs &&
          counter.nullOutputs <= out &&
          (Number(c.offset ?? 1) < out || counter.boundaryNulls === out)
        ) {
          add(
            `flow.window.${c.as}`,
            "flow",
            "measurement",
            `${json(c.as)} boundary nulls=${fraction(counter.boundaryNulls, out)}, total nulls=${fraction(counter.nullOutputs, out)}; existing null cells may also propagate.`,
            93
          );
        } else omissions.push("window_output_counters_unavailable");
      }
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
      add(
        "flow.pivot",
        "flow",
        "measurement",
        `Pivot unique pairs=${x.uniquePairs}, index groups=${out}, generated columns=${x.generatedColumns}, absent cells=${x.missingCells} (filled null, separate from null input values).`,
        94
      );
    } else omissions.push("invalid_pivot_counters");
  } else if (["Distinct", "Limit"].includes(view.type)) {
    if (count(operations.removedRows) && operations.removedRows + out === ns[0])
      add(
        "flow.removed",
        "flow",
        "measurement",
        `${view.type} retained=${fraction(out, ns[0])}, removed=${operations.removedRows}.`,
        94
      );
    else omissions.push("invalid_removal_counters");
  } else if (view.type === "Scan") {
    const scan = record(operations.scan);
    if (
      typeof scan.preview === "boolean" &&
      count(scan.resolvedFiles) &&
      count(scan.selectedFiles) &&
      count(scan.omittedFiles) &&
      scan.selectedFiles + scan.omittedFiles === scan.resolvedFiles
    ) {
      add(
        "flow.scan",
        "flow",
        "measurement",
        `Scan ${scan.preview ? "preview only (not full source)" : "parsed selected sources"}; files selected=${scan.selectedFiles}/${scan.resolvedFiles}, omitted=${scan.omittedFiles}; output=${out} rows.`,
        96
      );
      // Per source, only what the parse found: a header row that reads as
      // data (with the nearby row that reads as a header) and empty sources.
      // Paths, sizes and mtimes stay in the audit metadata.
      scanLines(operations).forEach((text, i) =>
        add(`flow.scan.header.${i}`, "flow", "measurement", `Scan: ${text}`, 97)
      );
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
  } else if (view.type === "Process") {
    add(
      "flow.process.counts",
      "flow",
      "measurement",
      `Process input rows=${json(ns)}, output=${out}; row/column mapping unknown.`,
      75
    );
  }
  if (["Cast", "Map"].includes(view.type) && ns[0] === out) {
    if (view.type === "Cast")
      for (const [name, failures] of Object.entries(record(operations.conversionFailures))) {
        if (count(failures) && failures <= ns[0] && (p.errors === "null" || failures === 0))
          add(
            `flow.cast.${name}`,
            "flow",
            "measurement",
            `${json(name)} conversion failures=${failures}/${ns[0]} rows (errors=${p.errors ?? "raise"}).`,
            failures ? 100 : 50
          );
      }
    const input = inputs[0]!;
    for (const [name, after] of Object.entries(profile!.columns)) {
      const before = own(input.tableProfile?.columns ?? {}, name) ? input.tableProfile!.columns[name] : undefined;
      if (
        relevant.has(name) &&
        before &&
        before.nullCount !== after.nullCount &&
        fullColumn(input, before) &&
        fullColumn(info, after)
      )
        add(
          `flow.nulls.${name}`,
          "flow",
          "measurement",
          `${json(name)} nulls before=${before.nullCount}/${ns[0]}, after=${after.nullCount}/${out}, delta=${after.nullCount - before.nullCount}; row-preserving contract, not a claim of cellwise equivalence.`,
          90
        );
    }
  }
  return { facts, omissions: [...new Set(omissions)] };
}

function cellText(value: unknown, type: string): string {
  if (value === null) return "null";
  if (type === "int64" && typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value)) return value;
  return json(value) ?? "[unavailable]";
}

/** Evidence is additive. The table (shape, schema, sample rows) is the same in
 * every arm and fits `maxChars`. Data measurements and flow evidence each get a
 * budget of their own, equal to the room the table's first allocation (shape,
 * schema, reserved rows) left, so neither family displaces a row or the other
 * family: the Data-only view is the no-evidence view plus the data lines, the
 * Flow-only view is it plus the flow lines, and the combined view is both.
 * Errors use the separate diagnostic path. */
export function selectNativeObservation(context: NativeEvidenceContext & NativeObservationOptions): NativeObservation {
  const { op, info, data, flow } = context;
  const maxChars = Number.isFinite(context.maxChars) ? Math.max(0, Math.floor(context.maxChars)) : 2000;
  const result: NativeObservation = {
    version: 1,
    resultVersion: info.resultVersion?.id ?? null,
    inputs: structuredClone(info.resultVersion?.inputs ?? []),
    options: {
      data,
      flow,
      maxChars,
      maxRows: context.maxRows,
      detail: context.detail,
      columns: context.columns ? [...context.columns] : undefined,
      ...(context.view
        ? { view: context.view, dataMaxChars: context.dataMaxChars, flowMaxChars: context.flowMaxChars }
        : {}),
    },
    text: "",
    selected: [],
    chunks: [],
    omitted: [],
  };
  // Three parts, each with its own budget; chunks are pushed in text order
  // (table, data lines, flow lines, notice).
  const lines: string[] = [];
  const dataLines: string[] = [];
  const flowLines: string[] = [];
  const NOTICE = "View incomplete; unshown rows/columns or evidence omitted.";
  const used = (list: string[]) => list.join("\n").length + (list.length ? 1 : 0);
  const pushTo =
    (list: string[], budget: () => number) =>
    (text: string, id: string): boolean => {
      if (used(list) + text.length > budget()) return false;
      list.push(text);
      result.selected.push(id);
      result.chunks.push({ id, text });
      return true;
    };
  let evidenceBudget = 0;
  const append = pushTo(lines, () => maxChars);
  const appendData = pushTo(dataLines, () => context.dataMaxChars ?? evidenceBudget);
  const appendFlow = pushTo(flowLines, () => context.flowMaxChars ?? evidenceBudget);
  const rows = info.result ?? [];
  const rawPreview = op.nativeOp?.type === "Scan" && Number(op.nativeOp.properties.preview ?? 0) > 0;
  const schema =
    info.resultSchema ?? Object.keys(rows[0] ?? {}).map(name => ({ name, type: "unknown", encoding: "unknown" }));
  const total = count(info.totalRowCount) ? info.totalRowCount : undefined;
  const summary = `Output Table: ${total ?? "?"} rows, ${schema.length} cols${rawPreview ? " (source preview only)" : ""}`;
  if (!append(summary, "table.shape")) {
    result.text = maxChars >= 9 ? "[omitted]" : "…".slice(0, maxChars);
    result.omitted.push({ id: "table", reason: "budget" });
    return result;
  }
  const rowLimit =
    context.view !== "full" && context.maxRows && context.maxRows > 0 ? Math.floor(context.maxRows) : rows.length;
  const schemaLine = (fields: typeof schema) => `Columns: ${fields.map(c => `${json(c.name)}:${c.type}`).join("\t")}`;
  const rowLine = (row: Record<string, unknown>, fields: typeof schema) =>
    fields.map(c => cellText(own(row, c.name) ? row[c.name] : undefined, c.type)).join("\t");
  const complete =
    context.detail !== "shape" &&
    !!info.resultSchema &&
    total !== undefined &&
    total === rows.length &&
    info.truncated === false &&
    rowLimit >= rows.length &&
    (!context.columns?.length || schema.every(c => context.columns!.includes(c.name))) &&
    rows.every(row =>
      schema.every(
        c => own(row, c.name) && !(typeof row[c.name] === "string" && row[c.name].includes("...[truncated]..."))
      )
    );
  const table = [
    schemaLine(schema),
    rawPreview ? "Complete preview output (source remains partial):" : "Complete table (all rows):",
    ...rows.map(row => rowLine(row, schema)),
  ].join("\n");
  const completeVisible = complete && append(table, "table.complete");
  let columnsShown = completeVisible ? schema.length : 0;
  const evidence = collectNativeEvidence(context);
  result.omitted.push(...evidence.omissions.map(id => ({ id, reason: "unavailable" as const })));
  // Rows that overflow the sample reserve fill the rest of the table's budget,
  // exactly as without evidence; evidence facts never compete with them.
  const rowCandidates: NativeEvidenceFact[] = [];
  const dataCandidates: NativeEvidenceFact[] = [];
  const flowCandidates: NativeEvidenceFact[] = [];
  if (!completeVisible && context.view === "full") {
    // Preserve stored order and cell contents. The transport may itself be
    // truncated; a full request must never label that partial result complete.
    const reserve = NOTICE.length + 1;
    const appendRecord = pushTo(lines, () => Math.max(0, maxChars - reserve));
    if (appendRecord(schemaLine(schema), "table.schema")) {
      columnsShown = schema.length;
      for (const [i, row] of rows.entries()) if (!appendRecord(rowLine(row, schema), `record.${i}`)) break;
    } else appendRecord("Columns omitted: budget", "table.schema_omitted");
  } else if (!completeVisible) {
    const relevant = relevance(context);
    const allowed = schema.filter(c => !context.columns?.length || context.columns.includes(c.name));
    // Relevant columns first, then the table's own order: a lexical tie-break
    // showed col0, col1, col10.. col137 of a 180-column table, and the model
    // read the fourth shown column as col3.
    const position = new Map(schema.map((c, i) => [c.name, i]));
    const ranked = [...allowed].sort(
      (a, b) =>
        Number(relevant.has(b.name)) - Number(relevant.has(a.name)) || position.get(a.name)! - position.get(b.name)!
    );
    const selected: typeof schema = [];
    const schemaBudget = Math.max(0, Math.floor(maxChars * 0.3));
    for (const c of ranked)
      if (schemaLine([...selected, c]).length + (selected.length + 1 === schema.length ? 0 : 24) <= schemaBudget)
        selected.push(c);
    // Keep the declared schema order within the selected column subset.
    const fields = schema.filter(c => selected.includes(c));
    columnsShown = fields.length;
    if (fields.length)
      append(
        `${schemaLine(fields)}${fields.length === schema.length ? "" : ` (shown=${fields.length}/${schema.length})`}`,
        "table.schema"
      );
    else append("Columns omitted: budget", "table.schema_omitted");
    if (context.detail !== "shape" && fields.length) {
      const order = Array.from({ length: rows.length }, (_, i) =>
        rawPreview ? i : i % 2 === 0 ? i / 2 : rows.length - 1 - Math.floor(i / 2)
      ).slice(0, rowLimit);
      // Reserve part of the SAME budget for records. Preview prefixes expose
      // headers beneath preambles; clipping cells must not hide entire rows.
      const sampleBudget = Math.floor(maxChars * (rawPreview ? 0.75 : 0.25));
      let sampleChars = 0;
      for (const [rank, i] of order.entries()) {
        const sampleRow = Object.fromEntries(
          fields.map(c => {
            const value = rows[i][c.name];
            const cap = rawPreview ? 120 : 160;
            return [
              c.name,
              typeof value === "string" && value.length > cap ? value.slice(0, cap) + "...[truncated]..." : value,
            ];
          })
        );
        // Retained samples can omit interior rows; do not imply table positions.
        const prefix = "Sample record: ";
        let sampleText = prefix + rowLine(sampleRow, fields);
        // A one-row preview is the documented way to inspect a wide header.
        // Spend its remaining record budget on the raw line, including JSON
        // escaping, instead of applying the multi-row 120-character clip.
        const rawLine = rows[i].line;
        if (rawPreview && order.length === 1 && typeof rawLine === "string" && fields.some(c => c.name === "line")) {
          const budget = Math.max(0, maxChars - used(lines) - NOTICE.length - 1);
          const render = (length: number) =>
            prefix +
            rowLine(
              { ...sampleRow, line: rawLine.slice(0, length) + (length < rawLine.length ? "...[truncated]..." : "") },
              fields
            );
          const fullLine = render(rawLine.length);
          if (fullLine.length <= budget) sampleText = fullLine;
          else if (render(0).length <= budget) {
            let lower = 0;
            let upper = rawLine.length - 1;
            while (lower < upper) {
              const middle = Math.ceil((lower + upper) / 2);
              if (render(middle).length <= budget) lower = middle;
              else upper = middle - 1;
            }
            sampleText = render(lower);
          }
        }
        const fact: NativeEvidenceFact = {
          id: `sample.${i}`,
          family: "data",
          kind: "measurement",
          text: sampleText,
          priority: rank === 0 ? 105 : 35 - rank,
        };
        if (sampleChars + fact.text.length + 1 <= sampleBudget && append(fact.text, fact.id)) {
          sampleChars += fact.text.length + 1;
        } else rowCandidates.push(fact);
      }
    }
    result.omitted.push({ id: "table.complete", reason: complete ? "budget" : "unavailable" });
  }
  // Each evidence family gets the room the table's first allocation left
  // (minus the incompleteness notice); the same size for data and flow.
  evidenceBudget = Math.max(0, maxChars - used(lines) - (completeVisible ? 0 : NOTICE.length + 1));
  for (const fact of evidence.facts) {
    if (!(fact.family === "data" ? data : flow)) result.omitted.push({ id: fact.id, reason: "disabled" });
    else if (completeVisible && fact.family === "data")
      result.omitted.push({ id: fact.id, reason: "redundant_complete_table" });
    else (fact.family === "flow" ? flowCandidates : dataCandidates).push(fact);
  }
  // Ties keep collection order, which follows the table's own column order.
  const byPriority = (a: NativeEvidenceFact, b: NativeEvidenceFact) => b.priority - a.priority;
  // Overflow rows fill the table's budget but never the notice's place.
  const appendRow = pushTo(lines, () => maxChars - (completeVisible ? 0 : NOTICE.length + 1));
  for (const fact of rowCandidates.sort(byPriority))
    if (!appendRow(fact.text, fact.id)) result.omitted.push({ id: fact.id, reason: "budget" });
  if (data && context.view === "sample_stats" && !completeVisible) {
    const profile = validProfile(info) ? info.tableProfile : undefined;
    const status = isRawLineTable(op, info)
      ? "Parse raw lines into columns to obtain data statistics."
      : !profile
        ? "Data statistics unavailable for this result."
        : profile.coverage.rowsProcessed === 0 && total !== 0
          ? "Data statistics unavailable: no rows were profiled."
          : `Data statistics: ${profile.coverage.complete && profile.coverage.rowsProcessed === total ? "full table" : "partial prefix"}, ${profile.coverage.rowsProcessed}/${total ?? "?"} rows; ${Object.keys(profile.columns).length}/${schema.length} columns profiled.`;
    if (!appendData(status, "view.data_status")) result.omitted.push({ id: "view.data_status", reason: "budget" });
  }
  // Column counts are rendered as rows of one table, so they are budgeted as
  // those rows (a header once, then a short line per column), not as the
  // sentences they were collected as; the rest of the data lines follow.
  // One table per coverage scope (full vs partial prefix), each contiguous.
  const scopes = new Map<string, NativeEvidenceFact[]>();
  const dataBudget = context.dataMaxChars ?? evidenceBudget;
  // Wide count tables otherwise consume the entire display allocation. Leave
  // room for distributions/ranges while retaining the existing small-budget
  // behavior and prioritizing counts for columns used by the graph.
  const countsBudget =
    dataBudget >= 600 && dataCandidates.some(f => !f.columnCount) ? Math.floor(dataBudget / 2) : dataBudget;
  const countsStart = used(dataLines);
  for (const fact of dataCandidates.filter(f => f.columnCount).sort(byPriority))
    scopes.set(fact.columnCount!.scope, [...(scopes.get(fact.columnCount!.scope) ?? []), fact]);
  for (const [scope, counts] of scopes) {
    const header = `Data measurement: column counts (${scope})\ncolumn | null | nonnull | distinct(nonnull)`;
    let shown = false;
    for (const fact of counts) {
      const c = fact.columnCount!;
      const row = `${json(c.column)} | ${c.nulls} | ${c.nonnull} | ${c.distinct ?? "unknown"}`;
      if (used(dataLines) - countsStart + (shown ? 0 : header.length + 1) + row.length + 1 > countsBudget) {
        result.omitted.push({ id: fact.id, reason: "budget" });
        continue;
      }
      if (!shown && used(dataLines) + header.length + row.length + 2 > (context.dataMaxChars ?? evidenceBudget)) {
        result.omitted.push({ id: fact.id, reason: "budget" });
        continue;
      }
      if (!shown) shown = appendData(header, `data.counts.header.${scope}`);
      if (!appendData(row, fact.id)) result.omitted.push({ id: fact.id, reason: "budget" });
    }
  }
  for (const fact of dataCandidates.filter(f => !f.columnCount).sort(byPriority))
    if (!appendData(fact.text, fact.id)) result.omitted.push({ id: fact.id, reason: "budget" });
  for (const fact of flowCandidates.sort(byPriority))
    if (!appendFlow(fact.text, fact.id)) result.omitted.push({ id: fact.id, reason: "budget" });
  const notice = !completeVisible && append(NOTICE, "view.omissions");
  // Text order = chunk order: the table, the data lines, the flow lines, then the notice.
  const tableLines = notice ? lines.slice(0, -1) : lines;
  result.text = [...tableLines, ...dataLines, ...flowLines, ...(notice ? lines.slice(-1) : [])].join("\n");
  result.table = {
    totalRows: total ?? null,
    returnedRows: completeVisible ? rows.length : result.selected.filter(id => /^(sample|record)\./.test(id)).length,
    totalColumns: schema.length,
    columnsShown,
    complete: !!completeVisible,
  };
  return compactNativeObservation(result, evidence.facts);
}

/** Historical compaction is subtractive: it may drop rows or tail chunks,
 * never extract fresh profiles or use a later DAG to choose new evidence. */
export function restrictNativeObservation(
  observation: NativeObservation,
  limits: { maxChars?: number; maxRows?: number; detail?: "sample" | "shape" }
): string {
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
