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
import { nativeTestTools } from "./test-support";
import { WorkflowState } from "../workflow-state";
import type { NativeBatchResult } from "../tools/native-batch-tools";
import { nativeBatchSchema, dataflowToolDescription } from "../tools/native-batch-tools";

function setup(state = new WorkflowState()) {
  const { tools } = nativeTestTools(state, { settings: { nativeAnalysisState: true } } as any);
  const call = async (edits: string, extra: Record<string, unknown> = {}) => {
    const result = await tools.dataflow.execute({ edits, ...extra });
    if (typeof result === "string") throw new Error(result);
    return result as NativeBatchResult;
  };
  return { state, call };
}

const initial = `
def convert(value):
    return value / 100
def numeric(row):
    return {**row, "value": convert(row["value"])}
source = scan("data/measurements.csv")
encoded = map(source, numeric, doc="Converts the measurement using the shared unit definition")
second = map(source, lambda row: {**row, "value": convert(row["value"])}, doc="Uses the same unit conversion")
total = aggregate(encoded, value=sum("value"))
unrelated = limit(source, 1)
`;

test("analysis inspection accepts a read-only call without empty edits", async () => {
  const { state, call } = setup();
  await call(initial);
  const before = state.getWorkflowContent();
  const { tools } = nativeTestTools(state, { settings: { nativeAnalysisState: true } } as any);
  const result = await tools.dataflow.execute({ inspect: ["encoded"] } as any);
  expect(typeof result).not.toBe("string");
  expect((result as NativeBatchResult).operators).toEqual([]);
  expect((result as NativeBatchResult).inspection?.join("\n")).toContain("def numeric(row)");
  expect(state.getWorkflowContent()).toEqual(before);
  expect(nativeBatchSchema({ analysisState: true }).required as string[]).not.toContain("edits");
  expect(nativeBatchSchema().required as string[]).toContain("edits");
});

test("inspection can retrieve a shared function by its advertised name", async () => {
  const { call } = setup();
  await call(initial);
  const result = await call("", { inspect: ["convert"] });
  expect(result.inspection?.join("\n")).toContain("def convert(value):");
  expect(result.inspection?.join("\n")).toContain("value / 100");
  expect(result.inspection?.join("\n")).toContain("encoded");
});

test("repeating an already retained function is an unchanged definition, not an unused-definition error", async () => {
  const { state, call } = setup();
  await call(initial);
  const before = state.getWorkflowContent();
  const result = await call("def convert(value):\n    return value / 100");
  expect(result.operators.some(op => op.status === "error")).toBe(false);
  expect(state.getWorkflowContent()).toEqual(before);
});

test("disabled restoration is absent from the analysis tool schema and description", () => {
  const options = { analysisState: true, restore: false };
  expect((nativeBatchSchema(options).properties as Record<string, unknown>).restore).toBeUndefined();
  expect(dataflowToolDescription(options)).not.toContain("`restore`");
});

test("column names, method names and local variables are not shared-function dependencies", async () => {
  const { state, call } = setup();
  await call(initial);
  await call(`def local_view(frame):
    convert = lambda value: value + 1
    return frame.assign(convert=frame["value"].map(convert))
local_result = process(source, fn=local_view, doc="A local conversion, independent of the shared helper")
column_result = map(source, lambda row: {**row, "convert": 1}, doc="Adds a column whose name matches a helper")`);
  expect(Object.keys(state.getOperator("local_result")!.nativeOp!.functions!)).toEqual(["local_view"]);
  expect(Object.keys(state.getOperator("column_result")!.nativeOp!.functions ?? {})).toEqual([]);
  const changed = await call("def convert(value):\n    return value / 10");
  expect(changed.operators.map(op => op.id).sort()).toEqual(["encoded", "second"]);
});

test("global helper calls inside a nested function still participate in correction", async () => {
  const { state, call } = setup();
  await call(initial);
  await call(`def nested(row):
    def apply(value):
        return convert(value)
    return {**row, "value": apply(row["value"])}
nested_result = map(source, nested, doc="Calls the shared helper through a local function")`);
  const result = await call("def convert(value):\n    return value / 10");
  expect(result.operators.some(op => op.id === "nested_result" && op.status === "modified")).toBe(true);
  expect(state.getOperator("nested_result")!.nativeOp!.properties.func).toContain("value / 10");
});

