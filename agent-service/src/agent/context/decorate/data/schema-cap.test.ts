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

import { describe, expect, test } from "bun:test";
import { formatSchemaLine } from "./schema";
import type { OperatorInfo } from "../../../../types/execution";

function infoWithCols(n: number): OperatorInfo {
  const row: Record<string, any> = { __row_index__: 0 };
  for (let i = 0; i < n; i++) row[`c${i}`] = i;
  return { state: "Completed", inputTuples: 0, outputTuples: 1, resultMode: "table", result: [row] } as OperatorInfo;
}

describe("formatSchemaLine — wide-table cap (Phase 1)", () => {
  test("narrow tables are unchanged (byte-identical to pre-cap)", () => {
    expect(formatSchemaLine(infoWithCols(4), false)).toBe("Schema (4 cols): c0, c1, c2, c3");
  });

  test("exactly 50 cols is not capped", () => {
    const line = formatSchemaLine(infoWithCols(50), false)!;
    expect(line.startsWith("Schema (50 cols):")).toBe(true);
    expect(line).not.toContain("showing");
  });

  test("179 cols → capped to 50 with a truthful total + both ends shown", () => {
    const line = formatSchemaLine(infoWithCols(179), false)!;
    expect(line.startsWith("Schema (showing 50 of 179 cols):")).toBe(true);
    expect(line).toContain("c0"); // first end
    expect(line).toContain("c178"); // last end
    expect(line).toContain("…"); // elision marker
    expect(line).not.toContain("c60"); // a middle column is dropped
    // and it's actually much shorter than the full enumeration would be
    expect(line.length).toBeLessThan(600);
  });
});
