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
import type { ProfileColumn, ProfileScalar } from "./profiles";
import { boundInputs, downstreamRelevantColumns } from "./evidence-lineage";
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
  /** Optional bounded slack for an entirely held small answer table only. */
  completeSmallTableChars?: number;
  maxRows?: number;
  detail?: "shape" | "sample";
  columns?: readonly string[];
}

/** Audit metadata is not appended to model text. Full version references are
 * retained here; short prefixes in text are display labels, not cache keys. */
export interface NativeObservation {
  version: 1;
  resultVersion: string | null;
  inputs: ResultVersion["inputs"];
  options: NativeObservationOptions;
  text: string;
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

/** Consumes structured, version-bound profiles only. No execution, hidden
 * fetch, human-stat-string parsing, or inference of Python semantics. */
/** Operators that keep one output row per input row: they do not change a
 * table's grain, so a lineage card leaves them out. */
const ROW_PRESERVING = new Set(["Project", "Cast", "Map", "Sort", "Window"]);

/** How a table was built: its row-changing steps back to the scans (the
 * first input of each, so the main line), with rows in and out and each
 * step's grouping keys or doc, at most six steps. A custom step that reuses
 * an earlier table reads its grain here (a mean of weekly means, a 10-row
 * leader table, a 498-row subset). Undefined when only the table itself is known. */
export function lineageCard(start: NativeEvidenceContext): string | undefined {
  const steps: string[] = [];
  const seen = new Set<string>();
  let current: NativeEvidenceContext | undefined = start;
  while (current && steps.length < 6 && !seen.has(current.op.operatorID)) {
    seen.add(current.op.operatorID);
    const view = current.op.nativeOp!;
    const p = view.properties;
    if (current === start || !ROW_PRESERVING.has(view.type)) {
      const inputRows = current.info.tableProfile?.native?.inputRows;
      const rows = current.info.totalRowCount ?? "?";
      const doc = typeof p.doc === "string" && p.doc ? ` ${json(p.doc)}` : "";
      const file = (value: unknown) => (typeof value === "string" ? value.split("/").pop() : value);
      const how =
        view.type === "Scan"
          ? `scan${p.files === undefined ? "" : ` of ${json(Array.isArray(p.files) ? p.files.map(file) : file(p.files))}`}`
          : view.type === "Aggregate"
            ? `aggregate by ${json(p.groupBy ?? [])}`
            : view.type === "Join"
              ? `${p.type ?? "inner"} join on ${json(p.on ?? [])}`
              : view.type === "Limit"
                ? `limit ${p.n}`
                : `${view.type.toLowerCase()}${doc}`;
      const flow = view.type !== "Scan" && Array.isArray(inputRows) && inputRows.length ? `${inputRows.join("+")} → ` : "";
      steps.push(`\`${current.op.operatorID}\` ${how}: ${flow}${rows} rows`);
    }
    current = boundInputs(current)[0];
  }
  return steps.length > 1 ? steps.join(" ← ") : undefined;
}

export function collectNativeEvidence(context: NativeEvidenceContext): {
  facts: NativeEvidenceFact[];
  omissions: string[];
} {
  const result = collectLocalEvidence(context);
  // A custom step's inputs, as they were built: the function reads them with
  // no other account of their grain or filters.
  if (context.op.nativeOp?.type === "Process")
    for (const input of boundInputs(context).slice(0, 2)) {
      const card = lineageCard(input);
      if (card)
        result.facts.push({
          id: `flow.lineage.${input.op.operatorID}`,
          family: "flow",
          kind: "measurement",
          text: `Flow measurement: input \`${input.op.operatorID}\` was built as ${card}.`,
          priority: 96,
        });
    }
  const queue = (context.op.nativeOp?.type === "Process" ? [] : boundInputs(context)).map(input => ({
    input,
    depth: 1,
  }));
  const seen = new Set([context.op.operatorID]);
  let summaries = 0;
  for (let visited = 0; queue.length && visited < 32 && summaries < 3; visited++) {
    const { input, depth } = queue.shift()!;
    const { op, info } = input;
    if (seen.has(op.operatorID)) continue;
    seen.add(op.operatorID);
    const view = op.nativeOp!;
    const p = view.properties;
    const semantic: Record<string, string> = {
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
    if (semantic[view.type]) {
      const local = collectLocalEvidence(input);
      const measurements = local.facts
        .filter(f => f.family === "flow" && f.kind === "measurement" && f.priority >= 94)
        .slice(0, view.type === "Aggregate" ? 2 : 1);
      const version = info.resultVersion!;
      result.facts.push({
        id: `flow.upstream.${op.operatorID}.${version.id}`,
        family: "flow",
        kind: measurements.length ? "measurement" : view.type === "Process" ? "warning" : "guarantee",
        text: `Flow upstream ${op.operatorID}: ${semantic[view.type]}.${measurements.length ? " " + measurements.map(f => f.text.replace(/^Flow measurement: /, "")).join(" ") : ""}`,
        priority: 98 - depth / 10,
        upstream: { operatorId: op.operatorID, resultVersion: version.id },
      });
      summaries++;
    }
    if (view.type === "Process") continue;
    if (depth < 8) queue.push(...boundInputs(input).map(next => ({ input: next, depth: depth + 1 })));
    else if (view.inputs.length) result.omissions.push("upstream_depth_bound");
  }
  if (queue.length) result.omissions.push("upstream_summary_bound");
  return result;
}

/**
 * The cells a scan read as missing because they spell one of pandas' default
 * missing-value tokens: totals per token, most common first, then the columns
 * with the most such cells. Undefined when there were none.
 */
export function scanMissingTokens(value: unknown): string | undefined {
  const perColumn = Object.entries(record(value))
    .map(([column, tokens]) => {
      const counts = Object.entries(record(tokens)).filter((entry): entry is [string, number] => count(entry[1]));
      return { column, counts, total: counts.reduce((sum, [, n]) => sum + n, 0) };
    })
    .filter(c => c.total > 0);
  if (!perColumn.length) return undefined;
  const byToken = new Map<string, number>();
  for (const c of perColumn) for (const [token, n] of c.counts) byToken.set(token, (byToken.get(token) ?? 0) + n);
  const total = perColumn.reduce((sum, c) => sum + c.total, 0);
  const tokens = [...byToken].sort((a, b) => b[1] - a[1]);
  const columns = [...perColumn].sort((a, b) => b.total - a.total);
  const tokenText = tokens.map(([token, n]) => `${json(token)} ${n}`).join(", ");
  const columnText = columns
    .slice(0, 8)
    .map(c => `${json(c.column)} ${c.total}`)
    .join(", ");
  return `${total} cell${total === 1 ? "" : "s"} (${tokenText}) in ${perColumn.length} column${perColumn.length === 1 ? "" : "s"} (${columnText}${columns.length > 8 ? `, and ${columns.length - 8} more` : ""})`;
}

function pairsOf(value: unknown): unknown[][] {
  return (Array.isArray(value) ? value : []).filter(Array.isArray) as unknown[][];
}

/** What a custom step did to the values of one column it kept, as the runtime
 * measured it with rows matched by their row labels (`_value_receipts` in
 * runtime.py): the engine cannot read the function, and an alias map that
 * sent "Rsa" to Russia or a dict that lacked "District Of Columbia" was
 * otherwise invisible. Undefined when nothing was measured. */
export function valueReceipt(name: string, receipt: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const rewritten = pairsOf(receipt.rewritten);
  if (rewritten.length) {
    const more = Number(receipt.rewrittenValues) - rewritten.length;
    parts.push(
      `rewrote ${receipt.rewrittenRows} rows: ${rewritten.map(([a, b, n]) => `${json(a)}→${json(b)} ${n}`).join(", ")}${more > 0 ? `, and ${more} more values` : ""}`
    );
  }
  const nulled = pairsOf(receipt.nulled);
  if (nulled.length) parts.push(`made ${receipt.nulledRows} rows null: ${nulled.map(([a, n]) => `${json(a)} ${n}`).join(", ")}`);
  const dropped = pairsOf(receipt.droppedByValue);
  if (dropped.length)
    parts.push(`dropped rows by value: ${dropped.map(([a, n]) => `${a === null ? "null" : json(a)} ${n}`).join(", ")}`);
  return parts.length ? `Process values of ${json(name)} (rows matched by label): ${parts.join("; ")}.` : undefined;
}

/** Values of one text column that differ only in case or spacing, with their
 * row counts ("Telecommunications" and "Telecommunications " were counted
 * apart). Undefined when there are none. */
export function spellingVariants(name: string, groups: unknown): string | undefined {
  const list = pairsOf(groups);
  if (!list.length) return undefined;
  return `${json(name)} has values that differ only in case or spacing: ${list
    .map(group => pairsOf(group).map(([value, n]) => `${json(value)} ${n}`).join(" ~ "))
    .join("; ")}.`;
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
  const rawPreview = view.type === "Scan" && typeof p.preview === "number" && p.preview > 0;
  if (!profile) omissions.push("profile_unavailable");

  if (profile) {
    for (const [name, c] of Object.entries(profile.columns).sort(([a], [b]) => lexical(a, b))) {
      if (rawPreview) continue;
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
      if (c.frequencies) {
        const f = c.frequencies;
        add(
          `data.column.${name}.values`,
          "data",
          "measurement",
          `${json(name)} (${scope}): ${f.truncated ? "top values (not exhaustive)" : "nonnull values"}=${f.values.map(v => `${scalarText(v.value)}:${v.count}`).join(", ")}; other=${f.otherCount}.`,
          priority - 20
        );
      }
    }
    const s = profile.structure;
    const scope = profile.coverage.complete
      ? "full table"
      : `partial prefix=${profile.coverage.rowsProcessed}/${info.totalRowCount ?? "?"} rows`;
    if (
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

  /** The author's `doc` of a custom operator (filter, map, process) leads its guarantee. */
  const docOf = (props: Record<string, unknown>): string =>
    typeof props.doc === "string" && props.doc ? `${props.doc}; ` : "";
  const contract: Record<string, string> = {
    Scan: "source creation; preview is not the full parsed source",
    Project: `row identities preserved, same order; selection/rename=${json(p)}`,
    Cast: `row identities preserved, same order; declared casts=${json(p.columns ?? [])}; errors=${p.errors ?? "raise"}`,
    Map: `${docOf(p)}row identities preserved, same order; added=${json(names(record(info.tableProfile?.native?.operations).addedColumns))}; dropped=${json(names(record(info.tableProfile?.native?.operations).droppedColumns))}; dependencies measured from the columns the function read`,
    Filter: `${docOf(p)}stable subset of input rows; predicate columns=${json(names(record(info.tableProfile?.native?.operations).predicateColumns))}`,
    Aggregate: `one output row per group; group keys=${json(p.groupBy ?? [])}; ${p.dropna === false ? "null keys form a group" : "rows with a null key are dropped (pandas groupby)"}`,
    Join: `declared ${p.type ?? "inner"} join; nullsEqual=${p.nullsEqual ?? false}; validate=${p.validate ?? "many_to_many"}; row order unspecified`,
    Union: "concatenation preserves all rows and input-port order; no deduplication",
    Distinct: `stable retained subset; keys=${p.columns === undefined ? "whole row" : json(p.columns)}; keep=${p.keep ?? "first"}`,
    Limit: `stable positional slice; offset=${p.offset ?? 0}, n=${p.n}; not a top-k claim without Sort`,
    Sort: `row identities preserved; stable sort by=${json(p.by ?? [])}; nulls=${p.nulls ?? "last"}`,
    Window: `row identities preserved, input order restored; partition keys=${json(p.partitionBy ?? [])}; stable order=${json(p.orderBy ?? [])}, nulls last; outputs=${json(p.columns ?? [])}`,
    Unpivot: `one output per input row then selected column, including null cells; value dependencies=${json(p.columns ?? [])}`,
    Pivot: `unique index/pivot-key pairs, no implicit aggregation; first-seen row/key order; dynamic column values depend on=${json(p.values)}`,
    Process: `${docOf(p)}row/column mapping unknown; equal row counts do not prove preservation`,
  };
  if (contract[view.type]) add("flow.contract", "flow", "guarantee", `${view.type}: ${contract[view.type]}.`, 25);

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
        if (before && after)
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
    // Rows whose key is null belong to no group (pandas groupby dropna=True).
    const dropped = count(operations.nullKeyRows) ? operations.nullKeyRows : 0;
    const grouped = ns[0] - dropped;
    const emptyGroups = out === 0 && grouped === 0 && size.min === null && size.max === null;
    if (
      operations.groupCount === out &&
      grouped >= 0 &&
      size.total === grouped &&
      (emptyGroups ||
        (count(size.min) &&
          count(size.max) &&
          size.min <= size.max &&
          size.max <= grouped &&
          out > 0 &&
          size.min * out <= grouped &&
          size.max * out >= grouped))
    ) {
      add(
        "flow.aggregate",
        "flow",
        "measurement",
        `Aggregate groups=${out} from ${ns[0]} rows; group size min=${size.min ?? "undefined"}, max=${size.max ?? "undefined"}.`,
        96
      );
      if (dropped)
        add(
          "flow.aggregate.nullKeys",
          "flow",
          "measurement",
          `Aggregate dropped ${fraction(dropped, ns[0])} rows whose group key is null (nulls per key column=${json(operations.nullKeyColumns ?? {})}), as pandas groupby does; dropna=False keeps them as a group.`,
          96
        );
      for (const agg of Array.isArray(p.aggregations) ? p.aggregations : []) {
        const a = record(agg),
          denom = record(record(operations.aggregateNonNull)[a.as]);
        if (
          typeof a.as === "string" &&
          count(denom.total) &&
          denom.total <= grouped &&
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
      for (const [i, source] of (Array.isArray(scan.sources) ? scan.sources : []).entries()) {
        const s = record(source);
        if (typeof s.path !== "string") continue;
        add(
          `flow.scan.source.${i}`,
          "flow",
          "measurement",
          `source=${json(s.path)}, format=${json(s.format)}, sizeBytes=${s.sizeBytes ?? "unknown"}, mtimeNs=${json(s.mtimeNs ?? "unknown")}; parse/coverage=${json(Object.fromEntries(Object.entries(s).filter(([k]) => !["path", "format", "sizeBytes", "mtimeNs", "missingTokens", "renamedHeaders"].includes(k))))}.`,
          30
        );
        const file = s.path.split("/").pop();
        const missing = scanMissingTokens(s.missingTokens);
        if (missing)
          add(
            `flow.scan.missing.${i}`,
            "flow",
            "measurement",
            `Scan of ${json(file)} read ${missing} as missing, as pandas.read_csv does; all_text=True keeps them as text.`,
            93
          );
        const renamed = (Array.isArray(s.renamedHeaders) ? s.renamedHeaders : []).map(record);
        if (renamed.length)
          add(
            `flow.scan.renamed.${i}`,
            "flow",
            "measurement",
            `Scan of ${json(file)} renamed repeated header names as pandas does: ${renamed
              .slice(0, 12)
              .map(r => `column ${r.column} ${json(r.header)} is ${json(r.name)}`)
              .join(", ")}${renamed.length > 12 ? `, and ${renamed.length - 12} more` : ""}.`,
            93
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
    for (const [name, receipt] of Object.entries(record(operations.valueReceipts)).slice(0, 6)) {
      if (context.columns?.length && !context.columns.includes(name)) continue;
      const line = valueReceipt(name, record(receipt));
      if (line) add(`flow.process.values.${name}`, "flow", "measurement", line, 95);
    }
  } else if (view.type === "Compare") {
    const c = record(operations.compare);
    if (count(c.rowsA) && count(c.rowsB) && count(c.inBoth) && count(c.onlyA) && count(c.onlyB))
      add(
        "flow.compare",
        "flow",
        "measurement",
        `Compare on keys=${json(c.keys)}: rows A=${c.rowsA}, B=${c.rowsB}; in both=${c.inBoth}, only A=${c.onlyA}, only B=${c.onlyB}; changed values per column=${json(c.changed ?? {})}.`,
        94
      );
    else omissions.push("compare_counters_unavailable");
  }
  for (const [name, groups] of Object.entries(record(operations.spellingVariants)).slice(0, 6)) {
    if (context.columns?.length && !context.columns.includes(name)) continue;
    const line = spellingVariants(name, groups);
    if (line) add(`data.spelling.${name}`, "data", "measurement", line, 93);
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
  let maxChars = Number.isFinite(context.maxChars) ? Math.max(0, Math.floor(context.maxChars)) : 2000;
  const result: NativeObservation = {
    version: 1,
    resultVersion: info.resultVersion?.id ?? null,
    inputs: structuredClone(info.resultVersion?.inputs ?? []),
    options: {
      data,
      flow,
      maxChars,
      completeSmallTableChars: context.completeSmallTableChars,
      maxRows: context.maxRows,
      detail: context.detail,
      columns: context.columns ? [...context.columns] : undefined,
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
  const appendData = pushTo(dataLines, () => evidenceBudget);
  const appendFlow = pushTo(flowLines, () => evidenceBudget);
  const rows = info.result ?? [];
  const rawPreview = op.nativeOp?.type === "Scan" && Number(op.nativeOp.properties.preview ?? 0) > 0;
  const fullSchema =
    info.resultSchema ?? Object.keys(rows[0] ?? {}).map(name => ({ name, type: "unknown", encoding: "unknown" }));
  // An explicit projection (`observe: ["t[a,b]"]`) shows those columns of the
  // rows; names the table does not have are ignored, and no match shows all.
  const projected = context.columns?.length ? fullSchema.filter(c => context.columns!.includes(c.name)) : [];
  const schema = projected.length ? projected : fullSchema;
  const total = count(info.totalRowCount) ? info.totalRowCount : undefined;
  const summary = `Output Table: ${total ?? "?"} rows, ${fullSchema.length} cols`;
  if (!append(summary, "table.shape")) {
    result.text = maxChars >= 9 ? "[omitted]" : "…".slice(0, maxChars);
    result.omitted.push({ id: "table", reason: "budget" });
    return result;
  }
  const rowLimit = context.maxRows && context.maxRows > 0 ? Math.floor(context.maxRows) : rows.length;
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
    rows.every(row =>
      schema.every(
        c => own(row, c.name) && !(typeof row[c.name] === "string" && row[c.name].includes("...[truncated]..."))
      )
    );
  const table = [
    schemaLine(schema),
    projected.length ? `Complete table (all rows; ${projected.length} of ${fullSchema.length} columns):` : "Complete table (all rows):",
    ...rows.map(row => rowLine(row, schema)),
  ].join("\n");
  const needed = used(lines) + table.length;
  if (complete && rows.length <= 20 && needed > maxChars && needed <= (context.completeSmallTableChars ?? 0)) {
    maxChars = needed;
    result.options.maxChars = maxChars;
  }
  const completeVisible = complete && append(table, "table.complete");
  const evidence = collectNativeEvidence(context);
  result.omitted.push(...evidence.omissions.map(id => ({ id, reason: "unavailable" as const })));
  // Rows that overflow the sample reserve fill the rest of the table's budget,
  // exactly as without evidence; evidence facts never compete with them.
  const rowCandidates: NativeEvidenceFact[] = [];
  const dataCandidates: NativeEvidenceFact[] = [];
  const flowCandidates: NativeEvidenceFact[] = [];
  if (!completeVisible) {
    const relevant = relevance(context);
    const allowed = schema.filter(c => !context.columns?.length || context.columns.includes(c.name));
    const ranked = [...allowed].sort(
      (a, b) => Number(relevant.has(b.name)) - Number(relevant.has(a.name)) || lexical(a.name, b.name)
    );
    const selected: typeof schema = [];
    const schemaBudget = Math.max(0, Math.floor(maxChars * 0.3));
    for (const c of ranked)
      if (schemaLine([...selected, c]).length + (selected.length + 1 === schema.length ? 0 : 24) <= schemaBudget)
        selected.push(c);
    // Keep the declared schema order within the selected column subset.
    const fields = schema.filter(c => selected.includes(c));
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
        const fact: NativeEvidenceFact = {
          id: `sample.${i}`,
          family: "data",
          kind: "measurement",
          text: `Sample stored row ${i + 1}: ${rowLine(sampleRow, fields)}`,
          priority: rank === 0 ? 105 : 35 - rank,
        };
        if (sampleChars + fact.text.length + 1 <= sampleBudget && append(fact.text, fact.id)) {
          sampleChars += fact.text.length + 1;
        } else rowCandidates.push(fact);
      }
    }
    result.omitted.push({ id: "table.complete", reason: complete ? "budget" : "unavailable" });
    if (rawPreview) {
      const gap = previewGap(rows, total);
      if (gap) append(gap, "preview.gap");
    }
  }
  // Each evidence family gets the room the table's first allocation left
  // (minus the incompleteness notice); the same size for data and flow.
  const NOTICE = "View incomplete; unshown rows/columns or evidence omitted.";
  evidenceBudget = Math.max(0, maxChars - used(lines) - (completeVisible ? 0 : NOTICE.length + 1));
  for (const fact of evidence.facts) {
    if (!(fact.family === "data" ? data : flow)) result.omitted.push({ id: fact.id, reason: "disabled" });
    else if (completeVisible && fact.family === "data")
      result.omitted.push({ id: fact.id, reason: "redundant_complete_table" });
    else (fact.family === "flow" ? flowCandidates : dataCandidates).push(fact);
  }
  const byPriority = (a: NativeEvidenceFact, b: NativeEvidenceFact) => b.priority - a.priority || lexical(a.id, b.id);
  // Full output/input bindings remain in the immutable audit metadata.
  for (const [facts, add] of [
    [rowCandidates, append],
    [dataCandidates, appendData],
    [flowCandidates, appendFlow],
  ] as const)
    for (const fact of facts.sort(byPriority))
      if (!add(fact.text, fact.id)) result.omitted.push({ id: fact.id, reason: "budget" });
  const notice = !completeVisible && append(NOTICE, "view.omissions");
  // Text order = chunk order: the table, the data lines, the flow lines, then the notice.
  const tableLines = notice ? lines.slice(0, -1) : lines;
  result.text = [...tableLines, ...dataLines, ...flowLines, ...(notice ? lines.slice(-1) : [])].join("\n");
  return compactNativeObservation(result, evidence.facts);
}

/** The raw lines of a preview that the stored sample does not hold, as one
 * line for the observation: the engine keeps a sample's head and tail within
 * its size budget, so the middle of a preview of long lines is missing and
 * must not read as a gap in the file. */
export function previewGap(rows: ReadonlyArray<Record<string, unknown>>, total: number | undefined): string | undefined {
  const numbers = rows.map(row => Number(row.line_no)).filter(n => Number.isInteger(n)).sort((a, b) => a - b);
  if (!numbers.length) return undefined;
  const missing: string[] = [];
  let count = 0;
  for (let i = 1; i < numbers.length; i++)
    if (numbers[i] - numbers[i - 1] > 1) {
      const from = numbers[i - 1] + 1;
      const to = numbers[i] - 1;
      missing.push(from === to ? `${from}` : `${from}–${to}`);
      count += to - from + 1;
    }
  const held = numbers.length + count;
  if (total !== undefined && total > held) {
    missing.push(`${numbers.at(-1)! + 1}…`);
    count += total - held;
  }
  if (!count) return undefined;
  return `Preview lines not shown here: ${missing.join(", ")} (${count} line${count === 1 ? "" : "s"}; the result's size budget, not the file). They are ordinary lines of the file; read them with a smaller preview or skip_lines.`;
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
    if (chunk.id.startsWith("sample.") && (limits.detail === "shape" || sampleRows++ >= rowLimit)) continue;
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
