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
import { scanLines } from "./checks";
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
  kind: "guarantee" | "measurement" | "warning";
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
            `source \`${context.displayName?.(source.op.operatorID) ?? source.op.operatorID}\` column ${json(name)} (${values(c)}) was dropped on the way here without any operator reading it.`,
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
        .slice(0, view.type === "Join" ? 3 : ["Aggregate", "Cast", "Window", "Filter"].includes(view.type) ? 2 : 1);
      // Keep coverage counters ahead of optional examples. Long compound keys
      // remain available on direct retrieval without crowding ancestor summaries.
      if (view.type === "Join")
        measurements.push(
          ...local.facts
            .filter(f => /^flow\.join\.\d+\.unmatched\.examples$/.test(f.id) && f.text.length <= 320)
            .slice(0, 2)
        );
      const version = info.resultVersion!;
      summaries.push({
        id: `flow.upstream.${op.operatorID}.${version.id}`,
        family: "flow",
        kind: measurements.length ? "measurement" : view.type === "Process" ? "warning" : "guarantee",
        text: `Flow upstream ${op.operatorID}: ${semantic[view.type]}.${measurements.length ? " " + measurements.map(f => f.text.replace(/^Flow measurement: /, "")).join(" ") : ""}${opaque ? " Before custom processing; row/column correspondence to this output unknown." : ""}`,
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
      `${view.registeredName ?? view.type}: ${contract[view.type]}.`,
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
      const rejected = record(operations.filterRejectedValues);
      if (rejected.rejectedRows === rejectedRows && rejectedRows > 0) {
        const columns = Object.entries(record(rejected.columns)).slice(0, 8);
        for (const [name, raw] of columns) {
          if (
            !names(operations.predicateColumns).includes(name) ||
            (context.columns?.length && !context.columns.includes(name))
          )
            continue;
          const details = record(raw);
          const examples = witnesses(details.examples, 1, rejectedRows);
          if (
            !examples.length ||
            !count(details.otherCount) ||
            examples.reduce((n, item) => n + item.count, 0) + details.otherCount !== rejectedRows
          )
            continue;
          add(
            `flow.filter.rejected.${name}`,
            "flow",
            "measurement",
            `Filter ${json(name)} among ${rejectedRows} rejected rows, including null-predicate drops: ${examples.map(item => witnessText(item)).join("; ")}; other=${details.otherCount}. Bounded first distinct values, not causes or top frequencies.`,
            94
          );
        }
      }
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
      if (valid) {
        add(
          "flow.join.output",
          "flow",
          "measurement",
          membership
            ? `${type === "semi" ? "Semi" : "Anti"} join output=${out}: the left rows with ${type === "semi" ? "a" : "no"} match on the right, each once.`
            : `Join matched contribution=${join.matchedOutputRows} (sum L(k)*R(k)); output=${out}, including outer unmatched rows as declared.`,
          96
        );
        sides.forEach((s, i) => {
          add(
            `flow.join.${i}`,
            "flow",
            "measurement",
            `${i ? "right" : "left"} matched rows=${fraction(s.matchedRows, s.rows)}, unmatched rows=${s.unmatchedRows}; matched keys=${fraction(s.matchedKeys, s.distinctKeys)}, unmatched keys=${s.unmatchedKeys}; null-key rows=${s.nullKeyRows}, max eligible multiplicity=${s.maxMultiplicity}.`,
            95
          );
          const keys = typeof p.on === "string" ? [p.on] : Array.isArray(p.on) ? p.on : [];
          for (const [kind, rows, minimum] of [
            ["unmatched", s.unmatchedRows, 1],
            ["duplicate", s.eligibleRows, 2],
          ] as const) {
            const examples = witnesses(s[`${kind}Examples`], keys.length, rows, minimum);
            if (
              !examples.length ||
              (kind === "unmatched" && examples.length > s.unmatchedKeys) ||
              examples.some(w => w.count > s.maxMultiplicity || (!join.nullsEqual && w.values.includes(null)))
            )
              continue;
            add(
              `flow.join.${i}.${kind}.examples`,
              "flow",
              "measurement",
              `${i ? "right" : "left"} ${kind === "unmatched" ? "eligible unmatched" : "duplicate"}-key examples (not exhaustive): ${examples.map(w => witnessText(w, true)).join("; ")}.`,
              92
            );
          }
        });
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
            `${json(c.as)} boundary nulls=${fraction(counter.boundaryNulls, out)}, total nulls=${fraction(counter.nullOutputs, out)}; ${c.fn}(${json(c.col)}, offset=${c.offset ?? 1}); existing null cells may also propagate.`,
            96
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
      // Only a scan that read less than every resolved file, previewed, or
      // returned nothing reports coverage; "selected=1/1" was 20–30% of all
      // flow lines and measured nothing.
      if (scan.preview || scan.omittedFiles > 0 || out === 0)
        add(
          "flow.scan",
          "flow",
          "measurement",
          `Scan ${scan.preview ? "preview only (not full source)" : "parsed selected sources"}; files selected=${scan.selectedFiles}/${scan.resolvedFiles}, omitted=${scan.omittedFiles}; output=${out} rows.`,
          // Ahead of the per-file lines: with many files, their findings fill
          // the budget, and the file and row counts must not be what is cut.
          98
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
  }
  // A registered function reports no flow line: its input and output row counts
  // are already in the receipts, and its row mapping is not measured.
  if (["Cast", "Map"].includes(view.type) && ns[0] === out) {
    if (view.type === "Cast")
      for (const [name, failures] of Object.entries(record(operations.conversionFailures))) {
        if (count(failures) && failures <= ns[0] && (p.errors === "null" || failures === 0)) {
          add(
            `flow.cast.${name}`,
            "flow",
            "measurement",
            `${json(name)} conversion failures=${failures}/${ns[0]} rows (errors=${p.errors ?? "raise"}).`,
            failures ? 100 : 50
          );
          const sample = record(record(operations.conversionFailureExamples)[name]);
          const examples = witnesses(sample.examples, 1, failures);
          if (
            examples.length &&
            count(sample.otherCount) &&
            examples.reduce((sum, w) => sum + w.count, sample.otherCount) === failures
          )
            add(
              `flow.cast.examples.${name}`,
              "flow",
              "measurement",
              `${json(name)} failed-value examples (not exhaustive): ${examples.map(w => witnessText(w)).join("; ")}; other failures=${sample.otherCount}.`,
              99
            );
        }
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
          const ranged = ["int64", "float64", "datetime"].includes(column.type) && column.min && column.max;
          let values = ranged ? `${display(column.min!)} to ${display(column.max!)}` : "";
          const frequencies = column.frequencies;
          if (frequencies?.values.length) {
            const shown = format.topValues > 0 ? frequencies.values.slice(0, format.topValues) : frequencies.values;
            const exhaustive =
              !frequencies.truncated && frequencies.otherCount === 0 && shown.length === frequencies.values.length;
            values =
              (values ? values + "; " : "") +
              `${exhaustive ? "all:" : "top:"} ${shown.map(item => `${display(item.value)} ${formatCount(item.count)}`).join("; ")}${exhaustive ? "" : `; other: ${formatCount(c.nonnull - shown.reduce((n, item) => n + item.count, 0))} (not exhaustive)`}`;
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
        if (rows.length)
          append(
            `data.statistics.${rowCount}`,
            `${caption(rows.length)}\n${renderTable(fields, rows, format.tableFormat)}`,
            dataBudget,
            "data",
            members
          );
        else
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
  if (flow) {
    const budget = Math.max(0, context.flowMaxChars ?? maxChars);
    const facts = evidence.facts
      .filter(f => f.family === "flow" && (context.upstream !== false || !f.upstream))
      .sort((a, b) => b.priority - a.priority);
    const notice = FLOW_OMITTED_NOTICE;
    const allText = facts.map(fact => {
      const origin = fact.upstream && (context.displayName?.(fact.upstream.operatorId) ?? fact.upstream.operatorId);
      const text = fact.text.replace(/^Flow upstream [^:]+:\s*/, "").replace(/^Flow \w+:\s*/, "");
      return `- flow${origin ? ` (${origin})` : ""}: ${fact.kind === "guarantee" ? "contract; " : ""}${text}`;
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
