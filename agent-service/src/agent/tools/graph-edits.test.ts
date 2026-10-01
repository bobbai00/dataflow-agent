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
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planGraphEdit, inspectGraph, missingGraphInputs } from "./graph-edits";
import { computeStaleResultOps } from "../workflow-snapshot-storage";
import { compileNativeOp } from "../native/codegen";

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
const chain = `create operator source: scan("data/a.csv")
create operator selected: project(keep=["region", "amount"])
create operator total: aggregate(by=["region"], total=sum("amount"))
create edge source.out -> selected.in
create edge selected.out -> total.in`;

test("graph edits keep definitions separate from edges and expose named ports", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["selected"]);
  const graph = inspectGraph(state.getWorkflowContent());
  expect(graph.edges).toContain("source.out -> selected.in");
  expect(graph.operators.find(o => o.id === "selected")!.ports).toEqual({ inputs: ["in"], outputs: ["out"] });
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("create and update are distinct and invalid edits are atomic", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  for (const bad of [
    'create operator source: scan("b.csv")',
    'update operator absent: scan("b.csv")',
    'create operator extra: scan("b.csv")\ncreate edge absent.out -> total.in',
    "delete operator selected\nupdate operator absent: limit(1)",
    "update edge source.out -> total.in",
    "modify edge source.out -> total.in",
    "create operator bad: limit(source, 1)",
  ]) {
    await expect(edit(state, bad)).rejects.toThrow();
    expect(state.getWorkflowContent()).toEqual(before);
  }
});

test("expression syntax errors name the command's line in the edit", async () => {
  const state = new WorkflowState();
  await expect(
    edit(state, 'create operator source: scan("data.csv")\ncreate operator typed: cast(Age (years)=float64)')
  ).rejects.toThrow("Line 2:");
  expect(state.getAllOperators()).toEqual([]);
});

test("reserved operator names explain the rename and keep the edit atomic", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  await expect(
    edit(state, 'delete operator selected\ncreate operator global: scan("data.csv")')
  ).rejects.toThrow("Line 2: `global` is a Python keyword");
  expect(state.getWorkflowContent()).toEqual(before);
  await expect(edit(state, 'create operator global: scan("data.csv")')).rejects.toThrow("global_data");
  await edit(state, 'create operator global_data: scan("data.csv")');
  expect(state.getOperator("global_data")).toBeDefined();
});

test("an indented graph command reports its own line and leaves the graph intact", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  await expect(edit(state, "delete operator selected\n delete operator total")).rejects.toThrow(
    "Line 2: start graph commands without indentation"
  );
  expect(state.getWorkflowContent()).toEqual(before);
});

test.each(["update", "modify"])("%s preserves connections and invalidates descendants", async verb => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  const result = await edit(
    state,
    `${verb} operator selected: project(keep=["region", "amount"], rename={"amount": "value"})`
  );
  const after = state.getWorkflowContent();
  expect(result.changes).toEqual([{ operation: "update_operator", operator_id: "selected" }]);
  expect(after.links).toEqual(before.links);
  expect(state.getOperator("selected")!.nativeOp!.inputs).toEqual(["source"]);
  expect(computeStaleResultOps(before, after)).toEqual(new Set(["selected", "total"]));
});

test("operator deletion reports every incident edge and leaves consumers unconnected", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const result = await edit(state, "delete operator selected");
  expect(result.changes[0].deleted_edges).toEqual(["source.out -> selected.in", "selected.out -> total.in"]);
  expect(state.getOperator("total")).toBeDefined();
  expect(state.getAllLinks()).toEqual([]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual(["total.in"]);
  await edit(state, "create edge source.out -> total.in");
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["source"]);
});

test("rewiring requires an explicit edge deletion and invalidates the receiving branch", async () => {
  const state = new WorkflowState();
  await edit(state, chain + '\ncreate operator alternative: scan("b.csv")');
  await expect(edit(state, "create edge alternative.out -> selected.in")).rejects.toThrow("occupied");
  const before = state.getWorkflowContent();
  await edit(state, "delete edge source.out -> selected.in\ncreate edge alternative.out -> selected.in");
  expect(state.getOperator("selected")!.nativeOp!.inputs).toEqual(["alternative"]);
  expect(computeStaleResultOps(before, state.getWorkflowContent())).toEqual(new Set(["selected", "total"]));
});

test("invalid ports and cycles cannot enter the graph", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  for (const bad of [
    "create edge source.out -> total.left",
    "create edge source.wrong -> total.in",
    "create edge source.out -> source.in",
    "delete edge source.out -> total.in",
    "delete edge source.out -> selected.in\ncreate edge total.out -> selected.in",
  ]) {
    await expect(edit(state, bad)).rejects.toThrow();
  }
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("joins have distinct left and right ports including a self-join", async () => {
  const state = new WorkflowState();
  await edit(
    state,
    `create operator source: scan("a.csv")
create operator combined: join(on="id")
create edge source.out -> combined.left
create edge source.out -> combined.right`
  );
  expect(state.getAllLinks()).toHaveLength(2);
  const view = state.getOperator("combined")!.nativeOp!;
  expect(view.inputs).toEqual(["source", "source"]);
  const code = compileNativeOp(view, "combined").code;
  expect(code).toContain("def process(_input_0, _input_1)");
  await expect(edit(state, 'update operator combined: project(keep=["id"])')).rejects.toThrow();
});

test("union inputs are ordered, can grow, and gaps remain explicitly unconnected", async () => {
  const state = new WorkflowState();
  await edit(
    state,
    `create operator a: scan("a.csv")
create operator b: scan("b.csv")
create operator u: union(schema="align")
create edge a.out -> u.in[0]
create edge b.out -> u.in[2]`
  );
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual(["u.in[1]"]);
  await edit(state, "create edge a.out -> u.in[1]");
  expect(state.getOperator("u")!.nativeOp!.inputs).toEqual(["a", "a", "b"]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("custom implementations belong to their operator and declare process input count", async () => {
  const state = new WorkflowState();
  await edit(
    state,
    `create operator source: scan("a.csv")
create operator fitted: process(fn=fit, doc="Compare the two input tables")
    def fit(left, right):
        import pandas as pd
        return pd.DataFrame({"difference": [len(left) - len(right)]})
create edge source.out -> fitted.in[0]
create edge source.out -> fitted.in[1]`
  );
  expect(inspectGraph(state.getWorkflowContent()).operators.find(o => o.id === "fitted")!.ports.inputs).toEqual([
    "in[0]",
    "in[1]",
  ]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
  expect(state.getOperator("fitted")!.nativeOp!.properties.code).toContain("def fit(left, right)");
});

test("multiline parameters and command text inside Python strings parse without changing boundaries", async () => {
  const state = new WorkflowState();
  await edit(
    state,
    `create operator source: scan(
    "a.csv",
    skip_lines=2
)
create operator loaded: process(fn=load, doc="A diagnostic source")
    def load():
        import pandas as pd
        text = """first
create operator fake: scan('never.csv')
last"""
        return pd.DataFrame({"text": [text]})`
  );
  expect(state.getAllOperators().map(o => o.operatorID)).toEqual(["source", "loaded"]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});
