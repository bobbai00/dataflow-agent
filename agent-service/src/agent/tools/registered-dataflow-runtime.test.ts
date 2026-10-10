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
import {
  prepareActions,
  renderDataflowActionsResult,
  type DataflowAction,
  type DataflowActionsResult,
} from "./dataflow-actions";
import { inspectRegisteredNamespace } from "./registered-inspection";
import { prepareDataflowCall } from "./turn-tool";
import { TexeraAgent } from "../texera-agent";
import type { ReActStep, RetrievalView } from "../../types/agent";
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

const VIEWS: RetrievalView[] = ["sample_stats", "full"];
type Execute = (step: string, ids?: readonly string[]) => Promise<void>;

/** One step per call: a `dataflow(python, statements)` call, or (for runtime
 * ordering rules the statement parser never produces) a raw action list. */
function harness() {
  const state = new WorkflowState();
  const steps: string[] = [];
  const storage = new WorkflowSnapshotStorage(id => steps.slice(0, steps.indexOf(id) + 1));
  let executions = 0;
  const resolve = async (result: DataflowActionsResult, execute?: Execute) => {
    const stepId = `step${steps.length}`;
    steps.push(stepId);
    storage.createSnapshot(stepId, state.getWorkflowContent());
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
      isCurrent: () => true,
    });
    return result;
  };
  const call = (python: string, statements: string, execute?: Execute) =>
    resolve(prepareDataflowCall({ python, statements }, VIEWS), execute);
  const actions = (list: DataflowAction[], execute?: Execute) => resolve(prepareActions(list, VIEWS), execute);
  return { state, storage, call, actions, executions: () => executions };
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
function failed(id: string, value: number): OperatorInfo {
  return { ...completed(id, value), state: "Failed", error: "Synthetic operator failure" } as unknown as OperatorInfo;
}

test("a receipt names functions, operators and results by statement while engine reuse stays in telemetry", async () => {
  const h = harness();
  const result = await h.call(
    loader,
    "set raw: source()\nset report: copy_values(raw)\nshow result report full",
    async step => {
      h.storage.setOperatorResult(step, "raw", { ...completed("raw", 2), state: "CompletedFromCache" });
      h.storage.setOperatorResult(step, "report", completed("report", 2));
    }
  );
  expect(result.actions.map(item => [item.action.type, item.status])).toEqual([
    ["edit", "ok"],
    ["execute", "ok"],
    ["retrieve", "ok"],
  ]);
  const text = renderDataflowActionsResult(result);
  expect(text).toContain("## edits applied\nfunctions: source registered, copy_values registered");
  expect(text).toContain("operators: raw created (source), report created (copy_values)");
  expect(text).toContain(
    "## show result report full\nexecuted: report\nresult report (copy_values of raw): 1 row × 1 column"
  );
  expect(text).toContain("| 2 |");
  expect(text).not.toMatch(/\bcach(?:e|ed|ing)\b/i);
  expect((result.actions[1].output as any).operators.find((op: any) => op.id === "raw").state).toBe("cached");
  expect(h.storage.getOperatorResult("step0", "raw")?.state).toBe("CompletedFromCache");
});

test("a rejected edit names the statement line and declaration, applies nothing and skips the requests", async () => {
  const h = harness();
  await h.call(loader, "set raw: source()");
  const result = await h.call("", "set report: copy_values(raw)\nset broken: limit(raw, n='invalid')\nexecute report");
  const text = renderDataflowActionsResult(result);
  expect(result.actions.map(item => item.status)).toEqual(["error", "skipped"]);
  expect(text).toContain("## edits rejected\nChanges line 2, operator broken: Invalid limit arguments");
  expect(text).toContain("## execute report: not run (an earlier statement failed)");
  expect(h.state.getAllOperators().map(op => op.operatorID)).toEqual(["raw"]);
  expect(h.executions()).toBe(0);
});

test("a result request keeps valid targets around a missing one and starts no execution for it", async () => {
  const h = harness();
  const created = await h.call(loader, "set a: source()\nset b: source(value=2)");
  expect(created.status).toBe("completed");
  expect(h.executions()).toBe(0);
  await h.call("", "execute a, b", async step => {
    h.storage.setOperatorResult(step, "a", completed("a", 2));
    h.storage.setOperatorResult(step, "b", completed("b", 3));
  });
  const read = await h.call("", "show result a, unknown, b full");
  expect(read.status).toBe("error");
  expect((read.actions[1].output as any).results.map((entry: any) => [entry.operator_id, entry.status])).toEqual([
    ["a", "ok"],
    ["unknown", "error"],
    ["b", "ok"],
  ]);
  expect(read.observe).toEqual(["a", "b"]);
  const text = renderDataflowActionsResult(read);
  expect(text).toContain("UNKNOWN_TARGET: Unknown or disabled execution targets: unknown. No execution was started.");
  expect(text).toContain("result unknown: unavailable\n- error UNKNOWN_OPERATOR");
  expect(text.indexOf("| 2 |")).toBeLessThan(text.indexOf("| 3 |"));
  expect(h.executions()).toBe(1);
});

