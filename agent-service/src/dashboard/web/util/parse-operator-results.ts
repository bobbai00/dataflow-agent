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

import type { ReActStep } from "../types";

/**
 * One operator's runtime result extracted from an agent step's
 * `inputMessages` content. The agent service's context assembler
 * (`context-utils.ts` / `context-utils-local-react.ts`) already serializes
 * the post-execution snapshot into a markdown block of the shape:
 *
 *     ### Operator `<id>` (<Type>)
 *     Summary: <customDisplayName>
 *     Result:
 *       Executed operator <id>
 *       Output table shape: (R, C)
 *       <TSV header row>
 *       <TSV row 0>
 *       ...
 *       Column stats:
 *         <col>: <stat-string>
 *         - "<col>" <stat-string>     (newer formatter variant)
 *
 * Failed ops render as:
 *
 *     Result:
 *       [ERROR] <message>
 *
 * For imported traces — where the agent service can't re-execute against
 * the Texera backend — this is the *only* place those per-operator
 * results survive on the wire. Parsing them client-side lets the dashboard
 * show TSV previews, error chips, and column stats without any server-side
 * change.
 */
export interface ParsedOperatorResult {
  state: "completed" | "failed";
  /** The `customDisplayName` summary line, trimmed of the `Summary: ` prefix. */
  summary?: string;
  /** Raw indented body of the `Result:` block. Preserved verbatim so the
   *  UI can render it as a fallback when the structured fields below
   *  don't capture everything. */
  resultBlock?: string;
  /** `Executed operator …` + `Output table shape: (R, C)` + TSV rows.
   *  Just the rows portion (after the metadata lines), one row per line.
   *  Undefined if the result wasn't a table (e.g. errors, visualizations). */
  tsv?: string;
  outputShape?: { rows: number; columns: number };
  /** Each column's stats string verbatim — formats vary across agent-service
   *  versions (`<col>: <stat>` vs `- "<col>" <stat>`), so we keep the
   *  string opaque and let the UI render it as-is in monospace. */
  columnStats?: Record<string, string>;
  /** Set when the block starts with `[ERROR]`. */
  error?: string;
  /** Warnings printed between the shape line and the TSV (rare). */
  warnings?: string[];
}

/**
 * Index per-operator results by stepId. Built once when a trace loads and
 * passed down through the component tree.
 */
export type ParsedResultsByStep = Map<string, Map<string, ParsedOperatorResult>>;

const OPERATOR_HEADER = /(?:^|\n)#*\s*Operator\s+`([^`]+)`\s+\(([^)]+)\)/g;

export function parseAllStepResults(steps: ReActStep[]): ParsedResultsByStep {
  const out: ParsedResultsByStep = new Map();
  for (const step of steps) {
    if (!step.inputMessages || step.inputMessages.length === 0) continue;
    const merged = new Map<string, ParsedOperatorResult>();
    for (const msg of step.inputMessages) {
      const content = typeof msg?.content === "string" ? msg.content : "";
      if (!content) continue;
      const parsed = parseContext(content);
      for (const [opId, r] of parsed) merged.set(opId, r);
    }
    if (merged.size > 0) out.set(step.id, merged);
  }
  return out;
}

/**
 * Pull every `### Operator …` block out of one message string. Tolerates
 * any heading depth (`### Operator` in local-react context, `##### Operator`
 * deep inside the events list of full-context mode) and missing-heading
 * variants where the line is just `Operator \`x\` (Type)`.
 */
export function parseContext(content: string): Map<string, ParsedOperatorResult> {
  const out = new Map<string, ParsedOperatorResult>();
  if (!content) return out;
  OPERATOR_HEADER.lastIndex = 0;
  const matches: Array<{ opId: string; start: number; afterHeader: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = OPERATOR_HEADER.exec(content)) !== null) {
    matches.push({ opId: m[1], start: m.index, afterHeader: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const here = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : content.length;
    const body = content.slice(here.afterHeader, end);
    // Last write wins — a later snapshot in the same message (rare) reflects
    // the more recent state. Most messages only mention each operator once.
    out.set(here.opId, parseOperatorBlock(body));
  }
  return out;
}

/**
 * Body of a single operator block — everything between this operator's
 * heading and the next operator's heading (or end of content). Lines
 * inside the `Result:` section are 2-space indented by the formatter;
 * we strip that indent so consumers see the raw values.
 */
function parseOperatorBlock(body: string): ParsedOperatorResult {
  const lines = body.split("\n");
  let summary = "";
  const resultLines: string[] = [];
  let inSummary = false;
  let inResult = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
    // Any unindented label-like line (other than data) closes the previous
    // section. Section terminators that appear inside trace context:
    //   - `### Operator …`         next operator (already split outside)
    //   - `## Links`               links sub-block
    //   - `## Operators`           operators sub-block header
    //   - `# Current Dataflow`     parent block opener
    if (/^#+\s/.test(line) || /^Links\s*:/.test(line)) {
      inSummary = false;
      inResult = false;
      continue;
    }
    if (inSummary) {
      // Multi-line summary continuation — only if the line looks like a
      // continuation (not a new top-level field). The formatter usually
      // keeps Summary on one line, but be permissive.
      if (line.trim() === "" || /^[A-Z][A-Za-z]+:\s*$/.test(line)) {
        inSummary = false;
      } else {
        summary += (summary ? "\n" : "") + line;
      }
      continue;
    }
    if (inResult) {
      // Result body is 2-space indented; strip only that exact prefix to
      // preserve any inner indentation (e.g. column-stats nesting).
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

  // Locate the structured anchors. `Output table shape` is emitted by
  // `formatInputOutputMetadata` and is the canonical hint that the body
  // is a successful table preview.
  const shapeMatch = resultBlock.match(/Output table shape:\s*\((\d+),\s*(\d+)\)/);
  const outputShape = shapeMatch
    ? { rows: parseInt(shapeMatch[1], 10), columns: parseInt(shapeMatch[2], 10) }
    : undefined;

  // Slice out a column-stats block if present.
  let columnStats: Record<string, string> | undefined;
  let tsvSection = resultBlock;
  const statsIdx = resultBlock.search(/(^|\n)Column stats[^\n]*\n/);
  if (statsIdx >= 0) {
    tsvSection = resultBlock.slice(0, statsIdx).replace(/\n+$/, "");
    const statsRaw = resultBlock.slice(statsIdx).replace(/^[\s\n]+/, "");
    columnStats = parseColumnStats(statsRaw);
  }

  // Carve TSV: drop the initial "Executed operator" / shape / warning lines.
  let tsv: string | undefined;
  const tsvLines = tsvSection.split("\n");
  const dataStart = tsvLines.findIndex(
    l => l.includes("\t") || (l.startsWith(" ") && /\d/.test(l))
  );
  if (dataStart >= 0) {
    tsv = tsvLines.slice(dataStart).join("\n").trimEnd();
  }

  const warnings: string[] = [];
  if (shapeMatch) {
    const shapeLineIdx = tsvLines.findIndex(l => l.includes("Output table shape"));
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

/**
 * Two known stats formats in the wild:
 *
 *   <col>: <stat-string>             (older Kramabench traces)
 *   - "<col>" <stat-string>          (current formatter — see `formatColumnStats`)
 *
 * We accept both. The stat string is opaque to us — the backend chooses
 * what to surface per column type, and the UI just renders it verbatim.
 */
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
    if (!line || /^Column stats/i.test(line)) continue;
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
