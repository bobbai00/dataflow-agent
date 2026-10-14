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

import { expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { ProfileColumn } from "./profiles";
import {
  collectNativeEvidence,
  restrictNativeObservation,
  selectNativeObservation,
} from "./evidence";
import { downstreamRelevantColumns } from "./evidence-lineage";

function column(rows = 5, nulls = 1): ProfileColumn {
  return {
    type: "int64",
    rowsProcessed: rows,
    nullCount: nulls,
    nonnullCount: rows - nulls,
    nullRatio: rows ? nulls / rows : null,
    distinctCount: rows - nulls,
    uniquenessRatio: rows > nulls ? 1 : null,
    min: rows > nulls ? { type: "int64", value: "9007199254740993" } : null,
    max: rows > nulls ? { type: "int64", value: "9007199254740999" } : null,
    frequencies: null,
    omissions: ["distinct_budget"],
  };
}

function fixture(type = "Filter", properties: Record<string, unknown> = { columns: ["x"], nulls: "drop" }) {
  const makeOp = (
    id: string,
    kind: string,
    inputs: string[],
    props: Record<string, unknown> = {}
  ): OperatorPredicate => ({
    operatorID: id,
    operatorType: inputs.length ? "DataProcessing" : "DataLoading",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: {
      type: kind,
      revision: "0123456789abcdef",
      inputs,
      properties: props,
      profileCollection: true,
    },
  });
  const inputs = type === "Scan" ? [] : type === "Join" || type === "Union" ? ["left", "right"] : ["left"];
  const op = makeOp("answer", type, inputs, properties);
  const upstream = inputs.map(id => makeOp(id, "Scan", []));
  const workflow: WorkflowContent = {
    operators: [...upstream, op],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
  const result = (o: OperatorPredicate, rows: number): OperatorInfo => ({
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows,
    resultMode: "table",
    result: [{ x: 1 }],
    totalRowCount: rows,
    truncated: true,
    resultSchema: [{ name: "x", type: "int64", encoding: "number-or-decimal-string" }],
    resultVersion: {
      version: 1,
      id: o.operatorID.padEnd(64, "0"),
      workflowId: 17,
      operatorId: o.operatorID,
      operatorRevision: o.nativeOp!.revision!,
      definitionHash: "definition",
      subgraphHash: "subgraph",
      outputPort: 0,
      executionId: "100",
      inputs: o.nativeOp!.inputs.map((id, inputIndex) => ({
        inputIndex,
        operatorId: id,
        outputPort: 0,
        resultVersion: id.padEnd(64, "0"),
      })),
      sourceFingerprints: null,
      complete: true,
      omissions: [],
    },
    tableProfile: {
      version: 1,
      resultVersion: o.operatorID.padEnd(64, "0"),
      status: "available",
      coverage: { scope: "full", complete: true, expectedWorkers: 1, receivedWorkers: 1, rowsProcessed: rows },
      rowCount: rows,
      columnCount: 1,
      schema: [{ name: "x", type: "int64", dtype: "Int64" }],
      schemaComplete: true,
      columns: { x: column(rows, Math.min(rows, 1)) },
      structure: { duplicateRows: 0, allNullRows: 0, allNullColumns: [] },
      native: null,
      producerIds: ["a".repeat(32)],
      omissions: [],
      cost: { collectionMs: 1, cellsProcessed: rows, payloadBytes: 100 },
    },
  });
  const results = new Map(upstream.map(o => [o.operatorID, result(o, 5)]));
  const info = result(op, 3);
  info.tableProfile!.native = {
    operatorType: type,
    inputOperators: inputs,
    inputRows: inputs.map(() => 5),
    outputRows: 3,
    operations: type === "Filter" ? { keptRows: 3, rejectedRows: 2, nullPredicates: 1, predicateColumns: ["x"] } : {},
  };
  return { op, info, workflow, results, resolveInput: (id: string) => results.get(id) };
}

const factText = (f: ReturnType<typeof fixture>) =>
  collectNativeEvidence(f)
    .facts.map(x => x.text)
    .join("\n");
const observe = (f: ReturnType<typeof fixture>, options = {}) =>
  selectNativeObservation({ ...f, data: true, flow: true, maxChars: 2000, ...options });

test("full retrieval preserves long cells and reports a bounded incomplete table", () => {
  const f = fixture("Scan", {});
  f.info.resultSchema = [{ name: "x", type: "string", encoding: "string" }];
  f.info.result = Array.from({ length: 12 }, (_, i) => ({ x: `${i}:` + "z".repeat(180) }));
  f.info.totalRowCount = 12;
  f.info.truncated = false;
  const full = observe(f, { view: "full", data: false, flow: false, maxChars: 1100, maxRows: 1 });
  expect(full.text).toContain("z".repeat(180));
  expect(full.text.length).toBeLessThanOrEqual(1100);
  expect(full.table?.complete).toBe(false);
  expect(full.table?.totalRows).toBe(12);
  expect(full.table!.returnedRows).toBeGreaterThan(1);
  expect(full.table!.returnedRows).toBeLessThan(12);
  expect(full.text).toContain("retained records, not a random sample");
});

test("sample_stats preserves the sample and has its own statistics budget", () => {
  const f = fixture();
  const sample = observe(f, { view: "sample", data: false, flow: false, maxChars: 200, dataMaxChars: 800 });
  const stats = observe(f, { view: "sample_stats", data: true, flow: false, maxChars: 200, dataMaxChars: 800 });
  const records = (o: typeof sample) => ({ rows: o.records?.rows, fields: o.records?.fields });
  expect(records(stats)).toEqual(records(sample));
  expect(stats.text).toContain("statistics:");
  expect(sample.text).not.toContain("statistics:");
});

test("sample statistics preserve exact floating-point extrema", () => {
  const f = fixture();
  f.info.resultSchema = [{ name: "x", type: "float64", encoding: "number-or-special-string" }];
  f.info.tableProfile!.columns.x = {
    ...column(3, 0),
    type: "float64",
    min: { type: "float64", value: -2.15300777 },
    max: { type: "float64", value: 0.0000123456789 },
  };
  const result = observe(f, { view: "sample_stats", flow: false });
  expect(result.text).toContain("-2.15300777 to 0.0000123456789");
  expect(result.text).not.toContain("-2.153 to");
});

test("partial records do not obscure exhaustive full-table value statistics", () => {
  const f = fixture("Scan", {});
  const years = [2003, 2011, 2015, 2018, 2020, 2021, 2022, 2023];
  f.info.result = years.map(x => ({ x }));
  f.info.truncated = false;
  f.info.totalRowCount = f.info.tableProfile!.rowCount = f.info.tableProfile!.coverage.rowsProcessed = years.length;
  f.info.tableProfile!.columns.x = {
    ...column(years.length, 0),
    min: { type: "int64", value: "2003" },
    max: { type: "int64", value: "2023" },
    omissions: [],
    frequencies: {
      values: years.map(x => ({ value: { type: "int64", value: String(x) }, count: 1 })),
      otherCount: 0,
      truncated: false,
    },
  };
  const result = observe(f, { view: "sample_stats", flow: false, maxRows: 5, dataMaxChars: 2000, topValues: 0 });
  expect(result.table?.returnedRows).toBe(5);
  expect(result.table?.complete).toBe(false);
  expect(result.text).toContain("statistics: full table, 8 of 8 rows");
  expect(result.text).toContain("all: 2003 1; 2011 1; 2015 1; 2018 1; 2020 1; 2021 1; 2022 1; 2023 1");
  expect(result.text).toContain("first and last retained records; … marks omitted rows");
});

test("preview completeness never implies that the full source was read", () => {
  const f = fixture("Scan", { files: "large.csv", preview: 3 });
  f.info.result = [{ x: 1 }, { x: 2 }, { x: 3 }];
  f.info.truncated = false;
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const result = observe(f, { view, data: view === "sample_stats", flow: false });
    expect(result.table?.complete).toBe(true);
    expect(result.text).toContain("source preview only");
    expect(result.text).toContain("(complete; source preview only)");
    expect(result.text).not.toContain("(complete) (all rows)");
  }
});

test("sample statistics disclose partial coverage without changing the sample", () => {
  const f = fixture("Scan");
  f.info.totalRowCount = 100000;
  f.info.tableProfile!.coverage = {
    scope: "partial",
    complete: false,
    expectedWorkers: 1,
    receivedWorkers: 1,
    rowsProcessed: 3,
  };
  f.info.tableProfile!.status = "partial";
  const sample = observe(f, { view: "sample", data: false, flow: false });
  const stats = observe(f, { view: "sample_stats", data: true, flow: false, dataMaxChars: 700 });
  expect(stats.text).toContain("statistics: partial profile, 3 of 100,000 rows");
  expect(stats.text).toContain("1 of 1 columns");
  expect(stats.records?.rows).toEqual(sample.records?.rows);
  expect(stats.table).toEqual(sample.table);
});

test("raw-line transport artifacts are not presented as parsed data statistics", () => {
  const f = fixture("Scan", { format: "lines" });
  f.info.tableProfile!.columns = { line: { ...column(3, 0), type: "str" } };
  f.info.tableProfile!.structure.duplicateRows = 2;
  const result = observe(f, { view: "sample_stats", data: true, flow: false, dataMaxChars: 700 });
  expect(result.text).toContain("statistics: unavailable for raw lines; parse them into columns first");
  expect(result.text).not.toContain("duplicate rows=2");
  expect(result.selected.some(id => id.startsWith("data."))).toBe(false);
});

test("unavailable statistics are explicit and do not fabricate zero counts", () => {
  const f = fixture("Scan");
  f.info.tableProfile = undefined;
  const result = observe(f, { view: "sample_stats", data: true, flow: false, dataMaxChars: 700 });
  expect(result.text).toContain("statistics: unavailable for this result");
  expect(result.text).not.toContain("null=0");
});

test("a nonempty table with zero profiled rows has unavailable data statistics", () => {
  const f = fixture("Scan");
  f.info.totalRowCount = 8627181;
  f.info.tableProfile!.status = "partial";
  f.info.tableProfile!.coverage.complete = false;
  f.info.tableProfile!.coverage.scope = "partial";
  f.info.tableProfile!.coverage.rowsProcessed = 0;
  f.info.tableProfile!.columns = { x: column(0, 0) };
  const result = observe(f, { view: "sample_stats", data: true, flow: false, dataMaxChars: 700 });
  expect(result.text).toContain("statistics: unavailable for this result");
  expect(result.selected.some(id => id.startsWith("data."))).toBe(false);
  expect(result.text).not.toContain("column counts");
  expect(result.table?.returnedRows).toBeGreaterThan(0);
});

test("flow evidence remains available when a full record view fills its budget", () => {
  const f = fixture();
  f.info.result = [{ x: 1 }, { x: 2 }, { x: 3 }];
  f.info.truncated = false;
  const full = observe(f, { view: "full", data: false, maxChars: 100, flowMaxChars: 700 });
  expect(full.text).toContain("- flow:");
  expect(full.text).toContain("kept=3/5");
  expect(full.table?.returnedRows).toBe(3);
  expect(full.table?.complete).toBe(true);
});

test("compact counts share coverage labels without losing unknown or null counts", () => {
  const f = fixture("Scan");
  f.info.tableProfile!.columns = {
    x: column(3, 0),
    nullable: column(3, 2),
    unknown_distinct: { ...column(3, 0), distinctCount: null },
  };
  const result = observe(f, { flow: false });
  expect(result.text).toContain("statistics: full table, 3 of 3 rows");
  expect(result.text).toContain("column | type | nulls | distinct | values");
  expect(result.text).toContain("nullable | int64 | 2 | 1 |");
  expect(result.text).toContain("unknown_distinct | int64 | 0 | unknown |");
  expect(result.text).toContain("x | int64 | 0 | 3 |");
  expect(result.text).not.toContain('"nullable" (full=3 rows): null=');
  expect(result.text).toContain("| 1 |");
});

test("sample records do not claim a row position in the original table", () => {
  const f = fixture("Sort");
  f.info.result = [
    { rank: 1, label: "first" },
    { rank: 5, label: "fifth" },
  ];
  f.info.resultSchema = [
    { name: "rank", type: "int64", encoding: "number-or-decimal-string" },
    { name: "label", type: "str", encoding: "string" },
  ];
  f.info.totalRowCount = 5;
  f.info.truncated = true;
  const result = observe(f, { data: false, flow: false });
  expect(result.text).toContain("| 1 | first |");
  expect(result.text).toContain("| 5 | fifth |");
  expect(result.text).not.toContain("row 2");
  expect(result.text).not.toContain("(complete) (all rows)");
  expect(result.text).toContain("retained records, not a random sample");
});

test("compact count groups do not conflate partial and full column coverage", () => {
  const f = fixture("Scan");
  f.info.tableProfile!.columns = {
    x: column(3, 0),
    full_other: column(3, 0),
    partial: column(2, 1),
    partial_other: column(2, 0),
  };
  const result = observe(f, { flow: false });
  expect(result.text).toContain("statistics: full table, 3 of 3 rows");
  expect(result.text).toContain("statistics: partial profile, 2 of 3 rows");
  expect(result.text).toContain("partial | int64 | 1 | 1 |");
});

test("combined keeps the data count beside the flow comparison: a flow line never suppresses a data line", () => {
  const f = fixture();
  const both = observe(f);
  expect(both.text).toContain("kept=3/5, rejected=2, null predicates=1");
  expect(both.selected).toContain("data.column.x.counts");
  expect(both.omitted).not.toContainEqual({ id: "data.column.x.counts", reason: "redundant_displayed_fact" });
  const data = observe(f, { flow: false });
  expect(data.selected).toContain("data.column.x.counts");
  expect(data.text).toContain("x | int64 | 1 | 2 |");
  const flow = observe(f, { data: false });
  expect(flow.text).not.toContain("statistics:");
  expect(flow.text).toContain("null predicates=1");
  f.results.get("left")!.error = "upstream failed";
  const unavailable = observe(f);
  expect(unavailable.selected).toContain("data.column.x.counts");
  expect(unavailable.text).not.toContain("null predicates=1");
});

test("column counts are budgeted as table rows and preserve sampled records", () => {
  const f = fixture("Scan");
  f.info.tableProfile!.columns = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, column(3, 0)]));
  const result = observe(f, { flow: false, maxChars: 700 });
  expect(result.text).toContain("statistics: full table, 3 of 3 rows");
  // Counts are budgeted as the table rows they render as, so the room they
  // save holds more columns instead of going unused; the budget still holds.
  expect(result.text.split("\n").filter(l => /^\| field_\d+ \|/.test(l)).length).toBeGreaterThan(2);
  expect(result.records?.rows.map(row => row.line)).toEqual(["| 1 |"]);
  const excluded = result.omitted.filter(c => c.reason === "budget").map(c => c.id);
  expect(excluded.some(id => id.startsWith("data.column."))).toBe(true);
  expect(result.selected.some(id => excluded.includes(id))).toBe(false);
  expect(result.text.length).toBeLessThanOrEqual(2 * 700 + 1);
});

