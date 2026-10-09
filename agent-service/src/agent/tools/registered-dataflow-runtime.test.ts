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
import { WorkflowSnapshotStorage, computeStaleResultOps } from "../workflow-snapshot-storage";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { planRegisteredGraphEdit } from "./graph-edits";
import { executeDataflowActionBatch } from "./dataflow-action-runtime";
import { prepareRegisteredDataflowActions, renderDataflowActionsResult } from "./dataflow-actions";
import { inspectRegisteredNamespace } from "./registered-inspection";
import { TexeraAgent } from "../texera-agent";
import type { ReActStep } from "../../types/agent";
import type { RegisteredNamespace } from "../native/registered";

function context() {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  return { metadataStore };
}
const loader = `import pandas as pd
OFFSET = 1
def source(*, value=1):
    """Create a single numeric record."""
    return pd.DataFrame({'value': [value + OFFSET]})
def copy_values(table):
    return table.copy()
`;
const graph =
  "set raw: source()\nset copied: copy_values(raw)\nset report: aggregate(copied, outputs={'total': sum('value')})\nset independent: scan(files='unused.csv')";

test("namespace inspection uses only saved own declarations, including prototype-like names", () => {
  const namespace: RegisteredNamespace = { cells: [], functions: {}, bindings: {}, revision: "empty" };
  const workflow = { ...new WorkflowState().getWorkflowContent(), nativeNamespace: namespace };
  for (const name of ["constructor", "toString", "__proto__"])
    expect(() => inspectRegisteredNamespace(workflow, [name], true)).toThrow("UNKNOWN_NAME");

  const source = "def constructor(table):\n    return table";
  Object.assign(namespace.bindings, {
    constructor: {
      name: "constructor",
      kind: "function",
      source,
      cell: 0,
    },
  });
  Object.assign(namespace.functions, {
    constructor: {
      name: "constructor",
      signature: "(table)",
      doc: "Return input.",
      source,
      exported: true,
    },
  });
  const ownFunction = inspectRegisteredNamespace(workflow, ["constructor"], true);
  expect(ownFunction.entries[0]).toMatchObject({ name: "constructor", kind: "operator function", source });

  Object.assign(namespace.bindings, {
    toString: {
      name: "toString",
      kind: "constant",
      source: "toString = 1",
      cell: 1,
    },
  });
  const ownConstant = inspectRegisteredNamespace(workflow, ["toString"], true);
  expect(ownConstant.entries[0]).toMatchObject({ name: "toString", kind: "constant", source: "toString = 1" });
  expect(ownConstant.entries[0].signature).toBeUndefined();
});

test("registered graph IDs retain prototype-like names across edits and report creation correctly", async () => {
  const names = ["constructor", "toString", "__proto__"];
  const first = await planRegisteredGraphEdit(
    new WorkflowState().getWorkflowContent(),
    "",
    names.map(name => `set ${name}: scan(files='unused.csv')`).join("\n"),
    context()
  );
  expect(first.operators.map(op => [op.id, op.status])).toEqual(names.map(name => [name, "added"]));
  const second = await planRegisteredGraphEdit(first.workflow, "", "set report: limit(__proto__, n=1)", context());
  expect(second.workflow.operators.map(op => op.operatorID).sort()).toEqual([...names, "report"].sort());
  expect(second.workflow.operators.find(op => op.operatorID === "report")?.nativeOp?.inputs).toEqual(["__proto__"]);
});

