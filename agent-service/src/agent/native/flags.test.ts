/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import type { OperatorInfo, TableFlag } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { ProfileColumn, TableProfile } from "./profiles";
import { applyContractFlags, checkExpectation, contractFlags, flagLine, ownFlags } from "./flags";
import { WorkflowState } from "../workflow-state";
import { buildTaskEntry, flagAlerts, renderLiveIndex, renderTaskEntry } from "./task-entries";
import type { ReActStep } from "../../types/agent";

const str = (value: string, count: number) => ({ value: { type: "str" as const, value }, count });

function column(
  type: ProfileColumn["type"],
  rows: number,
  nulls: number,
  extra: Partial<ProfileColumn> = {}
): ProfileColumn {
  return {
    type,
    rowsProcessed: rows,
    nullCount: nulls,
    nonnullCount: rows - nulls,
    nullRatio: rows ? nulls / rows : null,
    distinctCount: null,
    uniquenessRatio: null,
    min: null,
    max: null,
    frequencies: null,
    omissions: [],
    ...extra,
  };
}

function profile(
  rows: number,
  columns: Record<string, ProfileColumn>,
  operations: Record<string, unknown> = {}
): TableProfile & { resultVersion: string } {
  return {
    version: 1,
    status: "available",
    coverage: { scope: "full", complete: true, expectedWorkers: 1, receivedWorkers: 1, rowsProcessed: rows },
    rowCount: rows,
    columnCount: Object.keys(columns).length,
    schema: Object.entries(columns).map(([name, c]) => ({ name, type: c.type, dtype: c.type })),
    schemaComplete: true,
    columns,
    structure: { duplicateRows: 0, allNullRows: 0, allNullColumns: [] },
    native: { operations },
    producerIds: [],
    omissions: [],
    cost: { collectionMs: 0, cellsProcessed: 0, payloadBytes: 0 },
    resultVersion: "v",
  };
}

function info(rows: number, columns: Record<string, ProfileColumn>, extra: Partial<OperatorInfo> = {}): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows,
    resultMode: "table",
    totalRowCount: rows,
    truncated: false,
    resultSchema: Object.entries(columns).map(([name, c]) => ({ name, type: c.type, encoding: "plain" })),
    tableProfile: profile(rows, columns, (extra as any).operations ?? {}),
    resultVersion: { id: "v", complete: true } as any,
    ...extra,
  };
}

function op(id: string, type: string, inputs: string[] = [], properties: Record<string, unknown> = {}): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: { type, inputs, properties, source: `${id} = ${type.toLowerCase()}(${inputs.join(", ")})` },
  } as OperatorPredicate;
}

const codes = (flags: TableFlag[]) => flags.map(f => f.code);

test("encoding contracts: missing-value tokens, a header repeated in the data, numbers as text", () => {
  const scan = info(500, {
    q40: column("str", 500, 0, { distinctCount: 6, frequencies: { values: [str("yes", 300), str("nan", 143), str("no", 57)], otherCount: 0, truncated: false } }),
    year: column("str", 500, 0, { distinctCount: 4, frequencies: { values: [str("2020", 200), str("2021", 150), str("2022", 140), str("Year", 10)], otherCount: 0, truncated: false } }),
    score: column("str", 500, 3, { distinctCount: 40, frequencies: { values: [str("12", 90), str("7.5", 80), str("1,204", 70)], otherCount: 257, truncated: true } }),
    id: column("str", 500, 0, { distinctCount: 500, frequencies: { values: [str("1", 1), str("2", 1), str("3", 1)], otherCount: 497, truncated: true } }),
  });
  const flags = contractFlags(op("survey", "Scan"), scan, []);
  expect(codes(flags).sort()).toEqual(["HEADER_IN_DATA", "LITERAL_MISSING", "NUMERIC_TEXT", "NUMERIC_TEXT", "NUMERIC_TEXT"].sort());
  const literal = flags.find(f => f.code === "LITERAL_MISSING")!;
  expect(literal.column).toBe("q40");
  expect(literal.text).toBe('column "q40" holds the text "nan" in 143 rows: text, not a missing value (null cells in "q40": 0)');
  expect(literal.origin).toBe("survey");
  expect(flags.find(f => f.code === "HEADER_IN_DATA")!.text).toContain('column "year" contains its own name as a value in 10 rows');
  // The header token does not hide that "year" holds numbers; a key of digits is flagged as well.
  expect(flags.filter(f => f.code === "NUMERIC_TEXT").map(f => f.column).sort()).toEqual(["id", "score", "year"]);
  expect(flags.find(f => f.column === "score")!.text).toContain('holds numbers as text ("12", "7.5", "1,204", …)');
});

