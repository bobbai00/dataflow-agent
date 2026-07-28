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
  metrics: "all" | readonly string[] = "all",
  density: "full" | "anomaly" = "full"
): string | undefined {
  const stats = opInfo.columnStats;
  if (!stats) return undefined;
  const cols = Object.keys(stats).filter(k => !RESERVED_STATS_KEYS.has(k));
  if (cols.length === 0) return undefined;
  const rows = opInfo.totalRowCount ?? opInfo.outputTuples ?? 0;
  const shown = cols.slice(0, MAX_STATS_COLUMNS);
  const lines = shown.map(c => {
    const v = stats[c];
    let display = typeof v === "string" && v.length > 0 ? filterStatsLine(v, metrics) : undefined;
    if (display && density === "anomaly") display = densifyStatsLine(display, rows);
    // duplicate_values = nonNull − distinct: the exact count of surplus value
    // occurrences in this (str) column. Pre-computed arithmetic over numbers
    // already on the line — rendered whenever it is non-zero (presence, not a
    // threshold band). No labels, no alarms: what to DO about duplication is
    // the prompt's/model's judgment, not the renderer's.
    if (display && rows > 0) {
      const dv = duplicateValues(display, rows);
      if (dv && dv.dup > 0) {
        display = `${display}, duplicate_values=${dv.dup}`;
      }
    }
    return display ? `- "${c}" ${display}` : `- "${c}"`;
  });
  if (cols.length > MAX_STATS_COLUMNS) {
    lines.push(`- … (${cols.length - MAX_STATS_COLUMNS} more columns omitted)`);
  }
  return ["Column Schema and stats:", ...lines].join("\n");
}

/**
 * ANOMALY density — drop the segments whose value is the *default healthy state*
 * of a column, keeping only what would surprise a reader.
 *
 * Motivation (measured over 299 rendered operator blocks / 1,767 column entries
 * on the Rule A arms): `null=0` occupies 32.1% of all column entries and
 * `distinct == rows` another 5.9%. Both announce the ABSENCE of a problem, which
 * inverts the signal — a reader must scan every line to discover that no line
 * mattered. Rendering only anomalies makes the *presence* of `null=` mean
 * "this column has holes", which is the fact worth spending bytes on.
 *
 * Rewrites rather than deletions where the fact still matters but the number
 * does not: an all-distinct column becomes `unique`, a single-valued one
 * `constant` — both shorter than the `distinct=N` they replace AND stated in the
 * vocabulary the agent would use to reason about them.
 *
 * Never empties a line: the `(type)` tag always survives.
 */
export function densifyStatsLine(display: string, rows: number): string {
  const m = /^(\([^)]*\)):?\s*(.*)$/.exec(display.trim());
  if (!m || !m[2]) return display;
  const typeTag = m[1];
  const segments = splitTopLevel(m[2]);
  const nullSeg = segments.find(s => /^null=\d+$/.test(s));
  const nulls = nullSeg ? Number(nullSeg.split("=")[1]) : 0;
  const nonNull = rows > 0 ? rows - nulls : 0;

  const kept: string[] = [];
  for (const seg of segments) {
    const [key, rawVal] = [seg.split("=")[0]?.trim() ?? "", seg.split("=").slice(1).join("=").trim()];
    if (key === "null") {
      if (nulls > 0) kept.push(seg); // holes are the anomaly; completeness is not
      continue;
    }
    if (key === "distinct") {
      const d = Number(rawVal);
      if (!Number.isFinite(d)) {
        kept.push(seg);
      } else if (d === 1) {
        kept.push("constant");
      } else if (nonNull > 0 && d >= nonNull) {
        kept.push("unique");
      } else {
        kept.push(seg);
      }
      continue;
    }
    kept.push(seg);
  }
  return kept.length > 0 ? `${typeTag}: ${kept.join(", ")}` : typeTag;
}

/** Parse a (str) column's stats display and compute duplicate_values =
 *  nonNull − distinct. Pure arithmetic on the line's own numbers; returns
 *  undefined for non-string columns, fully-unique columns, or unparseable
 *  lines. No ratio bands — the caller renders whenever dup > 0. */
function duplicateValues(
  display: string,
  rows: number
): { dup: number; nonNull: number; distinct: number } | undefined {
  if (!/^\(str\)/.test(display.trim())) return undefined;
  const dm = /(?:^|[,\s])distinct=(\d+)/.exec(display);
  if (!dm) return undefined;
  const distinct = Number(dm[1]);
  const nm = /(?:^|[,\s])null=(\d+)/.exec(display);
  const nulls = nm ? Number(nm[1]) : 0;
  const nonNull = rows - nulls;
  if (nonNull <= 0 || distinct <= 0 || distinct >= nonNull) return undefined;
  return { dup: nonNull - distinct, nonNull, distinct };
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
