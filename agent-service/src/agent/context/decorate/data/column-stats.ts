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

import type { OperatorInfo } from "../../../../types/execution";
import { RESERVED_STATS_KEYS } from "./reserved-keys";

/** Wide tables: cap the rendered stats block so it can't blow the context
 *  budget. Matches the result-formatter's column cap intent. */
const MAX_STATS_COLUMNS = 50;

/**
 * Standalone data rung (pre-emptive) — NOT on the ordinal data ladder; driven
 * by the independent `columnStats` flag so it composes on top of any
 * data_level. Re-renders the worker's per-column statistics as the
 * `Column Schema and stats:` block the CODE-mode system prompt documents: one line per
 * column, `- "name" (type): k=v, …` — null counts, mean/min/max, distinct,
 * top-N histograms, datetime range, list/binary shape. The per-column display
 * string is fully owned by the amber worker (see
 * data_processor._compute_column_stats / _publish_column_stats, whose docstring
 * states the renderer "just wraps each one with `- \"col\" `"); this side only
 * wraps + filters. Reserved diagnostic keys (table-hints / join / coercion
 * telemetry) are dropped — they render via their own rungs. Returns undefined
 * when the operator published no real-column stats.
 */
export function formatColumnStats(
  opInfo: OperatorInfo,
  metrics: "all" | readonly string[] = "all"
): string | undefined {
  const stats = opInfo.columnStats;
  if (!stats) return undefined;
  const cols = Object.keys(stats).filter(k => !RESERVED_STATS_KEYS.has(k));
  if (cols.length === 0) return undefined;
  const rows = opInfo.totalRowCount ?? opInfo.outputTuples ?? 0;
  const alarms: string[] = [];
  const shown = cols.slice(0, MAX_STATS_COLUMNS);
  const lines = shown.map(c => {
    const v = stats[c];
    let display = typeof v === "string" && v.length > 0 ? filterStatsLine(v, metrics) : undefined;
    // Near-key duplicate signal (legal-hard-15 lesson): `distinct=401` on 452
    // rows is a passive cue the model must do arithmetic on — and the sample
    // can never show far-apart duplicates (head/tail of a concatenated table).
    // Make it active: append the precomputed dup_rows, and raise an explicit
    // alarm for MOSTLY-unique string columns (the "should this be unique?"
    // shape — entity names/ids duplicated across concatenated files).
    // Categoricals (low uniqueness) are untouched; display-format columns
    // (`format=` tag, e.g. currency strings) are excluded from the alarm.
    if (display && rows > 0) {
      const nk = nearKeyDuplicates(display, rows);
      if (nk) {
        display = `${display}, dup_rows=${nk.dup}`;
        if (nk.alarm) {
          alarms.push(
            `⚠ near-key duplicates: "${c}" — ${nk.dup} of ${nk.nonNull} non-null rows are duplicates ` +
              `(distinct=${nk.distinct}); if values should be unique (e.g. entities across concatenated files), ` +
              `dedupe before counting/aggregating.`
          );
        }
      }
    }
    return display ? `- "${c}" ${display}` : `- "${c}"`;
  });
  if (cols.length > MAX_STATS_COLUMNS) {
    lines.push(`- … (${cols.length - MAX_STATS_COLUMNS} more columns omitted)`);
  }
  return ["Column Schema and stats:", ...lines, ...alarms].join("\n");
}

/** Uniqueness ratio thresholds: dup_rows is appended at ≥0.5 (mostly-unique);
 *  the alarm fires at ≥0.7 (near-key). Both require dup > 0. */
const DUP_ANNOTATE_RATIO = 0.5;
const DUP_ALARM_RATIO = 0.7;

/** Parse a (str) column's stats display for the near-key-duplicates signal.
 *  Returns undefined for non-string columns, fully-unique columns, categoricals
 *  (low uniqueness), or unparseable lines. `alarm` additionally requires the
 *  near-key ratio and no `format=` display tag. */
function nearKeyDuplicates(
  display: string,
  rows: number
): { dup: number; nonNull: number; distinct: number; alarm: boolean } | undefined {
  if (!/^\(str\)/.test(display.trim())) return undefined;
  const dm = /(?:^|[,\s])distinct=(\d+)/.exec(display);
  if (!dm) return undefined;
  const distinct = Number(dm[1]);
  const nm = /(?:^|[,\s])null=(\d+)/.exec(display);
  const nulls = nm ? Number(nm[1]) : 0;
  const nonNull = rows - nulls;
  if (nonNull <= 0 || distinct <= 0 || distinct >= nonNull) return undefined;
  const ratio = distinct / nonNull;
  if (ratio < DUP_ANNOTATE_RATIO) return undefined;
  const dup = nonNull - distinct;
  const alarm = ratio >= DUP_ALARM_RATIO && !/\bformat=/.test(display);
  return { dup, nonNull, distinct, alarm };
}

/**
 * Filter one worker stats line (`(<type>): k=v, k=v, top_10={…}`) down to the
 * requested metric families. The worker owns the format; this parse is
 * best-effort — on any shape it doesn't recognize it returns the line
 * verbatim rather than dropping information.
 *
 * Family of a `k=v` segment = the key up to the first `_` group suffix:
 * `top_5` / `top_10` → "top"; `items_min|max|mean` → "items"; everything else
 * is its literal key (`null`, `mean`, `min`, `max`, `distinct`, `true`,
 * `false`). Unrecognized families (e.g. the `format=` tag) are always kept —
 * they are rare, cheap, and load-bearing for other rungs.
 */
export function filterStatsLine(line: string, metrics: "all" | readonly string[]): string {
  if (metrics === "all") return line;
  const m = /^(\([^)]*\)):?\s*(.*)$/.exec(line.trim());
  if (!m) return line;
  const typeTag = m[1];
  const body = m[2];
  if (!body) return typeTag;
  const segments = splitTopLevel(body);
  const known = new Set(["null", "mean", "min", "max", "distinct", "top", "true", "false", "items"]);
  const wanted = new Set(metrics);
  const kept = segments.filter(seg => {
    const key = seg.split("=")[0]?.trim() ?? "";
    const family = key.startsWith("top_") ? "top" : key.startsWith("items_") ? "items" : key;
    if (!known.has(family)) return true; // unknown families always kept
    return wanted.has(family as never);
  });
  return kept.length > 0 ? `${typeTag}: ${kept.join(", ")}` : typeTag;
}

/** Split `a=1, b=2, top_10={x=1, y=2}` on top-level commas (brace-aware). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