test("raw preview protects ordered header rows from metadata profiles and long cells", () => {
  const f = fixture("Scan", { files: "book.xlsx", preview: 10 });
  const lines = [
    "title",
    "1 | ".repeat(150),
    "2 | ".repeat(150),
    "",
    "",
    "heading_marker | amount",
    "A | 1",
    "B | 2",
    "C | 3",
    "D | 4",
  ];
  f.info.result = lines.map((line, row_no) => ({ sheet: "Sheet1", row_no, line }));
  f.info.resultSchema = [
    { name: "sheet", type: "str", encoding: "string" },
    { name: "row_no", type: "int64", encoding: "number-or-decimal-string" },
    { name: "line", type: "str", encoding: "string" },
  ];
  f.info.totalRowCount = lines.length;
  f.info.tableProfile!.columns = { row_no: column(10, 0), sheet: { ...column(10, 0), distinctCount: 1 } };
  for (const data of [false, true])
    for (const flow of [false, true]) {
      const result = observe(f, { data, flow });
      expect(result.text.replace(/\\([\\|])/g, "$1")).toContain("heading_marker | amount");
      expect(result.text.replace(/\\([\\|])/g, "$1")).toContain('| Sheet1 | 5 | "heading_marker | amount" |');
      expect(result.text.indexOf("| Sheet1 | 1 |")).toBeLessThan(result.text.indexOf("| Sheet1 | 5 |"));
      expect(result.selected.some(id => id.startsWith("data.column."))).toBe(false);
      expect(result.text).toContain("clipped cell");
      expect(result.text.length).toBeLessThanOrEqual(data && flow ? 4000 : 2000);
    }
});

