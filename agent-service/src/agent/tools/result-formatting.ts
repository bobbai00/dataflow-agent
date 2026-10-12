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

import type { OperatorInfo } from "../../types/execution";
import { parseNativeDiagnostic, nativeDiagnosticIssue, resolveNativeDiagnostic } from "../native/diagnostics";
import { nativeOperatorName } from "../native/catalog";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import {
  restrictNativeObservation,
  selectNativeObservation,
  type NativeEvidenceContext,
  type NativeObservation,
  type NativeObservationOptions,
} from "../native/evidence";
import type { WorkflowState } from "../workflow-state";
import { shareNativeObservation } from "../native/evidence-compaction";
import { getVisibleResultHeaders } from "./tools-utility";
// DECORATE data-facet render rungs (extracted into context/decorate/data/*).
// result-formatting orchestrates them in the established composition order and
// owns only the SUBSTRATE (sampling + TSV table render + shape metadata).
import { formatSchemaLine } from "../context/decorate/data/schema";
import { formatSampleDuplicates, formatSampleFds } from "../context/summarize/sample-profile";

// Back-compat re-exports: these render helpers were defined here before the
// DECORATE extraction; existing importers (e.g. loader-levers.test.ts) still
// reference them from this module.
export { formatSchemaLine };

export interface FormatOperatorResultOptions {
  /** V2 evidence shares the result body budget. A recorded DELTA frame wins
   * over today's exposure settings; only explicit compaction may shorten it. */
  nativeEvidence?: Pick<NativeEvidenceContext, "workflow" | "resolveInput"> &
    NativeObservationOptions & { frozen?: NativeObservation; compact?: boolean; sharedUpstream?: Map<string, string> };
  /** The operator definition that earned this result. Historical observations
   *  must echo failed parameters/code from their snapshot, not a later edit
   *  (or deletion) in the live DAG. Undefined keeps the current-state lookup. */
  operatorAtEvent?: OperatorPredicate;
  /** When true, prepend a compact `Schema:` line listing every output column
   *  as `name (type)`, derived from `opInfo.columnStats` (the `(type)` tag) or
   *  the result-row headers (names only). A cheaper, complete substitute for
   *  the fuller `Column Schema and stats:` block. Defaults to false. */
  schemaInResult?: boolean;
  /** W1: cap the TSV sample to first ceil(N/2) + last floor(N/2) rows (a true
   *  row count, vs the char-budget proxy). 0/undefined = no cap. */
  maxResultRows?: number;
  /** Resolve an input's COLUMN count from its upstream operator's output. The
   *  engine's input port metrics carry only the row count (tuple count), so the
   *  caller (which has the snapshot) supplies this to fill in `M cols` on the
   *  `Inputs:` shape line. Returns undefined when unknown. */
  resolveInputColumns?: (upstreamOpId: string) => number | undefined;
  /** Whether to render the `Inputs:` shape line inside the Result block.
   *  LATEST sets this false — it renders a single consolidated `Inputs:` line
   *  (with counts) at the operator-block level, so repeating it here is
   *  duplication. DELTA leaves it true (it has no operator-block level).
   *  Undefined ⇒ true. */
  inputsInResult?: boolean;
  /** summarize() detail level for the result body:
   *   - "sample" (default / legacy): the TSV row sample renders.
   *   - "shape": counts + column annotations only — no TSV rows. On an error
   *     result, only the first error line renders (no traceback/code echo).
   *  ("omit" is handled by the operator serializer — no Result block at all.) */
  detail?: "shape" | "sample";
  /** Per-operator char budget for the rendered TSV body (summarize
   *  `tuple.maxChars`); 0/undefined ⇒ uncapped. Distinct from the agent-level
   *  `maxOperatorResultCharLimit`, which is one engine-side number for the whole
   *  execution and cannot vary per operator. */
  maxResultChars?: number;
  /** Include `(type)` tags on the Schema line (default true). */
  schemaTypes?: boolean;
  /** Sample-based duplicate rows / identical-column detection line. */
  sampleDuplicates?: boolean;
  /** Sample-based candidate functional-dependency line. */
  sampleFdHints?: boolean;
  /** Sample-based `Type anomaly:` line — text columns that are mostly numeric. */
  /** Native `scoped` selection: restrict the TSV sample and the `Column Schema
   *  and stats:` block to these columns (the ones the operator's parameters
   *  name). The `Output Table` line and the `Schema:` line stay complete. An
   *  empty list drops the stats block and leaves the sample unprojected. */
  columns?: readonly string[];
}