test("flags are inherited while the column is still read as text, and dropped once an operator resolves them", () => {
  const upstream = info(500, {
    q40: column("str", 500, 0, { distinctCount: 3, frequencies: { values: [str("yes", 300), str("nan", 143), str("no", 57)], otherCount: 0, truncated: false } }),
  });
  upstream.flags = contractFlags(op("survey", "Scan"), upstream, []);
  expect(codes(upstream.flags)).toEqual(["LITERAL_MISSING"]);
  // A filter keeps the column as text: the flag travels with its origin.
  const filtered = info(300, { q40: column("str", 300, 0) });
  const inherited = contractFlags(op("kept", "Filter", ["survey"]), filtered, [{ id: "survey", info: upstream }]);
  expect(inherited.map(f => [f.code, f.origin])).toEqual([["FILTER_EMPTY", "kept"]].slice(0, 0).concat([["LITERAL_MISSING", "survey"]]));
  expect(flagLine(inherited[0]!, "kept")).toBe('⚠ column "q40" holds the text "nan" in 143 rows: text, not a missing value (null cells in "q40": 0) (from survey)');
  expect(flagLine(inherited[0]!, "survey")).not.toContain("(from");
  // A cast changed the column's type: the encoding flag no longer applies.
  const cast = info(500, { q40: column("float64", 500, 143) });
  expect(codes(contractFlags(op("typed", "Cast", ["survey"]), cast, [{ id: "survey", info: upstream }]))).toEqual([]);
  // A map cleaned the tokens: the output's own complete profile shows none.
  const cleaned = info(500, {
    q40: column("str", 500, 143, { distinctCount: 2, frequencies: { values: [str("yes", 300), str("no", 57)], otherCount: 0, truncated: false } }),
  });
  expect(codes(contractFlags(op("clean", "Map", ["survey"]), cleaned, [{ id: "survey", info: upstream }]))).toEqual([]);
  // A project that dropped the column drops the flag; another column keeps nothing.
  const projected = info(500, { other: column("int64", 500, 0) });
  expect(codes(contractFlags(op("narrow", "Project", ["survey"]), projected, [{ id: "survey", info: upstream }]))).toEqual([]);
  // An inherited flag on a column keeps the upstream origin even when the
  // output's own profile would raise the same flag.
  const same = info(500, {
    q40: column("str", 500, 0, { distinctCount: 3, frequencies: { values: [str("yes", 300), str("nan", 143), str("no", 57)], otherCount: 0, truncated: false } }),
  });
  const again = contractFlags(op("sorted", "Sort", ["survey"]), same, [{ id: "survey", info: upstream }]);
  expect(again.map(f => [f.code, f.origin])).toEqual([["LITERAL_MISSING", "survey"]]);
});

