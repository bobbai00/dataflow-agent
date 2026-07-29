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
import type { WorkflowState } from "../workflow-state";
import { getVisibleResultHeaders } from "./tools-utility";
// DECORATE data-facet render rungs (extracted into context/decorate/data/*).
// result-formatting orchestrates them in the established composition order and
// owns only the SUBSTRATE (sampling + TSV table render + shape metadata).
import { RESERVED_STATS_KEYS, COERCION_TELEMETRY_KEY } from "../context/decorate/data/reserved-keys";
import { formatSchemaLine } from "../context/decorate/data/schema";
import { formatColumnStats } from "../context/decorate/data/column-stats";
import { formatTableHints } from "../context/decorate/data/structural-profile";
import { formatValueFormatHints } from "../context/decorate/data/value-format";
import { formatReservedDiag } from "../context/decorate/data/diagnostics";
import { formatSampleDuplicates, formatSampleFds } from "../context/summarize/sample-profile";

// Back-compat re-exports: these render helpers were defined here before the
// DECORATE extraction; existing importers (e.g. loader-levers.test.ts) still
// reference them from this module.
export { formatSchemaLine, formatColumnStats, formatValueFormatHints, formatTableHints, formatReservedDiag };

export interface FormatOperatorResultOptions {
  /** When true, prepend a compact `Schema:` line listing every output column
   *  as `name (type)`, derived from `opInfo.columnStats` (the `(type)` tag) or
   *  the result-row headers (names only). A cheaper, complete substitute for
   *  the fuller `Column Schema and stats:` block. Defaults to false. */
  schemaInResult?: boolean;
  /** When true, append the full per-column `Column Schema and stats:` block (null counts,
   *  mean/min/max, distinct, top-N histograms, datetime range) the worker
   *  publishes on `columnStats`. Standalone — independent of the data ladder, so
   *  it composes on top of any `dataLevel`. Matches the format the CODE-mode
   *  system prompt documents. Defaults to false. */
  columnStats?: boolean;
  /** When true, append a `Format hints:` line naming string columns the backend
   *  detected as numbers wearing formatting punctuation (currency `$1,234`,
   *  thousands-separated, percent, accounting `(1,234)`) and the cleaning the
   *  model should apply BEFORE numeric conversion. Detection is done in the
   *  Python worker over the *whole* column via pandas (see
   *  data_processor._detect_numeric_format) and shipped as a `format=<tag>`
   *  field on `columnStats`; this side only renders. Targets silent
   *  to_numeric(errors='coerce') dataloss. Defaults to false. */
  valueFormatFlags?: boolean;
  /** When true, surface a coercion-dataloss line for any
   *  `to_numeric/to_datetime(errors="coerce")` that the worker's transparent
   *  instrumentation saw silently null a material block of values — with a
   *  SAMPLE of the dropped values. Read from the reserved `__coercion_telemetry__`
   *  entry on columnStats (see coercion_telemetry.py). Alarm-only. Defaults to false. */
  coercionTelemetry?: boolean;
  /** W1: cap the TSV sample to first ceil(N/2) + last floor(N/2) rows (a true
   *  row count, vs the char-budget proxy). 0/undefined = no cap. */
  maxResultRows?: number;
  /** #25/#26/#27: surface a `Data hints:` block of pre-emptive STRUCTURAL hints
   *  (table grain/key, low-cardinality partition/gate columns, dirty-load:
   *  empty rows/cols + duplicates) computed name-agnostically by the worker over
   *  the whole DataFrame (see data_processor._detect_table_structure). Read from
   *  the reserved `__table_hints__` entry on columnStats; this side only renders.
   *  Targets the silent wrong-population / wrong-grain failure class. Default false. */
  tableStructureHint?: boolean;
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
  /** Metric families to keep in the `Column Schema and stats:` block
   *  ("all" / undefined ⇒ worker strings verbatim). */
  statsMetrics?: "all" | readonly string[];
  /** How densely the stats block renders (default "full" = legacy verbatim):
   *   - "full":    every metric the worker published, on every column.
   *   - "anomaly": only facts the visible sample does not already prove —
   *                suppresses the block outright when every row is on screen,
   *                drops `null=0`, rewrites `distinct` to `unique`/`constant`,
   *                and drops the `Schema (…)` echo the block subsumes. */
  statsDensity?: "full" | "anomaly";
  /** Include `(type)` tags on the Schema line (default true). */
  schemaTypes?: boolean;
  /** Sample-based duplicate rows / identical-column detection line. */
  sampleDuplicates?: boolean;
  /** Sample-based candidate functional-dependency line. */
  sampleFdHints?: boolean;
  /** Sample-based `Type anomaly:` line — text columns that are mostly numeric. */
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

export function formatOperatorResult(
  operatorId: string,
  opInfo: OperatorInfo,
  workflowState: WorkflowState,
  options: FormatOperatorResultOptions = {}
): string {
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
    const op = workflowState.getOperator(operatorId);
    const code = String((op?.operatorProperties as Record<string, unknown> | undefined)?.code ?? "").trim();
    const codeBlock = code ? `\nOperator code:\n${code}` : "";
    return `[ERROR] ${opInfo.error}${codeBlock}`;
  }

  if (!opInfo.result || !Array.isArray(opInfo.result)) {
    return "(no result data)";
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
  const dataString = options.detail === "shape" ? "" : jsonToTableFormat(sampleRows);

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
    !cellsTruncated;
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

  const colStatsBlock =
    options.columnStats && !completeSmallTableVisible
      ? formatColumnStats(opInfo, options.statsMetrics ?? "all", options.statsDensity ?? "full")
      : undefined;
  // `Schema (N cols): col (type), …` and the stats block both carry every
  // column's name and type; when both render, the Schema line is a pure echo
  // (measured: 91.6% of operator blocks carried one, 24,259 chars across the
  // Rule A arms — the single largest waste class). Under "anomaly" density the
  // stats block subsumes it.
  const schemaEchoesStats = options.statsDensity === "anomaly" && colStatsBlock !== undefined;
  const schemaLine =
    options.schemaInResult && !schemaEchoesStats
      ? formatSchemaLine(opInfo, options.schemaTypes !== false)
      : undefined;
  const formatHints = options.valueFormatFlags ? formatValueFormatHints(opInfo) : undefined;
  const coercionLine = options.coercionTelemetry ? formatReservedDiag(opInfo, COERCION_TELEMETRY_KEY) : undefined;
  const tableHintsLine = options.tableStructureHint ? formatTableHints(opInfo) : undefined;
  // Sample-based tuple-level profiling (summarize params; explicitly labeled
  // sample-based — computed over the sampled rows this service holds).
  const dupLine = options.sampleDuplicates ? formatSampleDuplicates(serializableArray) : undefined;
  const fdLine = options.sampleFdHints ? formatSampleFds(serializableArray) : undefined;
  // Layout: shape metadata (Inputs / Output Table) → the result TABLE (TSV) →
  // then the data-derived annotations that DESCRIBE the table (schema / column
  // schema+stats / format & structure hints), so annotations read AFTER the data
  // they refer to. Flow rungs live in context-utils' "Operators needing
  // attention" section; result-formatting owns only the data facet + TSV.
  return [
    ...metadataLines,
    dataString,
    schemaLine,
    colStatsBlock,
    formatHints,
    coercionLine,
    tableHintsLine,
    dupLine,
    fdLine,
  ]
    .filter(Boolean)
    .join("\n");
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