/** Wide DataFrames blow up Latest-mode context because the whole result is
 *  re-echoed every turn. Cap both the TSV preview and the stats block at
 *  this many columns: keep the first half and the last half, drop the
 *  middle, and surface a "(showing N of M columns)" notice so the agent
 *  knows the view is truncated. Defaults chosen to keep an 8-turn run on
 *  a 300-column table well under 100k input tokens. */
const MAX_DISPLAYED_COLUMNS = 50;
const CELL_TRUNCATION_MARKER = "...[truncated]...";

function containsCellTruncation(value: unknown): boolean {
  if (typeof value === "string") return value.includes(CELL_TRUNCATION_MARKER);
  if (Array.isArray(value)) return value.some(containsCellTruncation);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsCellTruncation);
  }
  return false;
}

/**
 * NATIVE operators: the engine's error text points into the GENERATED Python
 * (`(line 21) \`d = _con.sql(q).df()\` - BinderException: …`), which the agent
 * never wrote. Rewrite it in the agent's own terms: the typed operator, the
 * engine message without the line pointer and exception class, and for a
 * downstream operator that never ran, the upstream operator that failed.
 *
 *   `(line N) \`…\` - BinderException: Binder Error: X`      → `Filter \`id\` failed: Binder Error: X`
 *   `execution failed — … Execution error: up: (line N) … X` → `not executed — upstream \`up\` failed: X`
 *   `execution failed — … Error: The operation timed out.`   → `not executed — the execution timed out`
 */
/** Engine type spellings → the vocabulary every Schema line already uses, so
 *  the model reads one type system instead of three (ours, DuckDB's, pandas').
 *  Measured: SQL type words reached the prompt in 54 of 104 tasks. */
const ENGINE_TYPE_WORDS: Array<[RegExp, string]> = [
  [/\b(?:VARCHAR|CHAR|TEXT|STRING)\b/g, "str"],
  [
    /\b(?:BIGINT|HUGEINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|DOUBLE|FLOAT|REAL|DECIMAL(?:\(\d+,\s*\d+\))?)\b/g,
    "numeric",
  ],
  // DuckDB names an untyped constant `INTEGER_LITERAL` / `VARCHAR_LITERAL`
  [/\b(?:INTEGER|DECIMAL|DOUBLE)_LITERAL\b/g, "numeric literal"],
  [/\bVARCHAR_LITERAL\b/g, "str literal"],
  [/\b(?:int64|float64|int32|float32)\b/g, "numeric"],
  [/\b(?:TIMESTAMP(?:_[A-Z]+)?|DATETIME|DATE|TIME)\b/g, "datetime"],
  [/\bdatetime64\[[^\]]*\]/g, "datetime"],
  [/\bBOOLEAN\b/g, "bool"],
  [/\b(?:BLOB|BYTEA)\b/g, "binary"],
];

/** Rewrite one engine message into our terms: our type names, and none of the
 *  engine's own vocabulary for where it went wrong. */
export function normalizeEngineTypes(msg: string): string {
  let out = msg;
  for (const [rx, name] of ENGINE_TYPE_WORDS) out = out.replace(rx, name);
  return out
    .replace(/\b(?:Binder|Conversion|Parser|Catalog|Invalid Input) Error: /g, "")
    .replace(/ in FROM clause/g, "")
    .replace(/\bReferenced (table|column) /g, "column ")
    .trim();
}

/** Whether `operatorId` reads, directly or through other operators, from
 * `rootId`. Walks the native inputs of the workflow as it was at the event
 * (historical renders must not consult a later edit), else the live state. */
export function readsFrom(
  operatorId: string,
  rootId: string,
  workflow: WorkflowContent | undefined,
  workflowState: WorkflowState
): boolean {
  const inputsOf = (id: string): string[] => {
    const op = workflow?.operators.find(o => o.operatorID === id) ?? workflowState.getOperator(id);
    if (op?.nativeOp) return op.nativeOp.inputs;
    const links = workflow?.links ?? workflowState.getAllLinks();
    return links.filter(l => l.target.operatorID === id).map(l => l.source.operatorID);
  };
  const seen = new Set<string>();
  const stack = [operatorId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const input of inputsOf(id)) {
      if (input === rootId) return true;
      if (!seen.has(input)) {
        seen.add(input);
        stack.push(input);
      }
    }
  }
  return false;
}

