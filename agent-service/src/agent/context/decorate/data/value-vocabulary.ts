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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { OperatorInfo } from "../../../../types/execution";
import { RESERVED_STATS_KEYS } from "./reserved-keys";

/**
 * VALUE VOCABULARY — the catalog's answer to "how does the data spell this?".
 *
 * A later turn's code fails silently when a literal it MATCHES against data
 * misspells the value: a mapping dict keyed `"$1,000-1,999"` against data that
 * writes `"1,000-1,999"` maps every row to NaN, and the numbers downstream look
 * ordinary. The cure is the categorical vocabulary of each column, verbatim.
 *
 * That is a strict subset of the worker's stats block, and the difference is
 * not small: rendering the WHOLE block in every catalog entry was measured at
 * 33% of a 342 kB turn-35 context on wids1 (1,115 column lines), of which the
 * string vocabularies were 4%. The other 29% was numeric mean/min/max and
 * unique-value histograms — distributional facts, which say nothing about how a
 * value is spelled and which an operator or a query can compute on demand.
 * Cost is not the only argument: that arm also lost accuracy on the task where
 * its context grew most, and spent more steps per turn.
 *
 * So this renders exactly the identity-bearing lines — a `(str)` column with a
 * `top_N={…}` histogram, i.e. a low-cardinality categorical whose values the
 * worker enumerated over the FULL table — and nothing else. Columns are named
 * on the entry's `Result: … Schema:` line already, so a column with no
 * vocabulary loses nothing by being absent here.
 */
const VOCAB = /top_\d+\s*=\s*\{/;

export function formatValueVocabulary(opInfo: OperatorInfo): string | undefined {
  const stats = opInfo.columnStats;
  if (!stats) return undefined;
  const lines: string[] = [];
  for (const col of Object.keys(stats)) {
    if (RESERVED_STATS_KEYS.has(col)) continue;
    const display = stats[col];
    if (typeof display !== "string" || display.length === 0) continue;
    if (!/^\(str\)/.test(display.trim())) continue;
    if (!VOCAB.test(display)) continue;
    lines.push(`- "${col}" ${display}`);
  }
  if (lines.length === 0) return undefined;
  return ["Value vocabulary (full-table, verbatim spellings):", ...lines].join("\n");
}
