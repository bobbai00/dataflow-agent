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
import { formatExecuteOperatorResult } from "./tools-utility";

export interface FormatOperatorResultOptions {
  /** When true and `opInfo.columnStats` is a non-empty map, append a
   *  `Column stats:` block — one indented line per column. Errors are
   *  rendered the same way regardless. Defaults to false. */
  statsEnabled?: boolean;
  /** When true, prepend a compact `Schema:` line listing every output column
   *  as `name (type)`, derived from `opInfo.columnStats` (the `(type)` tag) or
   *  the result-row headers (names only). A cheaper, complete substitute for
   *  the verbose `Column stats:` block (lever E). Defaults to false. */
  schemaInResult?: boolean;
  /** When true, append a `Format hints:` line naming string columns the backend
   *  detected as numbers wearing formatting punctuation (currency `$1,234`,
   *  thousands-separated, percent, accounting `(1,234)`) and the cleaning the
   *  model should apply BEFORE numeric conversion. Detection is done in the
   *  Python worker over the *whole* column via pandas (see
   *  data_processor._detect_numeric_format) and shipped as a `format=<tag>`
   *  field on `columnStats`; this side only renders. Targets silent
   *  to_numeric(errors='coerce') dataloss. Defaults to false. */
  valueFormatFlags?: boolean;
  /** When true, append a `Lineage:` line per operator: input→output row counts
   *  (kept % of the largest input) plus a conservative ALARM on degenerate
   *  cardinality transitions (empty output, fan-out row explosion). Derived
   *  purely from `OperatorInfo` row counts already carried (no extra data pass).
   *  Targets the dominant silent-cardinality wrong-answer and the cost spiral
   *  tail. Defaults to false. */
  lineageStats?: boolean;
  /** When true, surface a `Join check ⚠` line for any degenerate merge the
   *  worker's transparent join instrumentation flagged (near-zero key match —
   *  with an unmatched-key SAMPLE — or a many-to-many fan-out). Read from the
   *  reserved `__join_telemetry__` entry the worker publishes on `columnStats`
   *  (see join_telemetry.py). Alarm-only. Defaults to false. */
  joinTelemetry?: boolean;
  /** When true, surface a coercion-dataloss line for any
   *  `to_numeric/to_datetime(errors="coerce")` that the worker's transparent
   *  instrumentation saw silently null a material block of values — with a
   *  SAMPLE of the dropped values. Read from the reserved `__coercion_telemetry__`
   *  entry on columnStats (see coercion_telemetry.py). Alarm-only. Defaults to false. */
  coercionTelemetry?: boolean;
  /** W1: cap the TSV sample to first ceil(N/2) + last floor(N/2) rows (a true
   *  row count, vs the char-budget proxy). 0/undefined = no cap. */
  maxResultRows?: number;
}

/** Reserved columnStats keys the worker uses to ship operator-level diagnostics
 *  (levers 2 & 4). Not real columns — filtered from schema/stats rendering. */
const JOIN_TELEMETRY_KEY = "__join_telemetry__";
const COERCION_TELEMETRY_KEY = "__coercion_telemetry__";
const RESERVED_STATS_KEYS = new Set([JOIN_TELEMETRY_KEY, COERCION_TELEMETRY_KEY]);

/** Wide DataFrames blow up Latest-mode context because the whole result is
 *  re-echoed every turn. Cap both the TSV preview and the stats block at
 *  this many columns: keep the first half and the last half, drop the
 *  middle, and surface a "(showing N of M columns)" notice so the agent
 *  knows the view is truncated. Defaults chosen to keep an 8-turn run on
 *  a 300-column table well under 100k input tokens. */
const MAX_DISPLAYED_COLUMNS = 50;
const MAX_STATS_COLUMNS = 50;

