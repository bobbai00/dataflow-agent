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
 * Data-L3 (pre-emptive). Render a `Format hints:` line from the per-column
 * `format=<tag>` annotation the backend embeds in `opInfo.columnStats`.
 * Detection lives in the Python worker (it holds the whole column and uses
 * pandas.to_numeric as the judge — see data_processor._detect_numeric_format);
 * this only renders. Returns undefined when no column is tagged.
 */

/** Map each backend format tag to the concrete cleaning to apply BEFORE numeric
 *  conversion. */
const VALUE_FORMAT_HINTS: Record<string, string> = {
  currency: "currency ($, commas) — strip $ and commas before to_numeric; coerce would NULL them",
  thousands: "thousands-separated — strip commas before to_numeric; coerce would silently NULL these rows",
  percent: "percent (%) — strip % before converting; check whether the answer wants a fraction or ×100",
  accounting: "accounting negatives — convert ( ) to a leading minus before numeric",
  "numeric-as-text": "numbers stored as text — strip punctuation before to_numeric; coerce drops non-parseable rows",
};

/** Pull the `format=<tag>` field the backend embeds in a column's stats string. */
function extractFormatTag(stat: string): string | undefined {
  const m = /(?:^|[,\s])format=([\w-]+)/.exec(stat);
  return m ? m[1] : undefined;
}

export function formatValueFormatHints(opInfo: OperatorInfo): string | undefined {
  const stats = opInfo.columnStats ?? {};
  const clauses: string[] = [];
  for (const [col, stat] of Object.entries(stats)) {
    if (typeof stat !== "string") continue;
    const tag = extractFormatTag(stat);
    const hint = tag ? VALUE_FORMAT_HINTS[tag] : undefined;
    if (hint) clauses.push(`"${col}" ${hint}`);
  }
  if (clauses.length === 0) return undefined;
  return `Format hints: ${clauses.join("; ")}`;
}
