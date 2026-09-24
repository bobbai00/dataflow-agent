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
import { WorkflowState } from "../workflow-state";
import type { ReActStep } from "../../types/agent";
import { answerSources, buildTaskEntry, renderLiveIndex, renderTaskEntry } from "./task-entries";

function operator(id: string, source: string, extra: Record<string, unknown> = {}) {
  return {
    operatorID: id,
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: { type: "Filter", properties: {}, inputs: [], source, ...extra },
  } as any;
}

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ k: from + i, v: `v${from + i}` }));

function receipt(operators: Array<Record<string, unknown>>, observe: string[] = []) {
  return {
    id: `s${Math.random()}`,
    role: "agent",
    messageId: "m5",
    content: "",
    toolCalls: [{ toolName: "dataflow", toolCallId: "c", input: { edits: "", observe } }],
    toolResults: [{ toolCallId: "c", output: { kind: "native-batch", operators, observe, observationErrors: [] } }],
  } as unknown as ReActStep;
}

test("an entry folds the task's receipts into one change per operator, with doc, rows, flags and sources", () => {
  const state = new WorkflowState();
  state.addOperator(
    operator("parsed", 'parsed = map(cleaned, ratio_value, doc="Adds ratio = female share divided by male share")', {
      properties: { doc: "Adds ratio = female share divided by male share" },
      functions: { ratio_value: "def ratio_value(row):\n    return 1" },
    })
  );
  state.addOperator(
    operator(
      "cleaned_universities",
      'cleaned_universities = filter(parsed, lambda row: row["ratio"] > 5, doc="Keeps universities with ratio above 5")',
      { properties: { doc: "Keeps universities with ratio above 5" } }
    )
  );
  state.addOperator(operator("before_stats", 'before_stats = aggregate(parsed, mean_total=mean("total"))'));
  const steps: ReActStep[] = [
    {
      id: "u",
      role: "user",
      messageId: "m5",
      content: "After cleaning, how many universities remain?",
      isBegin: true,
    } as any,
    receipt([{ id: "parsed", op: "map", status: "modified", message: "" }]),
    receipt(
      [
        { id: "cleaned_universities", op: "filter", status: "added", message: "" },
        { id: "before_stats", op: "aggregate", status: "added", message: "" },
        { id: "probe", op: "delete", status: "deleted", message: "" },
        {
          id: "broken",
          op: "filter",
          status: "error",
          message: "[INVALID_ARGUMENTS] doc missing\nHint: …",
          attempted: { source: "broken = filter(parsed)" },
        },
      ],
      ["cleaned_universities", "before_stats"]
    ),
    {
      id: "a",
      role: "agent",
      messageId: "m5",
      content: 'Final Answer: {"remaining": 0, "mean_before": 38.7028}',
      isEnd: true,
    } as any,
  ];
  const results = new Map<string, any>([
    ["parsed", { state: "Completed", totalRowCount: 800, resultSchema: [{ name: "ratio" }, { name: "total" }] }],
    ["cleaned_universities", { state: "Completed", totalRowCount: 0, resultSchema: [{ name: "ratio" }] }],
    ["before_stats", { state: "Completed", totalRowCount: 1, result: [{ mean_total: 38.70281 }] }],
  ]);
  const history = {
    provenance: () => new Map([["parsed", { created: 3, edited: [5], lastSaved: 5, gaps: [] }]]),
    entries: () => [],
  } as any;
  const entry = buildTaskEntry({ task: 5, steps, results, state, history });
  expect(entry.changes.map(c => [c.status, c.id])).toEqual([
    ["modified", "parsed"],
    ["added", "cleaned_universities"],
    ["added", "before_stats"],
    ["deleted", "probe"],
    ["failed", "broken"],
  ]);
  expect(entry.changes[0]).toMatchObject({
    doc: "Adds ratio = female share divided by male share",
    rows: 800,
    replaces: 3,
  });
  expect(entry.changes[0].functions).toBeUndefined(); // the doc stands in for the body
  expect(entry.changes[1]).toMatchObject({ flag: "EMPTY", rows: 0 });
  expect(entry.changes[4].flag).toBe("failed: [INVALID_ARGUMENTS] doc missing");
  expect(entry.from).toEqual(["before_stats"]); // 38.7028 is a cell of before_stats, not of the empty table
  const text = renderTaskEntry(entry);
  expect(text).toContain("## Task 5");
  expect(text).toContain("modified parsed = map(cleaned, ratio_value, doc=");
  expect(text).toContain("→ rows=800; cols=ratio,total; replaces task 3");
  expect(text).toContain("doc: Adds ratio = female share divided by male share");
  expect(text).toContain("→ rows=0; cols=ratio; ⚠ EMPTY");
  expect(text).toContain("deleted  probe deleted");
  expect(text).toContain("failed   broken = filter(parsed)");
  // The rows the task read follow the changes: the answer-bearing table, whole.
  expect(entry.tables).toEqual([
    { id: "before_stats", total: 1, complete: true, text: "\tmean_total\n0\t38.70281" },
  ]);
  expect(text).toContain("Tables read:\n  before_stats (1 row, complete):\n  \tmean_total\n  0\t38.70281\nAnswer:");
  expect(text).toContain('Answer: Final Answer: {"remaining": 0, "mean_before": 38.7028}\n  from: before_stats');
});

