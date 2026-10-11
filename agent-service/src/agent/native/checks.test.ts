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
import { constantColumnLines, nativeAdjustmentLines, nativeCheckLines, scanNoteLines } from "./checks";

const op = (type: string, properties: Record<string, unknown> = {}): OperatorPredicate =>
  ({ operatorID: "x", operatorType: "DataProcessing", nativeOp: { type, properties, inputs: [] } }) as any;
const info = (operations: Record<string, unknown>, totalRowCount = 10): OperatorInfo =>
  ({ state: "Completed", totalRowCount, tableProfile: { native: { operations } } }) as any;

describe("nativeCheckLines", () => {
  test("a header that reads as data is a scan note shown in every setting, not a check", () => {
    const operations = {
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
    };
    expect(nativeCheckLines(op("Scan"), info(operations))).toEqual([]);
    expect(scanNoteLines({ properties: {} }, operations)).toEqual([
      'note: the header of `2024_CSN_Report_Categories.csv` reads as data ("1", "1,353,175", "20.91%"); skip_lines=2 gives the header "Rank", "Category", " # of Reports ", "Percentage".',
    ]);
  });

  test("records repeated across sources are named at the aggregate", () => {
    const [line] = nativeCheckLines(
      op("Aggregate"),
      info({
        repeatedRecords: {
          rows: 49,
          of: 90,
          records: 21,
          sources: 17,
          ignoring: ["source"],
          example: "Philadelphia, 28438",
        },
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

  test("registered event locations disambiguate definition cells", () => {
    expect(
      nativeCheckLines(
        op("Process"),
        info({
          process: {
            events: [{ cell: 2, line: 4, op: "filter", in: [8], out: 0, issue: "empty" }],
          },
        })
      )
    ).toEqual(["inside the function, definition cell 2, line 4: a row selection kept 0 of 8 rows."]);
  });
});

describe("scanNoteLines", () => {
  test("a header cell shaped like its column's values suggests a headerless read", () => {
    // biomedical-hard-7: the first gene became the column name and 15 of 16 rows remained.
    const operations = {
      scan: {
        selectedFiles: 1,
        sources: [
          {
            path: "/data/mmc3.xlsx",
            headerCheck: { header: ["BRD8"], valueLike: ["BRD8"], suggest: { header: false } },
          },
        ],
      },
    };
    expect(scanNoteLines({ properties: { sheet: "D-SE-acetyl" } }, operations)).toEqual([
      'note: header "BRD8" of `mmc3.xlsx` looks like a value of its column; a file without a header row needs header=False with names.',
    ]);
  });

  test("lines skipped before the header are shown, so a missing-value code stays visible", () => {
    const operations = {
      scan: {
        selectedFiles: 1,
        sources: [
          {
            path: "/data/wildfire/noaa_wildfires_monthly_stats.csv",
            autoSkipLines: 3,
            preamble: ["Title:U.S. Wildfires December", "Missing:-999"],
          },
        ],
      },
    };
    expect(scanNoteLines({ properties: {} }, operations)).toEqual([
      'note: `noaa_wildfires_monthly_stats.csv` has 3 lines before its header, skipped: "Title:U.S. Wildfires December"; "Missing:-999".',
    ]);
  });

  test("renamed duplicate headers, widened columns and concatenated files", () => {
    const operations = {
      scan: {
        selectedFiles: 52,
        widened: { "Indicator Level": ["float64", "int64"] },
        sources: [{ path: "/data/a.csv", renamedHeaders: [["Total.1", "Total"]] }],
      },
    };
    expect(scanNoteLines({ properties: {} }, operations)).toEqual([
      'note: duplicate header names of `a.csv` renamed: "Total" → "Total.1".',
      'note: column "Indicator Level" is integer in some files and decimal in others; read as decimal (float64).',
      "note: 52 files are concatenated into this table, and its rows do not record their source file; file_column='file' adds it.",
    ]);
    // A recorded source file or a preview needs no concatenation note.
    expect(scanNoteLines({ properties: { fileColumn: "file" } }, operations)).toHaveLength(2);
    expect(scanNoteLines({ properties: {} }, { scan: { ...operations.scan, preview: true } })).toHaveLength(2);
    expect(
      scanNoteLines({ properties: {} }, { scan: { preview: true, selectedFiles: 5, omittedFiles: 25, sources: [] } })
    ).toEqual(["note: the preview reads 5 of 30 files."]);
  });
});

describe("nativeAdjustmentLines", () => {
  test("Python outputs normalized instead of rejected, and widened union columns", () => {
    expect(nativeAdjustmentLines(op("Process"), info({ normalized: { utc: ["date"], text: ["c3", "c4"] } }))).toEqual([
      'note: datetime column "date" had no timezone; read as UTC.',
      'note: columns "c3", "c4" mixed numbers and text; kept as text.',
    ]);
    expect(nativeAdjustmentLines(op("Union"), info({ widened: { value: ["float64", "int64"] } }))).toEqual([
      'note: column "value" is integer in some inputs and decimal in others; read as decimal (float64).',
    ]);
  });
});

describe("constantColumnLines", () => {
  /** A registered step's result whose whole-table profile has the given added columns. */
  const step = (type = "Process", registered = true) =>
    ({
      operatorID: "gaps",
      operatorType: "DataProcessing",
      nativeOp: { type, properties: registered ? { registered: { entry: "gaps" } } : {}, inputs: ["teams"] },
    }) as any as OperatorPredicate;
  const column = (rows: number, nulls: number, distinct: number | null, min: unknown = null) => ({
    type: "integer",
    rowsProcessed: rows,
    nullCount: nulls,
    nonnullCount: rows - nulls,
    distinctCount: distinct,
    min,
  });
  const result = (columns: Record<string, unknown>, rows = 12, complete = true): OperatorInfo =>
    ({
      state: "Completed",
      totalRowCount: rows,
      resultSchema: ["team", ...Object.keys(columns)].map(name => ({ name, type: "int64", encoding: "" })),
      tableProfile: {
        status: "available",
        coverage: { scope: "full", complete, rowsProcessed: rows },
        rowCount: rows,
        columns: { team: column(rows, 0, rows), ...columns },
      },
    }) as any;
  const teams = { state: "Completed", resultSchema: [{ name: "team", type: "string", encoding: "" }] } as any;

  test("a column the step added with one value, or none, in every row", () => {
    // An NFL session ranked "largest gaps" that were all 0 and never noticed.
    expect(constantColumnLines(step(), result({ gap: column(12, 0, 1, 0), note: column(12, 12, 0) }), [teams])).toEqual(
      ['note: column "gap" has the same value, 0, in all 12 rows; column "note" is null in all 12 rows.']
    );
  });

  test("varied, inherited or partly profiled columns, filters, built-ins and one-row results say nothing", () => {
    expect(constantColumnLines(step(), result({ gap: column(12, 0, 5, -3) }), [teams])).toEqual([]);
    const constantTeam = result({ team: column(12, 0, 1, "Bills") });
    expect(constantColumnLines(step(), constantTeam, [teams])).toEqual([]);
    expect(constantColumnLines(step(), result({ gap: column(12, 0, 1, 0) }, 12, false), [teams])).toEqual([]);
    expect(constantColumnLines(step("Filter"), result({ gap: column(12, 0, 1, 0) }), [teams])).toEqual([]);
    expect(constantColumnLines(step("Aggregate", false), result({ gap: column(12, 0, 1, 0) }), [teams])).toEqual([]);
    expect(constantColumnLines(step(), result({ gap: column(1, 0, 1, 0) }, 1), [teams])).toEqual([]);
  });

  test("more than three such columns are counted", () => {
    const columns = Object.fromEntries(["a", "b", "c", "d", "e"].map(name => [name, column(4, 4, 0)]));
    expect(constantColumnLines(step(), result(columns, 4), [teams])).toEqual([
      'note: column "a" is null in all 4 rows; column "b" is null in all 4 rows; column "c" is null in all 4 rows; and 2 more such columns.',
    ]);
  });
});