export function formatOperatorResult(
  operatorId: string,
  opInfo: OperatorInfo,
  workflowState: WorkflowState,
  options: FormatOperatorResultOptions = {}
): string {
  const eventOp = options.operatorAtEvent ?? workflowState.getOperator(operatorId);
  if (opInfo.error && eventOp?.nativeOp) {
    const diagnostic =
      opInfo.nativeError?.diagnostic ??
      resolveNativeDiagnostic(
        eventOp,
        opInfo.error,
        id =>
          options.nativeEvidence?.workflow.operators.find(op => op.operatorID === id) ?? workflowState.getOperator(id)
      );
    const rootInfo = options.nativeEvidence?.resolveInput(diagnostic.operatorId);
    const rootDiagnostic =
      rootInfo?.nativeError?.diagnostic ?? (rootInfo?.error ? parseNativeDiagnostic(rootInfo.error) : undefined);
    const name = `${eventOp.nativeOp.registeredName ?? nativeOperatorName(eventOp.nativeOp.type)} \`${operatorId}\``;
    if (diagnostic.operatorId !== operatorId) {
      // The engine aborts the whole run at the first failure and hands every
      // unfinished operator the same payload. Say which case this is: a
      // consumer of the failed operator, or a bystander whose own definition is
      // not implicated and which merely needs that operator repaired or removed.
      const reads = readsFrom(operatorId, diagnostic.operatorId, options.nativeEvidence?.workflow, workflowState);
      const rootConfirmed =
        rootInfo?.error &&
        rootDiagnostic?.operatorId === diagnostic.operatorId &&
        rootDiagnostic.operatorRevision === diagnostic.operatorRevision &&
        rootDiagnostic.code === diagnostic.code;
      if (!reads) {
        return `- not run: ${name}; the run stopped when \`${diagnostic.operatorId}\` failed (${diagnostic.code}). \`${operatorId}\` does not read from \`${diagnostic.operatorId}\`, so its own definition is not implicated; it runs once that operator is repaired or deleted.`;
      }
      if (rootConfirmed) {
        return `- not run: ${name}; upstream \`${diagnostic.operatorId}\` failed (${diagnostic.code}). Repair that operator; this consumer did not run.`;
      }
    }
    // A function that names a table instead of taking it as an input.
    const undefinedName =
      diagnostic.code === "CALLBACK_RUNTIME"
        ? /NameError: name '([A-Za-z_]\w*)' is not defined/.exec(diagnostic.message)?.[1]
        : undefined;
    const namesTable =
      !!undefinedName &&
      (options.nativeEvidence?.workflow.operators.some(op => op.operatorID === undefinedName) ||
        !!workflowState.getOperator(undefinedName));
    const issue = namesTable
      ? {
          ...diagnostic,
          hint: `\`${undefinedName}\` is a table in the Dataflow, not a Python name: pass it as an input of this operator and read it as a parameter.`,
        }
      : diagnostic;
    return (
      (diagnostic.operatorId !== operatorId
        ? `- not run: ${name}; upstream \`${diagnostic.operatorId}\` failed (${diagnostic.code}).\n`
        : "") +
      nativeDiagnosticIssue(issue) +
      (opInfo.nativeError?.phase === "attempt" ? "\n- note: rejected edit; dataflow definition unchanged." : "")
    );
  }
  if (opInfo.error && options.detail === "shape") {
    // Shape-level error render: the first line carries the exception; the
    // traceback + code echo are the "sample-level" detail.
    return `[ERROR] ${opInfo.error.split("\n")[0]}`;
  }
  if (opInfo.error) {
    // Old-style error rendering: the ENGINE error message carries only the
    // exception + user-code line pointer (the worker no longer echoes source);
    // the operator's code is appended HERE, from the DAG's own
    // operatorProperties — so the agent still sees exactly what code failed,
    // without the engine duplicating it into every error payload.
    const op = options.operatorAtEvent ?? workflowState.getOperator(operatorId);
    const code = String((op?.operatorProperties as Record<string, unknown> | undefined)?.code ?? "").trim();
    const codeBlock = code ? `\nOperator code:\n${code}` : "";
    return `[ERROR] ${opInfo.error}${codeBlock}`;
  }

  if (!opInfo.result || !Array.isArray(opInfo.result)) {
    return "(no result data)";
  }

  const nativeOp = options.operatorAtEvent ?? workflowState.getOperator(operatorId);
  if (nativeOp?.nativeOp) {
    const evidence = options.nativeEvidence;
    if (evidence?.frozen) {
      const text = restrictNativeObservation(
        evidence.frozen,
        evidence.compact
          ? { maxChars: options.maxResultChars, maxRows: options.maxResultRows, detail: options.detail }
          : {}
      );
      return shareNativeObservation(text, evidence.frozen, operatorId, evidence.sharedUpstream);
    }
    const budget = evidence?.maxChars ?? 2000;
    const observation = selectNativeObservation({
      ...evidence,
      workflow: evidence?.workflow ?? workflowState.getWorkflowContent(),
      resolveInput: evidence?.resolveInput ?? (() => undefined),
      op: nativeOp,
      info: opInfo,
      data: evidence?.data ?? false,
      flow: evidence?.flow ?? false,
      maxChars:
        options.maxResultChars && options.maxResultChars > 0 ? Math.min(budget, options.maxResultChars) : budget,
      maxRows: options.maxResultRows,
      columns: options.columns,
      detail: options.detail,
    });
    return shareNativeObservation(observation.text, observation, operatorId, evidence?.sharedUpstream);
  }

  const jsonArray = opInfo.result as Record<string, any>[];
  const headers = jsonArray.length > 0 ? getVisibleResultHeaders(jsonArray[0]) : [];
  const columns = headers.length;
  const columnsTruncated = columns > MAX_DISPLAYED_COLUMNS;

  const isViz = jsonArray.length > 0 && jsonArray[0]["__is_visualization__"] === true;
  const serializableArray = isViz
    ? jsonArray.map(row => {
        const cleaned: Record<string, any> = {};
        for (const key of Object.keys(row)) {
          if (key === "__is_visualization__") continue;
          if (key === "html-content" || key === "json-content") {
            cleaned[key] = "<skipped: visualization content>";
          } else {
            cleaned[key] = row[key];
          }
        }
        return cleaned;
      })
    : jsonArray;

  // W1 (row-based sampling): a TRUE row cap — keep first ceil(N/2) + last
  // floor(N/2) rows (the original row objects keep `__row_index__`, so
  // jsonToTableFormat renders the `...` gap). Cleaner than the char-budget
  // proxy. 0/undefined = no cap (current behavior). Cell-level trim is
  // unaffected (it happens downstream in the TSV renderer / backend).
  let sampleRows = serializableArray;
  // Column scope: only the named columns (plus the row index) reach the TSV.
  if (options.columns && options.columns.length > 0) {
    const keep = new Set(options.columns);
    sampleRows = sampleRows.map(row => {
      const projected: Record<string, any> = {};
      for (const k of Object.keys(row)) if (k === "__row_index__" || keep.has(k)) projected[k] = row[k];
      return projected;
    });
  }
  const cap = options.maxResultRows ?? 0;
  if (cap > 0 && sampleRows.length > cap) {
    const head = Math.ceil(cap / 2);
    const tail = Math.floor(cap / 2);
    sampleRows =
      tail > 0
        ? [...sampleRows.slice(0, head), ...sampleRows.slice(sampleRows.length - tail)]
        : sampleRows.slice(0, head);
  }
  // detail:"shape" (summarize) drops the TSV body — counts + annotations only.
  const rawDataString = options.detail === "shape" ? "" : jsonToTableFormat(sampleRows);
  // Per-operator render budget (summarize `tuple.maxChars`). Keeps the header
  // plus as many head/tail rows as fit, mirroring the fetch-time safety net in
  // workflow-execution-tools so both truncations produce the same shape.
  const dataString = clampTableChars(rawDataString, options.maxResultChars ?? 0);
  const dataStringTruncatedByBudget = dataString.length < rawDataString.length;

  // A complete table with fewer than five rows is already its own exact
  // summary. Repeating mean/min/max/top-k stats adds tokens without revealing
  // anything beyond the visible rows. Keep stats whenever completeness is not
  // provable: backend truncation, renderer row sampling, wide-column sampling,
  // or shape-only rendering all hide data the stats may still summarize.
  const totalRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const allRowsHeld = totalRows >= 0 && serializableArray.length === totalRows;
  const rendererTruncatedRows = sampleRows.length < serializableArray.length;
  const cellsTruncated = serializableArray.some(containsCellTruncation);
  // The five structural conditions below already PROVE every value is on screen
  // (nothing truncated at the backend, the renderer, the column axis, or the
  // cell level, and the service holds exactly totalRows rows). Under "anomaly"
  // density that proof is the whole test. The legacy `totalRows < 5` bound is
  // kept for "full" so the default render stays byte-identical — it was measured
  // to leave stats on 22.4% of blocks whose sample already showed every row
  // (e.g. a 7-row table rendering `null=0, distinct=7` beneath all 7 values).
  const provablyComplete =
    opInfo.resultMode === "table" &&
    !isViz &&
    options.detail !== "shape" &&
    allRowsHeld &&
    opInfo.truncated === false &&
    !rendererTruncatedRows &&
    !columnsTruncated &&
    !cellsTruncated &&
    // A per-operator char budget that clipped rows also breaks the proof: the
    // agent can no longer read every value off the sample, so the stats block
    // becomes load-bearing again.
    !dataStringTruncatedByBudget;
  // Suppress the stats block whenever completeness is PROVEN, at any table size.
  // The five conditions above establish that every cell of every row is on
  // screen, so `null=`/`distinct=`/`min=`/`max=` are arithmetic over visible
  // data — the block cannot carry a fact the sample does not already show. The
  // previous `totalRows < 5` bound made this depend on size rather than proof
  // and left the block on 22.4% of blocks whose sample was already complete
  // (e.g. a 7-row table printing `null=0, distinct=7` beneath all seven values).
  // This is the one lossless trim: A2 measured that trimming stats on
  // INCOMPLETE tables costs exploration steps, but here there is nothing to
  // explore.
  const completeSmallTableVisible = provablyComplete;

  const metadataLines = [
    formatInputOutputMetadata(
      workflowState,
      operatorId,
      opInfo,
      columns,
      options.inputsInResult !== false,
      options.resolveInputColumns
    ),
    columnsTruncated && options.detail !== "shape"
      ? `(showing first ${Math.ceil(MAX_DISPLAYED_COLUMNS / 2)} and last ${Math.floor(MAX_DISPLAYED_COLUMNS / 2)} of ${columns} columns)`
      : "",
    ...(opInfo.warnings ?? []),
  ].filter(Boolean);

  const schemaLine =
    options.schemaInResult === true ? formatSchemaLine(opInfo, options.schemaTypes !== false) : undefined;
  const dupLine = options.sampleDuplicates ? formatSampleDuplicates(serializableArray) : undefined;
  const fdLine = options.sampleFdHints ? formatSampleFds(serializableArray) : undefined;
  // Layout: shape metadata (Inputs / Output Table) → the result TABLE (TSV) →
  // then the data-derived annotations that DESCRIBE the table (schema / column
  // schema+stats / format & structure hints), so annotations read AFTER the data
  // they refer to. Flow rungs live in context-utils' "Operators needing
  // attention" section; result-formatting owns only the data facet + TSV.
  return [...metadataLines, dataString, schemaLine, dupLine, fdLine].filter(Boolean).join("\n");
}

