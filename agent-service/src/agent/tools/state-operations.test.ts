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

// The state operations of an edit: a setting changed in place by restating the
// call, an alternative computed alongside, inserting a step, ranking
// comparisons, applying an edit statement by statement, and the forms that are
// refused with the one to write instead.
import { expect, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planGraphEdit, inspectGraph } from "./graph-edits";

const context = () => {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  return { metadataStore };
};
async function edit(state: WorkflowState, changes: string) {
  const result = await planGraphEdit(state.getWorkflowContent(), changes, context());
  state.setWorkflowContent(result.workflow);
  return result;
}
const view = (state: WorkflowState, id: string) => state.getOperator(id)!.nativeOp!;

const SESSION = `stores = scan("data/stores.csv")
def score(stores, sales_weight=0.7, rating_weight=0.3):
    """One row per store: sales_weight times sales plus rating_weight times rating."""
    out = stores.copy()
    out["score"] = sales_weight * out["sales"] + rating_weight * out["rating"]
    return out
scores = score(stores)
ranked = limit(scores, 50, by=[("score", "desc"), "store"])
top10 = limit(ranked, 10, by=[("score", "desc"), "store"])`;

test("restating a call changes its settings in place, and the definition shows every setting", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  expect(view(state, "scores").source).toBe("score(sales_weight=0.7, rating_weight=0.3)");
  const changed = await edit(state, "scores = score(stores, rating_weight=0.6)");
  expect(view(state, "scores").properties.params).toEqual({ rating_weight: 0.6 });
  expect(view(state, "scores").source).toBe("score(sales_weight=0.7, rating_weight=0.6)");
  expect(changed.invalidated_results.sort()).toEqual(["ranked", "scores", "top10"]);
  expect((await edit(state, "scores = score(stores, rating_weight=0.6)")).changes).toEqual([]);
});

test("an alternative is computed alongside, and the main chain stays as it is", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  const before = structuredClone(state.getWorkflowContent());
  await edit(state, 'heavy_scores = score(stores, rating_weight=0.6)\nheavy_top10 = limit(heavy_scores, 10, by=[("score", "desc"), "store"])');
  for (const id of ["scores", "ranked", "top10"])
    expect(state.getOperator(id)!.nativeOp).toEqual(before.operators.find(op => op.operatorID === id)!.nativeOp);
  expect(view(state, "heavy_scores").properties.params).toEqual({ rating_weight: 0.6 });
});

test("retired forms are refused with the statement to write instead", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  await expect(edit(state, "scores.rating_weight = 0.6")).rejects.toThrow("restate the call with it: `scores = function(inputs, rating_weight=...)`");
  await expect(edit(state, "alias = scores")).rejects.toThrow("would give a table a second name");
  await expect(edit(state, 'heavy = variant(top10, scores={"rating_weight": 0.6})')).rejects.toThrow("Unknown operator or function `variant`");
});

test("rank_change takes the earlier and the later table", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nheavy_scores = score(stores, rating_weight=0.6)\nmoves = rank_change(scores, heavy_scores, key=["store"], by=[("score", "desc")], n=10)`);
  expect(view(state, "moves").properties).toEqual({ key: ["store"], by: [{ col: "score", desc: true }], n: 10 });
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["scores.out -> moves.in[0]", "heavy_scores.out -> moves.in[1]"])
  );
});

test("a failing statement and the statements that use it are held back; the rest apply", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  const result = await edit(
    state,
    'extra = limit(scores, 5, by=[("sales", "desc"), "store"])\nbroken = limit(scores, 0)\nshown = filter(broken, lambda row: True, doc="All")\nscores = score(stores, rating_weight=0.5)'
  );
  expect(state.getOperator("extra")).toBeDefined();
  expect(state.getOperator("broken")).toBeUndefined();
  expect(view(state, "scores").properties.params).toEqual({ rating_weight: 0.5 });
  expect(result.held).toEqual([
    { line: 2, statement: "broken = limit(scores, 0)", reason: expect.stringContaining("Invalid limit arguments") },
    { line: 3, statement: 'shown = filter(broken, lambda row: True, doc="All")', reason: "uses `broken` from a statement held back" },
  ]);
  // An unclosed bracket holds back its statement and the ones after it that use it.
  const partial = await edit(state, 'a = limit(scores, 3,\nb = limit(a, 1)\nc = limit(scores, 2)');
  expect(partial.held?.map(h => h.line)).toEqual([1, 2]);
  expect(state.getOperator("c")).toBeDefined();
  // Nothing applies when every statement fails.
  await expect(edit(state, "bad = limit(scores, 0)\nworse = limit(bad, 0)")).rejects.toThrow("No changes were applied");
});

test("rebinding a name within one edit builds a chain, as in Python", async () => {
  const state = new WorkflowState();
  await edit(
    state,
    `${SESSION}\nshort = map(scores, lambda row: {**row, "gap": row["score"] - 1}, doc="Scores with their gap")\nshort = filter(short, lambda row: row["gap"] > 0, doc="Positive gaps")\nshort = sort(short, by=[("gap", "desc"), "store"])`
  );
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["scores.out -> short_v1.in", "short_v1.out -> short_v2.in", "short_v2.out -> short.in"])
  );
  expect([view(state, "short_v1").type, view(state, "short_v2").type, view(state, "short").type]).toEqual(["Map", "Filter", "Sort"]);
  // A plain second assignment is still a mistake: it is held back, the first applies.
  const twice = await edit(state, 'x = limit(scores, 1)\nx = limit(scores, 2)');
  expect(twice.held).toEqual([{ line: 2, statement: "x = limit(scores, 2)", reason: expect.stringContaining("assigned twice in this edit") }]);
  expect(view(state, "x").properties).toEqual({ n: 1 });
});

test("a table rebuilt on steps that read it inserts those steps, in one edit or across edits", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  const result = await edit(
    state,
    `detail = map(scores, lambda row: {**row, "gap": row["score"] - 1}, doc="Scores with their gap")\nscores = project(detail, keep=["store", "score", "gap"])`
  );
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["scores_v1.out -> detail.in", "detail.out -> scores.in", "scores.out -> ranked.in"])
  );
  expect(result.notes).toEqual(
    expect.arrayContaining([expect.stringContaining("scores is now built on detail, which reads the earlier scores; it continues as scores_v1")])
  );
  // A step written in an earlier edit: only it reads the earlier table.
  await edit(state, `flags = map(ranked, lambda row: {**row, "top": row["score"] > 1}, doc="Ranked stores with a top flag")`);
  await edit(state, `ranked = filter(flags, lambda row: row["top"], doc="Top-flagged stores")`);
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["ranked_v1.out -> flags.in", "flags.out -> ranked.in", "ranked.out -> top10.in"])
  );
});

test("a nested operator call is its own step, named after the table that reads it", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nunits = distinct(project(scores, keep=["store"]), columns=["store"])`);
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["scores.out -> units__project.in", "units__project.out -> units.in"])
  );
  expect(view(state, "units__project").properties).toEqual({ keep: ["store"] });
});