test("registration survives an empty graph and inspecting functions never calls their bodies", async () => {
  const state = new WorkflowState();
  const plan = await planRegisteredGraphEdit(
    state.getWorkflowContent(),
    "def unused(table):\n    raise RuntimeError('must not run')",
    "",
    context()
  );
  state.setWorkflowContent(plan.workflow);
  expect(state.getAllOperators()).toEqual([]);
  expect(plan.registrations).toEqual([{ name: "unused", kind: "registered" }]);
  const inspection = inspectRegisteredNamespace(state.getWorkflowContent(), ["unused"], true);
  expect(inspection.text).toContain("must not run");
  expect(inspection.entries[0].used_by).toEqual([]);
  const storage = new WorkflowSnapshotStorage(id => (id === "second" ? ["first", "second"] : ["first"]));
  storage.createSnapshot("first", state.getWorkflowContent());
  storage.createSnapshot("second", state.getWorkflowContent());
  state.reset();
  state.setWorkflowContent(storage.getWorkflow("first"));
  expect(state.getWorkflowContent().nativeNamespace?.functions.unused.source).toContain("must not run");
});

test("namespace and graph are atomic; Python edits invalidate custom nodes and descendants only", async () => {
  const state = new WorkflowState();
  const original = await planRegisteredGraphEdit(state.getWorkflowContent(), loader, graph, context());
  state.setWorkflowContent(original.workflow);
  const before = JSON.stringify(state.getWorkflowContent());
  await expect(
    planRegisteredGraphEdit(
      state.getWorkflowContent(),
      "def copy_values(first, second):\n    return first",
      "",
      context()
    )
  ).rejects.toThrow();
  expect(JSON.stringify(state.getWorkflowContent())).toBe(before);
  const changed = await planRegisteredGraphEdit(state.getWorkflowContent(), "OFFSET = 2", "", context());
  expect(new Set(changed.invalidated_results)).toEqual(new Set(["raw", "copied", "report"]));
  expect(changed.invalidated_results).not.toContain("independent");
  expect(changed.workflow.nativeNamespace?.cells).toHaveLength(2);
  await expect(planRegisteredGraphEdit(state.getWorkflowContent(), "", "delete raw", context())).rejects.toThrow();
  expect(JSON.stringify(state.getWorkflowContent())).toBe(before);
});

test("documentation-only replacements preserve cached numerical results", async () => {
  const first = await planRegisteredGraphEdit(new WorkflowState().getWorkflowContent(), loader, graph, context());
  const second = await planRegisteredGraphEdit(
    first.workflow,
    "",
    "set copied: copy_values(raw, doc='Preserve all input rows.')",
    context()
  );
  expect(second.workflow.operators.find(op => op.operatorID === "copied")?.nativeOp?.doc).toBe(
    "Preserve all input rows."
  );
  expect(computeStaleResultOps(first.workflow, second.workflow).size).toBe(0);
  expect(second.invalidated_results).toEqual([]);
});

function harness() {
  const state = new WorkflowState();
  const steps: string[] = [];
  const storage = new WorkflowSnapshotStorage(id => steps.slice(0, steps.indexOf(id) + 1));
  let executions = 0;
  const run = async (actions: unknown[], execute?: (step: string, ids?: readonly string[]) => Promise<void>) => {
    const stepId = `step${steps.length}`;
    steps.push(stepId);
    storage.createSnapshot(stepId, state.getWorkflowContent());
    const result = prepareRegisteredDataflowActions({ reasoning: "Check the registered protocol.", actions });
    await executeDataflowActionBatch(result, {
      state,
      storage,
      stepId,
      settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "" },
      context: context(),
      execute: async ids => {
        executions++;
        await execute?.(stepId, ids);
      },
      edited: () => {},
      isCurrent: () => true,
    });
    return result;
  };
  return { state, storage, run, executions: () => executions };
}
function completed(id: string, value: number): OperatorInfo {
  return {
    operatorID: id,
    state: "Completed",
    inputTuples: 0,
    outputTuples: 1,
    totalRowCount: 1,
    result: [{ value }],
    resultSchema: [{ name: "value", type: "integer" }],
  } as unknown as OperatorInfo;
}

