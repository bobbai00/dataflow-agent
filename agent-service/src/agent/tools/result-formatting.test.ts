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

  test("empty array result emits brief summary plus zero-column shape only", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ result: [], outputTuples: 0 }), EMPTY_STATE);
    expect(out.split("\n")).toEqual(["Executed operator op1", "Output table shape: (0, 0)"]);
  });
});

describe("formatOperatorResult - table shape and metadata", () => {
  test("uses outputTuples for row count when totalRowCount missing", () => {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 7, result: [{ a: 1, b: 2 }] }), EMPTY_STATE);
    expect(out).toContain("Output table shape: (7, 2)");
  });

  test("totalRowCount overrides outputTuples in output shape", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 7, totalRowCount: 999, result: [{ a: 1, b: 2 }] }),
      EMPTY_STATE
    );
    expect(out).toContain("Output table shape: (999, 2)");
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
    expect(out).toContain("Output table shape: (1, 1)");
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
    expect(lines[0]).toBe("Executed operator op1");
    expect(lines[1]).toBe("Output table shape: (1, 1)");
    expect(lines[2]).toBe("truncated to 1 row");
    expect(lines[3]).toBe("something else");
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
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 1, result: [makeWideRow(50)] }),
      EMPTY_STATE
    );
    expect(out).toContain("Output table shape: (1, 50)");
    expect(out).not.toContain("showing first");
    // every column header is present
    for (let i = 0; i < 50; i++) expect(out).toContain(`col_${i.toString().padStart(3, "0")}`);
  });

  test("with >50 columns: keeps first 25 + last 25, drops middle, surfaces truncation notice", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 1, result: [makeWideRow(200)] }),
      EMPTY_STATE
    );
    // The shape line reports the TRUE total — not the rendered subset.
    expect(out).toContain("Output table shape: (1, 200)");
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

  test("column-stats block applies the same cap with a parallel notice", () => {
    const stats: Record<string, string> = {};
    for (let i = 0; i < 200; i++) stats[`col_${i.toString().padStart(3, "0")}`] = "(numeric): null=0";
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 1, result: [makeWideRow(200)], columnStats: stats }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
    expect(out).toContain("Column stats (showing first 25 and last 25 of 200 columns):");
    // First kept (alphabetical sort means col_000..col_024)
    expect(out).toContain(`- "col_000" (numeric): null=0`);
    expect(out).toContain(`- "col_024" (numeric): null=0`);
    // Middle dropped
    expect(out).not.toContain(`- "col_100"`);
    // Last kept
    expect(out).toContain(`- "col_199" (numeric): null=0`);
  });
});