test("a shared helper correction revises every consumer and preserves unrelated definitions", async () => {
  const { state, call } = setup();
  await call(initial);
  const before = state.getOperator("encoded")!.nativeOp!.revision;
  const source = state.getOperator("source")!.nativeOp!.revision;
  const result = await call("def convert(value):\n    return value / 10");
  expect(
    result.operators
      .filter(o => o.status === "modified")
      .map(o => o.id)
      .sort()
  ).toEqual(["encoded", "second"]);
  expect(state.getOperator("encoded")!.nativeOp!.revision).not.toBe(before);
  expect(state.getOperator("encoded")!.nativeOp!.properties.func).toContain("value / 10");
  expect(state.getOperator("second")!.nativeOp!.properties.func).toContain("value / 10");
  expect(state.getOperator("source")!.nativeOp!.revision).toBe(source);
  expect(state.getOperator("total")!.nativeOp!.inputs).toEqual(["encoded"]);
});

test("later tasks reuse exact stored functions and workflow checkout carries them", async () => {
  const first = setup();
  await first.call(initial);
  const restored = new WorkflowState();
  restored.setWorkflowContent(first.state.getWorkflowContent());
  const { call, state } = setup(restored);
  const result = await call('third = map(source, numeric, doc="Uses the current unit conversion")');
  expect(result.operators[0].status).toBe("added");
  expect(state.getOperator("third")!.nativeOp!.properties.func).toContain("value / 100");
});

test("a malformed shared correction blocks consumers instead of silently reusing its old definition", async () => {
  const { state, call } = setup();
  await call(initial);
  const before = state.getOperator("encoded")!.nativeOp!.revision;
  const result = await call("def convert(value):\n    return value /\nnext_total = aggregate(encoded, n=count())");
  expect(result.operators.find(o => o.id === "encoded")?.status).toBe("error");
  expect(result.operators.find(o => o.id === "next_total")?.status).toBe("blocked");
  expect(state.getOperator("encoded")!.nativeOp!.revision).toBe(before);
});

test("shared definitions cannot be silently lost when no table uses them", async () => {
  const { call } = setup();
  const result = await call("def not_used(x):\n    return x");
  expect(result.operators.some(o => o.status === "error" && o.message.includes("consumer"))).toBe(true);
});

test("a parameter source preserves scalar types and changes its revision on a coefficient edit", async () => {
  const { state, call } = setup();
  const result = await call('policy = parameters(weight=0.5, unit="fraction", active=True, missing=None)');
  expect(result.operators[0].status).toBe("added");
  expect(state.getOperator("policy")!.nativeOp!.properties.values).toEqual({
    weight: 0.5,
    unit: "fraction",
    active: true,
    missing: null,
  });
  const revision = state.getOperator("policy")!.nativeOp!.revision;
  await call('policy = parameters(weight=0.75, unit="fraction", active=True, missing=None)');
  expect(state.getOperator("policy")!.nativeOp!.revision).not.toBe(revision);
});

const scoring = `
def score(rows, policy):
    out = rows.copy()
    out["score"] = out["value"] * policy.iloc[0]["weight"]
    return out
source = scan("data/measurements.csv")
policy = parameters(weight=0.5)
scored = process(source, policy, fn=score, doc="Applies the explicit policy coefficient")
ranked = sort(scored, by=[("score", "desc")])
leaders = limit(ranked, 3)
`;

test("fork plus parameter override in one call copies only the affected slice and keeps the default", async () => {
  const { state, call } = setup();
  await call(scoring);
  const before = state.getOperator("scored")!.nativeOp!.revision;
  const result = await call("alternative = parameters(weight=0.25)", {
    fork: [{ operator: "leaders", as: "scenario", bindings: { policy: "alternative" } }],
    observe: ["scenario", "leaders"],
  });
  expect(result.operators.every(o => o.status !== "error" && o.status !== "blocked")).toBe(true);
  expect(state.getOperator("scenario__scored")!.nativeOp!.inputs).toEqual(["source", "alternative"]);
  expect(state.getOperator("scenario")!.nativeOp!.inputs).toEqual(["scenario__ranked"]);
  expect(state.getOperator("scenario__source")).toBeUndefined();
  expect(state.getOperator("scored")!.nativeOp!.revision).toBe(before);
  expect(state.getOperator("scored")!.nativeOp!.inputs).toEqual(["source", "policy"]);
  const forkRevision = state.getOperator("scenario__scored")!.nativeOp!.revision;
  await call(
    'def score(rows, policy):\n    out = rows.copy()\n    out["score"] = out["value"] * 2 * policy.iloc[0]["weight"]\n    return out'
  );
  expect(state.getOperator("scored")!.nativeOp!.revision).not.toBe(before);
  expect(state.getOperator("scenario__scored")!.nativeOp!.revision).toBe(forkRevision);
});

