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
import { TABLE_HINTS_KEY, FILE_IO_KEY } from "./reserved-keys";

/**
 * Data-L2 (#25/#26/#27, pre-emptive) — THE accuracy win of the campaign.
 * Render an `Output Table profile:` block from the reserved `__table_hints__` entry the
 * worker publishes on `columnStats`: table grain/key, low-cardinality
 * partition/gate columns, dirty-load (empty rows/cols + duplicates), computed
 * name-agnostically over the WHOLE DataFrame (see data_processor.
 * _detect_table_structure). Worker joins hints with " || "; we split them into
 * one indented line each under a header. Render-only. Returns undefined when no
 * hint was published.
 */
export function formatTableHints(opInfo: OperatorInfo): string | undefined {
  const parts: string[] = [];
  // A7 first: what the operator READ precedes what the result looks like. An
  // agent that wrote glob.glob(...) otherwise never learns what it matched —
  // the rendered result shows only the concatenated table. Fact only; the
  // reserved key never renders as a column (see reserved-keys.ts).
  const fio = opInfo.columnStats?.[FILE_IO_KEY];
  if (typeof fio === "string" && fio.length > 0) {
    parts.push(...fio.split(" || ").map(p => p.trim()).filter(Boolean));
  }
  const v = opInfo.columnStats?.[TABLE_HINTS_KEY];
  if (typeof v === "string" && v.length > 0) {
    parts.push(...v.split(" || ").map(p => p.trim()).filter(Boolean));
  }
  if (parts.length === 0) return undefined;
  return ["Output Table profile:", ...parts.map(p => `- ${p}`)].join("\n");
}