export function formatOperatorResult(
  operatorId: string,
  opInfo: OperatorInfo,
  workflowState: WorkflowState,
  options: FormatOperatorResultOptions = {}
): string {
  if (opInfo.error) {
    return `[ERROR] ${opInfo.error}`;
  }

  if (!opInfo.result || !Array.isArray(opInfo.result)) {
    return "(no result data)";
  }

  const jsonArray = opInfo.result as Record<string, any>[];
  const headers =
    jsonArray.length > 0
      ? Object.keys(jsonArray[0]).filter(k => k !== "__row_index__" && k !== "__is_visualization__")
      : [];
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
    sampleRows = tail > 0
      ? [...sampleRows.slice(0, head), ...sampleRows.slice(sampleRows.length - tail)]
      : sampleRows.slice(0, head);
  }
  const dataString = jsonToTableFormat(sampleRows);

  const metadataLines = [
    formatInputOutputMetadata(workflowState, operatorId, opInfo, columns),
    columnsTruncated ? `(showing first ${Math.ceil(MAX_DISPLAYED_COLUMNS / 2)} and last ${Math.floor(MAX_DISPLAYED_COLUMNS / 2)} of ${columns} columns)` : "",
    ...(opInfo.warnings ?? []),
  ].filter(Boolean);

  const briefSummary = formatExecuteOperatorResult(operatorId);
  const schemaLine = options.schemaInResult ? formatSchemaLine(opInfo) : undefined;
  const formatHints = options.valueFormatFlags ? formatValueFormatHints(opInfo) : undefined;
  const lineageLine = options.lineageStats ? formatLineage(opInfo) : undefined;
  const joinLine = options.joinTelemetry ? formatJoinTelemetry(opInfo) : undefined;
  const coercionLine = options.coercionTelemetry ? formatReservedDiag(opInfo, COERCION_TELEMETRY_KEY) : undefined;
  const statsBlock = options.statsEnabled ? formatColumnStats(opInfo.columnStats) : undefined;
  return [briefSummary, schemaLine, formatHints, lineageLine, joinLine, coercionLine, ...metadataLines, dataString, statsBlock].filter(Boolean).join("\n");
}

/**
 * Build a compact, COMPLETE `Schema:` line — `name (type), name (type), …` for
 * every output column (lever E). Column names + types come from
 * `opInfo.columnStats` (whose display strings begin with a `(<type>)` tag and
 * which the engine computes for *every* column, so the list is complete even
 * for wide tables that the TSV/stats previews truncate). Falls back to the
 * result-row headers (names only) when `columnStats` is absent. Returns
 * `undefined` when no columns are known. Unlike the verbose `Column stats:`
 * block this is one short line and is intentionally NOT column-truncated — its
 * whole value is giving the model the full column inventory to write against.
 */
export function formatSchemaLine(opInfo: OperatorInfo): string | undefined {
  const stats = opInfo.columnStats ?? {};
  const statCols = Object.keys(stats).filter(k => !RESERVED_STATS_KEYS.has(k));
  let cols: string[];
  if (statCols.length > 0) {
    cols = statCols;
  } else {
    const result = Array.isArray(opInfo.result) ? (opInfo.result as Record<string, any>[]) : [];
    cols =
      result.length > 0
        ? Object.keys(result[0]).filter(k => k !== "__row_index__" && k !== "__is_visualization__")
        : [];
  }
  if (cols.length === 0) return undefined;
  const parts = cols.map(col => {
    const s = stats[col];
    const m = typeof s === "string" ? /^\(([^)]+)\)/.exec(s.trim()) : null;
    return m ? `${col} (${m[1]})` : col;
  });
  return `Schema (${cols.length} cols): ${parts.join(", ")}`;
}

/**
 * Map each backend format tag (see data_processor._detect_numeric_format) to
 * the concrete cleaning the model should apply BEFORE numeric conversion.
 */