test("one-row header previews use the record budget when the complete header is too wide", () => {
  const f = fixture("Scan", { files: "book.xlsx", preview: 1 });
  const header = "column | ".repeat(80) + "Age | " + 'quoted "field" | '.repeat(300);
  f.info.result = [{ sheet: "Sheet1", row_no: 0, line: header }];
  f.info.resultSchema = [
    { name: "sheet", type: "str", encoding: "string" },
    { name: "row_no", type: "int64", encoding: "number-or-decimal-string" },
    { name: "line", type: "str", encoding: "string" },
  ];
  f.info.totalRowCount = 1;
  f.info.truncated = false;
  for (const data of [false, true]) {
    const result = observe(f, { data, flow: false, maxChars: 2000, maxRows: 5 });
    expect(result.text.replace(/\\([\\|])/g, "$1")).toContain("Age |");
    expect(result.text).toContain("clipped cell");
    expect(result.text).toContain("(all rows; source preview only; 1 clipped cell)");
    expect(result.text.length).toBeGreaterThan(1850);
    expect(result.chunks[0].text.length).toBeLessThanOrEqual(2000);
    expect(result.table?.complete).toBe(false);
  }
});

test("result bindings remain exact audit metadata without a model-facing version preamble", () => {
  const f = fixture();
  const result = observe(f);
  expect(result.resultVersion).toBe(f.info.resultVersion!.id);
  expect(result.inputs).toEqual(f.info.resultVersion!.inputs);
  expect(result.text).not.toContain("Evidence version:");
  expect(result.text).toContain("kept=3/5");
});

test("shape measurements validate their row equations and reject stale or inconsistent counters", () => {
  for (const [kind, properties, rows, operations, validFact, corrupt] of [
    [
      "Unpivot",
      { columns: ["x", "y"] },
      10,
      { unpivot: { selectedColumns: 2, nullCells: 1 } },
      "flow.unpivot",
      { unpivot: { selectedColumns: 1, nullCells: 1 } },
    ],
    [
      "Window",
      { orderBy: [{ col: "x" }], columns: [{ fn: "lag", col: "x", as: "previous" }] },
      5,
      { window: { partitions: 2, tieRows: 1, outputs: { previous: { boundaryNulls: 2, nullOutputs: 3 } } } },
      "flow.window",
      { window: { partitions: 2, tieRows: 6, outputs: {} } },
    ],
    [
      "Pivot",
      { index: ["k"], columns: "key", values: "x" },
      2,
      { pivot: { uniquePairs: 5, indexGroups: 2, generatedColumns: 3, missingCells: 1 } },
      "flow.pivot",
      { pivot: { uniquePairs: 5, indexGroups: 2, generatedColumns: 3, missingCells: 2 } },
    ],
  ] as const) {
    const f = fixture(kind, properties);
    f.info.totalRowCount = f.info.tableProfile!.rowCount = rows;
    Object.assign(f.info.tableProfile!.native!, { outputRows: rows, operations });
    expect(collectNativeEvidence(f).facts.some(fact => fact.id === validFact)).toBe(true);
    f.results.get("left")!.resultVersion!.id = "stale";
    expect(collectNativeEvidence(f).facts.some(fact => fact.id === validFact)).toBe(false);
    f.results.get("left")!.resultVersion!.id = "left".padEnd(64, "0");
    f.info.tableProfile!.native!.operations = corrupt;
    expect(collectNativeEvidence(f).facts.some(fact => fact.id === validFact)).toBe(false);
    expect(collectNativeEvidence(f).omissions).toContain(`invalid_${kind.toLowerCase()}_counters`);
  }
});

test("shape lines that only restate row counts are not flow lines", () => {
  // No ties, no absent cells, no null cells: the line would restate the shape.
  for (const [kind, properties, rows, operations, fact] of [
    ["Unpivot", { columns: ["x", "y"] }, 10, { unpivot: { selectedColumns: 2, nullCells: 0 } }, "flow.unpivot"],
    ["Window", { orderBy: [{ col: "x" }], columns: [] }, 5, { window: { partitions: 2, tieRows: 0, outputs: {} } }, "flow.window"],
    [
      "Pivot",
      { index: [], columns: "key", values: "x" },
      1,
      { pivot: { uniquePairs: 5, indexGroups: 1, generatedColumns: 5, missingCells: 0 } },
      "flow.pivot",
    ],
  ] as const) {
    const f = fixture(kind, properties);
    f.info.totalRowCount = f.info.tableProfile!.rowCount = rows;
    Object.assign(f.info.tableProfile!.native!, { outputRows: rows, operations });
    const evidence = collectNativeEvidence(f);
    expect(evidence.facts.some(item => item.id === fact)).toBe(false);
    expect(evidence.omissions).not.toContain(`invalid_${kind.toLowerCase()}_counters`);
  }
});

test("filter uses exact kept/input denominator and counts None verdicts as drops", () => {
  const f = fixture();
  const facts = collectNativeEvidence(f).facts;
  expect(facts.find(x => x.id === "flow.filter")?.kind).toBe("measurement");
  expect(factText(f)).toContain("kept=3/5");
  expect(factText(f)).toContain("rejected=2");
  expect(factText(f)).toContain("null predicates=1");
  expect(factText(f)).toContain("a None verdict drops the row");
  // Nulls in a predicate column are usually what the condition was written to drop: no line.
  expect(factText(f)).not.toContain("predicate column");
});

test("explicit column scope excludes other profile values", () => {
  const f = fixture();
  f.info.tableProfile!.columns.private_column = {
    ...column(3),
    type: "str",
    min: { type: "str", value: "private_value" },
    max: { type: "str", value: "private_value" },
  };
  const observed = observe(f, { columns: ["x"], flow: false });
  expect(observed.text).not.toContain("private_value");
  expect(observed.text).not.toContain("private_column");
});

test("kept and rejected counts show only when a None verdict dropped rows", () => {
  expect(factText(fixture())).toContain("kept=3/5, rejected=2, null predicates=1");
  const f = fixture();
  f.results.get("left")!.totalRowCount = 0;
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 0;
  Object.assign(f.info.tableProfile!.native!, {
    inputRows: [0],
    outputRows: 0,
    operations: { keptRows: 0, rejectedRows: 0, nullPredicates: 0 },
  });
  // Without null verdicts the counts restate the row counts.
  expect(factText(f)).not.toContain("kept=");
  expect(collectNativeEvidence(f).omissions).not.toContain("invalid_filter_counters");
});

test("partial column profiles do not erase full operator counters or claim full column coverage", () => {
  const f = fixture();
  f.info.tableProfile!.status = "partial";
  f.info.tableProfile!.coverage = {
    scope: "partial",
    complete: false,
    expectedWorkers: 1,
    receivedWorkers: 1,
    rowsProcessed: 2,
  };
  f.info.tableProfile!.columns.x = column(2);
  expect(factText(f)).toContain("kept=3/5");
  expect(factText(f)).toContain("partial prefix=2/3 rows");
});

test("zero profiled rows omit column comparisons but preserve operator counters", () => {
  const f = fixture();
  for (const info of [f.info, f.results.get("left")!]) {
    info.tableProfile!.coverage.rowsProcessed = 0;
    info.tableProfile!.coverage.complete = false;
    info.tableProfile!.columns.x = column(0, 0);
  }
  expect(factText(f)).toContain("kept=3/5");
  expect(factText(f)).not.toContain("Flow measurement: predicate column");
  expect(collectNativeEvidence(f).facts.some(fact => fact.family === "data")).toBe(false);
});

test("stale profile, wrong operator revision, failed or missing input cannot earn relational measurements", () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.info.tableProfile!.resultVersion = "stale";
    },
    (f: ReturnType<typeof fixture>) => {
      f.op.nativeOp!.revision = "new";
    },
    (f: ReturnType<typeof fixture>) => {
      f.results.get("left")!.resultVersion!.id = "new";
    },
    (f: ReturnType<typeof fixture>) => {
      f.results.get("left")!.error = "failed";
    },
    (f: ReturnType<typeof fixture>) => {
      f.results.clear();
    },
  ]) {
    const f = fixture();
    alter(f);
    expect(collectNativeEvidence(f).facts.some(x => x.id === "flow.filter")).toBe(false);
    expect(collectNativeEvidence(f).omissions.length).toBeGreaterThan(0);
  }
});

test("inconsistent operational counts are omitted, not converted into precise claims", () => {
  const f = fixture();
  f.info.tableProfile!.native!.operations!.rejectedRows = 20;
  expect(collectNativeEvidence(f).facts.some(x => x.id === "flow.filter")).toBe(false);
  expect(collectNativeEvidence(f).omissions).toContain("invalid_filter_counters");
});

