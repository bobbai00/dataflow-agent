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
import { formatOperatorResult, formatSchemaLine } from "./result-formatting";
import { WorkflowState } from "../workflow-state";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, OperatorLink, PortDescription } from "../../types/workflow";

function makeOpInfo(overrides: Partial<OperatorInfo> = {}): OperatorInfo {
  return {
    state: "completed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
    ...overrides,
  };
}

function makeOperator(id: string, inputPortIDs: string[] = []): OperatorPredicate {
  const inputPorts: PortDescription[] = inputPortIDs.map((portID, i) => ({
    portID,
    displayName: `Input ${i}`,
  }));
  return {
    operatorID: id,
    operatorType: "TestOp",
    operatorVersion: "1.0",
    operatorProperties: {},
    inputPorts,
    outputPorts: [{ portID: "output-0", displayName: "Output 0" }],
    showAdvanced: false,
  };
}

function makeLink(linkID: string, source: [string, string], target: [string, string]): OperatorLink {
  return {
    linkID,
    source: { operatorID: source[0], portID: source[1] },
    target: { operatorID: target[0], portID: target[1] },
  };
}

const EMPTY_STATE = new WorkflowState();

describe("formatOperatorResult - early returns", () => {
  test("returns [ERROR] prefix when error field is set", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ error: "boom" }), EMPTY_STATE);
    expect(out).toBe("[ERROR] boom");
  });

  test("treats empty-string error as falsy and continues to result path", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ error: "" }), EMPTY_STATE);
    expect(out).not.toContain("[ERROR]");
    expect(out).toContain("(no result data)");
  });

  test("returns (no result data) when result is undefined", () => {
    const out = formatOperatorResult("op1", makeOpInfo(), EMPTY_STATE);
    expect(out).toBe("(no result data)");
  });

  test("returns (no result data) when result is not an array", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ result: { rows: [] } as unknown as Record<string, any>[] }),
      EMPTY_STATE
    );
    expect(out).toBe("(no result data)");
  });

  test("empty array result emits the zero-column shape only", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ result: [], outputTuples: 0 }), EMPTY_STATE);
    expect(out.split("\n")).toEqual(["Output Table: 0 rows, 0 cols"]);
  });
});

describe("formatOperatorResult - table shape and metadata", () => {
  test("uses outputTuples for row count when totalRowCount missing", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 7, result: [{ a: 1, b: 2 }] }), EMPTY_STATE);
    expect(out).toContain("Output Table: 7 rows, 2 cols");
  });

  test("totalRowCount overrides outputTuples in output shape", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 7, totalRowCount: 999, result: [{ a: 1, b: 2 }] }),
      EMPTY_STATE
    );
    expect(out).toContain("Output Table: 999 rows, 2 cols");
  });

  test("filters internal __is_visualization__ key from outer column count", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ __is_visualization__: true, "html-content": "<x/>" }],
      }),
      EMPTY_STATE
    );
    // 1 visible column ("html-content") since __is_visualization__ is filtered.
    expect(out).toContain("Output Table: 1 rows, 1 cols");
  });

  test("appends warnings after metadata lines", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ a: 1 }],
        warnings: ["truncated to 1 row", "something else"],
      }),
      EMPTY_STATE
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Output Table: 1 rows, 1 cols");
    expect(lines[1]).toBe("truncated to 1 row");
    expect(lines[2]).toBe("something else");
  });
});