/**
 * Estimated FULL serialized size of an operator's output table, in characters.
 *
 * The size-advertising fact for recall scaling: a later turn deciding how many
 * characters of an old result to pull needs to know how big that result is \u2014
 * `includeOutputTableSample: 2000` against a 4k table is the whole thing;
 * against a 400k table it is 0.5%. Only a row SAMPLE is materialized here, so
 * the estimate is mean sample-row TSV length x total row count (+ header).
 * Undefined when there are no rows to measure.
 */
export function estimateTableChars(opInfo: OperatorInfo): number | undefined {
  const rows = Array.isArray(opInfo.result) ? opInfo.result : undefined;
  if (!rows || rows.length === 0) return undefined;
  const cols = Object.keys(rows[0] ?? {}).filter(c => !c.startsWith("__"));
  if (cols.length === 0) return undefined;
  const line = (r: Record<string, unknown>): number =>
    cols.reduce((n, c) => n + String(r[c] ?? "").length, 0) + cols.length; // + tabs/newline
  const sampled = rows.slice(0, 50);
  const mean = sampled.reduce((n, r) => n + line(r as Record<string, unknown>), 0) / sampled.length;
  const total =
    typeof opInfo.totalRowCount === "number" && opInfo.totalRowCount > 0 ? opInfo.totalRowCount : rows.length;
  const header = cols.join("\t").length + 1;
  return Math.round(header + mean * total);
}