test("an aggregate's group sizes and non-null counts restate its result: no flow line", () => {
  const f = fixture("Aggregate", { groupBy: [], aggregations: [{ fn: "mean", col: "x", as: "mean" }] });
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 1;
  const operations = {
    groupCount: 1,
    groupSizes: { min: 5, max: 5, total: 5 },
    aggregateNonNull: { mean: { total: 4, min: 4, max: 4 } },
  };
  Object.assign(f.info.tableProfile!.native!, { outputRows: 1, operations });
  expect(collectNativeEvidence(f).facts.filter(x => x.family === "flow")).toEqual([]);
  expect(collectNativeEvidence(f).omissions).not.toContain("invalid_aggregate_counters");
});

function joinFixture() {
  const f = fixture("Join", { type: "left", on: [["x", "x"]], nullsEqual: false });
  f.results.get("right")!.totalRowCount = 4;
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 8;
  Object.assign(f.info.tableProfile!.native!, {
    inputRows: [5, 4],
    outputRows: 8,
    operations: {
      join: {
        type: "left",
        nullsEqual: false,
        validate: "many_to_many",
        matchedOutputRows: 6,
        left: {
          rows: 5,
          eligibleRows: 4,
          nullKeyRows: 1,
          distinctKeys: 2,
          matchedRows: 3,
          unmatchedRows: 2,
          matchedKeys: 1,
          unmatchedKeys: 1,
          maxMultiplicity: 3,
        },
        right: {
          rows: 4,
          eligibleRows: 4,
          nullKeyRows: 0,
          distinctKeys: 3,
          matchedRows: 2,
          unmatchedRows: 2,
          matchedKeys: 1,
          unmatchedKeys: 2,
          maxMultiplicity: 2,
        },
      },
    },
  });
  return f;
}

test("a join reports keys written two ways, not the coverage it was written to have", () => {
  const f = joinFixture();
  // Matched and unmatched counts and duplicate keys are what a left join does.
  expect(factText(f)).not.toContain("matched");
  const join = f.info.tableProfile!.native!.operations!.join as Record<string, any>;
  join.nearMisses = {
    keys: 1,
    rows: 1,
    pairs: [
      {
        left: { values: [{ type: "str", value: "Las Vegas, Nv" }], count: 1, truncated: false },
        right: { values: [{ type: "str", value: "Las Vegas, NV" }], count: 1, truncated: false },
      },
    ],
  };
  expect(factText(f)).toContain(
    '1 left key (1 row) matches a right key only when case, spacing, punctuation and leading zeros are ignored: "Las Vegas, Nv" ~ "Las Vegas, NV".'
  );
  f.info.tableProfile!.native!.operations!.join = { type: "left", matchedOutputRows: 100 };
  expect(collectNativeEvidence(f).facts.some(x => x.id.startsWith("flow.join."))).toBe(false);
});

test("join near misses are validated against the counters and versions", () => {
  const f = joinFixture();
  const join = f.info.tableProfile!.native!.operations!.join as Record<string, any>;
  const pair = {
    left: { values: [{ type: "int64", value: "9007199254740993" }], count: 1, truncated: false },
    right: { values: [{ type: "str", value: "9007199254740993" }], count: 1, truncated: false },
  };
  join.nearMisses = { keys: 1, rows: 1, pairs: [pair] };
  expect(factText(f)).toContain('9007199254740993 ~ "9007199254740993"');
  expect(observe(f, { flow: false }).text).not.toContain(" ~ ");
  // More near-miss keys than unmatched keys, or a witness counting more rows than the side has, say nothing.
  join.nearMisses.keys = 2;
  expect(factText(f)).not.toContain(" ~ ");
  join.nearMisses.keys = 1;
  pair.left.count = 100;
  expect(factText(f)).not.toContain(" ~ ");
  pair.left.count = 1;
  f.info.resultVersion!.inputs[0].resultVersion = "stale";
  expect(factText(f)).not.toContain(" ~ ");
});

test("a join that matched no key shows one key from each side", () => {
  const f = fixture("Join", { type: "left", on: [["x", "x"]], nullsEqual: false });
  f.results.get("right")!.totalRowCount = 4;
  const side = (rows: number) => ({
    rows,
    eligibleRows: rows,
    nullKeyRows: 0,
    distinctKeys: rows,
    matchedRows: 0,
    unmatchedRows: rows,
    matchedKeys: 0,
    unmatchedKeys: rows,
    maxMultiplicity: 1,
  });
  Object.assign(f.info.tableProfile!.native!, {
    inputRows: [5, 4],
    outputRows: 5,
    operations: {
      join: {
        type: "left",
        nullsEqual: false,
        validate: "many_to_many",
        matchedOutputRows: 0,
        left: side(5),
        right: side(4),
        noMatch: {
          left: { values: [{ type: "str", value: "45421" }], count: 1, truncated: false },
          right: { values: [{ type: "str", value: "18053677" }], count: 1, truncated: false },
        },
      },
    },
  });
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 5;
  expect(factText(f)).toContain('the join matched no keys; left keys look like "45421", right keys like "18053677".');
});

test("operator contracts are not flow lines, and a UDF's mapping is never claimed", () => {
  for (const kind of ["Project", "Map", "Cast", "Sort", "Filter", "Aggregate"]) {
    const f = fixture(kind);
    f.info.totalRowCount = f.info.tableProfile!.rowCount = 5;
    f.info.tableProfile!.native!.outputRows = 5;
    // A contract restates the operator's name and definition.
    expect(collectNativeEvidence(f).facts.some(x => x.id === "flow.contract")).toBe(false);
  }
  const f = fixture("Process");
  f.info.totalRowCount = 5;
  expect(factText(f)).not.toContain("mapping unknown");
  expect(factText(f)).not.toContain("row identities preserved");
});

test("a registered function adds no flow line: its row mapping is not measured", () => {
  const f = fixture("Process");
  f.op.nativeOp!.registeredName = "select_records";
  const text = factText(f);
  expect(text).not.toContain("select_records");
  expect(text).not.toContain("mapping unknown");
  expect(text).not.toContain("Process");
});

test("values a Python step dropped are not flow lines: its own code chose them", () => {
  // In 241 such lines over three models none led to a fix (2026-10-14 trace study).
  const f = fixture("Process");
  f.op.nativeOp!.registeredName = "normalize_rankings";
  f.info.tableProfile!.native!.operations = {
    droppedValues: [
      {
        input: 0,
        inputColumn: "Unnamed: 1",
        outputColumn: "state",
        missing: ["State", "District of Columbia", "Puerto Rico"],
        missingCount: 3,
        inputDistinct: 53,
      },
    ],
  };
  expect(observe(f, { data: false }).text).not.toContain("District of Columbia");
});

test("a Python step reports repeats in an identifying output column and whether it created them", () => {
  // legal-hard-1: every state's file lists its cross-state metro areas, so the cleaned table repeats them.
  const f = fixture("Process");
  f.op.nativeOp!.registeredName = "clean_identity";
  const entry = {
    outputColumn: "area",
    rows: 452,
    distinct: 401,
    repeatedValues: 43,
    examples: [
      {
        values: [{ type: "str", value: "Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area" }],
        count: 4,
        truncated: false,
      },
      { values: [{ type: "str", value: "Memphis, TN-MS-AR Metropolitan Statistical Area" }], count: 3, truncated: false },
    ],
    input: 0,
    inputColumn: "Metropolitan Areas",
    inputRepeated: 43,
  };
  f.info.tableProfile!.native!.operations = { repeatedValues: [entry] };
  expect(factText(f)).toContain(
    '"area" repeats 43 values (452 rows, 401 distinct), e.g. "Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area" × 4; "Memphis, TN-MS-AR Metropolitan Statistical Area" × 3; a sum, count or mean over these rows counts each repeat.'
  );
  // Carried repeats are the input's; a step that created them says so.
  entry.inputRepeated = 0;
  expect(factText(f)).toContain("; this step created them; a sum, count or mean over these rows counts each repeat.");
  entry.inputRepeated = 7;
  expect(factText(f)).not.toContain("created");
  // Repeats whose rows agree on the numbers are one entity counted twice; the line says so.
  Object.assign(entry, { sameMeasures: ["reports"] });
  expect(factText(f)).toContain('"area" repeats 43 values with the same "reports" (452 rows, 401 distinct)');
  // Counters that cannot hold say nothing: 43 repeated values need at least 43 extra rows.
  entry.rows = 420;
  expect(factText(f)).not.toContain("repeats");
});