test("a definitions-only call never executes; a failed recomputation reports the stale result, not the old one", async () => {
  const h = harness();
  await h.call(loader, "set a: source()");
  await h.call("", "execute a", async step => h.storage.setOperatorResult(step, "a", completed("a", 2)));
  const definitions = await h.call("OFFSET = 2", "");
  expect(definitions.actions.map(item => item.action.type)).toEqual(["edit"]);
  expect(renderDataflowActionsResult(definitions)).toContain("stale until executed: a");
  expect(h.executions()).toBe(1);
  const update = await h.call("OFFSET = 3", "show result a full", async () => {
    throw new Error("Synthetic engine failure");
  });
  expect(update.status).toBe("error");
  expect(renderDataflowActionsResult(update)).toContain("RESULT_STALE");
  expect(h.executions()).toBe(2);
  expect(h.storage.getOperatorResult("step1", "a")?.result).toEqual([{ value: 2 }]);
  expect(h.storage.getOperatorResult("step3", "a")).toBeUndefined();
});

test("show function and show operator report the latest authored definitions without executing", async () => {
  const h = harness();
  await h.call(loader, "set a: source(value=4)");
  const inspected = await h.call("", "show function source, copy_values\nshow operator a");
  expect(inspected.actions.map(item => item.status)).toEqual(["ok", "ok"]);
  const text = renderDataflowActionsResult(inspected);
  expect(text).toContain("## show function source, copy_values");
  expect(text).toContain("| source | operator function | (*, value=1) | Create a single numeric record. | a |");
  expect(text).toContain("def copy_values(table):");
  // The operator's block, not an empty lookup.
  const section = text.slice(text.indexOf("## show operator a"));
  expect(section).toContain("- **a** (source,");
  expect(section).toContain("definition: `set a: source(value=4)`");
  expect(section).not.toContain("No retained metadata.");
  const operator = inspected.actions[1].output as any;
  expect(operator.expression).toBe("set a: source(value=4)");
  expect(operator.signature).toBe("(*, value=1)");
  expect(operator.description).toBe("Create a single numeric record.");
  expect(h.executions()).toBe(0);
});

test("inspection exposes a semantic filter's registered predicate and its graph users", async () => {
  const h = harness();
  await h.call(
    loader +
      '\ndef keep(row, *, minimum=2):\n    """Keep values meeting the threshold."""\n    return row["value"] >= minimum\n',
    'set a: source()\nset kept: filter(a, predicate="keep", settings={"minimum": 3})'
  );
  const result = await h.call("", "show function keep\nshow operator kept");
  expect(result.actions.map(item => item.status)).toEqual(["ok", "ok"]);
  expect((result.actions[0].output as any).entries[0].used_by).toEqual(["kept"]);
  expect((result.actions[1].output as any).signature).toBe("(row, *, minimum=2)");
  const text = renderDataflowActionsResult(result);
  expect(text).toContain("Keep values meeting the threshold.");
  expect(text).toContain("def keep(row, *, minimum=2):");
  expect(h.executions()).toBe(0);
});

test("schema pages read retained engine metadata; a changed definition makes the schema stale", async () => {
  const h = harness();
  const fields = Array.from({ length: 179 }, (_, i) => ({
    name: i === 178 ? "Last column " : `field_${i}`,
    type: "string",
    encoding: "",
  }));
  await h.call("", "set table: scan(files='example.xlsx', sheet='Measurements')\nexecute table", async step =>
    h.storage.setOperatorResult(step, "table", { ...completed("table", 1), resultSchema: fields })
  );
  const read = await h.call("", "show schema table from 170");
  expect(read.actions.map(item => item.action)).toEqual([
    { type: "execute", operator_ids: ["table"] },
    { type: "inspect", target: "schema", operator_id: "table", offset: 170, limit: 200 },
  ]);
  expect(read.actions.map(item => item.status)).toEqual(["ok", "ok"]);
  const text = renderDataflowActionsResult(read);
  expect(text).toContain("## show schema table from 170");
  expect(text).toContain('"Last column "');
  expect(text).not.toContain('"field_10"');
  const frozen = structuredClone(read);
  const stale = await h.call("", "set table: scan(files='different.xlsx')\nshow schema table");
  expect(renderDataflowActionsResult(stale)).toContain("RESULT_STALE");
  expect(renderDataflowActionsResult(frozen)).toBe(text);
});

