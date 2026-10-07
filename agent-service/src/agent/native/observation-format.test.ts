/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";

test("mechanical row and diff notes require matching saved result provenance", () => {
  const result = {state:"Completed",totalRowCount:8,resultVersion:{id:"v1"},
    tableProfile:{resultVersion:"v1",native:{operatorType:"Process",inputRows:[1898],outputRows:8}}} as any;
  expect(boundResultNotes(result)).toEqual(["note: returned 8 of 1,898 input rows."]);
  expect(boundResultNotes({...result,tableProfile:{...result.tableProfile,resultVersion:"v2"}})).toEqual([]);
  expect(boundResultNotes({...result,state:"Running"})).toEqual([]);
  const diff = {...result,tableProfile:{resultVersion:"v1",native:{operatorType:"Diff",operations:{diff:{keys:4,added:1,removed:1,changed:1,same:1}}}}};
  expect(boundResultNotes(diff)).toEqual(["diff: 4 keys; 1 added, 1 removed, 1 changed, 1 same."]);
});
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import { issueText, renderActionObservations } from "./action-observations";
import {
  displayValue,
  describeOperator,
  renderRecords,
  restrictRecords,
  renderTable,
  operatorBlock,
  topologicalOperators,
  observationFormat,
  boundResultNotes,
  columnsFromInput,
} from "./observation-format";

const info = (rows: Record<string, unknown>[], overrides: Partial<OperatorInfo> = {}): OperatorInfo => ({
  state: "Completed",
  inputTuples: 0,
  outputTuples: rows.length,
  resultMode: "full",
  result: rows,
  totalRowCount: rows.length,
  truncated: false,
  resultSchema: Object.keys(rows[0] ?? {}).map(name => ({ name, type: "str", encoding: "plain" })),
  ...overrides,
});

describe("observation value representation", () => {
  test.each(["markdown", "tsv", "key-value"] as const)("%s preserves text types and separators", format => {
    for (const value of ["", "null", "true", "12", "001", "1e5", "NaN"])
      expect(displayValue(value, "str", format).text).toBe(JSON.stringify(value));
    expect(displayValue(null, "str", format).text).toBe("null");
    expect(displayValue("east", "str", format).text).toBe("east");
    const decoded = (value: string) => (format === "markdown" ? value.replace(/\\\|/g, "|") : value);
    expect(JSON.parse(decoded(displayValue("line\nnext", "str", format).text))).toBe("line\nnext");
    expect(JSON.parse(decoded(displayValue("a\tb", "str", format).text))).toBe("a\tb");
  });
  test("Markdown escapes only the cell separator, so JSON-quoted text keeps single escapes", () => {
    expect(displayValue("a|b", "str", "markdown").text).toBe('"a\\|b"');
    expect(JSON.parse(displayValue("a\\|b", "str", "markdown").text.replace(/\\\|/g, "|"))).toBe("a\\|b");
    // A newline inside text is one JSON escape, not a doubled backslash.
    expect(displayValue("line one\nline two", "str", "markdown").text).toBe('"line one\\nline two"');
  });
  test("key-value text quotes its delimiters", () => {
    expect(displayValue("a, b: c", "str", "key-value").text).toBe('"a, b: c"');
  });
  test("fractions show 15 significant digits; integers and int64 decimal transport stay exact", () => {
    expect(displayValue(56.75779857397504, "float64", "markdown").text).toBe("56.757798573975");
    expect(displayValue(63.153999999999996, "float64", "markdown").text).toBe("63.154");
    expect(displayValue(0.1 + 0.2, "float64", "markdown").text).toBe("0.3");
    expect(displayValue(9007199254740994, "float64", "markdown").text).toBe("9007199254740994");
    expect(displayValue(120.5, "float64", "markdown").text).toBe("120.5");
    expect(displayValue("9223372036854775807", "int64", "markdown").text).toBe("9223372036854775807");
    expect(displayValue("9223372036854775807", "str", "markdown").text).toBe('"9223372036854775807"');
  });
  test("datetime transport keeps sub-millisecond precision", () => {
    expect(displayValue("2026-01-01T00:00:00.123456789+00:00", "datetime", "markdown").text).toBe(
      "2026-01-01T00:00:00.123456789Z"
    );
  });
});

