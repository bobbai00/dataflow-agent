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
import { planGraphEdit, planGraphDefinitions, inspectGraph, missingGraphInputs } from "./graph-edits";
import { computeStaleResultOps } from "../workflow-snapshot-storage";
import { compileNativeOp } from "../native/codegen";
import { validateNativeSettings } from "../native/settings";
import { nativeAssignmentText } from "../native/catalog";

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
const chain = `source = scan("data/a.csv")
selected = project(source, keep=["region", "amount"])
total = aggregate(selected, by=["region"], total=sum("amount"))`;
const lines = (result: Awaited<ReturnType<typeof edit>>) =>
  result.changes.map(c =>
    c.change === "edge" ? `edge ${c.edge} ${c.action}` : `operator ${c.operator_id} ${c.action} (${c.operator})`
  );

test("typed definitions resolve forward references and compile ordered repeated physical ports", async () => {
  const state = new WorkflowState();
  const before = state.getWorkflowContent();
  const plan = await planGraphDefinitions(
    before,
    [
      {
        type: "set",
        definition: {
          id: "joined",
          operator: "join",
          inputs: ["source", "source"],
          params: { on: [{ left: "id", right: "id" }] },
        },
      },
      {
        type: "set",
        definition: { id: "unioned", operator: "union", inputs: ["joined", "source", "joined"], params: {} },
      },
      { type: "set", definition: { id: "source", operator: "scan", inputs: [], params: { files: ["a.csv"] } } },
    ],
    context()
  );
  expect(state.getWorkflowContent()).toEqual(before);
  state.setWorkflowContent(plan.workflow);
  expect(state.getOperator("joined")!.inputPorts).toHaveLength(2);
  expect(state.getOperator("unioned")!.inputPorts).toHaveLength(3);
  expect(state.getOperator("unioned")!.nativeOp!.inputs).toEqual(["joined", "source", "joined"]);
  expect(state.getAllLinks()).toHaveLength(5);
  expect(state.getOperator("unioned")!.operatorProperties.code).toContain("def process(_input_0, _input_1, _input_2)");
  expect(nativeAssignmentText("source", state.getOperator("source")!.nativeOp!)).toContain('"type":"set"');
});

test("typed replacements preserve consumers and invalidate only their downstream cached graph", async () => {
  const state = new WorkflowState();
  await edit(state, chain + '\nbystander = scan("other.csv")');
  const before = state.getWorkflowContent();
  const plan = await planGraphDefinitions(
    before,
    [
      {
        type: "set",
        definition: {
          id: "selected",
          operator: "project",
          inputs: ["source"],
          params: { keep: ["region", "amount"], rename: [{ from: "amount", to: "value" }] },
        },
      },
    ],
    context()
  );
  expect(plan.workflow.links).toEqual(before.links);
  expect(new Set(plan.invalidated_results)).toEqual(new Set(["selected", "total"]));
  state.setWorkflowContent(plan.workflow);
  const unchanged = await planGraphDefinitions(
    state.getWorkflowContent(),
    [
      {
        type: "set",
        definition: {
          id: "selected",
          operator: "project",
          inputs: ["source"],
          params: { keep: ["region", "amount"], drop: [], rename: [{ from: "amount", to: "value" }] },
        },
      },
    ],
    context()
  );
  expect(unchanged.invalidated_results).toEqual([]);
  const deleted = await planGraphDefinitions(
    state.getWorkflowContent(),
    [{ type: "delete", ids: ["selected"] }],
    context()
  );
  expect(deleted.unconnected_inputs).toEqual(["total.in"]);
  expect(new Set(deleted.invalidated_results)).toEqual(new Set(["total"]));
});

