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
 * Parser that recovers per-operator results from a trace step's
 * `inputMessages`. Used by `TexeraAgent.importReActSteps` to populate
 * each rebuilt snapshot's `results` map so an imported trace exposes the
 * same `Map<operatorId, OperatorInfo>` as a live agent run would.
 *
 * The agent service's context assemblers (`context-utils.ts` and
 * `context-utils-local-react.ts`) already serialize every action-bearing
 * snapshot into a markdown block of the shape
 *
 *     ### Operator `<id>` (<Type>)
 *     Summary: <customDisplayName>
 *     Inputs: <upstream> (R rows, C cols)     (LATEST only; DELTA carries it in Result)
 *     Result:
 *       Output Table: N rows, M cols          (legacy traces: `Output table shape: (R, C)`)
 *       <TSV header>
 *       <TSV row 0>
 *       ...
 *       Column Schema and stats:              (legacy: `Column stats:`)
 *         - "<col>" <stat>                    (current formatter — see `formatColumnStats`)
 *         <col>: <stat>                       (older Kramabench trace format)
 *
 * Failures render as `Result:\n  [ERROR] <message>`. The renderer's
 * heading depth varies with context mode (`### Operator` in local-react,
 * `##### Operator` deep inside FULL/DELTA contexts), so we accept any
 * leading `#` count, or none at all.
 */

import type { OperatorInfo } from "../../types/execution";

export interface ParsedOperatorResult {
  state: "completed" | "failed";
  /** The `Summary:` line, trimmed of the prefix. */
  summary?: string;
  /** Raw indented body of the `Result:` block, after stripping the
   *  two-space prefix the renderer indents with. Useful for debugging. */
  resultBlock?: string;
  /** The TSV portion of the result body — header row + data rows, no
   *  metadata lines, no column-stats block. Undefined when the operator
   *  errored or had no materialized table. */
  tsv?: string;
  outputShape?: { rows: number; columns: number };
  /** Each column's stats string verbatim. Format varies across
   *  agent-service versions — we keep it opaque. */
  columnStats?: Record<string, string>;
  /** Set when the block starts with `[ERROR]`. */
  error?: string;
  /** Warnings printed between the shape line and the TSV. Rare. */
  warnings?: string[];
}

// `### Operator \`id\` (Type)` (code mode) or `### filter operator \`id\`` (native).
const OPERATOR_HEADER = /(?:^|\n)#*\s*(?:Operator\s+`([^`]+)`\s+\(([^)]+)\)|(\w+) operator\s+`([^`]+)`)/g;

/**
 * Pull every `Operator <id> (Type)` block out of one message content
 * string. Tolerates any heading depth and merges multiple mentions of
 * the same operator id with last-write-wins (later mentions reflect
 * more recent state in interleaved contexts).
 */