describe("record views", () => {
  for (const tableFormat of ["markdown", "tsv"] as const) {
    test(`${tableFormat}: complete, empty, retained and unknown totals`, () => {
      const result = renderRecords(info([{ region: "east" }, { region: "west" }]), {
        tableFormat,
        view: "full",
        maxChars: 2000,
      });
      expect(result.text).toContain("records: full; 2 of 2 rows, 1 of 1 column (complete)");
      expect(result.complete).toBe(true);
      const empty = renderRecords(info([], { resultSchema: [{ name: "region", type: "str", encoding: "plain" }] }), {
        tableFormat,
        view: "full",
        maxChars: 2000,
      });
      expect(empty.complete).toBe(true);
      expect(empty.text).toContain("0 of 0 rows");
      const retained = renderRecords(info([{ region: "east" }], { totalRowCount: 100, truncated: true }), {
        tableFormat,
        view: "full",
        maxChars: 2000,
      });
      expect(retained.complete).toBe(false);
      expect(retained.text).toContain("1 of 100 rows");
      expect(retained.text).toContain("retained records, not a random sample");
      const unknown = renderRecords(info([{ region: "east" }], { totalRowCount: undefined }), {
        tableFormat,
        view: "full",
        maxChars: 2000,
      });
      expect(unknown.complete).toBe(false);
      expect(unknown.text).toContain("1 of unknown rows");
    });
    test(`${tableFormat}: cell clipping prevents a completeness claim`, () => {
      const result = renderRecords(info([{ text: "Delivered after a delay" }]), {
        tableFormat,
        view: "sample",
        maxChars: 2000,
        cellChars: 12,
      });
      expect(result.text).toContain("Delivered af…");
      expect(result.text).toContain("1 clipped cell");
      expect(result.complete).toBe(false);
      const full = renderRecords(info([{ text: "Delivered after a delay" }]), {
        tableFormat,
        view: "full",
        maxChars: 2000,
        cellChars: 12,
      });
      expect(full.text).toContain("Delivered after a delay");
      expect(full.complete).toBe(true);
    });
    test(`${tableFormat}: a wide view uses named fields and counts omitted columns`, () => {
      const row = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`field_${i}`, `v${i}`]));
      const wide = renderRecords(info([row]), { tableFormat, view: "full", maxChars: 5000 });
      expect(wide.text).toContain("- field_0: v0, field_1: v1");
      expect(wide.text).toContain("field_12: v12");
      expect(wide.complete).toBe(true);
      const narrow = renderRecords(info([row]), { tableFormat, view: "full", maxChars: 5000, columns: ["field_12"] });
      expect(narrow.text).toContain("1 of 13 columns");
      expect(narrow.complete).toBe(false);
      expect(narrow.text).not.toContain("field_0");
    });
  }
  test("schema order and sampled values stay aligned", () => {
    const row = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`col${i}`, `${i}`]));
    const result = renderRecords(info([row], { totalRowCount: 50, truncated: true }), {
      view: "sample",
      maxChars: 700,
    });
    expect(result.frozen.fields.map(c => c.name)).toEqual(
      result.frozen.fields.map(c => c.name).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    );
    expect(result.text.length).toBeLessThanOrEqual(700);
  });
  test("tiny budgets never emit a broken table or a false complete caption", () => {
    for (const maxChars of [0, 1, 8, 30, 80, 140, 300]) {
      const result = renderRecords(info([{ text: "x".repeat(300) }]), { view: "sample", maxChars });
      expect(result.text.length).toBeLessThanOrEqual(maxChars);
      expect(result.complete).toBe(false);
    }
  });
  test("a historical restriction updates coverage without adding facts", () => {
    const original = renderRecords(info([{ x: "a" }, { x: "b" }, { x: "c" }]), { view: "full", maxChars: 2000 });
    const restricted = restrictRecords(original.frozen, { maxRows: 1, maxChars: 2000 });
    expect(restricted.text).toContain("1 of 3 rows");
    expect(restricted.complete).toBe(false);
    expect(restricted.text).not.toContain("| b |");
    expect(original.text).toContain("(complete)");
  });
});

test("table headers cannot introduce rows or columns", () => {
  expect(renderTable(["a|b", "c\nd"], [["1", "2"]], "markdown")).toContain('"a\\|b"');
  expect(renderTable(["a\tb"], [["1"]], "tsv")).toContain('"a\\tb"');
});

test("operator blocks preserve the definition and fixed field order", () => {
  const text = operatorBlock({
    id: "joined",
    kind: "join",
    state: "executed",
    definition: 'join(on="a`b")',
    inputs: [
      { port: "left", id: "a" },
      { port: "right", id: "b" },
    ],
    result: "4 rows × 3 columns",
    columns: ["k int64", "v str"],
    usedBy: ["totals"],
  });
  expect(text).toContain("- **joined** (join, executed)");
  expect(text).toContain('definition: ``join(on="a`b")``');
  expect(text.indexOf("definition:")).toBeLessThan(text.indexOf("inputs:"));
  expect(text.indexOf("inputs:")).toBeLessThan(text.indexOf("result:"));
  expect(text.indexOf("result:")).toBeLessThan(text.indexOf("columns:"));
});

