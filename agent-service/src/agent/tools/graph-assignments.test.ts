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

// Assignment edits (`x = op(inputs, ...)`), shared functions called by name
// with settings, and ordered limits.
import { expect, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planGraphEdit, inspectGraph } from "./graph-edits";
import { computeStaleResultOps } from "../workflow-snapshot-storage";

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

const SCORE = `def score(orders, weight=0.5, minimum=1):
    """Units with at least {minimum} orders, scored with delivery weight {weight}."""
    counts = orders.groupby("unit").size().rename("orders").reset_index()
    counts["score"] = counts["orders"] * weight
    return counts[counts["orders"] >= minimum]`;

test("an assignment creates an operator whose call arguments become its input edges", async () => {
  const state = new WorkflowState();
  const result = await edit(
    state,
    'orders = scan("data/orders.csv")\ndelivered = filter(orders, lambda row: row["delivered"] == True, doc="Delivered orders")\ntotals = aggregate(delivered, by=["unit"], amount=sum("amount"))'
  );
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(["orders.out -> delivered.in", "delivered.out -> totals.in"]);
  expect(state.getOperator("totals")!.nativeOp!.source).toBe('aggregate(by=["unit"], amount=sum("amount"))');
  expect(result.changes.filter(change => change.operation === "create_operator")).toHaveLength(3);
  // Restating an operator with another input rewires it; an identical restatement changes nothing.
  await edit(state, 'orders2 = scan("data/orders2.csv")');
  const rewired = await edit(state, 'delivered = filter(orders2, lambda row: row["delivered"] == True, doc="Delivered orders")');
  expect(inspectGraph(state.getWorkflowContent()).edges).toContain("orders2.out -> delivered.in");
  expect(rewired.changes.map(change => change.operation).sort()).toEqual(["create_edge", "delete_edge"]);
  const same = await edit(state, 'totals = aggregate(delivered, by=["unit"], amount=sum("amount"))');
  expect(same.changes).toEqual([]);
  await expect(edit(state, 'totals = aggregate(totals, by=["unit"], n=count())')).rejects.toThrow("cannot be its own input");
  await expect(edit(state, "copy = totals")).rejects.toThrow("only renames");
  // A rejected call shows a saved reference as written, never its placeholder.
  await expect(edit(state, "top = limit(filter(orders@1, lambda row: True, doc=\"All\"), 1)")).rejects.toThrow(
    "got filter(orders@1, "
  );
  await edit(state, "del totals, orders");
  expect(state.getOperator("totals")).toBeUndefined();
  expect(state.getOperator("orders")).toBeUndefined();
});

test("a shared function is an operator with settings, and redefining it updates every caller", async () => {
  const state = new WorkflowState();
  await edit(state, `orders = scan("data/orders.csv")\n${SCORE}\nscores = score(orders)\nstrict = score(orders, minimum=3)`);
  const scores = state.getOperator("scores")!.nativeOp!;
  expect(scores.type).toBe("Process");
  expect(scores.properties).toMatchObject({ entry: "score", params: {}, shared: true });
  expect(scores.properties.doc).toBe("Units with at least 1 orders, scored with delivery weight 0.5.");
  expect(state.getOperator("strict")!.nativeOp!.properties.params).toEqual({ minimum: 3 });
  expect(state.getOperator("strict")!.nativeOp!.properties.doc).toContain("at least 3 orders");
  expect(state.getOperator("strict")!.nativeOp!.source).toBe("score(minimum=3)");
  // A later edit can call the function without restating it.
  await edit(state, "loose = score(orders, weight=0.2)");
  expect(state.getOperator("loose")!.nativeOp!.properties.code).toContain("def score(orders, weight=0.5, minimum=1):");
  // Redefine in place: every caller is rebuilt and its result invalidated.
  const before = state.getWorkflowContent();
  const redefined = await edit(state, SCORE.replace('counts["orders"] * weight', 'counts["orders"] * weight * 2'));
  for (const id of ["scores", "strict", "loose"])
    expect(state.getOperator(id)!.nativeOp!.properties.code).toContain("weight * 2");
  expect(state.getOperator("strict")!.nativeOp!.properties.params).toEqual({ minimum: 3 });
  expect([...computeStaleResultOps(before, state.getWorkflowContent())].sort()).toEqual(["loose", "scores", "strict"]);
  expect(redefined.notes?.join(" ")).toContain("score redefined; its callers scores, strict, loose recompute");
});

test("shared-function calls are checked against the signature, and unused or copied functions are named", async () => {
  const state = new WorkflowState();
  await edit(state, `orders = scan("data/orders.csv")\n${SCORE}\nscores = score(orders)`);
  await expect(edit(state, "bad = score(orders, threshold=2)")).rejects.toThrow("has no setting threshold; its settings are weight, minimum");
  await expect(edit(state, "bad = score(orders, scores)")).rejects.toThrow("takes 1 input table(s)");
  await expect(edit(state, 'bad = score(orders, weight="x" + "y")')).rejects.toThrow();
  await expect(edit(state, 'def helper(t):\n    """Unused."""\n    return t')).rejects.toThrow("defined but never used");
  await expect(edit(state, 'def nodoc(t):\n    return t\nx = nodoc(orders)')).rejects.toThrow("docstring");
  // A table may share its function's name; the two never collide, and the
  // table is an input like any other, in the same edit or a later one.
  await edit(state, 'score = score(orders, minimum=2)\nbest = limit(score, 1, by=[("score", "desc")])');
  expect(state.getOperator("score")!.nativeOp!.properties).toMatchObject({ entry: "score", params: { minimum: 2 } });
  expect(inspectGraph(state.getWorkflowContent()).edges).toContain("score.out -> best.in");
  await edit(state, 'kept = filter(score, lambda row: row["orders"] > 2, doc="Busy units")');
  expect(inspectGraph(state.getWorkflowContent()).edges).toContain("score.out -> kept.in");
  await edit(state, "del kept, best, score");
  const copied = await edit(state, `${SCORE.replace("def score(", "def score_copy(").replace("weight", "w")}\nother = score_copy(orders)`);
  expect(copied.notes?.join(" ")).toContain("score_copy repeats score");
  // Helpers at the margin travel with the functions that call them.
  await edit(
    state,
    'def clip(values, cap):\n    return values.clip(upper=cap)\ndef capped(t, cap=10):\n    """Scores capped at {cap}."""\n    t = t.copy()\n    t["score"] = clip(t["score"], cap)\n    return t\nlimited = capped(scores, cap=5)'
  );
  const code = String(state.getOperator("limited")!.nativeOp!.properties.code);
  expect(code.indexOf("def clip(")).toBeLessThan(code.indexOf("def capped("));
});

test("limit with by keeps the top n by its keys in one operator", async () => {
  const state = new WorkflowState();
  await edit(state, 'orders = scan("data/orders.csv")\ntop = limit(orders, 3, by=[("amount", "desc"), "unit"])');
  expect(state.getOperator("top")!.nativeOp!.properties).toEqual({ n: 3, by: [{ col: "amount", desc: true }, { col: "unit" }] });
});

test("the old command form still parses, but not mixed with assignments", async () => {
  const state = new WorkflowState();
  await edit(state, 'create operator source: scan("data/a.csv")\ncreate operator total: aggregate(by=["region"], n=count())\ncreate edge source.out -> total.in');
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(["source.out -> total.in"]);
  await expect(edit(state, 'x = scan("b.csv")\ncreate edge x.out -> total.in')).rejects.toThrow("write the whole edit as assignments");
});
