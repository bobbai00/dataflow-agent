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
  /** When true, append a `Format hints:` line flagging string columns whose
   *  sample values look like currency `$1,234`, percent, thousands-separated,
   *  parenthesized-negatives, or leading-zero codes — with the cleaning the
   *  model should apply BEFORE numeric conversion. Targets silent
   *  to_numeric(errors='coerce') dataloss. Defaults to false. */
  valueFormatFlags?: boolean;
}

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

  const dataString = jsonToTableFormat(serializableArray);

  const metadataLines = [
    formatInputOutputMetadata(workflowState, operatorId, opInfo, columns),
    columnsTruncated ? `(showing first ${Math.ceil(MAX_DISPLAYED_COLUMNS / 2)} and last ${Math.floor(MAX_DISPLAYED_COLUMNS / 2)} of ${columns} columns)` : "",
    ...(opInfo.warnings ?? []),
  ].filter(Boolean);

  const briefSummary = formatExecuteOperatorResult(operatorId);
  const schemaLine = options.schemaInResult ? formatSchemaLine(opInfo) : undefined;
  const formatHints = options.valueFormatFlags ? formatValueFormatHints(opInfo) : undefined;
  const statsBlock = options.statsEnabled ? formatColumnStats(opInfo.columnStats) : undefined;
  return [briefSummary, schemaLine, formatHints, ...metadataLines, dataString, statsBlock].filter(Boolean).join("\n");
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
  const statCols = Object.keys(stats);
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
 * Detect, per string column, a numeric-bearing surface format from the sample
 * rows (currency `$1,234`, percent, thousands-separated, parenthesized
 * negatives, leading-zero codes) and the cleaning the model should apply BEFORE
 * numeric conversion. Conservative: flags a column only when a clear majority
 * (>=60%) of >=2 non-empty sampled string values match a single pattern, so it
 * doesn't fire on ordinary text. Keyed purely on value shape — no task/column
 * literals — so it generalizes. Targets the dominant accuracy killer: silent
 * `to_numeric(errors='coerce')` dataloss on comma/$-bearing numbers.
 */
function detectColumnFormats(opInfo: OperatorInfo): Record<string, string> {
  const result = Array.isArray(opInfo.result) ? (opInfo.result as Record<string, any>[]) : [];
  if (result.length === 0) return {};
  const cols = Object.keys(result[0]).filter(k => k !== "__row_index__" && k !== "__is_visualization__");
  const out: Record<string, string> = {};
  for (const col of cols) {
    const strs = result
      .map(r => r[col])
      .filter(v => typeof v === "string" && v.trim().length > 0)
      .slice(0, 20) as string[];
    if (strs.length < 2) continue;
    const frac = (re: RegExp) => strs.filter(s => re.test(s.trim())).length / strs.length;
    if (frac(/^-?\$\s?[\d,]+(\.\d+)?$/) >= 0.6)
      out[col] = "currency ($, commas) — strip $ and commas, then convert; do NOT to_numeric(coerce) (it nulls them)";
    else if (frac(/^-?[\d,]+(\.\d+)?\s?%$/) >= 0.6)
      out[col] = "percent (%) — strip %, then convert; check whether the answer wants a fraction or ×100";
    else if (frac(/^-?\d{1,3}(,\d{3})+(\.\d+)?$/) >= 0.6)
      out[col] = "thousands-separated — strip commas before converting; to_numeric(coerce) would silently NULL these rows";
    else if (frac(/^\(\s*[\d,]+(\.\d+)?\s*\)$/) >= 0.6)
      out[col] = "parenthesized negatives — convert ( ) to a minus sign before numeric";
    else if (frac(/^0\d+$/) >= 0.6)
      out[col] = "leading-zero codes — keep as string, do NOT cast to int";
  }
  return out;
}

/**
 * Render the `Format hints:` line from detectColumnFormats — one clause per
 * flagged column. Returns `undefined` when nothing is flagged (no line emitted).
 */
export function formatValueFormatHints(opInfo: OperatorInfo): string | undefined {
  const fmt = detectColumnFormats(opInfo);
  const cols = Object.keys(fmt);
  if (cols.length === 0) return undefined;
  return `Format hints: ${cols.map(c => `"${c}" ${fmt[c]}`).join("; ")}`;
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
  const entries = Object.entries(stats).filter(([, v]) => typeof v === "string" && v.length > 0);
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
  for (const [col, stat] of shown) lines.push(`- "${col}" ${stat}`);
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
