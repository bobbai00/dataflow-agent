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

import { RESERVED_STATS_KEYS } from "./reserved-keys";

/**
 * Data-L1 verbose / compact per-column stats blocks. Rendered from the backend's
 * pre-formatted per-column display strings (`"(<type>): k=v, ..."`); no JSON
 * parsing on this side so the backend can change which stats it surfaces without
 * a renderer update. Same wide-table truncation (first + last MAX_STATS_COLUMNS)
 * for both. Return undefined when there is nothing useful to show.
 */

/** Wide-table cap: keep first half + last half of columns by name. Shared with
 *  the TSV/schema previews so displayed columns line up. */
export const MAX_STATS_COLUMNS = 50;

function selectStatEntries(stats: Record<string, string> | undefined): [string, string][] | undefined {
  if (!stats) return undefined;
  const entries = Object.entries(stats).filter(
    ([k, v]) => !RESERVED_STATS_KEYS.has(k) && typeof v === "string" && v.length > 0
  );
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries;
}

export function formatColumnStats(stats: Record<string, string> | undefined): string | undefined {
  const entries = selectStatEntries(stats);
  if (!entries) return undefined;
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
  // Strip the `format=<tag>` field: it's an annotation for the value-format hint
  // line, not part of the distribution stats.
  for (const [col, stat] of shown) lines.push(`- "${col}" ${stat.replace(/,?\s*format=[\w-]+/g, "")}`);
  return lines.join("\n");
}

/** W4 — compact, dataflow-aware stats: numeric keeps null/min/max (drops mean +
 *  top_10); categorical keeps distinct + top_5; others pass through. */
function compactifyStat(s: string): string {
  let out = s.replace(/,?\s*format=[\w-]+/g, "");
  if (out.startsWith("(numeric)")) {
    out = out.replace(/,?\s*mean=[^,]+/g, "").replace(/,?\s*top_10=\{[^}]*\}/g, "");
  }
  return out;
}

export function formatCompactStats(stats: Record<string, string> | undefined): string | undefined {
  const entries = selectStatEntries(stats);
  if (!entries) return undefined;
  const total = entries.length;
  let shown = entries;
  let header = "Column stats (compact):";
  if (total > MAX_STATS_COLUMNS) {
    const leftCount = Math.ceil(MAX_STATS_COLUMNS / 2);
    const rightCount = Math.floor(MAX_STATS_COLUMNS / 2);
    shown = [...entries.slice(0, leftCount), ...entries.slice(-rightCount)];
    header = `Column stats (compact, first ${leftCount} + last ${rightCount} of ${total}):`;
  }
  const lines = [header];
  for (const [col, stat] of shown) lines.push(`- "${col}" ${compactifyStat(stat)}`);
  return lines.join("\n");
}