describe("formatOperatorResult - small complete table stats", () => {
  const stats = { value: "(numeric): null=0, mean=2.5, min=1, max=4" };
  const rows = [1, 2, 3, 4].map((value, index) => ({ __row_index__: index, value }));

  test("suppresses stats when all rows of a table smaller than five are visible", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 4, totalRowCount: 4, result: rows, truncated: false, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("3\t4");
    expect(out).not.toContain("Column Schema and stats:");
  });

  test("suppression is by PROOF, not table size — a fully visible 5-row table drops stats", () => {
    // Was asserted the other way while a `totalRows < 5` bound gated the
    // suppression. Size is not the question: with nothing truncated at the
    // backend, renderer, column or cell level, every value is on screen and the
    // stats block is arithmetic over data the agent can already read.
    const fiveRows = [...rows, { __row_index__: 4, value: 5 }];
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 5, totalRowCount: 5, result: fiveRows, truncated: false, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).not.toContain("Column Schema and stats:");
    expect(out).toContain("value"); // the data itself is untouched
  });

  test("a table too large to fully render KEEPS stats (the load-bearing case)", () => {
    // 40 rows held but the renderer shows 5 ⇒ completeness unproven ⇒ stats stay.
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 40,
        totalRowCount: 40,
        result: Array.from({ length: 40 }, (_, i) => ({ __row_index__: i, value: i })),
        truncated: false,
        columnStats: stats,
      }),
      EMPTY_STATE,
      { columnStats: true, maxResultRows: 5 }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when the backend result is truncated", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 4, totalRowCount: 4, result: rows.slice(0, 2), truncated: true, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when the backend does not prove the result is complete", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 4, totalRowCount: 4, result: rows, truncated: undefined, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when the renderer samples away rows", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 4, totalRowCount: 4, result: rows, truncated: false, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true, maxResultRows: 2 }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats for non-table result modes", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 4,
        totalRowCount: 4,
        resultMode: "scalar",
        result: rows,
        truncated: false,
        columnStats: stats,
      }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when held rows disagree with the reported total", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 3, totalRowCount: 3, result: rows, truncated: false, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when a visible cell was truncated independently", () => {
    const truncatedRows = [{ __row_index__: 0, value: { nested: "prefix...[truncated]...suffix" } }, ...rows.slice(1)];
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 4,
        totalRowCount: 4,
        result: truncatedRows,
        truncated: false,
        columnStats: stats,
      }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when visualization payload cells are hidden", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        totalRowCount: 1,
        result: [
          {
            __row_index__: 0,
            __is_visualization__: true,
            "html-content": "<div>hidden</div>",
            label: "chart",
          },
        ],
        truncated: false,
        columnStats: { label: "(string): null=0, distinct=1" },
      }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("<skipped: visualization content>");
    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when shape-only detail hides every row", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 4, totalRowCount: 4, result: rows, truncated: false, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true, detail: "shape" }
    );

    expect(out).not.toContain("3\t4");
    expect(out).toContain("Column Schema and stats:");
  });

  test("keeps stats when wide-table rendering hides columns", () => {
    const wideRow: Record<string, number> = { __row_index__: 0 };
    for (let index = 0; index < 51; index++) wideRow[`column_${index}`] = index;

    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        totalRowCount: 1,
        result: [wideRow],
        truncated: false,
        columnStats: stats,
      }),
      EMPTY_STATE,
      { columnStats: true }
    );

    expect(out).toContain("showing first 25 and last 25 of 51 columns");
    expect(out).toContain("Column Schema and stats:");
  });

  test("suppresses stats for a complete empty table while retaining its typed schema", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 0, totalRowCount: 0, result: [], truncated: false, columnStats: stats }),
      EMPTY_STATE,
      { columnStats: true, schemaInResult: true }
    );

    expect(out).toContain("Output Table: 0 rows, 0 cols");
    expect(out).toContain("Schema (1 cols): value (numeric)");
    expect(out).not.toContain("Column Schema and stats:");
  });
});