test("operator boundary conditions: join multiplication, skipped nulls, lost casts, empty and total filters, null maps, aligned unions", () => {
  const left = info(721, { id: column("str", 721, 0), x: column("float64", 721, 57) });
  const right = info(300, { id: column("str", 300, 0) });
  const joined = info(1842, { id: column("str", 1842, 0), x: column("float64", 1842, 100) }, {
    operations: { join: { left: { maxMultiplicity: 1 }, right: { maxMultiplicity: 4 } } },
  } as any);
  const multiplied = contractFlags(op("j", "Join", ["l", "r"], { type: "inner" }), joined, [{ id: "l", info: left }, { id: "r", info: right }]);
  expect(multiplied.map(f => f.text)).toEqual([
    "join produced 1842 rows from 721 and 300: keys repeat on at least one side (a key occurs up to 4 times), so rows were multiplied",
  ]);
  // With validate= the engine enforced the cardinality; nothing to flag.
  expect(codes(contractFlags(op("j", "Join", ["l", "r"], { type: "inner", validate: "many_to_one" }), joined, [{ id: "l", info: left }, { id: "r", info: right }]))).toEqual([]);
  // The join flag is about every row of the output: descendants inherit it.
  const downstream = info(10, { id: column("str", 10, 0), n: column("int64", 10, 0) });
  joined.flags = multiplied;
  expect(contractFlags(op("agg", "Aggregate", ["j"], { groupBy: ["id"], aggregations: [{ fn: "count", as: "n" }] }), downstream, [{ id: "j", info: joined }]).map(f => [f.code, f.origin])).toEqual([["JOIN_MULTIPLIED", "j"]]);

  const mean = info(3, { region: column("str", 3, 0), m: column("float64", 3, 0) });
  const skipped = contractFlags(
    op("means", "Aggregate", ["l"], { groupBy: ["region"], aggregations: [{ fn: "mean", col: "x", as: "m" }, { fn: "sum", col: "x", as: "s" }, { fn: "count", as: "n" }] }),
    mean,
    [{ id: "l", info: left }]
  );
  expect(skipped.map(f => f.text)).toEqual(['mean/sum("x") ignored 57 null values of the input: its denominator is 664, not 721']);

  const cast = info(721, { x: column("float64", 721, 12) }, { operations: { conversionFailures: { x: 12, y: 0 } } } as any);
  expect(contractFlags(op("typed", "Cast", ["l"]), cast, [{ id: "l", info: left }]).map(f => [f.code, f.column, f.text])).toEqual([
    ["CAST_LOST", "x", 'cast made 12 values of "x" missing: they did not parse'],
  ]);

  expect(contractFlags(op("none", "Filter", ["l"]), info(0, { id: column("str", 0, 0) }), [{ id: "l", info: left }]).map(f => f.code)).toEqual(["EMPTY", "FILTER_EMPTY"]);
  expect(contractFlags(op("all", "Filter", ["l"]), info(721, { id: column("str", 721, 0) }), [{ id: "l", info: left }]).map(f => f.text)).toEqual([
    "filter kept all 721 rows: the predicate dropped nothing",
  ]);

  const mapped = info(721, { id: column("str", 721, 0), unit_price: column("float64", 721, 721) }, { operations: { addedColumns: ["unit_price"] } } as any);
  expect(contractFlags(op("priced", "Map", ["l"]), mapped, [{ id: "l", info: left }]).map(f => f.text)).toEqual(['added column "unit_price" is null in every row']);

  const unioned = info(1021, { id: column("str", 1021, 0) }, { operations: { alignedMissingColumns: [[], ["x"]] } } as any);
  expect(contractFlags(op("both", "Union", ["l", "r"], { schema: "align" }), unioned, [{ id: "l", info: left }, { id: "r", info: right }]).map(f => f.text)).toEqual([
    'input 2 has no column "x": filled with null in its 300 rows',
  ]);
});

test("expectations are checked on the profile, or on the held rows when the table is complete", () => {
  const cohort = info(742, { id: column("str", 742, 0, { distinctCount: 742 }), score: column("float64", 742, 5), region: column("str", 742, 0) });
  expect(checkExpectation("cohort", { rows: [700, 800], unique: ["id"], columns: ["region"] }, cohort).map(f => [f.code, f.text])).toEqual([
    ["EXPECT_OK", "expectation met: rows=742, has region, unique id"],
  ]);
  expect(checkExpectation("cohort", { rows: 700, nonnull: ["score"], columns: ["zip"], nonempty: true }, cohort).map(f => f.text)).toEqual([
    'expectation failed: rows=742, expected 700; no column "zip"; "score" has 5 null values',
  ]);
  const small: OperatorInfo = {
    state: "Completed",
    inputTuples: 0,
    outputTuples: 3,
    resultMode: "table",
    totalRowCount: 3,
    truncated: false,
    result: [{ k: "a", v: 1 }, { k: "b", v: null }, { k: "b", v: 3 }],
  };
  expect(checkExpectation("small", { unique: ["k"], nonnull: ["v"] }, small).map(f => f.text)).toEqual([
    'expectation failed: "k" is not unique: 2 distinct of 3 rows; "v" has 1 null value',
  ]);
  expect(checkExpectation("gone", { nonempty: true }, undefined).map(f => f.code)).toEqual(["EXPECT_FAILED"]);
});

