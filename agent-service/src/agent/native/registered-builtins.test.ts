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

/**
 * Built-in operators declared through registered edits: their argument
 * normalization, and the generated Python run end to end through its entry
 * points (`load()` for sources, `process(*inputs)` otherwise).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planRegisteredGraphEdit } from "../tools/graph-edits";
import { compileNativeOp, nativePython } from "./codegen";

const metadataStore = new WorkflowSystemMetadata();
metadataStore.seedCodeModeDefaults();

/** Apply one registered edit to the state; a rejected edit throws and changes nothing. */
async function edit(state: WorkflowState, python: string, changes: string) {
  const plan = await planRegisteredGraphEdit(state.getWorkflowContent(), python, changes, { metadataStore });
  state.setWorkflowContent(plan.workflow);
  return plan;
}

/** Run every operator's generated code in dependency order; the requested tables as records. */
function execute(state: WorkflowState, answer: string): any[];
function execute(state: WorkflowState, answer: string[]): Record<string, any[]>;
function execute(state: WorkflowState, answer: string | string[]): any[] | Record<string, any[]> {
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `
import json, sys
operators = json.load(sys.stdin)
pending = {op['operatorID']: op for op in operators}
results = {}
while pending:
    ready = [op for op in pending.values() if all(id in results for id in op['nativeOp']['inputs'])]
    assert ready, 'cycle or missing input'
    for op in ready:
        scope = {}
        exec(op['operatorProperties']['code'], scope)
        inputs = op['nativeOp']['inputs']
        results[op['operatorID']] = scope['process'](*[results[id] for id in inputs]) if inputs else scope['load']()
        del pending[op['operatorID']]
answer = json.loads(sys.argv[1])
if isinstance(answer, str):
    print(results[answer].to_json(orient='records'))
else:
    print(json.dumps({id: json.loads(results[id].to_json(orient='records')) for id in answer}))
`,
      JSON.stringify(answer),
    ],
    { input: JSON.stringify(state.getAllOperators()), encoding: "utf8", timeout: 60_000 }
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}

const loaders = `import pandas as pd

def first_rows():
    return pd.DataFrame({'g': ['a', 'b'], 'v': [1, 2]})

def second_rows():
    return pd.DataFrame({'g': ['b', 'b'], 'v': [2, 3]})
`;

describe("join argument normalization", () => {
  test("semi and anti joins are join types that need keys", async () => {
    const state = new WorkflowState();
    await edit(
      state,
      loaders,
      "set orders: first_rows()\nset units: second_rows()\nset kept: join(orders, units, on='g', how='semi')\nset rest: join(orders, units, on=[('g', 'g')], how='anti')"
    );
    expect(state.getOperator("kept")!.nativeOp!.properties).toMatchObject({ on: "g", type: "semi" });
    expect(state.getOperator("rest")!.nativeOp!.properties).toMatchObject({ on: [["g", "g"]], type: "anti" });
    await expect(edit(state, "", "set bare: join(orders, units, how='semi')")).rejects.toThrow("join needs on=");
    expect(state.getOperator("bare")).toBeUndefined();
    expect(execute(state, ["kept", "rest"])).toEqual({ kept: [{ g: "b", v: 2 }], rest: [{ g: "a", v: 1 }] });
  });

  test("explicit empty keys equal omitted keys only for cross joins", async () => {
    const state = new WorkflowState();
    await edit(
      state,
      loaders,
      "set left: first_rows()\nset right: second_rows()\nset a: join(left, right, how='cross')\nset b: join(left, right, on=[], how='cross')"
    );
    for (const id of ["a", "b"]) expect(state.getOperator(id)!.nativeOp!.properties).toMatchObject({ type: "cross" });
    for (const [changes, cause] of [
      ["set c: join(left, right, on=[], how='inner')", "on needs at least 1 name"],
      ["set d: join(left, right, on='g', how='cross')", "a cross join has no keys"],
      ["set e: join(left, right, how='cross', validate='one_to_one')", "JOIN_KEYS"],
    ])
      await expect(edit(state, "", changes)).rejects.toThrow(cause);
    expect(execute(state, "b")).toHaveLength(4);
  });
});