/** `~48k chars` / `321 chars` \u2014 the human-scale rendering of estimateTableChars. */
export function formatApproxChars(chars: number): string {
  return chars >= 10_000
    ? `~${Math.round(chars / 1000)}k chars`
    : chars >= 1000
      ? `~${(chars / 1000).toFixed(1)}k chars`
      : `~${chars} chars`;
}
function formatInputOutputMetadata(
  workflowState: WorkflowState,
  operatorId: string,
  opInfo: OperatorInfo,
  outputColumns: number,
  includeInputs: boolean,
  resolveInputColumns?: (upstreamOpId: string) => number | undefined
): string {
  const outputRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const outputLine = `Output Table: ${outputRows} rows, ${outputColumns} cols`;

  const inputShapes = opInfo.inputPortShapes;
  if (!includeInputs || !inputShapes || inputShapes.length === 0) {
    return outputLine;
  }

  const inputLinks = workflowState.getAllLinks().filter(l => l.target.operatorID === operatorId);
  const portIndexToUpstream = new Map<number, string>();
  const op = workflowState.getOperator(operatorId);
  for (const link of inputLinks) {
    const portIdx = op?.inputPorts.findIndex(p => p.portID === link.target.portID) ?? -1;
    if (portIdx >= 0) {
      portIndexToUpstream.set(portIdx, link.source.operatorID);
    }
  }

  const inputPart = inputShapes
    .sort((a, b) => a.portIndex - b.portIndex)
    .map(p => {
      const upstreamId = portIndexToUpstream.get(p.portIndex);
      const name = upstreamId ?? `input${p.portIndex}`;
      const rowsPart = typeof p.rows === "number" ? `${p.rows} rows` : undefined;
      // Input column count isn't in the engine's port metrics — resolve it from
      // the upstream operator's output column count.
      const cols =
        typeof p.columns === "number" ? p.columns : upstreamId ? resolveInputColumns?.(upstreamId) : undefined;
      const colsPart = typeof cols === "number" ? `${cols} cols` : undefined;
      const shape = [rowsPart, colsPart].filter(Boolean).join(", ");
      return shape ? `${name} (${shape})` : name;
    })
    .join(", ");

  // Descriptive, single line: names each input by its SOURCE OPERATOR id (an
  // operator's output IS this operator's input — see the chaining principle in
  // the system prompt), so the model can trace a column back to the operator
  // whose Result section defines it.
  return `Inputs: ${inputPart}\n${outputLine}`;
}

