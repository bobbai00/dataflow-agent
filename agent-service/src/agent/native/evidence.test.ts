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
import { collectNativeEvidence, FLOW_OMITTED_NOTICE, restrictNativeObservation, selectNativeObservation } from "./evidence";
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
  expect(both.text).toContain('predicate column "x": input (full=5 rows)');
  expect(both.selected).toContain("data.column.x.counts");
  expect(both.omitted).not.toContainEqual({ id: "data.column.x.counts", reason: "redundant_displayed_fact" });
  const data = observe(f, { flow: false });
  expect(data.selected).toContain("data.column.x.counts");
  expect(data.text).toContain("x | int64 | 1 | 2 |");
  const flow = observe(f, { data: false });
  expect(flow.text).not.toContain("statistics:");
  expect(flow.text).toContain('predicate column "x":');
  f.results.get("left")!.error = "upstream failed";
  const unavailable = observe(f);
  expect(unavailable.selected).toContain("data.column.x.counts");
  expect(unavailable.text).not.toContain('predicate column "x":');
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
      { index: [], columns: "key", values: "x" },
      1,
      { pivot: { uniquePairs: 5, indexGroups: 1, generatedColumns: 5, missingCells: 0 } },
      "flow.pivot",
      { pivot: { uniquePairs: 5, indexGroups: 1, generatedColumns: 5, missingCells: 1 } },
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