const VALUE_FORMAT_HINTS: Record<string, string> = {
  currency: "currency ($, commas) — strip $ and commas before to_numeric; coerce would NULL them",
  thousands: "thousands-separated — strip commas before to_numeric; coerce would silently NULL these rows",
  percent: "percent (%) — strip % before converting; check whether the answer wants a fraction or ×100",
  accounting: "accounting negatives — convert ( ) to a leading minus before numeric",
  "numeric-as-text": "numbers stored as text — strip punctuation before to_numeric; coerce drops non-parseable rows",
};

/** Pull the `format=<tag>` field the backend embeds in a column's stats string. */
function extractFormatTag(stat: string): string | undefined {
  const m = /(?:^|[,\s])format=([\w-]+)/.exec(stat);
  return m ? m[1] : undefined;
}

/**
 * Render the `Format hints:` line from the per-column `format=<tag>` annotation
 * the backend embeds in `opInfo.columnStats`. Detection lives in the Python
 * worker, which holds the *whole* column and uses pandas.to_numeric as the
 * judge (see data_processor._detect_numeric_format) — far more reliable than a
 * regex over the truncated preview, and non-duplicative (one detection path).
 * This function only renders. Returns `undefined` when no column is tagged.
 */
export function formatValueFormatHints(opInfo: OperatorInfo): string | undefined {
  const stats = opInfo.columnStats ?? {};
  const clauses: string[] = [];
  for (const [col, stat] of Object.entries(stats)) {
    if (typeof stat !== "string") continue;
    const tag = extractFormatTag(stat);
    const hint = tag ? VALUE_FORMAT_HINTS[tag] : undefined;
    if (hint) clauses.push(`"${col}" ${hint}`);
  }
  if (clauses.length === 0) return undefined;
  return `Format hints: ${clauses.join("; ")}`;
}

/**
 * Per-operator cardinality lineage ALARM (lever 1, alarm-only). Returns a line
 * ONLY when an operator's row-count transition is one of the two degenerate
 * cases that are unambiguous bugs in any tabular pipeline:
 *   - empty output (0 rows) when there was input — over-restrictive filter or a
 *     zero-match join (the dominant silent wrong-answer / NaN failure);
 *   - fan-out explosion (output ≫ largest input) — a join on a non-unique key;
 *   - (source) an empty load — 0 rows read.
 *
 * Returns `undefined` for every other operator — NO routine per-operator line.
 * Rationale (measured): emitting "X in → Y out (kept %)" on every operator
 * every turn floods LATEST-mode context (median 13, max 756 lines/trace) with
 * no accuracy payoff and a real cost penalty; the SIGNAL is the alarm, not the
 * routine count. Deliberately does NOT alarm on shrinkage: filters /
 * aggregations / dedup / argmax legitimately drop most rows (the alarm-fatigue
 * risk). Derived only from row counts already in `OperatorInfo` — topology-
 * level, keyed on no column/task literal, so it generalizes.
 */
export function formatLineage(opInfo: OperatorInfo): string | undefined {
  const out = opInfo.totalRowCount ?? opInfo.outputTuples;
  if (typeof out !== "number") return undefined;
  const inRows = (opInfo.inputPortShapes ?? [])
    .map(s => s.rows)
    .filter((r): r is number => typeof r === "number" && r >= 0);
  if (inRows.length === 0) {
    // Source/loader: alarm only on an empty load; otherwise silent.
    return out === 0
      ? "Lineage ⚠: loaded 0 rows — check the file path/glob and parse options (wrong delimiter, header, or all rows skipped)"
      : undefined;
  }
  const maxIn = Math.max(...inRows);
  const inDesc = inRows.length === 1 ? `${maxIn} in` : `[${inRows.join(", ")}] in`;
  if (out === 0 && maxIn > 0) {
    return `Lineage ⚠: ${inDesc} → 0 out — EMPTY output from an over-restrictive filter or a zero-match join; verify the filter condition and join keys/dtypes`;
  }
  if (maxIn > 0 && out > 3 * maxIn) {
    return `Lineage ⚠: ${inDesc} → ${out} out — row count EXPLODED (fan-out); likely a join on a non-unique key; verify join keys are correct and unique`;
  }
  return undefined; // normal transition: no line (the count is already in the shape metadata)
}