export function parseTraceContext(content: string): Map<string, ParsedOperatorResult> {
  const out = new Map<string, ParsedOperatorResult>();
  if (!content) return out;
  OPERATOR_HEADER.lastIndex = 0;
  const matches: Array<{ opId: string; start: number; afterHeader: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = OPERATOR_HEADER.exec(content)) !== null) {
    matches.push({ opId: m[1] ?? m[4], start: m.index, afterHeader: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const here = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : content.length;
    const body = content.slice(here.afterHeader, end);
    out.set(here.opId, parseOperatorBlock(body));
  }
  return out;
}

function parseOperatorBlock(body: string): ParsedOperatorResult {
  const lines = body.split("\n");
  let summary = "";
  const resultLines: string[] = [];
  let inSummary = false;
  let inResult = false;

  for (const line of lines) {
    if (/^Summary:\s*/.test(line)) {
      summary = line.replace(/^Summary:\s*/, "");
      inSummary = true;
      inResult = false;
      continue;
    }
    if (/^Result:\s*$/.test(line)) {
      inResult = true;
      inSummary = false;
      continue;
    }
    if (/^#+\s/.test(line) || /^Links\s*:/.test(line)) {
      inSummary = false;
      inResult = false;
      continue;
    }
    if (inSummary) {
      if (line.trim() === "" || /^[A-Z][A-Za-z]+:\s*$/.test(line)) {
        inSummary = false;
      } else {
        summary += (summary ? "\n" : "") + line;
      }
      continue;
    }
    if (inResult) {
      resultLines.push(line.startsWith("  ") ? line.slice(2) : line);
    }
  }

  const resultBlock = resultLines.join("\n").replace(/\n+$/, "");
  return classifyResult(summary, resultBlock);
}

function classifyResult(summary: string, resultBlock: string): ParsedOperatorResult {
  const summaryClean = summary.trim() || undefined;
  if (!resultBlock) return { state: "completed", summary: summaryClean };

  const errMatch = resultBlock.match(/^\[ERROR\]\s*([\s\S]*)$/);
  if (errMatch) {
    return {
      state: "failed",
      summary: summaryClean,
      resultBlock,
      error: errMatch[1].trim(),
    };
  }

  // New descriptive form `Output: N rows, M cols`; fall back to the legacy
  // `Output table shape: (N, M)` so older traces still import.
  const shapeMatch =
    resultBlock.match(/Output:\s*(\d+)\s*rows,\s*(\d+)\s*cols/) ??
    resultBlock.match(/Output table shape:\s*\((\d+),\s*(\d+)\)/);
  const outputShape = shapeMatch
    ? { rows: parseInt(shapeMatch[1], 10), columns: parseInt(shapeMatch[2], 10) }
    : undefined;

  let columnStats: Record<string, string> | undefined;
  let tsvSection = resultBlock;
  const statsIdx = resultBlock.search(/(^|\n)Column (?:Schema and stats|[Ss]tats)[^\n]*\n/);
  if (statsIdx >= 0) {
    tsvSection = resultBlock.slice(0, statsIdx).replace(/\n+$/, "");
    const statsRaw = resultBlock.slice(statsIdx).replace(/^[\s\n]+/, "");
    columnStats = parseColumnStats(statsRaw);
  }

  let tsv: string | undefined;
  const tsvLines = tsvSection.split("\n");
  // First TSV-ish row: tab-bearing or whitespace-prefixed numeric (index rows).
  const dataStart = tsvLines.findIndex(
    l => l.includes("\t") || (l.startsWith(" ") && /\d/.test(l))
  );
  if (dataStart >= 0) {
    tsv = tsvLines.slice(dataStart).join("\n").trimEnd();
  }

  const warnings: string[] = [];
  if (shapeMatch) {
    const shapeLineIdx = tsvLines.findIndex(l => /Output:\s*\d+\s*rows/.test(l) || l.includes("Output table shape"));
    if (shapeLineIdx >= 0 && dataStart > shapeLineIdx + 1) {
      for (let i = shapeLineIdx + 1; i < dataStart; i++) {
        const t = tsvLines[i].trim();
        if (t) warnings.push(t);
      }
    }
  }

  return {
    state: "completed",
    summary: summaryClean,
    resultBlock,
    tsv,
    outputShape,
    columnStats,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function parseColumnStats(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = block.split("\n");
  let buffer: string | null = null;
  let bufferKey: string | null = null;
  const flush = () => {
    if (bufferKey !== null && buffer !== null) {
      result[bufferKey] = buffer.trim();
    }
    bufferKey = null;
    buffer = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/^\s+/, "");
    if (!line || /^Column (?:Schema and stats|stats)/i.test(line)) continue;
    const dashFmt = line.match(/^-\s+"([^"]+)"\s+(.*)$/);
    const colonFmt = line.match(/^([A-Za-z0-9_.\- ?%/]+):\s+(.*)$/);
    if (dashFmt) {
      flush();
      bufferKey = dashFmt[1];
      buffer = dashFmt[2];
    } else if (colonFmt) {
      flush();
      bufferKey = colonFmt[1];
      buffer = colonFmt[2];
    } else if (bufferKey !== null) {
      buffer = (buffer ?? "") + " " + line;
    }
  }
  flush();
  return result;
}

/**
 * Reverse the TSV that `jsonToTableFormat` produces back into the
 * `Record<string, any>[]` shape `OperatorInfo.result` expects. The
 * formatter:
 *  - emits one header row with an empty leading cell for the row index,
 *  - emits each data row as `<index>\t<value>\t<value>…`,
 *  - inserts a `\t…\t…\t…` separator row when truncating the middle of a
 *    long table. We discard that row.
 *
 * Values stay as strings — the formatter didn't preserve typing, and
 * inferring it (numeric vs string vs date) is more pain than it's worth
 * for a preview that the renderer shows as text anyway.
 */
function parseTsvToRecords(tsv: string): Record<string, string>[] {
  const lines = tsv.split("\n").filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headerCells = lines[0].split("\t");
  // Header has a leading empty cell iff each data row prepends its index.
  const hasIndexCol = headerCells[0] === "" || headerCells[0].trim() === "";
  const cols = hasIndexCol ? headerCells.slice(1) : headerCells;
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Truncation marker: only dots, tabs, spaces.
    if (/^[.\t\s]+$/.test(line)) continue;
    const cells = line.split("\t");
    const values = hasIndexCol ? cells.slice(1) : cells;
    const row: Record<string, string> = {};
    for (let j = 0; j < cols.length; j++) {
      row[cols[j]] = values[j] ?? "";
    }
    out.push(row);
  }
  return out;
}

/**
 * Translate a parsed trace result into the `OperatorInfo` shape the agent
 * service stores in `WorkflowSnapshotStorage.results`. Returns `null` when
 * the parsed block carried no usable data (no TSV, no error, no shape) —
 * the import path uses that to skip writing a phantom entry that would
 * shadow a real inherited result from an ancestor snapshot.
 */
export function parsedResultToOperatorInfo(parsed: ParsedOperatorResult): OperatorInfo | null {
  if (parsed.state === "failed") {
    return {
      state: "Failed",
      inputTuples: 0,
      outputTuples: 0,
      resultMode: "table",
      error: parsed.error,
      warnings: parsed.warnings,
    };
  }
  const hasData = !!parsed.tsv || !!parsed.outputShape || !!parsed.columnStats;
  if (!hasData) return null;

  const records = parsed.tsv ? parseTsvToRecords(parsed.tsv) : [];
  const rows = parsed.outputShape?.rows ?? records.length;
  return {
    state: "Completed",
    // Input-side tuple counts aren't preserved in the rendered context;
    // `0` is the same default a live execution returns for a sourceless op.
    inputTuples: 0,
    outputTuples: rows,
    resultMode: "table",
    result: records.length > 0 ? records : undefined,
    totalRowCount: parsed.outputShape?.rows ?? records.length,
    displayedRows: records.length || undefined,
    truncated:
      parsed.outputShape && records.length > 0
        ? parsed.outputShape.rows > records.length
        : undefined,
    columnStats: parsed.columnStats,
    warnings: parsed.warnings,
  };
}