test("filter uses exact kept/input denominator and counts None verdicts as drops", () => {
  const f = fixture();
  const facts = collectNativeEvidence(f).facts;
  expect(facts.find(x => x.id === "flow.filter")?.kind).toBe("measurement");
  expect(factText(f)).toContain("kept=3/5");
  expect(factText(f)).toContain("rejected=2");
  expect(factText(f)).toContain("null predicates=1");
  expect(factText(f)).toContain("a None verdict drops the row");
  expect(factText(f)).toContain('predicate column "x": input (full=5 rows) null=1/5');
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

test("zero input gives undefined retention, not zero percent", () => {
  const f = fixture();
  f.results.get("left")!.totalRowCount = 0;
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 0;
  Object.assign(f.info.tableProfile!.native!, {
    inputRows: [0],
    outputRows: 0,
    operations: { keptRows: 0, rejectedRows: 0, nullPredicates: 0 },
  });
  expect(factText(f)).toContain("kept=0/0 (no rows)");
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

test("aggregate shows group size and per-reducer nonnull denominators", () => {
  const f = fixture("Aggregate", { groupBy: [], aggregations: [{ fn: "mean", col: "x", as: "mean" }] });
  f.info.totalRowCount = f.info.tableProfile!.rowCount = 1;
  Object.assign(f.info.tableProfile!.native!, {
    outputRows: 1,
    operations: {
      groupCount: 1,
      groupSizes: { min: 5, max: 5, total: 5 },
      aggregateNonNull: { mean: { total: 4, min: 4, max: 4 } },
    },
  });
  expect(factText(f)).toContain("groups=1 from 5 rows");
  expect(factText(f)).toContain('"mean" nonnull=4/5');
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

test("equijoin distinguishes matched output contribution from row and key coverage", () => {
  const f = joinFixture();
  const text = factText(f);
  expect(text).toContain("matched contribution=6");
  expect(text).toContain("left matched rows=3/5");
  expect(text).toContain("matched keys=1/2");
  expect(text).toContain("right matched rows=2/4");
  expect(text).not.toContain("8 entities");
  f.info.tableProfile!.native!.operations!.join = { type: "left", matchedOutputRows: 100 };
  expect(collectNativeEvidence(f).facts.some(x => x.id.startsWith("flow.join."))).toBe(false);
});

test("join witnesses are bounded optional evidence and cannot override counters or versions", () => {
  const f = joinFixture();
  const left = (f.info.tableProfile!.native!.operations!.join as Record<string, any>).left;
  left.unmatchedExamples = [{ values: [{ type: "int64", value: "9007199254740993" }], count: 1, truncated: false }];
  left.duplicateExamples = [{ values: [{ type: "int64", value: "7" }], count: 3, truncated: false }];
  expect(factText(f)).toContain("[9007199254740993] × 1");
  expect(factText(f)).toContain("[7] × 3");
  expect(observe(f, { flow: false }).text).not.toContain("key examples");
  expect(observe(f, { data: false, flowMaxChars: 400 }).text).toContain("matched contribution=6");
  left.unmatchedExamples[0].count = 100;
  left.duplicateExamples[0].values[0].value = "9223372036854775808";
  expect(factText(f)).not.toContain("key examples");
  expect(factText(f)).toContain("matched contribution=6");
  f.info.resultVersion!.inputs[0].resultVersion = "stale";
  expect(factText(f)).not.toContain("matched contribution=6");
});

test("guarantees describe contracts, UDF remains unknown at equal row counts", () => {
  for (const kind of ["Project", "Map", "Cast", "Sort"]) {
    const f = fixture(kind);
    f.info.totalRowCount = f.info.tableProfile!.rowCount = 5;
    f.info.tableProfile!.native!.outputRows = 5;
    const contract = collectNativeEvidence(f).facts.find(x => x.id === "flow.contract");
    // A project, cast or sort contract only restates the operator's name.
    expect(contract?.kind).toBe(kind === "Map" ? "guarantee" : undefined);
  }
  const f = fixture("Process");
  f.info.totalRowCount = 5;
  expect(factText(f)).toContain("row/column mapping unknown");
  expect(factText(f)).not.toContain("row identities preserved");
});

test("an author's description is never presented as an engine guarantee", () => {
  for (const type of ["Map", "Filter", "Process"]) {
    const f = fixture(type, { doc: "Every excluded participant has been removed" });
    const text = factText(f);
    expect(text).not.toContain("Every excluded participant has been removed");
    if (type === "Process") {
      expect(text).toContain("Flow warning: Process");
      expect(text).not.toContain("Flow guarantee: Process");
    }
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

test("observed final count includes bound upstream group grain, not hidden tables", () => {
  const f = calculationFixture();
  const selection = observe(f, { data: false });
  expect(selection.text).toContain('group keys=["account","region"]');
  expect(selection.text).toContain("groups=5 from 10 rows");
  expect(selection.text).toContain("row denominator=10/10");
  expect(selection.text).not.toContain("UNOBSERVED_ROW_CANARY");
  expect(selection.text).not.toContain("statistics:");
  expect(selection.selected.some(id => id.startsWith("flow.upstream."))).toBe(true);
  expect(observe(f, { flow: false }).text).not.toContain("account");
  expect(selection.text.length).toBeLessThanOrEqual(2000);
});

test("upstream conversion losses survive nearby summaries and remain version bound", () => {
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
  expect(selected.text).toContain('"x" conversion failures=6/10');
  expect(selected.text).toContain('"1,299" × 4');
  expect(selected.chunks.filter(c => c.upstream).length).toBeLessThanOrEqual(3);
  expect(selected.text).not.toContain("UNOBSERVED_ROW_CANARY");
  rawInfo.resultVersion!.inputs[0].resultVersion = "stale";
  expect(observe(f).text).not.toContain("conversion failures");
  expect(observe(f).text).not.toContain("1,299");
});

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
  expect(factText(f)).toContain('"x" conversion failures=2/5');
  expect(factText(f)).not.toContain("failed-value examples");
});

test("upstream summaries stop at stale edges and opaque UDFs", () => {
  const f = calculationFixture();
  f.info.resultVersion!.inputs[0].resultVersion = "older";
  expect(observe(f).text).not.toContain("account");
  f.info.resultVersion!.inputs[0].resultVersion = f.results.get("left")!.resultVersion!.id;
  f.workflow.operators.find(op => op.operatorID === "left")!.nativeOp!.type = "Process";
  const text = observe(f).text;
  expect(text).toContain("mapping unknown");
  expect(text).not.toContain("groups=5 from 10 rows");
  expect(text).not.toContain("UNOBSERVED_ROW_CANARY");
});

test("an observed UDF itself is an opaque calculation boundary", () => {
  const f = calculationFixture();
  f.op.nativeOp!.type = "Process";
  const selection = observe(f);
  expect(selection.text).toContain("mapping unknown");
  expect(selection.selected.some(id => id.startsWith("flow.upstream."))).toBe(false);
  expect(selection.text).not.toContain("account");
});

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

test("empty grouped aggregate has zero groups and undefined per-group range", () => {
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
  expect(factText(f)).toContain("groups=0 from 0 rows");
  expect(factText(f)).toContain('"n" row denominator=0/0 (no rows)');
});

test("aggregate semantics: what a distinct count counts, a key that pools entities, an unread flag", () => {
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
  expect(text).toContain(
    '"areas" = count_distinct("GlobalID"): "GlobalID" is unique on every one of the 12 input rows, so it counts rows; input columns with fewer values: "GACCName" (2)'
  );
  expect(text).toContain('group key ["state"] determines "Community" in most groups but not in 1 of 3');
  expect(text).toContain(
    'input column "Case_excluded" was read by no operator on the way here; over the 12 rows reduced it is "No":11, "Yes":1.'
  );
  // A flag the lineage filtered on has been read: no line.
  f.workflow.operators[0].nativeOp!.properties = { keep: ["Case_excluded", "GlobalID", "GACCName", "state"] };
  expect(factText(f)).not.toContain("was read by no operator");
});

test("per-file scan findings cannot push the file and row counts out of the flow budget", () => {
  const f = fixture("Scan", { files: "data/legal/*.csv" });
  const sources = Array.from({ length: 30 }, (_, i) => ({
    path: `/data/legal/2024_CSN_Report_${String(i).padStart(2, "0")}_${"Category".repeat(4)}.csv`,
    headerCheck: { blank: 3, suggest: { skipLines: 2, header: ["Year", "Category", "# of Reports", "Percentage"] } },
  }));
  f.info.tableProfile!.native!.operations = {
    scan: { preview: false, resolvedFiles: 30, selectedFiles: 30, omittedFiles: 0, sources },
  };
  // The execute receipt's selection: flow only, the operator's own facts.
  const own = observe(f, { data: false, flowMaxChars: 2000, upstream: false });
  const flow = own.chunks.filter(chunk => chunk.id.startsWith("flow."));
  expect(flow[0].text).toBe("- flow: Scan parsed selected sources; files selected=30/30, omitted=0; output=3 rows.");
  expect(flow.at(-1)!.text).toBe(FLOW_OMITTED_NOTICE);
  expect(own.omitted.some(item => item.reason === "budget" && item.id.startsWith("flow.scan.header."))).toBe(true);
  expect(own.text.length).toBeLessThanOrEqual(2000 + own.chunks[0].text.length + 1);
});