describe("generated Python", () => {
  test("the compiler keeps the identifier and port guards", () => {
    for (const inputs of [[], ["source", "extra"], ["not-an-id"], ["x): pass #"]]) {
      expect(() => compileNativeOp({ type: "Project", inputs, properties: { keep: ["x"] } }, "answer")).toThrow();
    }
  });

  test("a reversed relational chain lands, wires and runs through the generated entry points", async () => {
    const state = new WorkflowState();
    const plan = await edit(
      state,
      loaders,
      [
        "set answer: limit(ordered, n=1)",
        "set ordered: sort(totals, by=[('n', 'desc')])",
        "set totals: aggregate(dedup, by=['g'], outputs={'n': count()})",
        "set dedup: distinct(combined)",
        "set combined: union(first, second)",
        "set first: first_rows()",
        "set second: second_rows()",
      ].join("\n")
    );
    expect(plan.operators.map(op => op.status)).toEqual(Array(7).fill("added"));
    expect(state.getAllLinks()).toHaveLength(6);
    expect(execute(state, "answer")).toEqual([{ g: "b", n: 2 }]);
    for (const op of state.getAllOperators()) expect(op.operatorProperties.code).not.toContain("import duckdb");
  });

  test("a registered filter, a cast and a self-join run with measured predicate columns", async () => {
    const state = new WorkflowState();
    await edit(
      state,
      `import pandas as pd

def load():
    return pd.DataFrame({'id': [1, 2, 3], 'x': ['1', '2', None], 'y': [10, 20, 30]})

def above(row, *, minimum=1):
    return row['x'] is not None and row['x'] > minimum
`,
      [
        "set source: load()",
        "set typed: cast(source, columns={'x': int64})",
        "set positive: filter(typed, predicate='above', settings={'minimum': 1})",
        "set pairs: join(positive, positive, on='id', validate='one_to_one', suffix='_b')",
      ].join("\n")
    );
    expect(state.getOperator("pairs")!.nativeOp?.inputs).toEqual(["positive", "positive"]);
    expect(execute(state, "pairs")).toEqual([{ id: 2, x: 2, y: 20, x_b: 2, y_b: 20 }]);
    const measured = spawnSync(
      nativePython(),
      [
        "-c",
        "import sys,json,pandas as pd\nns={}\nexec(sys.stdin.read(),ns)\nout=ns['process'](pd.DataFrame({'id':[1],'x':[5],'y':[2]}))\nprint(json.dumps(out.attrs['native_v2']['operations']))",
      ],
      { input: state.getOperator("positive")!.operatorProperties.code, encoding: "utf8", timeout: 30_000 }
    );
    expect(measured.status, measured.stderr).toBe(0);
    expect(JSON.parse(measured.stdout)).toMatchObject({
      keptRows: 1,
      rejectedRows: 0,
      nullPredicates: 0,
      predicateColumns: ["x"],
    });
  });

  test("shape operators run through unpivot, window and pivot, and a source revision refreshes them", async () => {
    const state = new WorkflowState();
    const source = (value: number) =>
      `import pandas as pd\n\ndef load(*, value=${value}):\n    return pd.DataFrame({'code': ['A', 'A'], 'tags': [1, 2], 'y2024': [value, value], 'y2025': [value + 5, value + 5]})`;
    const first = await edit(
      state,
      source(10),
      [
        "set source: load()",
        "set long: unpivot(source, columns=['y2024', 'y2025'])",
        "set lagged: window(long, partition_by=['code', 'tags'], order_by=['variable'], outputs={'previous': lag('value', 1)})",
        "set wide: pivot(lagged, index=['code', 'tags'], columns='variable', values='previous')",
      ].join("\n")
    );
    expect(first.operators.map(op => op.status)).toEqual(Array(4).fill("added"));
    expect(execute(state, "wide")).toEqual([
      { code: "A", tags: 1, y2024: null, y2025: 10 },
      { code: "A", tags: 2, y2024: null, y2025: 10 },
    ]);
    const changed = await edit(
      state,
      "",
      "set source: load(value=20)\nset answer: project(wide, keep=['code', 'tags', 'y2025'])"
    );
    expect(changed.operators.map(op => [op.id, op.status])).toEqual([
      ["source", "modified"],
      ["answer", "added"],
    ]);
    expect(execute(state, "answer")).toEqual([
      { code: "A", tags: 1, y2025: 20 },
      { code: "A", tags: 2, y2025: 20 },
    ]);
    expect(state.getAllLinks()).toHaveLength(4);
  });

  test("window gives percentile ranks and group values without order_by, and aggregate takes quantile", async () => {
    const state = new WorkflowState();
    await edit(
      state,
      "import pandas as pd\n\ndef load():\n    return pd.DataFrame({'side': ['LT', 'LT', 'LT', 'RT', 'RT'], 'plays': [10, 20, 20, 5, None], 'pressure': [0.1, 0.3, 0.2, 0.4, 0.5]})",
      [
        "set players: load()",
        "set graded: window(players, partition_by=['side'], outputs={'plays_pct': pct_rank('plays'), 'pressure_pct': pct_rank('pressure', desc=True), 'side_median': median('plays'), 'p75': quantile('pressure', 0.75), 'n': count()})",
        "set cutoffs: aggregate(players, by=['side'], outputs={'p75': quantile('pressure', q=0.75)})",
      ].join("\n")
    );
    const rounded = (rows: any[]) =>
      rows.map(row =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value,
          ])
        )
      );
    const out = execute(state, ["graded", "cutoffs"]);
    expect(
      rounded(out.graded).map(({ plays_pct, pressure_pct, side_median, p75, n }) => [
        plays_pct,
        pressure_pct,
        side_median,
        p75,
        n,
      ])
    ).toEqual([
      [0.333333, 1, 20, 0.25, 3],
      [0.833333, 0.333333, 20, 0.25, 3],
      [0.833333, 0.666667, 20, 0.25, 3],
      [1, 1, 5, 0.475, 2],
      [null, 0.5, 5, 0.475, 2],
    ]);
    expect(rounded(out.cutoffs)).toEqual([
      { side: "LT", p75: 0.25 },
      { side: "RT", p75: 0.475 },
    ]);
    for (const [statement, message] of [
      ["set r: window(players, outputs={'r': rank()})", "rank and dense_rank need order_by"],
      ["set r: window(players, outputs={'q': quantile('plays')})", "quantile() needs q, a fraction from 0 to 1"],
      ["set r: window(players, outputs={'q': quantile('plays', 75)})", "must be a fraction from 0 to 1"],
      ["set r: window(players, outputs={'p': pct_rank()})", "pct_rank() takes the column"],
      ["set r: aggregate(players, outputs={'q': quantile('plays', 1.5)})", "must be a fraction from 0 to 1"],
    ])
      await expect(edit(state, "", statement)).rejects.toThrow(message);
  });

  test("invalid options are rejected atomically before anything changes", async () => {
    const state = new WorkflowState();
    await edit(state, "", "set source: scan(files='data/placeholder.csv')");
    const before = JSON.stringify(state.getWorkflowContent());
    await expect(
      edit(
        state,
        "",
        "set bad: window(source, order_by=['label'], outputs={'r': rank('x')})\nset parts: project(source, keep=['label'])"
      )
    ).rejects.toThrow("Changes line 1, operator bad: Invalid window arguments: rank() takes no arguments");
    expect(JSON.stringify(state.getWorkflowContent())).toBe(before);
    expect(state.getOperator("parts")).toBeUndefined();
  });
});