test("an aggregate reports input rows it counts more than once", () => {
  const f = fixture("Aggregate", { groupBy: [], aggregations: [{ fn: "sum", col: "reports", as: "total" }] });
  f.results.get("left")!.totalRowCount = 94;
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 1;
  const operations: Record<string, any> = {
    groupCount: 1,
    groupSizes: { min: 94, max: 94, total: 94 },
    repeatedInput: [
      {
        outputColumn: "area",
        rows: 94,
        distinct: 51,
        repeatedValues: 43,
        sameMeasures: ["reports"],
        examples: [{ values: [{ type: "str", value: "Columbus, GA-AL" }], count: 2, truncated: false }],
      },
    ],
  };
  Object.assign(f.info.tableProfile!.native!, { inputRows: [94], outputRows: 1, operations });
  expect(factText(f)).toContain(
    '"area" repeats 43 values with the same "reports" (94 rows, 51 distinct), e.g. "Columbus, GA-AL" × 2; this aggregate\'s sum, count and mean count each repeat.'
  );
  // With the scan's file column, the same record listed by each state's file is named as such.
  operations.repeatedRecords = { rows: 94, of: 94, records: 43, sources: 38, example: "Columbus, GA-AL, 1302", ignoring: ["file"] };
  expect(factText(f)).toContain(
    '94 of 94 input rows are 43 records each listed once by 38 different sources apart from "file", e.g. "Columbus, GA-AL, 1302"; the aggregate counts every copy.'
  );
  operations.repeatedRecords.rows = 95;
  expect(factText(f)).not.toContain("records each listed");
});

test("group counts are not flow lines, beside the aggregate or downstream", () => {
  const f = fixture("Aggregate", { groupBy: ["g"], aggregations: [{ fn: "count", as: "n" }] });
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 2;
  Object.assign(f.info.tableProfile!.native!, {
    outputRows: 2,
    operations: {
      groupCount: 2,
      groupSizes: { min: 2, max: 3, total: 5 },
      aggregateNonNull: { n: { total: 5, min: 2, max: 3 } },
    },
  });
  expect(factText(f)).not.toContain("groups=2");
  expect(observe(f, { data: false }).text).not.toContain("groups=2");
});

test("an author's description is never presented as an engine guarantee", () => {
  for (const type of ["Map", "Filter", "Process"]) {
    const f = fixture(type, { doc: "Every excluded participant has been removed" });
    const text = factText(f);
    expect(text).not.toContain("Every excluded participant has been removed");
    // A registered function gets neither a warning nor a guarantee line.
    if (type === "Process") expect(text).not.toMatch(/Flow (?:warning|guarantee): Process/);
  }
});

test("wide data views leave room for compact category values and relevant ranges", () => {
  const f = fixture("Scan");
  f.info.resultSchema = Array.from({ length: 80 }, (_, i) => ({ name: `c${i}`, type: "int64", encoding: "number" }));
  f.info.tableProfile!.columns = Object.fromEntries(f.info.resultSchema.map(c => [c.name, column(100, 0)]));
  f.info.tableProfile!.columns.c0 = {
    ...column(100, 0),
    type: "str",
    min: null,
    max: null,
    distinctCount: 2,
    frequencies: {
      values: [
        { value: { type: "str", value: "Yes" }, count: 80 },
        { value: { type: "str", value: "No" }, count: 20 },
      ],
      otherCount: 0,
      truncated: false,
    },
  };
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 100;
  f.info.tableProfile!.coverage.rowsProcessed = 100;
  const selection = observe(f, { view: "sample_stats", flow: false, dataMaxChars: 2000 });
  expect(selection.selected).toContain("data.column.c0.counts");
  expect(selection.selected).toContain("data.column.c0.values");
  expect(selection.selected.some(id => id.endsWith(".range"))).toBe(true);
  expect(selection.omitted.some(f => f.id.endsWith(".counts") && f.reason === "budget")).toBe(true);
});

test("complete small tables outrank redundant data profiles but retain useful input evidence", () => {
  const f = fixture();
  f.info.result = [{ x: 10 }, { x: 20 }, { x: 30 }];
  f.info.truncated = false;
  const selection = observe(f);
  expect(selection.text).toContain("(complete)");
  expect(selection.selected.some(x => x.startsWith("data.column"))).toBe(false);
  expect(selection.text).toContain("kept=3/5");
  expect(selection.omitted.some(x => x.reason === "redundant_complete_table")).toBe(true);
});

test("all exposure arms share typed data formatting and obey their result budgets", () => {
  const f = fixture();
  for (const data of [false, true])
    for (const flow of [false, true])
      for (const maxChars of [1, 12, 60, 160, 400, 2000]) {
        const selection = observe(f, { data, flow, maxChars });
        // The table and data lines fit `maxChars`; flow lines have their own budget of at most the same size.
        expect(selection.text.length).toBeLessThanOrEqual((1 + Number(data) + Number(flow)) * maxChars + 2);
        if (!data) expect(selection.selected.some(x => x.startsWith("data."))).toBe(false);
        if (!flow) expect(selection.selected.some(x => x.startsWith("flow."))).toBe(false);
        expect(observe(f, { data, flow, maxChars })).toEqual(selection);
      }
});

test("evidence is additive: every arm shows the same table, and each family appends its own lines", () => {
  for (const f of [fixture(), fixture("Aggregate"), calculationFixture()])
    for (const maxChars of [300, 450, 600, 900, 2000]) {
      const arms = {
        neither: observe(f, { data: false, flow: false, maxChars }),
        dataOnly: observe(f, { data: true, flow: false, maxChars }),
        flowOnly: observe(f, { data: false, flow: true, maxChars }),
        both: observe(f, { data: true, flow: true, maxChars }),
      };
      const part = (o: ReturnType<typeof observe>, kind: "table" | "data" | "flow" | "notice") =>
        o.chunks.filter(c =>
          kind === "notice"
            ? c.id === "view.omissions"
            : kind === "table"
              ? c.id.startsWith("table.") || c.id.startsWith("sample.")
              : c.id.startsWith(`${kind}.`)
        );
      const texts = (o: ReturnType<typeof observe>, kind: "table" | "data" | "flow" | "notice") =>
        part(o, kind).map(c => c.text);
      // The table (shape, schema, sample rows) is identical in every arm: evidence never displaces a row.
      for (const o of Object.values(arms)) expect(texts(o, "table")).toEqual(texts(arms.neither, "table"));
      // Each family's lines ignore the other family's switch.
      expect(texts(arms.both, "data")).toEqual(texts(arms.dataOnly, "data"));
      expect(texts(arms.both, "flow")).toEqual(texts(arms.flowOnly, "flow"));
      expect(texts(arms.flowOnly, "data")).toEqual([]);
      expect(texts(arms.dataOnly, "flow")).toEqual([]);
      for (const [name, o] of Object.entries(arms)) {
        // Text = table, data lines, flow lines, notice; every part within its own budget.
        const ordered = ["table", "data", "flow", "notice"].flatMap(k => texts(o, k as any));
        expect(o.text, name).toBe(ordered.join("\n"));
        expect(o.chunks.length, name).toBe(ordered.length);
        for (const k of ["data", "flow"] as const) expect(texts(o, k).join("\n").length).toBeLessThanOrEqual(maxChars);
        expect([...texts(o, "table"), ...texts(o, "notice")].join("\n").length).toBeLessThanOrEqual(maxChars);
        // A frozen observation is never shortened without an explicit limit.
        expect(restrictNativeObservation(o, {})).toBe(o.text);
      }
    }
});

test("unknown or truncated data is never labelled a complete table", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      delete f.info.totalRowCount;
    },
    (f: ReturnType<typeof fixture>) => {
      f.info.result = [{ x: "...[truncated]..." }];
      f.info.totalRowCount = 1;
      f.info.truncated = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.info.totalRowCount = 1;
      f.info.truncated = true;
    },
  ]) {
    const f = fixture();
    change(f);
    expect(observe(f).text).not.toContain("(complete)");
  }
});

test("true null, literal NULL, unsafe int64 and reserved-looking user columns survive rendering", () => {
  const f = fixture("Process");
  f.info.totalRowCount = 1;
  f.info.truncated = false;
  f.info.resultSchema = [
    { name: "missing", type: "str", encoding: "string" },
    { name: "text", type: "str", encoding: "string" },
    { name: "id", type: "int64", encoding: "number-or-decimal-string" },
    { name: "__row_index__", type: "str", encoding: "string" },
    { name: "__is_visualization__", type: "bool", encoding: "boolean" },
  ];
  f.info.result = [
    { missing: null, text: "NULL", id: "9007199254740993", __row_index__: "user value", __is_visualization__: true },
  ];
  const text = observe(f, { data: false, flow: false }).text;
  expect(text).toContain('| null | "NULL" | 9007199254740993 | user value | true |');
  expect(text).toContain("__row_index__");
  expect(text).toContain("__is_visualization__");
});

