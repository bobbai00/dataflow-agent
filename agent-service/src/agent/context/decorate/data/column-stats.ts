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
export function formatColumnStats(opInfo: OperatorInfo): string | undefined {
  const stats = opInfo.columnStats;
  if (!stats) return undefined;
  const cols = Object.keys(stats).filter(k => !RESERVED_STATS_KEYS.has(k));
  if (cols.length === 0) return undefined;
  const shown = cols.slice(0, MAX_STATS_COLUMNS);
  const lines = shown.map(c => {
    const v = stats[c];
    return typeof v === "string" && v.length > 0 ? `- "${c}" ${v}` : `- "${c}"`;
  });
  if (cols.length > MAX_STATS_COLUMNS) {
    lines.push(`- … (${cols.length - MAX_STATS_COLUMNS} more columns omitted)`);
  }
  return ["Column Schema and stats:", ...lines].join("\n");
}