describe("formatOperatorResult - wide-table column cap", () => {
  // Build a single row with N columns; values are the column names so we
  // can assert exactly which ones are kept vs dropped.
  const makeWideRow = (n: number): Record<string, any> => {
    const r: Record<string, any> = {};
    for (let i = 0; i < n; i++) r[`col_${i.toString().padStart(3, "0")}`] = `c${i}`;
    return r;
  };

  test("does not truncate at 50 columns or fewer (the threshold itself is the boundary)", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 1, result: [makeWideRow(50)] }), EMPTY_STATE);
    expect(out).toContain("Output Table: 1 rows, 50 cols");
    expect(out).not.toContain("showing first");
    // every column header is present
    for (let i = 0; i < 50; i++) expect(out).toContain(`col_${i.toString().padStart(3, "0")}`);
  });

  test("with >50 columns: keeps first 25 + last 25, drops middle, surfaces truncation notice", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 1, result: [makeWideRow(200)] }), EMPTY_STATE);
    // The shape line reports the TRUE total — not the rendered subset.
    expect(out).toContain("Output Table: 1 rows, 200 cols");
    // The truncation banner appears as its own metadata line.
    expect(out).toContain("(showing first 25 and last 25 of 200 columns)");
    // First 25 kept (col_000 .. col_024)
    expect(out).toContain("col_000");
    expect(out).toContain("col_024");
    // Middle dropped (col_025 .. col_174)
    expect(out).not.toContain("col_025");
    expect(out).not.toContain("col_100");
    expect(out).not.toContain("col_174");
    // Last 25 kept (col_175 .. col_199)
    expect(out).toContain("col_175");
    expect(out).toContain("col_199");
    // The data row also has the `...` separator between left and right halves.
    const dataLine = out.split("\n").find(l => l.startsWith("0\t"));
    expect(dataLine).toBeDefined();
    expect(dataLine!.split("\t")).toContain("...");
  });
});

describe("formatOperatorResult - input port metadata", () => {
  test("omits input metadata when inputPortShapes is missing", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 1, result: [{ a: 1 }] }), EMPTY_STATE);
    expect(out).not.toContain("Input operator");
  });

  test("omits input metadata when inputPortShapes is empty", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 1, result: [{ a: 1 }], inputPortShapes: [] }),
      EMPTY_STATE
    );
    expect(out).not.toContain("Input operator");
  });

  test("falls back to inputN placeholder when no upstream link matches the port", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ a: 1 }],
        inputPortShapes: [{ portIndex: 0, rows: 5, columns: 3 }],
      }),
      EMPTY_STATE
    );
    expect(out).toContain("Inputs: input0 (5 rows, 3 cols)");
  });

  test("uses upstream operator id when an input link matches the port", () => {
    const state = new WorkflowState();
    state.addOperator(makeOperator("upstream"));
    state.addOperator(makeOperator("op1", ["input-0"]));
    state.addLink(makeLink("l1", ["upstream", "output-0"], ["op1", "input-0"]));

    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 4,
        result: [{ a: 1, b: 2 }],
        inputPortShapes: [{ portIndex: 0, rows: 10, columns: 2 }],
      }),
      state
    );
    expect(out).toContain("Inputs: upstream (10 rows, 2 cols)");
  });

  test("sorts multiple input ports by portIndex regardless of input order", () => {
    const state = new WorkflowState();
    state.addOperator(makeOperator("up0"));
    state.addOperator(makeOperator("up1"));
    state.addOperator(makeOperator("op1", ["input-0", "input-1"]));
    state.addLink(makeLink("l0", ["up0", "output-0"], ["op1", "input-0"]));
    state.addLink(makeLink("l1", ["up1", "output-0"], ["op1", "input-1"]));

    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ a: 1 }],
        inputPortShapes: [
          { portIndex: 1, rows: 2, columns: 2 },
          { portIndex: 0, rows: 1, columns: 1 },
        ],
      }),
      state
    );
    expect(out).toContain("Inputs: up0 (1 rows, 1 cols), up1 (2 rows, 2 cols)");
  });
});