function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const hasRowIndex = "__row_index__" in jsonResult[0];
  const allHeaders = getVisibleResultHeaders(jsonResult[0]);
  if (allHeaders.length === 0) return "";

  // Wide tables: render only the first half + last half of columns, joined
  // by a `...` separator (mirrors pandas display). The headline metadata
  // line in formatOperatorResult already announces the truncation.
  const totalCols = allHeaders.length;
  const truncated = totalCols > MAX_DISPLAYED_COLUMNS;
  let leftHeaders: string[];
  let rightHeaders: string[];
  if (truncated) {
    const leftCount = Math.ceil(MAX_DISPLAYED_COLUMNS / 2);
    const rightCount = Math.floor(MAX_DISPLAYED_COLUMNS / 2);
    leftHeaders = allHeaders.slice(0, leftCount);
    rightHeaders = allHeaders.slice(-rightCount);
  } else {
    leftHeaders = allHeaders;
    rightHeaders = [];
  }

  const renderHeader = (hs: string[]) => hs.join("\t");
  const headerLine = truncated
    ? "\t" + renderHeader(leftHeaders) + "\t...\t" + renderHeader(rightHeaders)
    : "\t" + renderHeader(leftHeaders);

  const renderCell = (val: unknown): string => {
    if (val === null) return "NaN";
    if (val === undefined) return "";
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "string") {
      if (val === "NULL") return "NaN";
      return val.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    }
    return JSON.stringify(val);
  };

  const formattedRows: string[] = [];
  let prevIndex = -1;
  for (let i = 0; i < jsonResult.length; i++) {
    const row = jsonResult[i];
    const rowIndex = hasRowIndex ? (row["__row_index__"] as number) : i;

    if (prevIndex >= 0 && rowIndex > prevIndex + 1) {
      // Row gap separator. Columns are already capped; just emit one `...` per visible cell.
      const visibleCols = truncated ? leftHeaders.length + 1 + rightHeaders.length : leftHeaders.length;
      const dots = Array(visibleCols).fill("...").join("\t");
      formattedRows.push(`...\t${dots}`);
    }
    prevIndex = rowIndex;

    const leftCells = leftHeaders.map(h => renderCell(row[h]));
    const rightCells = rightHeaders.map(h => renderCell(row[h]));
    const cells = truncated ? [...leftCells, "...", ...rightCells] : leftCells;
    formattedRows.push(`${rowIndex}\t${cells.join("\t")}`);
  }

  return [headerLine, ...formattedRows].join("\n");
}