test("a large table keeps its first rows, unchanged rows point at the entry that shows them, and the budget bounds an entry", () => {
  const state = new WorkflowState();
  for (const id of ["big", "same", "wide"]) state.addOperator(operator(id, `${id} = scan("x.csv")`));
  const cells = rows(60).map(row => ({ ...row, v: "x".repeat(70) }));
  const results = new Map<string, any>([
    ["big", { state: "Completed", totalRowCount: 5063, result: rows(10) }],
    ["same", { state: "Completed", totalRowCount: 2, result: rows(2) }],
    ["wide", { state: "Completed", totalRowCount: 60, result: cells.slice(0, 3) }],
  ]);
  const shown = { id: "same", total: 2, complete: true, text: "\tk\tv\n0\t0\tv0\n1\t1\tv1" };
  const history = {
    provenance: () => new Map(),
    entries: () => [{ task: 2, request: "", changes: [], tables: [shown], answer: "", from: [] }],
  } as any;
  const steps: ReActStep[] = [
    { id: "u", role: "user", messageId: "m", content: "q", isBegin: true } as any,
    receipt([], ["big", "same", "wide"]),
    { id: "a", role: "agent", messageId: "m", content: "Final Answer: 5063", isEnd: true } as any,
  ];
  const entry = buildTaskEntry({ task: 4, steps, results, state, history });
  expect(entry.tables.map(t => [t.id, t.complete, t.sameAs, t.text.split("\n").length])).toEqual([
    ["big", false, undefined, 4], // header + first 3 rows of 5063
    ["same", true, 2, 1], // identical rows already shown in task 2: no text
    ["wide", false, undefined, 4],
  ]);
  expect(entry.tables[2]!.text).toContain("xxxxxxxxx…"); // cells are clipped
  const text = renderTaskEntry(entry);
  expect(text).toContain("  big (first 3 of 5063 rows):\n  \tk\tv\n  0\t0\tv0\n  1\t1\tv1\n  2\t2\tv2");
  expect(text).toContain("  same: same rows as shown in task 2");
  // Past the budget, a table is listed by size alone.
  const many = new Map<string, any>();
  const crowded = new WorkflowState();
  const ids = Array.from({ length: 8 }, (_, i) => `t${i}`);
  for (const id of ids) {
    crowded.addOperator(operator(id, `${id} = scan("x.csv")`));
    many.set(id, { state: "Completed", totalRowCount: 20, result: rows(20).map(r => ({ ...r, v: "y".repeat(40) })) });
  }
  const bounded = buildTaskEntry({
    task: 1,
    steps: [steps[0]!, receipt([], ids), steps[2]!],
    results: many,
    state: crowded,
    history: { provenance: () => new Map(), entries: () => [] } as any,
  });
  const rendered = bounded.tables.map(t => renderTaskEntry({ ...bounded, tables: [t] }).length);
  expect(bounded.tables.filter(t => t.text).length).toBeLessThan(ids.length);
  expect(bounded.tables.filter(t => t.text).reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(4000);
  expect(renderTaskEntry(bounded)).toContain(`${bounded.tables.find(t => !t.text)!.id}: 20 rows, not shown here`);
  expect(rendered.length).toBe(ids.length);
});

test("answer values are matched against the tables the task observed", () => {
  const results = new Map<string, any>([
    ["a", { result: [{ n: 721, mean: 38.66051 }] }],
    ["b", { result: [{ n: 718 }] }],
  ]);
  expect(answerSources("721 universities remain, mean 38.6605", ["a", "b"], results)).toEqual(["a"]);
  expect(answerSources("nothing numeric here", ["a"], results)).toEqual([]);
});

test("the live index names every current table with its history and flags empty or failed tables", () => {
  const state = new WorkflowState();
  state.addOperator(operator("uof", 'uof = scan("x.csv")'));
  state.addOperator(operator("cleaned", 'cleaned = filter(uof, lambda row: True, doc="all")'));
  const results = new Map<string, any>([
    ["uof", { state: "Completed", totalRowCount: 100 }],
    ["cleaned", { state: "Completed", totalRowCount: 0 }],
  ]);
  const history = {
    provenance: () =>
      new Map([
        ["uof", { created: 1, edited: [], lastSaved: 5, gaps: [] }],
        ["cleaned", { created: 2, edited: [5], lastSaved: 5, gaps: [] }],
      ]),
  } as any;
  const text = renderLiveIndex(state, results, history);
  expect(text).toBe(
    "# Tables now\nuof (t1) · cleaned (t2, edited t5)\n⚠ cleaned has 0 rows; everything built on it is empty"
  );
});

test("the live index marks a table whose upstream changed after its own last change", () => {
  const state = new WorkflowState();
  state.addOperator(operator("uof", 'uof = scan("x.csv")'));
  state.addOperator(operator("cleaned", 'cleaned = filter(uof, lambda row: True, doc="all")', { inputs: ["uof"] }));
  state.addOperator(operator("stats", 'stats = aggregate(cleaned, n=count())', { inputs: ["cleaned"] }));
  const results = new Map<string, any>([
    ["uof", { state: "Completed", totalRowCount: 100 }],
    ["cleaned", { state: "Completed", totalRowCount: 90 }],
    ["stats", { state: "Completed", totalRowCount: 1 }],
  ]);
  const history = {
    provenance: () =>
      new Map([
        ["uof", { created: 1, edited: [4], lastSaved: 6, gaps: [] }],
        ["cleaned", { created: 2, edited: [], lastSaved: 6, gaps: [] }],
        ["stats", { created: 3, edited: [6], lastSaved: 6, gaps: [] }],
      ]),
  } as any;
  // cleaned's rows shown at task 2 are outdated by uof's edit at task 4; stats
  // was itself redefined at task 6, after that edit, so its rows are current.
  expect(renderLiveIndex(state, results, history)).toBe(
    "# Tables now\nuof (t1, edited t4) · cleaned (t2, recomputed t4) · stats (t3, edited t6)"
  );
});

test("a long request and answer are kept whole: the first request carries rules every later task inherits", () => {
  const state = new WorkflowState();
  const request = "Context. ".repeat(400) + "Round decimal-valued results to three decimal places.";
  const answer = "Final Answer: " + "{\"x\": 1.234} ".repeat(200);
  const steps: ReActStep[] = [
    { id: "u", role: "user", messageId: "m", content: request, isBegin: true } as any,
    { id: "a", role: "agent", messageId: "m", content: answer, isEnd: true } as any,
  ];
  const entry = buildTaskEntry({ task: 1, steps, results: new Map(), state });
  expect(entry.request).toBe(request.trim());
  expect(entry.answer).toBe(answer.trim());
  expect(renderTaskEntry(entry)).toContain("Round decimal-valued results to three decimal places.");
});
