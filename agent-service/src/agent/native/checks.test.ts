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
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import { nativeCheckLines } from "./checks";

const op = (type: string, properties: Record<string, unknown> = {}): OperatorPredicate =>
  ({ operatorID: "x", operatorType: "DataProcessing", nativeOp: { type, properties, inputs: [] } }) as any;
const info = (operations: Record<string, unknown>, totalRowCount = 10): OperatorInfo =>
  ({ state: "Completed", totalRowCount, tableProfile: { native: { operations } } }) as any;

describe("nativeCheckLines", () => {
  test("a header that reads as data names the header row the engine found", () => {
    const lines = nativeCheckLines(
      op("Scan"),
      info({
        scan: {
          sources: [
            {
              path: "/data/legal/2024_CSN_Report_Categories.csv",
              headerCheck: {
                dataLike: ["1", "1,353,175", "20.91%"],
                suggest: { skipLines: 2, header: ["Rank", "Category", " # of Reports ", "Percentage"] },
              },
            },
          ],
        },
      })
    );
    expect(lines).toEqual([
      'the header of `2024_CSN_Report_Categories.csv` reads as data ("1", "1,353,175", "20.91%"); skip_lines=2 gives the header "Rank", "Category", " # of Reports ", "Percentage".',
    ]);
  });

  test("records repeated across sources are named at the aggregate", () => {
    const [line] = nativeCheckLines(
      op("Aggregate"),
      info({
        repeatedRecords: { rows: 49, of: 90, records: 21, sources: 17, ignoring: ["source"], example: "Philadelphia, 28438" },
      })
    );
    expect(line).toBe(
      '49 of 90 input rows are 21 records each listed once by 17 different sources apart from "source", e.g. "Philadelphia, 28438"; the aggregate counts every copy.'
    );
  });

  test("joins have no check: dropping or repeating rows may be intended", () => {
    const join = { join: { left: { rows: 100, unmatchedRows: 30 }, right: { maxMultiplicity: 3 } } };
    expect(nativeCheckLines(op("Join"), info(join, 150))).toEqual([]);
  });

  test("steps inside a process function", () => {
    const lines = nativeCheckLines(
      op("Process"),
      info({
        process: {
          reads: [{ line: 3, file: "a.csv", rows: 2 }],
          events: [
            { line: 6, op: "filter", in: [15602], out: 0, issue: "empty" },
            { line: 8, op: "merge", how: "left", in: [153, 95], out: 0, issue: "empty" },
          ],
        },
      })
    );
    expect(lines).toEqual([
      "inside the function, line 6: a row selection kept 0 of 15602 rows.",
      "inside the function, line 8: a merge of 153 and 95 rows returned 0 rows.",
    ]);
  });

  test("no violation, no line", () => {
    expect(nativeCheckLines(op("Filter"), info({ keptRows: 3 }))).toEqual([]);
    expect(nativeCheckLines(op("Scan"), info({ scan: { sources: [{ path: "/a.csv" }] } }))).toEqual([]);
  });
});