describe("formatOperatorResult - visualization rows", () => {
  test("strips html-content and json-content payloads when row is flagged as visualization", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [
          {
            __is_visualization__: true,
            "html-content": "<div>hidden</div>",
            "json-content": '{"big":1}',
            label: "chart",
          },
        ],
      }),
      EMPTY_STATE
    );
    expect(out).toContain("<skipped: visualization content>");
    expect(out).not.toContain("<div>hidden</div>");
    expect(out).not.toContain('{"big":1}');
    expect(out).toContain("chart");
  });

  test("__is_visualization__ false leaves the visualization-only fields untouched", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ __is_visualization__: false, "html-content": "<keep/>" }],
      }),
      EMPTY_STATE
    );
    expect(out).toContain("<keep/>");
    expect(out).not.toContain("<skipped: visualization content>");
  });

  test("__is_visualization__ column is excluded from rendered table body and shape agrees", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ __is_visualization__: false, value: 1 }],
      }),
      EMPTY_STATE
    );
    const lines = out.split("\n");
    expect(out).toContain("Output Table: 1 rows, 1 cols");
    // Header line is the second line (after the shape line).
    expect(lines[1]).toBe("\tvalue");
    expect(lines[2]).toBe("0\t1");
    expect(out).not.toContain("__is_visualization__");
  });
});

describe("jsonToTableFormat - cell coercion via formatOperatorResult", () => {
  function tableLines(opInfo: Partial<OperatorInfo>): string[] {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 1, ...opInfo }), EMPTY_STATE);
    // Skip the shape line (the table header + rows follow it).
    return out.split("\n").slice(1);
  }

  test("null is rendered as NaN, undefined as empty cell", () => {
    const [header, row] = tableLines({ result: [{ a: null, b: undefined }] });
    expect(header).toBe("\ta\tb");
    expect(row).toBe("0\tNaN\t");
  });

  test('string "NULL" sentinel is normalized to NaN', () => {
    const [, row] = tableLines({ result: [{ x: "NULL" }] });
    expect(row).toBe("0\tNaN");
  });

  test("number and boolean cells are stringified directly", () => {
    const [, row] = tableLines({ result: [{ n: 3.5, b: true, f: false }] });
    expect(row).toBe("0\t3.5\ttrue\tfalse");
  });

  test("tabs and newlines inside string cells are escape-encoded", () => {
    const [, row] = tableLines({ result: [{ s: "a\tb\nc" }] });
    expect(row).toBe("0\ta\\tb\\nc");
  });

  test("object and array cells are JSON-stringified", () => {
    const [, row] = tableLines({ result: [{ obj: { k: 1 }, arr: [1, 2] }] });
    expect(row).toBe('0\t{"k":1}\t[1,2]');
  });
});

describe("jsonToTableFormat - row index gaps", () => {
  test("inserts ... separator when __row_index__ skips ahead", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 2,
        result: [
          { __row_index__: 0, v: "a" },
          { __row_index__: 5, v: "b" },
        ],
      }),
      EMPTY_STATE
    );
    const lines = out.split("\n");
    // header, row0, gap marker, row5
    expect(lines[lines.length - 4]).toBe("\tv");
    expect(lines[lines.length - 3]).toBe("0\ta");
    expect(lines[lines.length - 2]).toBe("...\t...");
    expect(lines[lines.length - 1]).toBe("5\tb");
  });

  test("no separator is emitted between consecutive __row_index__ values", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 2,
        result: [
          { __row_index__: 0, v: "a" },
          { __row_index__: 1, v: "b" },
        ],
      }),
      EMPTY_STATE
    );
    expect(out).not.toContain("...\t...");
  });

  test("non-zero starting __row_index__ does not emit a leading gap marker", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 1, result: [{ __row_index__: 9, v: "z" }] }),
      EMPTY_STATE
    );
    expect(out).not.toContain("...\t...");
    expect(out.endsWith("9\tz")).toBe(true);
  });
});

