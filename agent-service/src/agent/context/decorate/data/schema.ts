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
 * Data-L1 (pre-emptive). A compact, COMPLETE `Schema:` line —
 * `name (type), name (type), …` for every output column. Names + types come
 * from `opInfo.columnStats` (whose display strings begin with a `(<type>)` tag,
 * computed for EVERY column so the list is complete even for wide tables the
 * TSV/stats previews truncate). Falls back to result-row headers (names only)
 * when columnStats is absent. Intentionally NOT column-truncated — its whole
 * value is the full column inventory. Returns undefined when no columns known.
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
