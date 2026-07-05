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

/**
 * Wide-table cap for the schema line. A `shape`-detail render of a very wide
 * table (e.g. biomedical clinical = 179 cols) still emits a full column
 * inventory — ~3k chars re-rendered every step (docs/context-param-case-studies
 * Case 3). Cap the enumerated columns; the count still reports the true total,
 * so nothing is silently lost. Matches the TSV/stats renderers' 50-col cap.
 */
const MAX_SCHEMA_COLUMNS = 50;

/**
 * Data-L1 (pre-emptive). A compact `Schema:` line — `name (type), …`. Names +
 * types come from `opInfo.columnStats` (whose display strings begin with a
 * `(<type>)` tag, computed for EVERY column), falling back to result-row headers
 * (names only). For very wide tables the enumeration is capped at
 * `MAX_SCHEMA_COLUMNS` (first half + last half, mirroring the TSV renderer) with
 * a `(showing N of M cols)` header so the total is never hidden. Returns
 * undefined when no columns are known.
 */
export function formatSchemaLine(opInfo: OperatorInfo, includeTypes = true): string | undefined {
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
  const total = cols.length;
  if (total === 0) return undefined;

  const render = (name: string): string => {
    if (!includeTypes) return name;
    const s = stats[name];
    const m = typeof s === "string" ? /^\(([^)]+)\)/.exec(s.trim()) : null;
    return m ? `${name} (${m[1]})` : name;
  };

  // Wide: first ⌈N/2⌉ + last ⌊N/2⌋ columns, joined by `…`, so both ends of the
  // inventory stay visible. Narrow: the full list (byte-identical to before).
  if (total > MAX_SCHEMA_COLUMNS) {
    const left = Math.ceil(MAX_SCHEMA_COLUMNS / 2);
    const right = Math.floor(MAX_SCHEMA_COLUMNS / 2);
    const parts = [...cols.slice(0, left).map(render), "…", ...cols.slice(-right).map(render)];
    return `Schema (showing ${MAX_SCHEMA_COLUMNS} of ${total} cols): ${parts.join(", ")}`;
  }
  return `Schema (${total} cols): ${cols.map(render).join(", ")}`;
}