test("registered receipts retain useful identities while engine reuse stays in telemetry", async () => {
  const h = harness();
  const result = await h.run(
    [
      { type: "edit", python: loader, changes: "set raw: source()\nset report: copy_values(raw)" },
      { type: "execute", operator_ids: ["report"] },
      { type: "retrieve", operator_ids: ["report"], view: "full" },
    ],
    async step => {
      h.storage.setOperatorResult(step, "raw", {
        ...completed("raw", 2),
        state: "CompletedFromCache",
      });
      h.storage.setOperatorResult(step, "report", completed("report", 2));
    }
  );
  expect(result.actions.map(action => action.status)).toEqual(["ok", "ok", "ok"]);
  const text = renderDataflowActionsResult(result);
  expect(text).toContain("function source registered");
  expect(text).toContain("function copy_values registered");
  expect(text).toContain("operator raw created (source)");
  expect(text).toContain("operator report created (copy_values)");
  expect(text).toContain("edge raw -> report created");
  expect(text).toContain("2. execute report: ok");
  expect(text).toContain("2 completed (report, raw)");
  expect(text).toContain("3. retrieve report: ok");
  expect(text).toContain("**report** (copy_values, completed)");
  expect(text).toContain("| 2 |");
  expect(text).not.toMatch(/\bcach(?:e|ed|ing)\b/i);
  expect((result.actions[1].output as any).operators.find((op: any) => op.id === "raw").state).toBe("cached");
  expect(h.storage.getOperatorResult("step0", "raw")?.state).toBe("CompletedFromCache");
});

test("rejected batch edits name the action and declaration without undoing earlier edits", async () => {
  const h = harness();
  const result = await h.run([
    { type: "edit", python: loader, changes: "set raw: source()" },
    {
      type: "edit",
      python: "",
      changes: "set report: copy_values(raw)\nset broken: limit(raw, n='invalid')",
    },
    { type: "execute", operator_ids: ["report"] },
  ]);
  const text = renderDataflowActionsResult(result);
  expect(result.actions.map(action => action.status)).toEqual(["ok", "error", "skipped"]);
  expect(text).toContain("2. edit: error\nNo changes were applied.");
  expect(text).toContain("Changes line 2, operator broken");
  expect(text).toContain("3. execute report: skipped (action 2 failed)");
  expect(h.state.getAllOperators().map(op => op.operatorID)).toEqual(["raw"]);
  expect(h.executions()).toBe(0);
});

test("batched retrieval keeps valid targets around missing targets without execution", async () => {
  const h = harness();
  const created = await h.run([{ type: "edit", python: loader, changes: "set a: source()\nset b: source(value=2)" }]);
  expect(created.status).toBe("completed");
  expect(h.executions()).toBe(0);
  await h.run([{ type: "execute", operator_ids: ["a", "b"] }], async step => {
    h.storage.setOperatorResult(step, "a", completed("a", 2));
    h.storage.setOperatorResult(step, "b", completed("b", 3));
  });
  const read = await h.run([{ type: "retrieve", operator_ids: ["a", "unknown", "b"], view: "full" }]);
  expect(read.status).toBe("error");
  expect((read.actions[0].output as any).results.map((entry: any) => [entry.operator_id, entry.status])).toEqual([
    ["a", "ok"],
    ["unknown", "error"],
    ["b", "ok"],
  ]);
  expect(read.observe).toEqual(["a", "b"]);
  expect(renderDataflowActionsResult(read)).toContain("UNKNOWN_OPERATOR");
  expect(h.executions()).toBe(1);
});

test("a Python-only edit never executes, rejects stale reads, and keeps prior snapshot results", async () => {
  const h = harness();
  await h.run([{ type: "edit", python: loader, changes: "set a: source()" }]);
  await h.run([{ type: "execute", operator_ids: ["a"] }], async step =>
    h.storage.setOperatorResult(step, "a", completed("a", 2))
  );
  const update = await h.run([
    { type: "edit", python: "OFFSET = 2", changes: "" },
    { type: "retrieve", operator_ids: ["a"], view: "full" },
  ]);
  expect(update.status).toBe("error");
  expect(renderDataflowActionsResult(update)).toContain("RESULT_STALE");
  expect(h.executions()).toBe(1);
  expect(h.storage.getOperatorResult("step1", "a")?.result).toEqual([{ value: 2 }]);
  expect(h.storage.getOperatorResult("step2", "a")).toBeUndefined();
});