describe("formatSchemaLine — compact typed schema (lever E)", () => {
  test("builds 'name (type)' for every column from columnStats type tags", () => {
    const info = makeOpInfo({
      result: [{ __row_index__: 0, id: 1, name: "x", amount: 5.0 }],
      columnStats: {
        id: "(numeric): null=0, mean=1, min=1, max=1",
        name: "(str): null=0, distinct=1",
        amount: "(numeric): null=0, mean=5, min=5, max=5",
      },
    });
    const line = formatSchemaLine(info);
    expect(line).toBe("Schema (3 cols): id (numeric), name (str), amount (numeric)");
  });

  test("caps very wide tables at 50 cols with a truthful total (Phase 1)", () => {
    // Wide schema lines (e.g. biomedical 179-col) re-render ~3k chars every step
    // for no accuracy benefit — cap the enumeration but never hide the true count.
    const stats: Record<string, string> = {};
    const row: Record<string, any> = { __row_index__: 0 };
    for (let i = 0; i < 80; i++) {
      stats[`c${i}`] = "(numeric): null=0";
      row[`c${i}`] = i;
    }
    const line = formatSchemaLine(makeOpInfo({ result: [row], columnStats: stats }))!;
    expect(line.startsWith("Schema (showing 50 of 80 cols): ")).toBe(true);
    expect(line).toContain("c0 (numeric)"); // first end kept
    expect(line).toContain("c79 (numeric)"); // last end kept
    expect(line).toContain("…"); // elision marker
    expect(line).not.toContain("c40 (numeric)"); // a middle column is dropped
  });

  test("falls back to result headers (names only) when columnStats is absent", () => {
    const info = makeOpInfo({ result: [{ __row_index__: 0, a: 1, b: 2 }] });
    expect(formatSchemaLine(info)).toBe("Schema (2 cols): a, b");
  });

  test("returns undefined when no columns are known", () => {
    expect(formatSchemaLine(makeOpInfo({ result: [] }))).toBeUndefined();
  });

  test("schemaInResult option prepends the Schema line to the result; off by default omits it", () => {
    const info = makeOpInfo({
      result: [{ __row_index__: 0, id: 1, amount: 5.0 }],
      columnStats: { id: "(numeric): null=0", amount: "(numeric): null=0" },
    });
    const withSchema = formatOperatorResult("op1", info, EMPTY_STATE, { schemaInResult: true });
    expect(withSchema).toContain("Schema (2 cols): id (numeric), amount (numeric)");
    const without = formatOperatorResult("op1", info, EMPTY_STATE, {});
    expect(without).not.toContain("Schema (");
  });
});

describe("scoped columns", () => {
  const info = makeOpInfo({
    outputTuples: 3,
    totalRowCount: 3,
    truncated: false,
    result: [
      { __row_index__: 0, year: 2021, team: "A", yards: 5 },
      { __row_index__: 1, year: 2022, team: "B", yards: 7 },
      { __row_index__: 2, year: 2023, team: "C", yards: 9 },
    ],
    columnStats: {
      year: "(numeric): null=0, distinct=3",
      team: "(str): null=0, distinct=3",
      yards: "(numeric): null=0, distinct=3",
    },
  });

  test("`columns` projects the sample and the stats block; the Schema line stays complete", () => {
    const text = formatOperatorResult("f", info, EMPTY_STATE, {
      columnStats: true,
      schemaInResult: true,
      columns: ["year"],
      maxResultRows: 2,
    });
    expect(text).toMatch(/Schema \(3 cols\)/);
    expect(text).toContain('- "year"');
    expect(text).not.toContain('- "team"');
    expect(text).not.toMatch(/\tteam/); // no team column in the TSV
    expect(text).toMatch(/\tyear/);
  });

  test("an empty `columns` list drops the stats block and leaves the sample whole", () => {
    const text = formatOperatorResult("f", info, EMPTY_STATE, { columnStats: true, columns: [], maxResultRows: 2 });
    expect(text).not.toContain("Column Schema and stats");
    expect(text).toMatch(/\tteam/);
  });

  test("detail shape with a scope keeps counts and the scoped stats, no rows", () => {
    const text = formatOperatorResult("f", info, EMPTY_STATE, {
      columnStats: true,
      schemaInResult: true,
      columns: ["year"],
      detail: "shape",
    });
    expect(text).not.toMatch(/\t2021/);
    expect(text).toContain('- "year"');
    expect(text).not.toContain('- "yards"');
  });
});
