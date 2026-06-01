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

/**
 * Flow-L1 (post-hoc, alarm-only). Per-operator cardinality lineage ALARM.
 * Returns a line ONLY for the degenerate row-count transitions that are
 * unambiguous bugs in any tabular pipeline (empty output from non-empty input;
 * fan-out explosion; empty load), and undefined for every normal transition —
 * the SIGNAL is the alarm, not a routine per-op count (which floods LATEST with
 * no payoff). Deliberately silent on shrinkage (filters/aggregations/dedup
 * legitimately drop rows). Derived only from row counts in OperatorInfo —
 * topology-level, no column/task literal, so it generalizes.
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