test("namespace inspection and operator implementation report the latest authored definitions", async () => {
  const h = harness();
  await h.run([{ type: "edit", python: loader, changes: "set a: source(value=4)" }]);
  const inspected = await h.run([
    { type: "inspect", target: "namespace" },
    { type: "inspect", target: "operator", operator_id: "a", include_implementation: true },
  ]);
  const text = renderDataflowActionsResult(inspected);
  expect(text).toContain("operator function");
  expect(text).toContain("copy_values");
  expect(text).toContain("Create a single numeric record.");
  expect(text).toContain("set a: source(value=4)");
  expect(text).not.toContain("= set");
  expect(h.executions()).toBe(0);
});

test("inspection exposes a semantic filter's registered predicate and its graph users", async () => {
  const h = harness();
  await h.run([
    {
      type: "edit",
      python:
        loader +
        '\ndef keep(row, *, minimum=2):\n    """Keep values meeting the threshold."""\n    return row["value"] >= minimum\n',
      changes: 'set a: source()\nset kept: filter(a, predicate="keep", settings={"minimum": 3})',
    },
  ]);
  const result = await h.run([
    { type: "inspect", target: "namespace", names: ["keep"], include_implementation: true },
    { type: "inspect", target: "operator", operator_id: "kept", include_implementation: true },
  ]);
  expect(result.actions.map(action => action.status)).toEqual(["ok", "ok"]);
  expect((result.actions[0].output as any).entries[0].used_by).toEqual(["kept"]);
  expect((result.actions[1].output as any).signature).toBe("(row, *, minimum=2)");
  const text = renderDataflowActionsResult(result);
  expect(text).toContain("Keep values meeting the threshold.");
  expect(text).toContain("def keep(row, *, minimum=2):");
  expect(h.executions()).toBe(0);
});

test("same-call preview discovery and paginated schema inspection read retained engine metadata only", async () => {
  const h = harness();
  const discovered = await h.run(
    [
      { type: "edit", python: "", changes: "set preview: scan(files='example.xlsx', preview=1)" },
      { type: "execute", operator_ids: ["preview"] },
      { type: "inspect", target: "source", operator_id: "preview" },
    ],
    async step => {
      h.storage.setOperatorResult(step, "preview", {
        ...completed("preview", 1),
        result: [{ sheet: "Measurements", row_no: 0, line: "id | amount" }],
        resultSchema: [
          { name: "sheet", type: "string" },
          { name: "row_no", type: "integer" },
          { name: "line", type: "string" },
        ],
      } as unknown as OperatorInfo);
    }
  );
  expect(discovered.actions.map(action => action.status)).toEqual(["ok", "ok", "ok"]);
  expect(renderDataflowActionsResult(discovered)).toContain('"Measurements"');
  expect(renderDataflowActionsResult(discovered)).toContain("known names only");
  const frozen = structuredClone(discovered);
  const fields = Array.from({ length: 179 }, (_, i) => ({
    name: i === 178 ? "Last column " : `field_${i}`,
    type: "string",
    encoding: "",
  }));
  await h.run(
    [
      { type: "edit", python: "", changes: "set table: scan(files='example.xlsx', sheet='Measurements')" },
      { type: "execute", operator_ids: ["table"] },
    ],
    async step => h.storage.setOperatorResult(step, "table", { ...completed("table", 1), resultSchema: fields })
  );
  const read = await h.run([
    { type: "inspect", target: "schema", operator_id: "table", offset: 170, limit: 20 },
    { type: "inspect", target: "source", operator_id: "preview" },
  ]);
  expect(read.actions.map(action => action.status)).toEqual(["ok", "ok"]);
  expect(renderDataflowActionsResult(read)).toContain('"Last column "');
  expect(h.executions()).toBe(2);
  expect(renderDataflowActionsResult(frozen)).toBe(renderDataflowActionsResult(discovered));
  const stale = await h.run([
    { type: "edit", python: "", changes: "set table: scan(files='different.xlsx')" },
    { type: "inspect", target: "schema", operator_id: "table" },
  ]);
  expect(renderDataflowActionsResult(stale)).toContain("RESULT_STALE");
  expect(h.executions()).toBe(2);
});