test("typed writes use their final definitions, including delete/recreate, without losing consumers", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  const same = { id: "selected", operator: "project", inputs: ["source"], params: { keep: ["region", "amount"] } };
  const replacement = { ...same, params: { keep: ["region", "amount"], rename: [{ from: "amount", to: "value" }] } };
  for (const commands of [
    [
      { type: "set" as const, definition: same },
      { type: "set" as const, definition: replacement },
    ],
    [
      { type: "delete" as const, ids: ["selected"] },
      { type: "set" as const, definition: replacement },
    ],
  ]) {
    const plan = await planGraphDefinitions(before, commands, context());
    expect(plan.workflow.links).toEqual(before.links);
    expect(plan.workflow.operators.find(op => op.operatorID === "selected")!.nativeOp!.properties.rename).toEqual({
      amount: "value",
    });
    expect(plan.command_results!.map(command => command.status)).toEqual(["superseded", "applied"]);
    expect(plan.operators.filter(op => op.id === "selected")).toHaveLength(1);
  }
  const identical = await planGraphDefinitions(
    before,
    [
      { type: "set", definition: replacement },
      { type: "set", definition: replacement },
    ],
    context()
  );
  expect(identical.command_results!.map(command => command.status)).toEqual(["superseded", "applied"]);
  const canceled = await planGraphDefinitions(
    before,
    [
      { type: "set", definition: { id: "temporary", operator: "scan", inputs: [], params: { files: ["other.csv"] } } },
      { type: "delete", ids: ["temporary"] },
    ],
    context()
  );
  expect(canceled.workflow).toEqual(before);
  await expect(
    planGraphDefinitions(
      before,
      [
        { type: "delete", ids: ["selected"] },
        { type: "set", definition: { ...replacement, inputs: ["total"] } },
      ],
      context()
    )
  ).rejects.toThrow("cycle");
  expect(state.getWorkflowContent()).toEqual(before);
});

test("invalid typed definitions and cyclic rewiring roll back the complete private draft", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  for (const commands of [
    [
      { type: "delete" as const, ids: ["selected"] },
      { type: "set" as const, definition: { id: "bad", operator: "limit", inputs: ["missing"], params: { n: 2 } } },
    ],
    [{ type: "set" as const, definition: { id: "source", operator: "limit", inputs: ["total"], params: { n: 2 } } }],
    [
      {
        type: "set" as const,
        definition: {
          id: "kept",
          operator: "filter",
          inputs: ["source"],
          params: { code: "def keep(x, y):\n    return True", entry: "keep", doc: "" },
        },
      },
    ],
  ]) {
    await expect(planGraphDefinitions(before, commands, context())).rejects.toThrow("No changes were applied.");
    expect(state.getWorkflowContent()).toEqual(before);
  }
});

test("typed edits preserve established profile settings and keep rendering metadata out of engine code", async () => {
  const state = new WorkflowState();
  const metadata = context();
  const original = await planGraphEdit(state.getWorkflowContent(), 'source = scan("a.csv")', {
    ...metadata,
    settings: { nativeProfileCollection: false },
  });
  const plan = await planGraphDefinitions(
    original.workflow,
    [
      { type: "set", definition: { id: "source", operator: "scan", inputs: [], params: { files: ["b.csv"] } } },
      {
        type: "set",
        definition: {
          id: "kept",
          operator: "filter",
          inputs: ["source"],
          params: {
            code: "def ordinary_name(record, limit=2):\n    return record['x'] > limit",
            entry: "",
            doc: "",
          },
        },
      },
    ],
    { ...metadata, settings: { nativeProfileCollection: true, nativeProfileScope: "full" } }
  );
  const source = plan.workflow.operators.find(op => op.operatorID === "source")!;
  const kept = plan.workflow.operators.find(op => op.operatorID === "kept")!;
  expect(source.nativeOp!.profileCollection).toBe(false);
  expect(kept.nativeOp!.profileCollection).toBe(true);
  expect(kept.nativeOp!.profileScope).toBe("full");
  expect(kept.operatorProperties.code).toContain('\\"functionValidation\\":\\"callable\\"');
  expect(kept.operatorProperties.code).toContain('\\"datetimePolicy\\":\\"preserve\\"');
  expect(kept.operatorProperties.code).not.toContain("jsonDefinition");
});