/**
 * Render the join-telemetry line(s) from the reserved `__join_telemetry__`
 * entry the worker publishes on `columnStats` (lever 2). Detection lives in the
 * Python worker (it has the input frames + the join keys, via transparent
 * pandas.merge instrumentation — see join_telemetry.py); this only renders.
 * The worker joins multiple diagnostics with " || "; we render one per line.
 * Returns `undefined` when no degenerate join was flagged.
 */
/** Render a reserved operator-level diagnostic the worker shipped under `key`
 *  on columnStats (one diagnostic per line; worker joins them with " || "). */
export function formatReservedDiag(opInfo: OperatorInfo, key: string): string | undefined {
  const v = opInfo.columnStats?.[key];
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.split(" || ").map(s => s.trim()).filter(Boolean).join("\n");
}

export function formatJoinTelemetry(opInfo: OperatorInfo): string | undefined {
  return formatReservedDiag(opInfo, JOIN_TELEMETRY_KEY);
}

/**
 * Render a `Column stats:` block from `OperatorInfo.columnStats`.
 *
 * The backend ships per-column annotations as pre-formatted display strings
 * of the shape `"(<type>): k=v, k=v, ..."` (see
 * data_processor._compute_column_stats). The renderer wraps each one with
 * `- "<col>" ` and emits them under the header — no JSON parsing happens
 * on this side, so the backend can freely change which stats it surfaces
 * per type without coordinating a renderer update.
 *
 * Returns `undefined` when the map is missing, empty, or otherwise
 * unhelpful (caller treats `undefined` as "omit this section entirely").
 */
function formatColumnStats(stats: Record<string, string> | undefined): string | undefined {
  if (!stats) return undefined;
  const entries = Object.entries(stats).filter(
    ([k, v]) => !RESERVED_STATS_KEYS.has(k) && typeof v === "string" && v.length > 0
  );
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  // Wide tables: keep first half + last half by column name, drop the middle.
  // Symmetric to jsonToTableFormat so the displayed table columns and the
  // stats columns line up (modulo the sort orders, which differ — stats are
  // alphabetical, table preview is insertion order).
  const total = entries.length;
  let shown = entries;
  let header = "Column stats:";
  if (total > MAX_STATS_COLUMNS) {
    const leftCount = Math.ceil(MAX_STATS_COLUMNS / 2);
    const rightCount = Math.floor(MAX_STATS_COLUMNS / 2);
    shown = [...entries.slice(0, leftCount), ...entries.slice(-rightCount)];
    header = `Column stats (showing first ${leftCount} and last ${rightCount} of ${total} columns):`;
  }
  const lines = [header];
  // Strip the `format=<tag>` field: it's an annotation for the value-format
  // hint line (formatValueFormatHints), surfaced there only when the
  // valueFormatFlags lever is on — not part of the distribution stats.
  for (const [col, stat] of shown)
    lines.push(`- "${col}" ${stat.replace(/,?\s*format=[\w-]+/g, "")}`);
  return lines.join("\n");
}

function formatInputOutputMetadata(
  workflowState: WorkflowState,
  operatorId: string,
  opInfo: OperatorInfo,
  outputColumns: number
): string {
  const outputRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const outputLine = `Output table shape: (${outputRows}, ${outputColumns})`;

  const inputShapes = opInfo.inputPortShapes;
  if (!inputShapes || inputShapes.length === 0) {
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
      const name = portIndexToUpstream.get(p.portIndex) ?? `input${p.portIndex}`;
      return `${name}(${p.rows}, ${p.columns})`;
    })
    .join(", ");

  return `Input operator(table shape): ${inputPart}\n${outputLine}`;
}

function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const hasRowIndex = "__row_index__" in jsonResult[0];
  const allHeaders = Object.keys(jsonResult[0]).filter(h => h !== "__row_index__");
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