test("topological order keeps creation order for independent operators", () => {
  const operators = [
    { operatorID: "b", nativeOp: { inputs: ["a"] } },
    { operatorID: "z", nativeOp: { inputs: [] } },
    { operatorID: "a", nativeOp: { inputs: [] } },
    { operatorID: "c", nativeOp: { inputs: ["b"] } },
  ];
  expect(topologicalOperators(operators).map(o => o.operatorID)).toEqual(["z", "a", "b", "c"]);
  expect(
    topologicalOperators([
      { operatorID: "a", nativeOp: { inputs: ["b"] } },
      { operatorID: "b", nativeOp: { inputs: ["a"] } },
    ])
  ).toHaveLength(2);
});

test("format defaults keep zero as an explicit setting", () => {
  expect(observationFormat().keyValueColumns).toBe(12);
  expect(observationFormat({ keyValueColumns: 0 }).keyValueColumns).toBe(0);
});

test("an upstream failure leaves a consumer's state and result as not run", () => {
  const consumer = { operatorID: "consumer", operatorType: "Project" } as OperatorPredicate;
  const failed = info([], { state: "Failed", error: "An upstream operator failed." });
  const explicit = describeOperator(consumer, failed, { state: "not run" });
  expect(explicit.state).toBe("not run");
  expect(explicit.result).toBe("not run");
  failed.nativeError = {
    diagnosticId: "d",
    operatorId: "source",
    operatorRevision: "r",
    stepId: "s",
    executionId: "e",
    phase: "execution",
    diagnostic: {
      version: 1,
      operatorId: "source",
      operatorRevision: "r",
      code: "MISSING_COLUMN",
      stage: "execute",
      message: "A column is missing.",
    },
  };
  expect(describeOperator(consumer, failed).state).toBe("not run");
  expect(describeOperator(consumer, failed).result).toBe("not run");
  const root = describeOperator({ ...consumer, operatorID: "source" }, failed);
  expect(root.state).toBe("failed");
  expect(root.result).toBe("failed");
});

test("wrapped engine diagnostics never expose their JSON envelope in action errors", () => {
  const diagnostic = {
    version: 1,
    operatorId: "broken",
    operatorRevision: "a".repeat(16),
    code: "MISSING_COLUMN",
    stage: "execute",
    message: "Column 'unknown' is missing.",
    field: "func",
    source: { entry: "apply", line: 2, excerpt: 'return row["unknown"] > 0' },
  };
  const error = "Execution failed: NativeError: NATIVE_ERROR_V2:" + JSON.stringify(diagnostic);
  const issue = issueText(error);
  expect(issue).toContain("- error MISSING_COLUMN: Column 'unknown' is missing.");
  expect(issue).toContain("- at: apply line 2");
  expect(issue).toContain("- fix:");
  expect(issue).not.toContain("NATIVE_ERROR_V2");
  expect(issue).not.toContain(diagnostic.operatorRevision);
  const text = renderActionObservations({
    kind: "dataflow-actions",
    status: "error",
    actions: [{ index: 1, action: { type: "execute" }, status: "error", output: { operators: [], error } }],
    operators: [],
    observe: [],
    observationErrors: [],
  });
  expect(text).not.toContain("NATIVE_ERROR_V2");
});

test("a step's columns are described by how they differ from its first input's", () => {
  const loans = [
    { name: "id", type: "int64" },
    { name: "country", type: "string" },
    { name: "amount", type: "string" },
    { name: "term", type: "double" },
  ];
  expect(columnsFromInput(loans, loans, "loans")).toBe("same as `loans`");
  expect(columnsFromInput([...loans, { name: "share", type: "double" }], loans, "loans")).toBe(
    "same as `loans`; plus share float64"
  );
  expect(columnsFromInput(loans.filter(field => field.name !== "term"), loans, "loans")).toBe(
    "same as `loans`; without term"
  );
  const cast = loans.map(field => (field.name === "amount" ? { ...field, type: "double" } : field));
  expect(columnsFromInput(cast, loans, "loans")).toBe("same as `loans`; retyped amount float64");
  // A plain list is clearer when kept columns move, a new one comes first,
  // or the change is longer than the list.
  expect(columnsFromInput([loans[1], loans[0], loans[2], loans[3]], loans, "loans")).toBeUndefined();
  expect(columnsFromInput([{ name: "rank", type: "int64" }, ...loans], loans, "loans")).toBeUndefined();
  expect(columnsFromInput([loans[1], { name: "n", type: "int64" }], loans, "loans")).toBeUndefined();
});