test("project accepts explicit None defaults like omitted optional parameters", async () => {
  for (const [explicit, omitted] of [
    ['keep=["region"], drop=None, rename=None', 'keep=["region"]'],
    ['keep=None, drop=["amount"], rename=None', 'drop=["amount"]'],
    ['keep=None, drop=None, rename={"amount": "value"}', 'rename={"amount": "value"}'],
  ]) {
    const state = new WorkflowState();
    await edit(
      state,
      `source = scan("a.csv")\nexplicit = project(source, ${explicit})\nomitted = project(source, ${omitted})`
    );
    expect(state.getOperator("explicit")!.nativeOp!.properties).toEqual(
      state.getOperator("omitted")!.nativeOp!.properties
    );
  }
  const state = new WorkflowState();
  await expect(
    edit(state, 'source = scan("a.csv")\nempty = project(source, keep=None, drop=None, rename=None)')
  ).rejects.toThrow("project needs");
  await expect(
    edit(state, 'source = scan("a.csv")\ninvalid = project(source, keep=["x"], drop=["y"])')
  ).rejects.toThrow("not both");
  expect(state.getAllOperators()).toEqual([]);
});

test("an assignment creates the operator and an edge from each input, reported one line per change", async () => {
  const state = new WorkflowState();
  const result = await edit(state, chain);
  expect(lines(result)).toEqual([
    "operator source created (scan)",
    "operator selected created (project)",
    "operator total created (aggregate)",
    "edge source -> selected created",
    "edge selected -> total created",
  ]);
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["selected"]);
  const graph = inspectGraph(state.getWorkflowContent());
  expect(graph.edges).toEqual(["source -> selected", "selected -> total"]);
  expect(graph.operators.find(o => o.id === "selected")!.ports).toEqual({ inputs: ["in"], outputs: ["out"] });
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("definitions are stored without inputs and rendered with the current ones", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const view = state.getOperator("total")!.nativeOp!;
  expect(view.source).toBe('aggregate(by=["region"], total=sum("amount"))');
  expect(nativeAssignmentText("total", view)).toBe('total = aggregate(selected, by=["region"], total=sum("amount"))');
  expect(nativeAssignmentText("source", state.getOperator("source")!.nativeOp!)).toBe('source = scan("data/a.csv")');
});

test("statements may refer to operators defined later in the same edit", async () => {
  const state = new WorkflowState();
  await edit(state, `total = aggregate(source, by=["region"], total=sum("amount"))\nsource = scan("data/a.csv")`);
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["source"]);
});

test("reassigning a name replaces its definition, keeps consumers and invalidates descendants", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  const result = await edit(state, 'selected = project(source, keep=["region", "amount"], rename={"amount": "value"})');
  expect(lines(result)).toEqual(["operator selected updated (project)"]);
  const after = state.getWorkflowContent();
  expect(after.links).toEqual(before.links);
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["selected"]);
  expect(computeStaleResultOps(before, after)).toEqual(new Set(["selected", "total"]));
});

test("restating an operator unchanged changes nothing", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  const result = await edit(state, 'selected = project(source,  keep=["region", "amount"])');
  expect(lines(result)).toEqual(["operator selected unchanged (project)"]);
  expect(result.operators).toEqual([]);
  expect(computeStaleResultOps(before, state.getWorkflowContent())).toEqual(new Set());
});

test("restating an operator with another input rewires only that edge", async () => {
  const state = new WorkflowState();
  await edit(state, chain + '\nalternative = scan("b.csv")');
  const before = state.getWorkflowContent();
  const result = await edit(state, 'selected = project(alternative, keep=["region", "amount"])');
  expect(lines(result)).toEqual(["edge source -> selected removed", "edge alternative -> selected created"]);
  expect(state.getOperator("selected")!.nativeOp!.inputs).toEqual(["alternative"]);
  expect(computeStaleResultOps(before, state.getWorkflowContent())).toEqual(new Set(["selected", "total"]));
});