describe("formatOperatorResult - column-stats schema is opaque", () => {
  // Locks in the contract that agent-service does NOT look inside the per-
  // column stat string it gets from the backend. The backend produces
  // pre-formatted display lines (current shape: "(<type>): k=v, k=v, …")
  // and the renderer just wraps each with `- "<col>" `. Future backend
  // changes — new type labels, renamed fields, added stats — flow through
  // unchanged without a renderer update. If any of these tests start
  // failing, someone added a backend-coupled assumption to the renderer —
  // push that back into the backend instead.

  function renderWithStats(stats: Record<string, string>): string {
    return formatOperatorResult(
      "op1",
      makeOpInfo({ outputTuples: 1, result: [{ a: 1 }], columnStats: stats }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
  }

  test("renamed stat keys flow through (top_10 → top_3) without renderer awareness", () => {
    const old = { sentinel: `(str): null=0, distinct=3, top_10={"A"=2, "B"=1}` };
    const fresh = { sentinel: `(str): null=0, distinct=3, top_3={"A"=2, "B"=1}` };
    const outOld = renderWithStats(old);
    const outFresh = renderWithStats(fresh);
    expect(outOld).toContain("top_10");
    expect(outOld).not.toContain("top_3");
    expect(outFresh).toContain("top_3");
    expect(outFresh).not.toContain("top_10");
    // Both renderings carry the same per-value content.
    expect(outOld).toContain(`"A"=2`);
    expect(outFresh).toContain(`"A"=2`);
  });

  test("a brand-new stat key the renderer has never heard of is still emitted verbatim", () => {
    const blob = { sentinel: `(unicorn): null=5, unicorn_metric=3.14, histogram_bins=[1,2,3]` };
    const out = renderWithStats(blob);
    // No key whitelist, no shape check, no JSON parse — backend string is the truth.
    expect(out).toContain("unicorn");
    expect(out).toContain("unicorn_metric");
    expect(out).toContain("3.14");
    expect(out).toContain("histogram_bins");
  });

  test("a brand-new type label is rendered as-is in the parenthesised header", () => {
    // Backend invents a new type tag (e.g. "categorical-ordered"); renderer
    // just emits it. Today's known types are bool/numeric/str/datetime,
    // but the renderer never enumerates them.
    const blob = { sentinel: `(categorical-ordered): null=0, levels=["low","mid","high"]` };
    const out = renderWithStats(blob);
    expect(out).toContain(`- "sentinel" (categorical-ordered): null=0, levels=["low","mid","high"]`);
  });

  test("an oversized string inside the stat blob is rendered as-is (the backend owns truncation)", () => {
    // Documents the explicit division of responsibility: the agent-service does
    // NOT re-truncate within stat strings. The backend's
    // truncateColumnStatsValues (Scala) is what bounds the size. If a test
    // later wants a safety net here, change the renderer AND update this assertion.
    const huge = "X".repeat(200);
    const stats = { sentinel: `(str): null=0, distinct=1, top_10={"${huge}"=1}` };
    const out = renderWithStats(stats);
    expect(out).toContain("X".repeat(200));
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
    expect(out).toContain("Input operator(table shape): input0(5, 3)");
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
    expect(out).toContain("Input operator(table shape): upstream(10, 2)");
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
    expect(out).toContain("Input operator(table shape): up0(1, 1), up1(2, 2)");
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
});

describe("jsonToTableFormat - cell coercion via formatOperatorResult", () => {
  function tableLines(opInfo: Partial<OperatorInfo>): string[] {
    const out = formatOperatorResult("op1", makeOpInfo({ outputTuples: 1, ...opInfo }), EMPTY_STATE);
    // Skip brief summary + shape line.
    return out.split("\n").slice(2);
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

describe("formatOperatorResult - statsEnabled column stats", () => {
  // Backend ships pre-formatted display strings per column, of the shape
  // "(<type>): k=v, k=v, ...". The renderer wraps each with `- "<col>" `
  // and emits them under a `Column stats:` block. These fixtures use the
  // real backend shape produced by data_processor._compute_column_stats.
  const info = makeOpInfo({
    result: [{ a: 1, b: "x" }],
    outputTuples: 1,
    columnStats: {
      a: "(numeric): null=0, mean=1, min=1, max=1",
      b: "(str): null=0, distinct=1, top_10={\"x\"=1}",
    },
  });

  test("statsEnabled=false: no Column stats block", () => {
    const out = formatOperatorResult("op1", info, EMPTY_STATE, { statsEnabled: false });
    expect(out).not.toContain("Column stats:");
  });

  test("statsEnabled default off: no Column stats block", () => {
    const out = formatOperatorResult("op1", info, EMPTY_STATE);
    expect(out).not.toContain("Column stats:");
  });

  test("statsEnabled=true: appends sorted Column stats block under the data preview", () => {
    const out = formatOperatorResult("op1", info, EMPTY_STATE, { statsEnabled: true });
    expect(out).toContain("Column stats:");
    expect(out).toContain(`- "a" (numeric): null=0, mean=1, min=1, max=1`);
    expect(out).toContain(`- "b" (str): null=0, distinct=1, top_10={"x"=1}`);
    // alphabetical: '- "a"' precedes '- "b"'.
    expect(out.indexOf(`- "a"`)).toBeLessThan(out.indexOf(`- "b"`));
    // appears at the end (after data), not before the preview.
    expect(out.indexOf("Column stats:")).toBeGreaterThan(out.indexOf("Output table shape"));
  });

  test("statsEnabled=true + no columnStats: omits the stats section", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ result: [{ a: 1 }], outputTuples: 1 }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
    expect(out).not.toContain("Column stats:");
  });

  test("statsEnabled=true + empty columnStats map: omits the stats section", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ result: [{ a: 1 }], outputTuples: 1, columnStats: {} }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
    expect(out).not.toContain("Column stats:");
  });

  test("statsEnabled=true on errored op: error renders verbatim, stats are suppressed", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({ error: "boom", columnStats: { a: "(numeric): null=0" } }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
    expect(out).toBe("[ERROR] boom");
  });

  test("statsEnabled=true filters out empty-string column entries", () => {
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        result: [{ a: 1 }],
        outputTuples: 1,
        columnStats: { a: "(numeric): null=0", b: "" },
      }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
    expect(out).toContain(`- "a" (numeric): null=0`);
    expect(out).not.toContain(`- "b"`);
  });

  test("statsEnabled=true: renders the full per-type set (bool / numeric / str / datetime / high-cardinality str)", () => {
    // Mirrors the exact shape data_processor._compute_column_stats emits.
    const out = formatOperatorResult(
      "op1",
      makeOpInfo({
        outputTuples: 1,
        result: [{ is_premium: true, tier: "gold", customer_id: "C001", signup_date: "2023-01-15", amount: 250 }],
        columnStats: {
          is_premium: "(bool): null=0, true=4200, false=5800",
          tier: `(str): null=0, distinct=3, top_10={"gold"=4200, "silver"=3800, "bronze"=2000}`,
          customer_id: "(str): null=0, distinct=10000",
          signup_date: "(datetime): null=0, min=2023-01-15, max=2024-06-30",
          amount: "(numeric): null=0, mean=219.2, min=95, max=520",
        },
      }),
      EMPTY_STATE,
      { statsEnabled: true }
    );
    expect(out).toContain(`- "is_premium" (bool): null=0, true=4200, false=5800`);
    expect(out).toContain(`- "tier" (str): null=0, distinct=3, top_10={"gold"=4200, "silver"=3800, "bronze"=2000}`);
    expect(out).toContain(`- "customer_id" (str): null=0, distinct=10000`);
    expect(out).toContain(`- "signup_date" (datetime): null=0, min=2023-01-15, max=2024-06-30`);
    expect(out).toContain(`- "amount" (numeric): null=0, mean=219.2, min=95, max=520`);
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

  test("lists ALL columns even when wide (no 50-col truncation)", () => {
    const stats: Record<string, string> = {};
    const row: Record<string, any> = { __row_index__: 0 };
    for (let i = 0; i < 80; i++) {
      stats[`c${i}`] = "(numeric): null=0";
      row[`c${i}`] = i;
    }
    const line = formatSchemaLine(makeOpInfo({ result: [row], columnStats: stats }))!;
    expect(line.startsWith("Schema (80 cols): ")).toBe(true);
    expect(line).toContain("c0 (numeric)");
    expect(line).toContain("c79 (numeric)"); // middle/last columns are NOT dropped
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