test("an execution failure still shows the results that completed", async () => {
  const h = harness();
  await h.call(loader, "set a: source()\nset b: source(value=2)");
  const result = await h.call("", "show result a, b full", async step => {
    h.storage.setOperatorResult(step, "a", completed("a", 2));
    h.storage.setOperatorResult(step, "b", failed("b", 3));
    throw new Error("Synthetic operator failure");
  });
  expect(result.actions.map(item => item.status)).toEqual(["error", "error"]);
  expect((result.actions[1].output as any).results.map((entry: any) => entry.status)).toEqual(["ok", "error"]);
  expect(result.observe).toEqual(["a"]);
  const text = renderDataflowActionsResult(result);
  expect(text).toContain("result a (source): 1 row × 1 column");
  expect(text).toContain("result b: unavailable");
});

test("a failed execution permits a later requested execution and its result in the same call", async () => {
  const h = harness();
  await h.call(loader, "set a: source()\nset b: source(value=2)");
  const requested: string[][] = [];
  const result = await h.call("", "execute a\nexecute b\nshow result a, b full", async (step, ids) => {
    requested.push([...(ids ?? [])]);
    if (ids?.includes("a")) {
      h.storage.setOperatorResult(step, "a", failed("a", 2));
      throw new Error("Synthetic operator failure");
    }
    h.storage.setOperatorResult(step, "b", completed("b", 3));
  });
  expect(requested).toEqual([["a"], ["b"], ["a", "b"]]);
  expect(result.actions.map(item => item.status)).toEqual(["error", "ok", "error", "error"]);
  expect((result.actions[3].output as any).results.map((entry: any) => [entry.operator_id, entry.status])).toEqual([
    ["a", "error"],
    ["b", "ok"],
  ]);
  expect(result.observe).toEqual(["b"]);
});

test("nothing after a skipped edit runs, so an execution cannot silently use the old graph", async () => {
  const h = harness();
  await h.call(loader, "set a: source()\nset b: source(value=2)");
  const requested: string[][] = [];
  const result = await h.actions(
    [
      { type: "execute", operator_ids: ["a"] },
      { type: "edit", python: "", changes: "set b: source(value=9)" },
      { type: "execute", operator_ids: ["b"] },
      { type: "inspect", target: "operator", operator_id: "b", include_implementation: false },
    ],
    async (_step, ids) => {
      requested.push([...(ids ?? [])]);
      throw new Error("Synthetic operator failure");
    }
  );
  // Reads continue after a failed execution, but nothing runs after the skipped edit.
  expect(requested).toEqual([["a"]]);
  expect(result.actions.map(item => item.status)).toEqual(["error", "skipped", "skipped", "skipped"]);
  expect(h.state.getOperator("b")?.nativeOp?.source).toContain("value=2");
});

test("a read followed by an edit marks only that target's captured observation superseded", async () => {
  const h = harness();
  await h.call(loader, "set a: source()\nset b: source(value=2)");
  await h.call("", "execute a, b", async step => {
    h.storage.setOperatorResult(step, "a", completed("a", 2));
    h.storage.setOperatorResult(step, "b", completed("b", 3));
  });
  const result = await h.actions([
    { type: "retrieve", operator_ids: ["a", "b"], view: "full" },
    { type: "edit", python: "", changes: "set a: source(value=4)" },
  ]);
  expect(result.status).toBe("completed");
  const reads = (result.actions[0].output as any).results;
  expect(reads[0].superseded_in_call).toBe(true);
  expect(reads[1].superseded_in_call).toBeUndefined();
  expect(result.observe).toEqual(["b"]);
  expect(renderDataflowActionsResult(result)).toContain("note: this result was superseded later in the call.");
  expect(h.executions()).toBe(1);
});

test("trace import replays dataflow edits without executing operators", async () => {
  context();
  const inputs = [
    { python: loader, statements: "" },
    { python: "", statements: "set a: source()\nexecute a" },
  ];
  const outputs = inputs.map(input => {
    const output = prepareDataflowCall(input, VIEWS);
    output.status = "completed";
    output.actions.forEach(action => (action.status = "ok"));
    return output;
  });
  const steps: ReActStep[] = outputs.map((output, i) => ({
    id: `import${i}`,
    parentId: i ? "import0" : undefined,
    messageId: "import",
    stepId: i,
    timestamp: i,
    role: "agent",
    content: "",
    isBegin: i === 0,
    isEnd: false,
    toolCalls: [{ toolCallId: `call${i}`, toolName: "dataflow", input: inputs[i] }],
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