test("del removes operators and their edges and leaves consumers unconnected until restated", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const result = await edit(state, "del selected");
  expect(lines(result)).toEqual([
    "operator selected deleted (project)",
    "edge source -> selected removed",
    "edge selected -> total removed",
  ]);
  expect(state.getOperator("total")).toBeDefined();
  expect(state.getAllLinks()).toEqual([]);
  expect(result.unconnected_inputs).toEqual(["total.in"]);
  await edit(state, 'total = aggregate(source, by=["region"], total=sum("amount"))');
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["source"]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("invalid edits are rejected whole, with the reason and the line", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  for (const [bad, reason] of [
    [
      'extra = scan("b.csv")\nselected = project(absent, keep=["region"])',
      "Line 2: selected's input `absent` is not an operator",
    ],
    ["del absent", "Operator absent does not exist"],
    ['source = project(source, keep=["region"])', "source cannot be its own input"],
    ['source = scan("b.csv")\nsource = scan("c.csv")', "source is assigned twice"],
    ["total = limit(selected, 1)\ndel total", "total is both assigned and deleted"],
    ['del selected\ntotal = aggregate(selected, by=["region"], total=sum("amount"))', "(deleted in this edit)"],
    ["source = limit(total, 1)", "cycle"],
    ["selected = limit(1)", "limit takes the input table as its first positional argument"],
    ['selected = join(source, on="region")', "join takes the left and right tables"],
    ["selected = union(source)", "union takes two or more input tables"],
    ['selected = filter(scan("a.csv"), lambda row: True, doc="All")', "Nested operator calls are not supported"],
    ["selected = source", "must be an operator call"],
    ['selected.keep = ["region"]', "restating the whole definition"],
    ["update operator selected: limit(1)", "write `selected = limit(...)`"],
    ["create edge source.out -> total.in", "edges follow from inputs"],
    ["delete operator selected", "`del name`"],
  ]) {
    await expect(edit(state, bad)).rejects.toThrow(reason);
    expect(state.getWorkflowContent()).toEqual(before);
  }
});

test("syntax errors name their line in the edit", async () => {
  const state = new WorkflowState();
  await expect(edit(state, 'source = scan("data.csv")\ntyped = cast(source, Age (years)=float64)')).rejects.toThrow(
    "Line 2:"
  );
  expect(state.getAllOperators()).toEqual([]);
});

test("reserved operator names explain the rename and keep the edit atomic", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  await expect(edit(state, 'del selected\nglobal = scan("data.csv")')).rejects.toThrow(
    "Line 2: `global` is a Python keyword"
  );
  expect(state.getWorkflowContent()).toEqual(before);
  await expect(edit(state, 'global = scan("data.csv")')).rejects.toThrow("global_data");
  await edit(state, 'global_data = scan("data.csv")');
  expect(state.getOperator("global_data")).toBeDefined();
});

test("an indented statement reports its own line and leaves the graph intact", async () => {
  const state = new WorkflowState();
  await edit(state, chain);
  const before = state.getWorkflowContent();
  await expect(edit(state, 'del total\n    other = scan("b.csv")')).rejects.toThrow(
    "Line 2: start each statement at the margin"
  );
  await expect(edit(state, '  other = scan("b.csv")')).rejects.toThrow("Line 1: start each statement at the margin");
  expect(state.getWorkflowContent()).toEqual(before);
});

test("joins take left then right, including a self-join, and a kind change rewires the ports", async () => {
  const state = new WorkflowState();
  const result = await edit(
    state,
    `source = scan("a.csv")\nother = scan("b.csv")\ncombined = join(source, other, on="id")`
  );
  expect(lines(result).slice(-2)).toEqual([
    "edge source -> combined.left created",
    "edge other -> combined.right created",
  ]);
  await edit(state, 'combined = join(source, source, on="id")');
  const view = state.getOperator("combined")!.nativeOp!;
  expect(view.inputs).toEqual(["source", "source"]);
  expect(compileNativeOp(view, "combined").code).toContain("def process(_input_0, _input_1)");
  const narrowed = await edit(state, 'combined = project(source, keep=["id"])');
  expect(lines(narrowed)).toEqual([
    "operator combined updated (project)",
    "edge source -> combined.left removed",
    "edge source -> combined.right removed",
    "edge source -> combined created",
  ]);
  expect(state.getAllLinks()).toHaveLength(1);
});