test("execution failures permit independent batch reads while later writes are skipped", async () => {
  const h = harness();
  await h.run([{ type: "edit", python: loader, changes: "set a: source()\nset b: source(value=2)" }]);
  const result = await h.run(
    [
      { type: "execute", operator_ids: ["a", "b"] },
      { type: "retrieve", operator_ids: ["a", "b"], view: "full" },
      { type: "edit", python: "OFFSET = 9", changes: "" },
    ],
    async step => {
      h.storage.setOperatorResult(step, "a", completed("a", 2));
      h.storage.setOperatorResult(step, "b", {
        ...completed("b", 3),
        state: "Failed",
        error: "Synthetic operator failure",
      } as unknown as OperatorInfo);
      throw new Error("Synthetic operator failure");
    }
  );
  expect(result.actions.map(item => item.status)).toEqual(["error", "error", "skipped"]);
  expect((result.actions[1].output as any).results.map((entry: any) => entry.status)).toEqual(["ok", "error"]);
  expect(result.observe).toEqual(["a"]);
  expect(h.state.getWorkflowContent().nativeNamespace?.cells).toHaveLength(1);
});

test("a failed execution permits a later requested execution and its result in the same call", async () => {
  const h = harness();
  await h.run([{ type: "edit", python: loader, changes: "set a: source()\nset b: source(value=2)" }]);
  const requested: string[][] = [];
  const result = await h.run(
    [
      { type: "execute", operator_ids: ["a"] },
      { type: "execute", operator_ids: ["b"] },
      { type: "retrieve", operator_ids: ["a", "b"], view: "full" },
    ],
    async (step, ids) => {
      requested.push([...(ids ?? [])]);
      if (ids?.includes("a")) {
        h.storage.setOperatorResult(step, "a", {
          ...completed("a", 2),
          state: "Failed",
          error: "Synthetic operator failure",
        } as unknown as OperatorInfo);
        throw new Error("Synthetic operator failure");
      }
      h.storage.setOperatorResult(step, "b", completed("b", 3));
    }
  );
  expect(requested).toEqual([["a"], ["b"]]);
  expect(result.actions.map(item => item.status)).toEqual(["error", "ok", "error"]);
  expect((result.actions[2].output as any).results.map((entry: any) => [entry.operator_id, entry.status])).toEqual([
    ["a", "error"],
    ["b", "ok"],
  ]);
  expect(result.observe).toEqual(["b"]);
});

test("an execution after a skipped edit cannot silently use the old graph", async () => {
  const h = harness();
  await h.run([{ type: "edit", python: loader, changes: "set a: source()\nset b: source(value=2)" }]);
  const requested: string[][] = [];
  const result = await h.run(
    [
      { type: "execute", operator_ids: ["a"] },
      { type: "edit", python: "", changes: "set b: source(value=9)" },
      { type: "execute", operator_ids: ["b"] },
      { type: "inspect", target: "graph" },
    ],
    async (_step, ids) => {
      requested.push([...(ids ?? [])]);
      throw new Error("Synthetic operator failure");
    }
  );
  expect(requested).toEqual([["a"]]);
  expect(result.actions.map(item => item.status)).toEqual(["error", "skipped", "skipped", "ok"]);
  expect(h.state.getOperator("b")?.nativeOp?.source).toContain("value=2");
});

