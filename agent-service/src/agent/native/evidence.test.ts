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
import { collectNativeEvidence, restrictNativeObservation, selectNativeObservation } from "./evidence";

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
      version: "v2",
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
    operations: type === "Filter" ? { keptRows: 3, rejectedRows: 2, nullPredicates: 1 } : {},
  };
  return { op, info, workflow, results, resolveInput: (id: string) => results.get(id) };
}

const factText = (f: ReturnType<typeof fixture>) =>
  collectNativeEvidence(f)
    .facts.map(x => x.text)
    .join("\n");
const observe = (f: ReturnType<typeof fixture>, options = {}) =>
  selectNativeObservation({ ...f, data: true, flow: true, maxChars: 2000, ...options });

test("shape measurements validate their row equations and reject stale or inconsistent counters", () => {
  for (const [kind, properties, rows, operations, validFact, corrupt] of [
    [
      "Explode",
      { column: "x", encoding: "json" },
      6,
      { explode: { emptyParents: 2, arrayElements: 6, nullElements: 1, maxElements: 3 } },
      "flow.explode",
      { explode: { emptyParents: 2, arrayElements: 99, nullElements: 1, maxElements: 3 } },
    ],
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

test("filter uses exact kept/input denominator and declared null policy", () => {
  const f = fixture();
  const facts = collectNativeEvidence(f).facts;
  expect(facts.find(x => x.id === "flow.filter")?.kind).toBe("measurement");
  expect(factText(f)).toContain("kept=3/5");
  expect(factText(f)).toContain("rejected=2");
  expect(factText(f)).toContain("null predicates=1");
  expect(factText(f)).toContain("nulls=drop");
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
  expect(factText(f)).toContain("kept=0/0 (undefined)");
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

test("equijoin distinguishes matched output contribution from row and key coverage", () => {
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
  const text = factText(f);
  expect(text).toContain("matched contribution=6");
  expect(text).toContain("left matched rows=3/5");
  expect(text).toContain("matched keys=1/2");
  expect(text).toContain("right matched rows=2/4");
  expect(text).not.toContain("8 entities");
  f.info.tableProfile!.native!.operations!.join = { type: "left", matchedOutputRows: 100 };
  expect(collectNativeEvidence(f).facts.some(x => x.id.startsWith("flow.join."))).toBe(false);
});

test("projection/derive guarantees are contractual, UDF remains unknown at equal row counts", () => {
  for (const kind of ["Project", "Transform", "Derive", "FillNull", "Cast", "Sort"]) {
    const f = fixture(kind);
    f.info.totalRowCount = f.info.tableProfile!.rowCount = 5;
    f.info.tableProfile!.native!.outputRows = 5;
    expect(collectNativeEvidence(f).facts.find(x => x.id === "flow.contract")?.kind).toBe("guarantee");
  }
  const f = fixture("UDF");
  f.info.totalRowCount = 5;
  expect(factText(f)).toContain("row/column mapping unknown");
  expect(factText(f)).not.toContain("row identities preserved");
});

test("complete small tables outrank redundant data profiles but retain useful input evidence", () => {
  const f = fixture();
  f.info.result = [{ x: 10 }, { x: 20 }, { x: 30 }];
  f.info.truncated = false;
  const selection = observe(f);
  expect(selection.text).toContain("Complete table");
  expect(selection.selected.some(x => x.startsWith("data.column"))).toBe(false);
  expect(selection.text).toContain("kept=3/5");
  expect(selection.omitted.some(x => x.reason === "redundant_complete_table")).toBe(true);
});

test("all exposure arms share typed data formatting and obey the entire result budget", () => {
  const f = fixture();
  for (const data of [false, true])
    for (const flow of [false, true])
      for (const maxChars of [1, 12, 60, 160, 400, 2000]) {
        const selection = observe(f, { data, flow, maxChars });
        expect(selection.text.length).toBeLessThanOrEqual(maxChars);
        if (!data) expect(selection.selected.some(x => x.startsWith("data."))).toBe(false);
        if (!flow) expect(selection.selected.some(x => x.startsWith("flow."))).toBe(false);
        expect(observe(f, { data, flow, maxChars })).toEqual(selection);
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
    expect(observe(f).text).not.toContain("Complete table");
  }
});

test("true null, literal NULL, unsafe int64 and reserved-looking user columns survive rendering", () => {
  const f = fixture("UDF");
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
  expect(text).toContain('null\t"NULL"\t9007199254740993\t"user value"\ttrue');
  expect(text).toContain('"__row_index__"');
  expect(text).toContain('"__is_visualization__"');
});

test("budget selection prioritizes relevant columns beyond the old first/last column cap", () => {
  const f = fixture("Filter", { columns: ["c70"] });
  const names = Array.from({ length: 100 }, (_, i) => `c${i}`);
  f.info.resultSchema = names.map(name => ({ name, type: "int64", encoding: "number-or-decimal-string" }));
  f.info.result = [Object.fromEntries(names.map(name => [name, 1]))];
  f.info.tableProfile!.columns = Object.fromEntries(names.map(name => [name, column(3)]));
  f.info.tableProfile!.columnCount = 100;
  const selected = observe(f, { flow: false, maxChars: 550 });
  expect(selected.text).toContain('"c70"');
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

test("missing evidence is not an execution error and never triggers hidden work", () => {
  const f = fixture();
  delete f.info.tableProfile;
  expect(observe(f).text).toContain("Output Table");
  expect(observe(f).text).not.toContain("[ERROR]");
  expect(observe(f).omitted.some(x => x.id === "profile_unavailable")).toBe(true);
});

test("shape-only and tighter row limits cannot imply complete visibility", () => {
  const f = fixture();
  f.info.result = [{ x: 1 }, { x: 2 }, { x: 3 }];
  f.info.truncated = false;
  expect(observe(f, { detail: "shape" }).text).not.toContain("Complete table");
  expect(observe(f, { maxRows: 1 }).text).not.toContain("Complete table");
});

test("compaction only shortens recorded evidence and never adds new facts", () => {
  const f = fixture();
  f.info.result = [{ x: 10 }, { x: 20 }, { x: 30 }];
  f.info.truncated = false;
  const recorded = observe(f);
  const shape = restrictNativeObservation(recorded, { detail: "shape" });
  expect(shape).not.toContain("Complete table");
  expect(shape).not.toContain("10\n20\n30");
  expect(shape).toContain("kept=3/5");
  expect(shape).not.toContain("Data measurement");
  const sample = restrictNativeObservation(recorded, { maxRows: 1 });
  expect(sample).not.toContain("Complete table");
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
  expect(factText(f)).toContain('"n" row denominator=0/0 (undefined)');
});
