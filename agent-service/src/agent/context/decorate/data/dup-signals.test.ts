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
 * The two non-passive duplicate signals mined from the gpt-5.2 KramaBench
 * failure analysis (docs/compaction-case-analysis-gpt52.md):
 *  - near-key duplicates in the stats block (legal-hard-15: distinct=401 on 452
 *    rows was rendered but passive → the agent double-counted cross-state MSAs),
 *  - embedded duplicate header names on dirty loads (environment-hard-11: the
 *    agent's `columns.duplicated()` dedup silently dropped 2 of 3 Enterococcus
 *    columns).
 * Each test reconstructs the REAL failing shape.
 */

import { describe, expect, test } from "bun:test";
import { formatColumnStats } from "./column-stats";
import { formatEmbeddedDupHeader } from "../../summarize/sample-profile";
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

describe("embedded duplicate header signal (environment-hard-11 shape)", () => {
  // The real pbci raw load: generic Unnamed headers; row 0 = super-header
  // (locations), row 1 = the real header with Tag/Enterococcus repeated ×3.
  const H = ["Pleasure Bay Beach, South Boston: Bacterial Water Quality",
             "Unnamed: 1","Unnamed: 2","Unnamed: 3","Unnamed: 4","Unnamed: 5","Unnamed: 6","Unnamed: 7","Unnamed: 8","Unnamed: 9"];
  const row = (vals: (string | number | null)[]) => Object.fromEntries(H.map((h, i) => [h, vals[i]]));
  const rows = [
    row([null, null, null, null, "Pleasure Bay @ Broadway", null, "Pleasure Bay @ Flagpole", null, "Castle Island Playground", null]),
    row(["Date", "1-Day Rain", "2-Day Rain", "3-Day Rain", "Tag", "Enterococcus", "Tag", "Enterococcus", "Tag", "Enterococcus"]),
    row(["August 27, 2024", "0.00", "0", "0", null, "30", null, "10", null, "20"]),
    row(["August 20, 2024", "0.01", "0.12", "0.15", null, "10", null, "10", null, "60"]),
  ];

  test("fires on the real pbci shape and names the repeated columns + the trap", () => {
    const line = formatEmbeddedDupHeader(rows)!;
    expect(line).toContain("Embedded header ⚠: row 1");
    expect(line).toContain("`Tag` ×3");
    expect(line).toContain("`Enterococcus` ×3");
    expect(line).toContain("dropping duplicate-named columns silently discards distinct data");
  });

  test("silent on clean loads (real headers, no embedded header row)", () => {
    const clean = [
      { Date: "2024-01-01", Rain: 0.1, Enterococcus: 10 },
      { Date: "2024-01-02", Rain: 0.0, Enterococcus: 20 },
      { Date: "2024-01-03", Rain: 0.2, Enterococcus: 30 },
    ];
    expect(formatEmbeddedDupHeader(clean)).toBeUndefined();
  });

  test("silent on dirty loads whose header row has NO duplicate names", () => {
    const H2 = ["Unnamed: 0", "Unnamed: 1", "Unnamed: 2", "Unnamed: 3"];
    const r = (vals: (string | null)[]) => Object.fromEntries(H2.map((h, i) => [h, vals[i]]));
    const noDup = [
      r(["Date", "Rain", "Tag", "Enterococcus"]),
      r(["2024-01-01", "0.1", "<", "10"]),
      r(["2024-01-02", "0.0", "<", "20"]),
    ];
    expect(formatEmbeddedDupHeader(noDup)).toBeUndefined();
  });
});