test("unused fork bindings and occupied targets are refused before any branch is created", async () => {
  const { state, call } = setup();
  await call(scoring);
  for (const request of [
    { operator: "leaders", as: "bad", bindings: { misspelled: "policy" } },
    { operator: "leaders", as: "scored", bindings: { policy: "policy" } },
  ]) {
    const result = await call("", { fork: [request] });
    expect(result.operators.some(o => o.status === "error")).toBe(true);
    expect(state.getOperator("bad")).toBeUndefined();
  }
});

test("inspection returns exact definitions without adding or modifying operators", async () => {
  const { state, call } = setup();
  await call(scoring);
  const before = JSON.stringify(state.getWorkflowContent());
  const result = await call("", { inspect: ["scored", "policy"] });
  expect(result.operators).toEqual([]);
  expect(JSON.stringify((result as any).inspection)).toContain('out[\\"score\\"]');
  expect(JSON.stringify(state.getWorkflowContent())).toBe(before);
});

test("existing behavior remains available with analysis state disabled", async () => {
  const { state, tools } = nativeTestTools();
  await tools.dataflow.execute({ edits: initial });
  const before = state.getOperator("encoded")!.nativeOp!.revision;
  const result = await tools.dataflow.execute({ edits: "def convert(value):\n    return value / 10" });
  expect((result as NativeBatchResult).operators).toEqual([]);
  expect(state.getOperator("encoded")!.nativeOp!.revision).toBe(before);
});

test("table inputs remain addressable when a shared function has the same name", async () => {
  const { state, call } = setup();
  await call(
    'def score(rows):\n    return rows\nsource = scan("data/x.csv")\nscore = process(source, fn=score, doc="Reusable view")'
  );
  const result = await call("top = limit(score, 2)");
  expect(result.operators[0].status).toBe("added");
  expect(state.getOperator("top")!.nativeOp!.inputs).toEqual(["score"]);
});

test("a binding hidden behind another replaced boundary is refused as unused", async () => {
  const { state, call } = setup();
  await call(scoring);
  const result = await call("", {
    fork: [{ operator: "leaders", as: "hidden", bindings: { scored: "scored", policy: "policy" } }],
  });
  expect(result.operators.some(o => o.status === "error" && o.message.includes("unused"))).toBe(true);
  expect(state.getOperator("hidden")).toBeUndefined();
});

for (const [kind, expression] of [
  ["keyword function", 'process(score, fn=score, doc="Shared function with a table name")'],
  ["positional function", 'map(score, score, doc="Shared function with a table name")'],
] as const) {
  test(`fork changes its table input without renaming the ${kind}`, async () => {
    const { state, call } = setup();
    const initial = await call(`def score(value):
    return value
score = scan("data/x.csv")
replacement = scan("data/y.csv")
result = ${expression}`);
    expect(initial.operators.some(op => op.status === "error")).toBe(false);
    const branch = await call("", {
      fork: [
        {
          operator: "result",
          as: "alternative",
          bindings: { score: "replacement" },
        },
      ],
    });
    expect(branch.operators.some(op => op.status === "error")).toBe(false);
    expect(state.getOperator("alternative")?.nativeOp?.inputs).toEqual(["replacement"]);
    expect(state.getOperator("alternative")?.nativeOp?.functions?.score).toContain("def score(value):");
  });
}

test("fork does not rename dtypes that match its table input", async () => {
  const { state, call } = setup();
  const initial = await call(`float64 = scan("data/x.csv")
replacement = scan("data/y.csv")
result = cast(float64, value=float64, **{"extra column": float64})`);
  expect(initial.operators.some(op => op.status === "error")).toBe(false);
  const branch = await call("", {
    fork: [
      {
        operator: "result",
        as: "alternative",
        bindings: { float64: "replacement" },
      },
    ],
  });
  expect(branch.operators.some(op => op.status === "error")).toBe(false);
  expect(state.getOperator("alternative")?.nativeOp?.inputs).toEqual(["replacement"]);
  expect(state.getOperator("alternative")?.nativeOp?.source).toContain('value=float64, **{"extra column": float64}');
});

test("an unsupported async correction blocks old consumers and their new descendants", async () => {
  const { state, call } = setup();
  await call(initial);
  const before = state.getOperator("encoded")!.nativeOp!.revision;
  const result = await call(
    "async def convert(value):\n    return value / 10\nnext_total = aggregate(encoded, n=count())"
  );
  expect(result.operators.find(op => op.id === "encoded")?.status).toBe("error");
  expect(result.operators.find(op => op.id === "next_total")?.status).toBe("blocked");
  expect(state.getOperator("encoded")!.nativeOp!.revision).toBe(before);
});