test("a read followed by an edit marks only that target's captured observation superseded", async () => {
  const h = harness();
  await h.run([{ type: "edit", python: loader, changes: "set a: source()\nset b: source(value=2)" }]);
  await h.run([{ type: "execute", operator_ids: ["a", "b"] }], async step => {
    h.storage.setOperatorResult(step, "a", completed("a", 2));
    h.storage.setOperatorResult(step, "b", completed("b", 3));
  });
  const result = await h.run([
    { type: "retrieve", operator_ids: ["a", "b"], view: "full" },
    { type: "edit", python: "", changes: "set a: source(value=4)" },
  ]);
  expect(result.status).toBe("completed");
  const reads = (result.actions[0].output as any).results;
  expect(reads[0].superseded_in_call).toBe(true);
  expect(reads[1].superseded_in_call).toBeUndefined();
  expect(result.observe).toEqual(["b"]);
  expect(h.executions()).toBe(1);
});

test("trace import preserves registered protocol and replays definitions without executing operators", async () => {
  context();
  const first = prepareRegisteredDataflowActions({
    reasoning: "Register.",
    actions: [{ type: "edit", python: loader, changes: "" }],
  });
  first.status = "completed";
  first.actions[0].status = "ok";
  const second = prepareRegisteredDataflowActions({
    reasoning: "Build.",
    actions: [
      { type: "edit", python: "", changes: "set a: source()" },
      { type: "execute", operator_ids: ["a"] },
    ],
  });
  second.status = "completed";
  second.actions.forEach(action => (action.status = "ok"));
  const steps: ReActStep[] = [first, second].map((output, i) => ({
    id: `import${i}`,
    parentId: i ? "import0" : undefined,
    messageId: "import",
    stepId: i,
    timestamp: i,
    role: "agent",
    content: "",
    isBegin: i === 0,
    isEnd: false,
    toolCalls: [
      {
        toolCallId: `call${i}`,
        toolName: "dataflow",
        input: { reasoning: "Replay.", actions: output.actions.map(item => item.action) },
      },
    ],
    toolResults: [{ toolCallId: `call${i}`, output }],
  }));
  const agent = new TexeraAgent({
    driver: {
      runTurn: async () => {
        throw new Error("A trace import must not request a model.");
      },
    },
    contextAssembler: () => [],
    modelType: "test-model",
    agentId: "registered-import-test",
  });
  await agent.importReActSteps(structuredClone(steps));
  expect(agent.getWorkflowState().getOperator("a")?.nativeOp?.registeredName).toBe("source");
  expect(agent.getWorkflowState().getWorkflowContent().nativeNamespace?.functions.source).toBeDefined();
  expect(agent.getSnapshotStorage().getOperatorResult("import1", "a")).toBeUndefined();
  expect((agent.getReActSteps()[0].toolResults?.[0].output as any).protocol).toBe("registered-python-v1");
  agent.checkout("import0");
  expect(agent.getWorkflowState().getAllOperators()).toEqual([]);
  expect(agent.getWorkflowState().getWorkflowContent().nativeNamespace?.functions.source).toBeDefined();
});

test("an update names what it replaced, and an unrelated definition updates nothing", async () => {
  const first = await planRegisteredGraphEdit(new WorkflowState().getWorkflowContent(), loader, graph, context());
  const reset = await planRegisteredGraphEdit(first.workflow, "", "set raw: source(value=5)", context());
  expect(reset.changes).toEqual([
    { change: "operator", operator_id: "raw", operator: "source", action: "updated", was: "set raw: source()" },
  ]);
  const redefined = await planRegisteredGraphEdit(
    first.workflow,
    "def copy_values(table):\n    return table.head(1)",
    "",
    context()
  );
  expect(redefined.changes).toEqual([
    {
      change: "operator",
      operator_id: "copied",
      operator: "copy_values",
      action: "updated",
      definitions_changed: true,
    },
  ]);
  const unrelated = await planRegisteredGraphEdit(first.workflow, "def other(table):\n    return table", "", context());
  expect(unrelated.changes).toEqual([]);
  expect(unrelated.registrations).toEqual([{ name: "other", kind: "registered" }]);
});