test("budget selection prioritizes relevant columns beyond the old first/last column cap", () => {
  const f = fixture("Filter", { columns: ["c70"] });
  const names = Array.from({ length: 100 }, (_, i) => `c${i}`);
  f.info.resultSchema = names.map(name => ({ name, type: "int64", encoding: "number-or-decimal-string" }));
  f.info.result = [Object.fromEntries(names.map(name => [name, 1]))];
  f.info.tableProfile!.columns = Object.fromEntries(names.map(name => [name, column(3)]));
  f.info.tableProfile!.columnCount = 100;
  const selected = observe(f, { flow: false, maxChars: 550 });
  expect(selected.text).toContain("c70");
  expect(selected.selected).toContain("data.column.c70.counts");
  expect(selected.omitted.some(x => x.reason === "budget")).toBe(true);
});

test("projection rename targets participate in output-column relevance", () => {
  const f = fixture("Project", { rename: { x: "renamed_value" } });
  const names = [...Array.from({ length: 60 }, (_, i) => `c${i}`), "renamed_value"];
  f.info.resultSchema = names.map(name => ({ name, type: "int64", encoding: "number-or-decimal-string" }));
  f.info.result = [Object.fromEntries(names.map(name => [name, 1]))];
  f.info.tableProfile!.columns = Object.fromEntries(names.map(name => [name, column(3)]));
  expect(observe(f, { flow: false, maxChars: 550 }).selected).toContain("data.column.renamed_value.counts");
});

test("downstream dependencies cross renames and derives without parsing callbacks", () => {
  const f = fixture("Scan", {});
  const columns = [...Array.from({ length: 60 }, (_, i) => `c${i}`), "z_amount"];
  f.info.resultSchema = columns.map(name => ({ name, type: "int64", encoding: "number-or-decimal-string" }));
  f.info.result = [Object.fromEntries(columns.map(name => [name, 1]))];
  f.info.tableProfile!.columns = Object.fromEntries(columns.map(name => [name, column(3)]));
  const downstream = (id: string, type: string, input: string, properties: Record<string, unknown>) => {
    const op = { ...structuredClone(f.op), operatorID: id };
    Object.assign(op.nativeOp!, { type, inputs: [input], properties });
    f.workflow.operators.push(op);
    return op;
  };
  downstream("pass", "Project", "answer", {});
  downstream("project", "Project", "pass", { rename: { z_amount: "amount" } });
  downstream("derive", "Map", "project", {
    columns: [{ as: "total", dtype: "int64", func: "lambda value: value * 2", entry: "apply" }],
  });
  // A map's dependencies are measured when it runs, so lineage needs its result.
  const derived = structuredClone(f.info);
  derived.tableProfile!.native = {
    operatorType: "Map",
    inputOperators: ["project"],
    inputRows: [3],
    outputRows: 3,
    operations: { columnDependencies: { total: ["amount"] } },
  } as any;
  f.results.set("derive", derived);
  downstream("filter", "Filter", "derive", { columns: ["total"] });
  const selection = observe(f, { flow: false, maxChars: 550 });
  expect(selection.selected).toContain("data.column.z_amount.counts");
  expect(selection.text).not.toContain("lambda");
  // Opaque UDF code cannot establish column lineage, even if names match.
  f.workflow.operators[1].nativeOp!.type = "Process";
  f.workflow.operators[1].nativeOp!.properties = { code: "secret callback" };
  expect(observe(f, { flow: false, maxChars: 550 }).selected).not.toContain("data.column.z_amount.counts");
});

test("data counts append to the full no-evidence view instead of replacing sample rows", () => {
  const f = fixture("Scan", {});
  f.info.totalRowCount = 100;
  f.info.result = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i, z: i }));
  f.info.resultSchema = ["x", "y", "z"].map(name => ({ name, type: "int64", encoding: "number" }));
  f.info.tableProfile!.columns = { x: column(100), y: column(100), z: column(100) };
  const withData = observe(f, { flow: false, maxChars: 850 });
  const without = observe(f, { data: false, flow: false, maxChars: 850 });
  for (const name of ["x", "y", "z"]) expect(withData.selected).toContain(`data.column.${name}.counts`);
  const rows = (o: ReturnType<typeof observe>) => o.records?.rows;
  expect(rows(withData)).toEqual(rows(without));
  expect(rows(withData)?.length).toBeGreaterThan(8);
  expect(withData.text.startsWith(without.text.replace(/\nretained records, not a random sample[^\n]*$/, ""))).toBe(
    true
  );
  expect(withData.text.length).toBeLessThanOrEqual(2 * 850);
});

test("lineage walk bounds wide fan-out, not only visited queue entries", () => {
  const f = fixture("Scan", {});
  for (let i = 0; i < 500; i++) {
    const op = { ...structuredClone(f.op), operatorID: `consumer_${i}` };
    Object.assign(op.nativeOp!, { type: "Project", inputs: ["answer"], properties: {} });
    f.workflow.operators.push(op);
  }
  let reads = 0;
  downstreamRelevantColumns(f, () => {
    reads++;
    return [];
  });
  expect(reads).toBeLessThanOrEqual(65);
});

test("join suffix inversion cannot mistake a left column for a coalesced right key", () => {
  const f = fixture("Join", { on: "id", rightSuffix: "_right" });
  f.results.get("left")!.resultSchema = ["id", "id_right"].map(name => ({ name, type: "int64", encoding: "number" }));
  f.results.get("right")!.resultSchema = [{ name: "id", type: "int64", encoding: "number" }];
  const consumer = { ...structuredClone(f.op), operatorID: "consumer" };
  Object.assign(consumer.nativeOp!, { type: "Filter", inputs: ["answer"], properties: { columns: ["id_right"] } });
  f.workflow.operators.push(consumer);
  const right = f.workflow.operators.find(op => op.operatorID === "right")!;
  const relevant = downstreamRelevantColumns({ ...f, op: right, info: f.results.get("right")! }, op =>
    op.operatorID === "consumer" ? ["id_right"] : []
  );
  expect(relevant.has("id")).toBe(false);
});

function calculationFixture() {
  const f = fixture("Aggregate", { groupBy: [], aggregations: [{ fn: "count", as: "total" }] });
  const grouped = f.workflow.operators[0];
  Object.assign(grouped.nativeOp!, {
    type: "Aggregate",
    inputs: ["raw"],
    properties: { groupBy: ["account", "region"], aggregations: [{ fn: "count", as: "events" }] },
  });
  const raw = { ...structuredClone(grouped), operatorID: "raw" };
  Object.assign(raw.nativeOp!, { type: "Scan", inputs: [], properties: {} });
  f.workflow.operators.unshift(raw);
  const groupedInfo = f.results.get("left")!;
  const rawInfo = structuredClone(groupedInfo);
  Object.assign(rawInfo.resultVersion!, { id: "raw".padEnd(64, "0"), operatorId: "raw", inputs: [] });
  rawInfo.tableProfile!.resultVersion = rawInfo.resultVersion!.id;
  rawInfo.totalRowCount = rawInfo.tableProfile!.rowCount = 10;
  rawInfo.result = [{ x: "UNOBSERVED_ROW_CANARY" }];
  f.results.set("raw", rawInfo);
  groupedInfo.resultVersion!.inputs = [
    { inputIndex: 0, operatorId: "raw", outputPort: 0, resultVersion: rawInfo.resultVersion!.id },
  ];
  groupedInfo.tableProfile!.native = {
    operatorType: "Aggregate",
    inputOperators: ["raw"],
    inputRows: [10],
    outputRows: 5,
    operations: {
      groupCount: 5,
      groupSizes: { min: 2, max: 2, total: 10 },
      aggregateNonNull: { events: { total: 10, min: 2, max: 2 } },
      keyDependencies: [{ column: "owner", groups: 5, split: 1, example: { key: ["a1", "west"], values: ["Ann", "Bo"] } }],
    },
  };
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 1;
  f.info.result = [{ total: 5 }];
  f.info.resultSchema = [{ name: "total", type: "int64", encoding: "number" }];
  f.info.truncated = false;
  Object.assign(f.info.tableProfile!.native!, {
    outputRows: 1,
    operations: {
      groupCount: 1,
      groupSizes: { min: 5, max: 5, total: 5 },
      aggregateNonNull: { total: { total: 5, min: 5, max: 5 } },
    },
  });
  return f;
}

/** The grouped aggregate's measured fact, as its downstream summaries carry it. */
const SPLIT = 'pools rows with different "owner" values in 1 of 5 groups';