/**
 * Clamp a rendered `Code:` block to a char budget, keeping whole lines from the
 * HEAD and the TAIL and eliding the middle with a line-count marker.
 *
 * Head AND tail, not a prefix: the head carries the signature, imports and loads;
 * the tail carries the return value, which is what a downstream operator's schema
 * depends on. A prefix-only truncation would hide exactly the part that says what
 * this operator produces.
 *
 * Sized for the measured distribution — per-operator code blocks run p50 286 B,
 * p90 2,014 B, p99 6,081 B, max 16,400 B — so at a realistic budget most blocks
 * return unchanged and only the long tail is touched.
 */
export function clampCodeChars(code: string, budget: number): string {
  if (budget <= 0 || code.length <= budget) return code;
  const lines = code.split("\n");
  if (lines.length <= 2) return code.slice(0, budget);

  const front: string[] = [];
  const back: string[] = [];
  // Reserve room for the marker so the result actually lands under budget.
  const marker = (n: number) => `    # ... ${n} line${n === 1 ? "" : "s"} elided ...`;
  let used = marker(lines.length).length + 1;
  let i = 0;
  let j = lines.length - 1;
  // Alternate head/tail so both ends survive even at a tight budget; bias to the
  // head on ties since it establishes what the function is.
  while (i <= j) {
    const takeFront = front.length <= back.length;
    const idx = takeFront ? i : j;
    const len = (lines[idx] ?? "").length + 1;
    if (used + len > budget) break;
    used += len;
    if (takeFront) {
      front.push(lines[idx]!);
      i++;
    } else {
      back.unshift(lines[idx]!);
      j--;
    }
  }
  const elided = j - i + 1;
  if (elided <= 0) return code;
  if (front.length === 0 && back.length === 0) return code.slice(0, budget);
  return [...front, marker(elided), ...back].join("\n");
}

/**
 * Clamp a rendered TSV table to a char budget, keeping the header plus as many
 * head + tail data rows as fit. Mirrors the fetch-time safety net in
 * workflow-execution-tools so a per-operator budget and the engine-side budget
 * produce the same shape. Returns the input unchanged when it already fits, when
 * the budget is 0/absent, or when the table has no data rows to drop.
 */
export function clampTableChars(table: string, budget: number): string {
  if (budget <= 0 || table.length <= budget) return table;
  const lines = table.split("\n");
  const header = lines[0] ?? "";
  const rows = lines.slice(1);
  if (rows.length === 0) return table;
  const half = Math.floor((budget - (header.length + 1)) / 2);
  if (half <= 0) return header;

  const front: string[] = [];
  let frontSize = 0;
  for (const r of rows) {
    const len = r.length + 1;
    if (frontSize + len > half && front.length > 0) break;
    front.push(r);
    frontSize += len;
  }
  const back: string[] = [];
  let backSize = 0;
  for (let i = rows.length - 1; i >= front.length; i--) {
    const len = rows[i]!.length + 1;
    if (backSize + len > half && back.length > 0) break;
    back.unshift(rows[i]!);
    backSize += len;
  }
  return [header, ...front, ...back].join("\n");
}
