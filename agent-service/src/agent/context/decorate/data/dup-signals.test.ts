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

/**
 * Non-passive near-key duplicate signal mined from the gpt-5.2 KramaBench
 * failure analysis (docs/compaction-case-analysis-gpt52.md): legal-hard-15's
 * `distinct=401` on 452 rows was rendered but passive → the agent double-counted
 * cross-state MSAs. `dup_rows=` makes the arithmetic explicit (exact, from the
 * worker's own distinct/null counts — no heuristics); the ⚠ alarm names the
 * dedupe question on near-key columns. Tests reconstruct the REAL failing shape.
 */

import { describe, expect, test } from "bun:test";
import { formatColumnStats } from "./column-stats";
import type { OperatorInfo } from "../../../../types/execution";

function info(partial: Partial<OperatorInfo>): OperatorInfo {
  return { state: "Completed", inputTuples: 0, outputTuples: 0, resultMode: "table", ...partial } as OperatorInfo;
}

describe("near-key duplicate signal (legal-hard-15 shape)", () => {
  const msaClean = info({
    totalRowCount: 452,
    outputTuples: 452,
    columnStats: {
      source_path: "(str): null=0, distinct=52",
      metropolitan_area: "(str): null=0, distinct=401",
      reports: "(numeric): null=0, mean=1200.5, min=8, max=98000",
    },
  });

  test("appends dup_rows and raises the near-key alarm on the real msa_clean shape", () => {
    const block = formatColumnStats(msaClean)!;
    expect(block).toContain('"metropolitan_area" (str): null=0, distinct=401, dup_rows=51');
    expect(block).toContain('⚠ near-key duplicates: "metropolitan_area" — 51 of 452 non-null rows are duplicates');
    expect(block).toContain("dedupe before counting/aggregating");
  });

  test("categoricals (low uniqueness) are untouched — no spam", () => {
    const cat = info({
      totalRowCount: 63160,
      columnStats: { Violation: "(str): null=0, distinct=4, top_5={No=44000, Yes=2000}" },
    });
    const block = formatColumnStats(cat)!;
    expect(block).toContain('"Violation" (str): null=0, distinct=4, top_5={No=44000, Yes=2000}');
    expect(block).not.toContain("dup_rows");
    expect(block).not.toContain("near-key");
  });

  test("display-format columns get dup_rows but NOT the alarm", () => {
    const fmt = info({
      totalRowCount: 1000,
      columnStats: { price_display: "(str): null=0, distinct=890, format=currency" },
    });
    const block = formatColumnStats(fmt)!;
    expect(block).toContain("dup_rows=110");
    expect(block).not.toContain("near-key");
  });

  test("fully-unique columns are untouched", () => {
    const uniq = info({ totalRowCount: 100, columnStats: { id: "(str): null=0, distinct=100" } });
    const block = formatColumnStats(uniq)!;
    expect(block).not.toContain("dup_rows");
  });
});