test("applyContractFlags walks the graph in dependency order, writes tables without flags once, and attaches expectations", () => {
  const workflow: WorkflowContent = {
    operators: [op("survey", "Scan"), op("kept", "Filter", ["survey"]), op("count", "Aggregate", ["kept"], { aggregations: [{ fn: "count", as: "n" }] })],
    links: [
      { linkID: "a", source: { operatorID: "survey", portID: "o" }, target: { operatorID: "kept", portID: "i" } },
      { linkID: "b", source: { operatorID: "kept", portID: "o" }, target: { operatorID: "count", portID: "i" } },
    ],
  } as WorkflowContent;
  const results = new Map<string, OperatorInfo>([
    ["survey", info(500, { q40: column("str", 500, 0, { distinctCount: 2, frequencies: { values: [str("yes", 300), str("nan", 200)], otherCount: 0, truncated: false } }) })],
    ["kept", info(300, { q40: column("str", 300, 0) })],
    ["count", info(1, { n: column("int64", 1, 0) })],
  ]);
  const written: string[] = [];
  applyContractFlags(
    workflow,
    id => results.get(id),
    (id, updated) => {
      written.push(id);
      results.set(id, updated);
    },
    { count: { rows: 1 }, kept: { rows: [400, 500] } }
  );
  expect(written).toEqual(["survey", "kept", "count"]);
  expect(results.get("survey")!.flags!.map(f => f.code)).toEqual(["LITERAL_MISSING"]);
  expect(results.get("kept")!.flags!.map(f => [f.code, f.origin])).toEqual([["LITERAL_MISSING", "survey"], ["EXPECT_FAILED", "kept"]]);
  expect(results.get("count")!.flags!.map(f => [f.code, f.text])).toEqual([["EXPECT_OK", "expectation met: rows=1"]]);
  // A second pass rewrites only the tables with a new expectation.
  written.length = 0;
  applyContractFlags(workflow, id => results.get(id), id => written.push(id), { count: { rows: 2 } });
  expect(written).toEqual(["count"]);
  expect(ownFlags("kept", results.get("kept")).map(f => f.code)).toEqual([]);
  expect(ownFlags("survey", results.get("survey")).map(f => f.code)).toEqual(["LITERAL_MISSING"]);
});

test("entries and indexes carry a table's own flags, never the inherited copies", () => {
  const state = new WorkflowState();
  for (const item of [op("survey", "Scan"), op("kept", "Filter", ["survey"])]) state.addOperator(item);
  const results = new Map<string, OperatorInfo>([
    ["survey", { ...info(500, { q40: column("str", 500, 0) }), flags: [{ code: "LITERAL_MISSING", column: "q40", text: 'column "q40" holds the text "nan" in 200 rows', origin: "survey" }] }],
    ["kept", { ...info(300, { q40: column("str", 300, 0) }), flags: [{ code: "LITERAL_MISSING", column: "q40", text: 'column "q40" holds the text "nan" in 200 rows', origin: "survey" }, { code: "EXPECT_OK", text: "expectation met: rows=300", origin: "kept" }] }],
  ]);
  expect(flagAlerts(state.getAllOperators(), results)).toEqual(['⚠ survey: column "q40" holds the text "nan" in 200 rows']);
  expect(renderLiveIndex(state, results)).toContain('⚠ survey: column "q40" holds the text "nan" in 200 rows');
  const receipt = {
    id: "s1",
    role: "agent",
    messageId: "m1",
    content: "",
    toolCalls: [{ toolName: "dataflow", toolCallId: "c", input: { edits: "", observe: [] } }],
    toolResults: [{ toolCallId: "c", output: { kind: "native-batch", operators: [{ id: "survey", op: "scan", status: "added", message: "" }, { id: "kept", op: "filter", status: "added", message: "" }], observe: [], observationErrors: [] } }],
  } as unknown as ReActStep;
  const entry = buildTaskEntry({
    task: 1,
    steps: [{ id: "u", role: "user", messageId: "m1", content: "Load", isBegin: true } as any, receipt, { id: "a", role: "agent", messageId: "m1", content: "done", isEnd: true } as any],
    results,
    state,
  });
  expect(entry.changes.find(c => c.id === "survey")!.flags).toEqual(['column "q40" holds the text "nan" in 200 rows']);
  expect(entry.changes.find(c => c.id === "kept")!.flags).toBeUndefined();
  expect(renderTaskEntry(entry, true)).toContain('⚠ column "q40" holds the text "nan" in 200 rows');
  expect(renderTaskEntry(entry)).toContain('           ⚠ column "q40" holds the text "nan" in 200 rows');
});
