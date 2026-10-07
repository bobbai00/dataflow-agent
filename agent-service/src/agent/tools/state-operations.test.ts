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

// The state operations of an edit: setting changes in place, variants of a
// chain, committing a table, inserting a step, ranking comparisons, and
// applying an edit statement by statement.
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

test("every call shows all its settings, and name.setting = value changes one in place", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  expect(view(state, "scores").source).toBe("score(sales_weight=0.7, rating_weight=0.3)");
  const changed = await edit(state, "scores.rating_weight = 0.6");
  expect(view(state, "scores").properties.params).toEqual({ rating_weight: 0.6 });
  expect(view(state, "scores").source).toBe("score(sales_weight=0.7, rating_weight=0.6)");
  expect(changed.operators[0].message).toBe("updated `scores`: rating_weight 0.3 to 0.6");
  expect(changed.invalidated_results.sort()).toEqual(["ranked", "scores", "top10"]);
  expect((await edit(state, "scores.rating_weight = 0.6")).changes).toEqual([]);
  await expect(edit(state, "scores.weight = 1")).rejects.toThrow("has no setting `weight`; its settings are sales_weight, rating_weight");
  await expect(edit(state, "top10.n = 5")).rejects.toThrow("only shared functions have settings");
});

test("a variant copies the steps between its changes and the table, and leaves them alone", async () => {
  const state = new WorkflowState();
  await edit(state, SESSION);
  const before = structuredClone(state.getWorkflowContent());
  const added = await edit(state, 'heavy = variant(top10, scores={"rating_weight": 0.6})');
  expect(added.operators[0].message).toBe(
    "added variant `heavy` of `top10` with scores.rating_weight=0.6; it copies scores, ranked"
  );
  expect(view(state, "heavy__scores").properties.params).toEqual({ rating_weight: 0.6 });
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["stores.out -> heavy__scores.in[0]", "heavy__scores.out -> heavy__ranked.in", "heavy__ranked.out -> heavy.in"])
  );
  expect(view(state, "heavy").variant).toMatchObject({ name: "heavy", of: "top10", changes: [{ step: "scores", settings: { rating_weight: 0.6 } }] });
  expect(view(state, "heavy").source).toBe('variant(top10, scores={"rating_weight": 0.6})');
  for (const id of ["scores", "ranked", "top10"]) expect(view(state, id)).toEqual(before.operators.find(o => o.operatorID === id)!.nativeOp!);
  // A whole step can be swapped, and deleting the variant removes its copies.
  await edit(state, 'flat = variant(top10, ranked=limit(scores, 20, by=[("sales", "desc"), "store"]))');
  expect(view(state, "flat__ranked").properties).toEqual({ n: 20, by: [{ col: "sales", desc: true }, { col: "store" }] });
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["ranked.out -> top10.in", "scores.out -> flat__ranked.in", "flat__ranked.out -> flat.in"])
  );
  expect(state.getOperator("flat")!.nativeOp!.inputs).toEqual(["flat__ranked"]);
  await edit(state, "del flat");
  expect(state.getOperator("flat__ranked")).toBeUndefined();
  await expect(edit(state, 'x = variant(stores, scores={"rating_weight": 1})')).rejects.toThrow("is not upstream of `stores`");
  await expect(edit(state, "x = variant(top10)")).rejects.toThrow("needs at least one change");
  await expect(edit(state, "heavy__scores.rating_weight = 1")).rejects.toThrow("is a step inside the variant `heavy`");
});

test("committing a variant applies its change to the real steps; committing a table built on another inserts it", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nheavy = variant(top10, scores={"rating_weight": 0.6})\nreport = filter(heavy, lambda row: True, doc="Every heavy row")`);
  const committed = await edit(state, "top10 = heavy");
  expect(view(state, "scores").properties.params).toEqual({ rating_weight: 0.6 });
  expect(state.getOperator("heavy")).toBeUndefined();
  expect(state.getOperator("heavy__scores")).toBeUndefined();
  expect(inspectGraph(state.getWorkflowContent()).edges).toContain("top10.out -> report.in");
  expect(committed.notes?.join(" ")).toContain("top10 now has heavy's changes (scores.rating_weight 0.3 to 0.6)");
  await expect(edit(state, "x = scores")).rejects.toThrow("`x` does not exist yet");
  // A table built on another: the step is inserted after the earlier definition.
  await edit(state, 'trimmed = project(scores, drop=["rating"])');
  const inserted = await edit(state, "scores = trimmed");
  expect(view(state, "scores").type).toBe("Project");
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["stores.out -> scores_v1.in[0]", "scores_v1.out -> scores.in", "scores.out -> ranked.in"])
  );
  expect(inserted.notes?.join(" ")).toContain("continues as scores_v1");
  // The same insertion written directly.
  await edit(state, 'ranked = filter(ranked, lambda row: row["sales"] > 0, doc="Stores with sales")');
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["scores.out -> ranked_v1.in", "ranked_v1.out -> ranked.in", "ranked.out -> top10.in"])
  );
});

test("committing an unrelated table replaces the definition and folds the other name in", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nstrict = score(stores, rating_weight=0.9)\nshown = filter(strict, lambda row: True, doc="Every strict row")`);
  await edit(state, "scores = strict");
  expect(view(state, "scores").properties.params).toEqual({ rating_weight: 0.9 });
  expect(state.getOperator("strict")).toBeUndefined();
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(expect.arrayContaining(["stores.out -> scores.in[0]", "scores.out -> shown.in"]));
  await expect(edit(state, "top10 = ranked__x")).rejects.toThrow("`ranked__x` is not an operator");
});

test("rank_change takes the earlier and the later table", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nheavy_scores = variant(scores, scores={"rating_weight": 0.6})\nmoves = rank_change(scores, heavy_scores, key=["store"], by=[("score", "desc")], n=10)`);
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
    'extra = limit(scores, 5, by=[("sales", "desc"), "store"])\nbroken = limit(scores, 0)\nshown = filter(broken, lambda row: True, doc="All")\nscores.rating_weight = 0.5'
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

test("redefining a variant's name drops its copies, and a setting set on a variant joins its changes", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nheavy = variant(top10, scores={"rating_weight": 0.6})`);
  await edit(state, 'heavy = limit(scores, 3, by=[("score", "desc"), "store"])');
  expect(state.getOperator("heavy__scores")).toBeUndefined();
  expect(view(state, "heavy").variant).toBeUndefined();
  await edit(state, 'light = variant(scores, scores={"rating_weight": 0.1})');
  await edit(state, "light.sales_weight = 0.5");
  expect(view(state, "light").variant!.changes).toEqual([{ step: "scores", settings: { rating_weight: 0.1, sales_weight: 0.5 } }]);
  await edit(state, "scores = light");
  expect(view(state, "scores").properties.params).toEqual({ rating_weight: 0.1, sales_weight: 0.5 });
  expect(state.getOperator("light")).toBeUndefined();
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

test("a nested operator call is its own step, named after the table that reads it", async () => {
  const state = new WorkflowState();
  await edit(state, `${SESSION}\nunits = distinct(project(scores, keep=["store"]), columns=["store"])`);
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(
    expect.arrayContaining(["scores.out -> units__project.in", "units__project.out -> units.in"])
  );
  expect(view(state, "units__project").properties).toEqual({ keep: ["store"] });
});