test("observed final count includes bound upstream group grain, not hidden tables", () => {
  const f = calculationFixture();
  const selection = observe(f, { data: false });
  expect(selection.text).toContain('group keys=["account","region"]');
  expect(selection.text).toContain(SPLIT);
  expect(selection.text).not.toContain("groups=5 from 10 rows");
  expect(selection.text).not.toContain("UNOBSERVED_ROW_CANARY");
  expect(selection.text).not.toContain("statistics:");
  expect(selection.selected.some(id => id.startsWith("flow.upstream."))).toBe(true);
  expect(observe(f, { flow: false }).text).not.toContain("account");
  expect(selection.text.length).toBeLessThanOrEqual(2000);
});

test.each([false, true])(
  "upstream conversion losses survive nearby summaries and remain version bound (custom=%s)",
  custom => {
    const f = calculationFixture();
    const raw = f.workflow.operators.find(op => op.operatorID === "raw")!;
    const source = { ...structuredClone(raw), operatorID: "source" };
    f.workflow.operators.unshift(source);
    Object.assign(raw.nativeOp!, {
      type: "Cast",
      inputs: ["source"],
      properties: { columns: [{ column: "x", dtype: "int64" }], errors: "null" },
    });
    const rawInfo = f.results.get("raw")!;
    const sourceInfo = structuredClone(rawInfo);
    Object.assign(sourceInfo.resultVersion!, { id: "source".padEnd(64, "0"), operatorId: "source", inputs: [] });
    sourceInfo.tableProfile!.resultVersion = sourceInfo.resultVersion!.id;
    f.results.set("source", sourceInfo);
    rawInfo.resultVersion!.inputs = [
      { inputIndex: 0, operatorId: "source", outputPort: 0, resultVersion: sourceInfo.resultVersion!.id },
    ];
    rawInfo.tableProfile!.native = {
      operatorType: "Cast",
      inputOperators: ["source"],
      inputRows: [10],
      outputRows: 10,
      operations: {
        conversionFailures: { x: 6 },
        conversionFailureExamples: {
          x: { examples: [{ values: [{ type: "str", value: "1,299" }], count: 4, truncated: false }], otherCount: 2 },
        },
      },
    };
    // Add enough nearby projections to exhaust the old first-three-ancestors rule.
    for (let i = 0; i < 3; i++) {
      const id = `project${i}`;
      const previous = f.op.nativeOp!.inputs[0];
      const previousInfo = f.results.get(previous)!;
      const op = { ...structuredClone(source), operatorID: id };
      Object.assign(op.nativeOp!, { type: "Project", inputs: [previous], properties: { keep: ["x"] } });
      if (custom && i === 1)
        Object.assign(op.nativeOp!, { type: "Process", registeredName: "reshape_values", properties: {} });
      const info = structuredClone(previousInfo);
      Object.assign(info.resultVersion!, {
        id: id.padEnd(64, "0"),
        operatorId: id,
        inputs: [{ inputIndex: 0, operatorId: previous, outputPort: 0, resultVersion: previousInfo.resultVersion!.id }],
      });
      info.tableProfile!.resultVersion = info.resultVersion!.id;
      info.tableProfile!.native = null;
      f.workflow.operators.push(op);
      f.results.set(id, info);
      f.op.nativeOp!.inputs = [id];
      f.info.resultVersion!.inputs = [
        { inputIndex: 0, operatorId: id, outputPort: 0, resultVersion: info.resultVersion!.id },
      ];
    }
    const selected = observe(f, { data: false, flowMaxChars: 1000 });
    expect(selected.text).toContain("- flow (raw):");
    expect(selected.text).toContain('"x" could not be converted in 6 of 10 rows, e.g. "1,299" × 4; those cells are now null.');
    if (custom) expect(selected.text).toContain("row/column correspondence to this output unknown");
    expect(selected.chunks.filter(c => c.upstream).length).toBeLessThanOrEqual(3);
    expect(selected.text).not.toContain("UNOBSERVED_ROW_CANARY");
    rawInfo.resultVersion!.inputs[0].resultVersion = "stale";
    expect(observe(f).text).not.toContain("could not be converted");
    expect(observe(f).text).not.toContain("1,299");
  }
);

test("invalid cast witnesses cannot remove valid conversion counts", () => {
  const f = fixture("Cast", { columns: [{ column: "x", dtype: "int64" }], errors: "null" });
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 5;
  Object.assign(f.info.tableProfile!.native!, {
    outputRows: 5,
    operations: {
      conversionFailures: { x: 2 },
      conversionFailureExamples: {
        x: {
          examples: [{ values: [{ type: "str", value: "bad" }], count: 2, truncated: false }],
          otherCount: 1,
        },
      },
    },
  });
  expect(factText(f)).toContain('"x" could not be converted in 2 of 5 rows; those cells are now null.');
  expect(factText(f)).not.toContain("e.g.");
});

test("upstream summaries stop at stale edges and preserve opaque UDF semantics", () => {
  const f = calculationFixture();
  f.info.resultVersion!.inputs[0].resultVersion = "older";
  expect(observe(f).text).not.toContain("account");
  f.info.resultVersion!.inputs[0].resultVersion = f.results.get("left")!.resultVersion!.id;
  Object.assign(f.workflow.operators.find(op => op.operatorID === "left")!.nativeOp!, {
    type: "Process",
    registeredName: "summarize_records",
  });
  const text = observe(f).text;
  expect(text).not.toContain("mapping unknown");
  expect(text).not.toContain("summary stops here");
  expect(text).not.toContain("Process");
  expect(text).not.toContain(SPLIT);
  expect(text).not.toContain("UNOBSERVED_ROW_CANARY");
});

test("an observed UDF includes measured input ancestors without inferring row correspondence", () => {
  const f = calculationFixture();
  f.op.nativeOp!.type = "Process";
  const selection = observe(f);
  expect(selection.selected.some(id => id.startsWith("flow.upstream.left."))).toBe(true);
  expect(selection.text).toContain(SPLIT);
  expect(selection.text).toContain("row/column correspondence to this output unknown");
  expect(selection.text).not.toContain("UNOBSERVED_ROW_CANARY");
  expect(selection.selected.some(id => id.startsWith("flow.filter"))).toBe(false);
});

function opaqueAncestorFixture() {
  const f = calculationFixture();
  const upstream = f.results.get("left")!;
  const custom = { ...structuredClone(f.op), operatorID: "custom" };
  Object.assign(custom.nativeOp!, {
    type: "Process",
    registeredName: "choose_rows",
    inputs: ["left"],
    properties: {},
  });
  const info = structuredClone(upstream);
  Object.assign(info.resultVersion!, {
    id: "custom".padEnd(64, "0"),
    operatorId: "custom",
    inputs: [{ inputIndex: 0, operatorId: "left", outputPort: 0, resultVersion: upstream.resultVersion!.id }],
  });
  info.tableProfile!.resultVersion = info.resultVersion!.id;
  info.totalRowCount = info.tableProfile!.rowCount = 2;
  info.tableProfile!.native = {
    operatorType: "Process",
    inputOperators: ["left"],
    inputRows: [5],
    outputRows: 2,
    operations: {},
  };
  f.workflow.operators.push(custom);
  f.results.set("custom", info);
  f.op.nativeOp!.inputs = ["custom"];
  f.info.resultVersion!.inputs = [
    { inputIndex: 0, operatorId: "custom", outputPort: 0, resultVersion: info.resultVersion!.id },
  ];
  return f;
}

test("downstream retrieval crosses a custom operator using version-bound graph dependencies only", () => {
  const f = opaqueAncestorFixture();
  const selection = observe(f, { data: false });
  expect(selection.text).not.toContain("mapping unknown");
  expect(selection.text).toContain(SPLIT);
  expect(selection.text).toContain("row/column correspondence to this output unknown");
  expect(selection.selected.some(id => id.startsWith("flow.upstream.left."))).toBe(true);
  expect(selection.selected.some(id => id.startsWith("flow.filter"))).toBe(false);
  expect(selection.text).not.toContain("UNOBSERVED_ROW_CANARY");
  expect(selection.chunks.filter(chunk => chunk.upstream).length).toBeLessThanOrEqual(3);
  expect(observe(f, { flow: false }).text).not.toContain(SPLIT);
  expect(observe(f, { upstream: false }).text).not.toContain(SPLIT);
});