test("union inputs are ordered and grow or shrink with the statement", async () => {
  const state = new WorkflowState();
  await edit(state, `a = scan("a.csv")\nb = scan("b.csv")\nu = union(a, b, schema="align")`);
  expect(inspectGraph(state.getWorkflowContent()).edges.slice(-2)).toEqual(["a -> u.in[0]", "b -> u.in[1]"]);
  const grown = await edit(state, 'u = union(a, b, a, schema="align")');
  expect(lines(grown)).toEqual(["operator u updated (union)", "edge a -> u.in[2] created"]);
  expect(state.getOperator("u")!.nativeOp!.inputs).toEqual(["a", "b", "a"]);
  const shrunk = await edit(state, 'u = union(b, a, schema="align")');
  expect(lines(shrunk)).toEqual([
    "operator u updated (union)",
    "edge a -> u.in[0] removed",
    "edge b -> u.in[1] removed",
    "edge a -> u.in[2] removed",
    "edge b -> u.in[0] created",
    "edge a -> u.in[1] created",
  ]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("custom functions belong to their operator, and a process takes one input per parameter", async () => {
  const state = new WorkflowState();
  const result = await edit(
    state,
    `source = scan("a.csv")
fitted = process(source, source, fn=fit, doc="Compare the two input tables")
    def fit(left, right):
        import pandas as pd
        return pd.DataFrame({"difference": [len(left) - len(right)]})`
  );
  expect(lines(result).slice(-2)).toEqual([
    "edge source -> fitted.in[0] created",
    "edge source -> fitted.in[1] created",
  ]);
  expect(inspectGraph(state.getWorkflowContent()).operators.find(o => o.id === "fitted")!.ports.inputs).toEqual([
    "in[0]",
    "in[1]",
  ]);
  expect(state.getOperator("fitted")!.nativeOp!.properties.code).toContain("def fit(left, right)");
  const before = state.getWorkflowContent();
  await expect(
    edit(state, 'fitted = process(source, fn=fit, doc="Compare")\n    def fit(left, right):\n        return left')
  ).rejects.toThrow("has 1 input table(s) but fit takes 2 parameter(s)");
  await expect(edit(state, 'fitted = process(source, fn=fit, doc="Compare")')).rejects.toThrow(
    "not a function defined in this edit"
  );
  expect(state.getWorkflowContent()).toEqual(before);
});

test("a single-input process names no port, and a loader takes no inputs", async () => {
  const state = new WorkflowState();
  const result = await edit(
    state,
    `loaded = process(fn=load, doc="A diagnostic source")
    def load():
        import pandas as pd
        return pd.DataFrame({"x": [1]})
shaped = process(loaded, fn=shape, doc="Keep the input table")
    def shape(table):
        return table`
  );
  expect(lines(result).at(-1)).toBe("edge loaded -> shaped created");
  expect(inspectGraph(state.getWorkflowContent()).edges).toEqual(["loaded -> shaped"]);
  expect(state.getOperator("shaped")!.nativeOp!.graph!.inputPorts).toEqual(["in[0]"]);
});

test("multiline parameters and statement text inside Python strings parse without changing boundaries", async () => {
  const state = new WorkflowState();
  await edit(
    state,
    `source = scan(
    "a.csv",
    skip_lines=2
)
loaded = process(fn=load, doc="A diagnostic source")
    def load():
        import pandas as pd
        text = """first
fake = scan('never.csv')
del source
last"""
        return pd.DataFrame({"text": [text]})`
  );
  expect(state.getAllOperators().map(o => o.operatorID)).toEqual(["source", "loaded"]);
  expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);
});

test("full profile scope is compiled into new operators, and existing operators keep theirs", async () => {
  const plan = (workflow: ReturnType<WorkflowState["getWorkflowContent"]>, changes: string, scope: "prefix" | "full") =>
    planGraphEdit(workflow, changes, {
      ...context(),
      settings: { nativeProfileCollection: true, nativeProfileScope: scope },
    });
  const full = await plan(new WorkflowState().getWorkflowContent(), chain, "full");
  for (const op of full.workflow.operators) {
    expect(op.nativeOp?.profileCollection).toBe(true);
    expect(op.nativeOp?.profileScope).toBe("full");
  }
  const code = JSON.parse(
    String(full.workflow.operators[0].operatorProperties.code).match(/json\.loads\((".*")\)/)![1]
  );
  expect(JSON.parse(code).profileScope).toBe("full");
  const prefix = await plan(new WorkflowState().getWorkflowContent(), chain, "prefix");
  expect(prefix.workflow.operators.some(op => "profileScope" in op.nativeOp!)).toBe(false);
  const updated = await plan(full.workflow, 'source = scan("data/b.csv")', "prefix");
  expect(updated.workflow.operators.find(op => op.operatorID === "source")!.nativeOp?.profileScope).toBe("full");
  expect(() => validateNativeSettings({ nativeProfileScope: "everything" } as any)).toThrow(/prefix" or "full/);
});
