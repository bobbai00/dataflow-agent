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

import { describe, expect, test } from "bun:test";
import { formatTableHints } from "./structural-profile";
import { formatColumnStats } from "./column-stats";
import { RESERVED_STATS_KEYS, FILE_IO_KEY } from "./reserved-keys";
import type { OperatorInfo } from "../../../../types/execution";

const info = (columnStats: Record<string, string>): OperatorInfo =>
  ({ columnStats, totalRowCount: 100, outputTuples: 100 } as unknown as OperatorInfo);

describe("A7 __file_io__ — multi-file load provenance", () => {
  test("renders the file list on the structural rung", () => {
    const out = formatTableHints(info({ __file_io__: "files read: 53 [ALABAMA.csv, ALASKA.csv, … (+51)]" }));
    expect(out).toContain("Output Table profile:");
    expect(out).toContain("- files read: 53 [ALABAMA.csv, ALASKA.csv, … (+51)]");
  });

  test("the file fact precedes the table facts (read before result)", () => {
    const out = formatTableHints(info({
      __file_io__: "files read: 3 [a.csv, b.csv, c.csv]",
      __table_hints__: "duplicate rows: 359 of 764 (47%) || empty rows: 156 of 764 rows are entirely null",
    }))!;
    expect(out.indexOf("files read")).toBeLessThan(out.indexOf("duplicate rows"));
    expect(out.split("\n")).toHaveLength(4); // header + 1 file fact + 2 table facts
  });

  test("is NEVER rendered as a column — the key is reserved", () => {
    expect(RESERVED_STATS_KEYS.has(FILE_IO_KEY)).toBe(true);
    const block = formatColumnStats(info({
      region: "(str): null=0, distinct=4",
      __file_io__: "files read: 3 [a.csv, b.csv, c.csv]",
    }));
    expect(block).toContain('- "region"');
    expect(block).not.toContain("__file_io__");
    expect(block).not.toContain("files read");
  });

  test("absent key leaves the render byte-identical to before A7", () => {
    const withTable = formatTableHints(info({ __table_hints__: "duplicate rows: 2 of 10 (20%)" }));
    expect(withTable).toBe("Output Table profile:\n- duplicate rows: 2 of 10 (20%)");
    expect(formatTableHints(info({ region: "(str): null=0" }))).toBeUndefined();
  });
});