test.each(["input version", "input revision", "failed custom", "incomplete custom"])(
  "custom dependency traversal refuses an invalid %s",
  corruption => {
    const f = opaqueAncestorFixture();
    const custom = f.results.get("custom")!;
    if (corruption === "input version") custom.resultVersion!.inputs[0].resultVersion = "old";
    if (corruption === "input revision") f.results.get("left")!.resultVersion!.operatorRevision = "old";
    if (corruption === "failed custom") custom.error = "custom operator failed";
    if (corruption === "incomplete custom") custom.resultVersion!.complete = false;
    expect(observe(f).text).not.toContain(SPLIT);
  }
);

test("missing evidence is not an execution error and never triggers hidden work", () => {
  const f = fixture();
  delete f.info.tableProfile;
  expect(observe(f).text).toContain("records:");
  expect(observe(f).text).not.toContain("[ERROR]");
  expect(observe(f).omitted.some(x => x.id === "profile_unavailable")).toBe(true);
});

test("shape-only and tighter row limits cannot imply complete visibility", () => {
  const f = fixture();
  f.info.result = [{ x: 1 }, { x: 2 }, { x: 3 }];
  f.info.truncated = false;
  expect(observe(f, { detail: "shape" }).text).not.toContain("(complete)");
  expect(observe(f, { maxRows: 1 }).text).not.toContain("(complete)");
});

test("compaction only shortens recorded evidence and never adds new facts", () => {
  const f = fixture();
  f.info.result = [{ x: 10 }, { x: 20 }, { x: 30 }];
  f.info.truncated = false;
  const recorded = observe(f);
  const shape = restrictNativeObservation(recorded, { detail: "shape" });
  expect(shape).not.toContain("(complete)");
  expect(shape).not.toContain("10\n20\n30");
  expect(shape).toContain("kept=3/5");
  expect(shape).not.toContain("statistics:");
  const sample = restrictNativeObservation(recorded, { maxRows: 1 });
  expect(sample).not.toContain("(complete)");
  expect(sample).toContain("10");
  expect(sample).not.toContain("20\n30");
  for (const maxChars of [1, 40, 150, 1000])
    expect(restrictNativeObservation(recorded, { maxChars }).length).toBeLessThanOrEqual(maxChars);
  expect(restrictNativeObservation(recorded, {})).toBe(recorded.text);
});

test("an empty grouped aggregate reports nothing beyond its empty table", () => {
  const f = fixture("Aggregate", { groupBy: ["x"], aggregations: [{ fn: "count", as: "n" }] });
  f.results.get("left")!.totalRowCount = 0;
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 0;
  Object.assign(f.info.tableProfile!.native!, {
    inputRows: [0],
    outputRows: 0,
    operations: {
      groupCount: 0,
      groupSizes: { total: 0, min: null, max: null },
      aggregateNonNull: { n: { total: 0, min: null, max: null } },
    },
  });
  expect(factText(f)).not.toContain("groups=0");
  expect(factText(f)).not.toContain("row denominator");
  expect(collectNativeEvidence(f).omissions).not.toContain("aggregate_denominator_unavailable");
  expect(collectNativeEvidence(f).omissions).not.toContain("invalid_aggregate_counters");
});

test("aggregate semantics: what a distinct count counts and a key that pools entities", () => {
  const str = (distinct: number, values?: Array<[string, number]>): ProfileColumn => ({
    ...column(12, 0),
    type: "str",
    distinctCount: distinct,
    min: null,
    max: null,
    frequencies: values
      ? {
          values: values.map(([value, count]) => ({ value: { type: "str", value }, count })),
          otherCount: 0,
          truncated: false,
        }
      : null,
  });
  const f = fixture("Aggregate", {
    groupBy: ["state"],
    aggregations: [{ fn: "count_distinct", col: "GlobalID", as: "areas" }],
  });
  const input = f.results.get("left")!;
  input.totalRowCount = input.tableProfile!.rowCount = input.tableProfile!.coverage.rowsProcessed = 12;
  input.tableProfile!.columns = {
    GlobalID: str(12),
    GACCName: str(2),
    state: str(3),
    Case_excluded: str(2, [
      ["No", 11],
      ["Yes", 1],
    ]),
  };
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 3;
  Object.assign(f.info.tableProfile!.native!, {
    outputRows: 3,
    inputRows: [12],
    operations: {
      groupCount: 3,
      groupSizes: { min: 2, max: 6, total: 12 },
      aggregateNonNull: { areas: { total: 12, min: 2, max: 6 } },
      keyDependencies: [{ column: "Community", groups: 3, split: 1, example: { key: ["CA"], values: ["a", "b"] } }],
    },
  });
  const text = factText(f);
  // A distinct count over a column unique on every row counts rows: the agent's own choice, not a measurement.
  expect(text).not.toContain("count_distinct");
  expect(text).toContain('grouping by "state" pools rows with different "Community" values in 1 of 3 groups, e.g. "CA": "a", "b".');
  // One line per aggregate: the runtime puts the strongest split first.
  (f.info.tableProfile!.native!.operations!.keyDependencies as unknown[]).push({
    column: "County",
    groups: 3,
    split: 1,
    example: { key: ["CA"], values: ["c", "d"] },
  });
  expect(factText(f)).not.toContain('"County"');
  // Unread input columns are not flow lines: models never acted on them
  // (0 of 167 Claude receipts, 2026-10-11); `values` statistics show a flag.
  expect(text).not.toContain("was read by no operator");
});

test("scan coverage and per-file header findings are scan notes, not flow lines", () => {
  const f = fixture("Scan", { files: "data/legal/*.csv" });
  const sources = Array.from({ length: 30 }, (_, i) => ({
    path: `/data/legal/2024_CSN_Report_${String(i).padStart(2, "0")}_${"Category".repeat(4)}.csv`,
    headerCheck: { blank: 3, suggest: { skipLines: 2, header: ["Year", "Category", "# of Reports", "Percentage"] } },
  }));
  f.info.tableProfile!.native!.operations = {
    scan: { preview: false, resolvedFiles: 32, selectedFiles: 30, omittedFiles: 2, sources },
  };
  // The execute receipt's selection: flow only, the operator's own facts.
  // Header findings are shown with the scan's result in every setting.
  const own = observe(f, { data: false, flowMaxChars: 2000, upstream: false });
  expect(own.chunks.filter(chunk => chunk.id.startsWith("flow."))).toEqual([]);
  // An empty source is still a flow measurement.
  (sources[0] as Record<string, unknown>).outputRows = 0;
  const empty = observe(f, { data: false, flowMaxChars: 2000, upstream: false });
  expect(empty.chunks.filter(chunk => chunk.id.startsWith("flow.")).map(chunk => chunk.id)).toEqual([
    "flow.scan.empty.0",
  ]);
});

test("filter near misses and no-match lines are validated against the filter's counters", () => {
  const f = fixture();
  const operations = f.info.tableProfile!.native!.operations!;
  const near: Record<string, any> = {
    column: "x",
    rows: 1,
    values: [{ value: "YES", rows: 1, counterpart: "yes", how: "literal" }],
  };
  operations.filterNearMisses = [near];
  expect(factText(f)).toContain(
    '"x" values the condition rejected equal its literal "yes" except for case, spacing or punctuation: "YES" × 1.'
  );
  near.values[0].how = "kept";
  expect(factText(f)).toContain('equal the kept value "yes" except for');
  near.values[0] = { value: "the United Kingdom", rows: 1, counterpart: "United Kingdom", how: "contains" };
  expect(factText(f)).toContain('"x" values the condition rejected contain its literal "United Kingdom": "the United Kingdom" × 1.');
  // More near-miss rows than rejected rows, or an unknown kind, say nothing.
  near.values[0].rows = 3;
  expect(factText(f)).not.toContain("United Kingdom");
  near.values[0] = { value: "YES", rows: 1, counterpart: "yes", how: "guess" };
  expect(factText(f)).not.toContain("YES");
  // A filter that kept nothing names its literals and the values it saw.
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 0;
  Object.assign(f.info.tableProfile!.native!, {
    outputRows: 0,
    operations: {
      keptRows: 0,
      rejectedRows: 5,
      nullPredicates: 0,
      predicateColumns: ["x"],
      filterNoMatch: {
        column: "x",
        literals: ["07"],
        seen: [{ values: [{ type: "str", value: "8/25/2002" }], count: 4, truncated: false }],
      },
    },
  });
  expect(factText(f)).toContain('no row passed the condition\'s test for "07"; "x" values seen: "8/25/2002" × 4.');
  // Stable's rejected-value lists are no longer flow lines.
  (f.info.tableProfile!.native!.operations as Record<string, unknown>).filterRejectedValues = {
    rejectedRows: 5,
    columnsObserved: 1,
    columns: { x: { examples: [], otherCount: 5 } },
  };
  expect(factText(f)).not.toContain("not causes");
});
