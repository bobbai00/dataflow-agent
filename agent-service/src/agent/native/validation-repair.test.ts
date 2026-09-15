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

import { expect, spyOn, test } from "bun:test";
import Ajv from "ajv";
import { AgentMode, ContextMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { assembleContext } from "../util/context-utils";
import { createNativeBatchTools, nativeBatchSchema, type NativeBatchResult } from "../tools/native-batch-tools";
import { nativeToolName, nativeToolSchema, rejectedNativeViewOf } from "../tools/native-typed-tools";
import { nativeOperators } from "./catalog";
import { nativeSchemaExample, NativeValidationRepair } from "./validation-repair";
import { formatNativeDiagnostic } from "./diagnostics";
import * as codegen from "./codegen-v2";

const source = { op: "scan", id: "source", files: "data/fixture.csv" };
const good = { op: "aggregate", id: "answer", input: "source", aggregations: [{ fn: "count", as: "n" }] };
const bad = { ...good, aggregations: [{ fn: "count", alias: "n" }] };

test("minimal examples satisfy every V2 catalog schema and survive the diagnostic text budget", () => {
  const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
  for (const def of nativeOperators("v2")) {
    const op = nativeToolName(def.type),
      schema = nativeToolSchema(def);
    const example = { op, ...(nativeSchemaExample(schema) as object) };
    expect(validate({ operators: [example] })).toBe(true);
    const tracker = new NativeValidationRepair();
    const diagnostic = {
      version: 1 as const,
      operatorId: "answer",
      operatorRevision: "rev",
      code: "INVALID_ARGUMENTS",
      stage: "validate" as const,
      message: "detail ".repeat(100),
    };
    tracker.record(op, { id: "answer" }, diagnostic, schema);
    const text = formatNativeDiagnostic(tracker.record(op, { id: "answer" }, diagnostic, schema));
    expect(text).toContain(`Schema example: ${JSON.stringify(example)}`);
    expect(text).not.toContain("def apply");
  }
});

function fixture(version: "v1" | "v2" = "v2") {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const repair = new NativeValidationRepair();
  const tools = createNativeBatchTools(state, { metadataStore: metadata, nativeValidationRepair: repair }, version);
  const execute = (operators: unknown[]): Promise<NativeBatchResult> => tools.dataflow.execute({ operators });
  return { state, tools, execute, repair };
}

test("two schema failures show actionable fields and a valid schema example; identical retries leave the DAG untouched", async () => {
  const { state, execute } = fixture();
  await execute([source, good]);
  const before = state.getWorkflowContent();
  const first = (await execute([bad])).operators[0]!;
  expect(first.status).toBe("error");
  expect(first.message).not.toContain("Needs inspection");
  const second = (await execute([bad])).operators[0]!;
  expect(second.message).toContain("Repeated validation failure (2)");
  expect(second.message).toContain("/aggregations/0/as");
  expect(second.message).toContain("alias");
  expect(second.message).toContain("Needs inspection");
  const match = /Schema example: (\{[^\n]+\})/.exec(second.message);
  expect(match).not.toBeNull();
  const example = JSON.parse(match![1]!);
  expect(new Ajv({ strict: false }).compile(nativeBatchSchema("v2"))({ operators: [example] })).toBe(true);
  const third = (await execute([bad])).operators[0]!;
  expect(third.message).toContain("Identical invalid submission paused");
  expect(state.getWorkflowContent()).toEqual(before);
  // JSON key order is not a correction.
  const reordered = { input: bad.input, aggregations: bad.aggregations, id: bad.id, op: bad.op };
  expect((await execute([reordered])).operators[0]!.message).toContain("Identical invalid submission paused");
});

test("a repeated error pattern escalates across changed values, while corrections and independent branches remain eligible", async () => {
  const { state, execute } = fixture();
  await execute([source, good]);
  await execute([bad]);
  const changed = { ...bad, aggregations: [{ fn: "count", alias: "rows" }] };
  expect((await execute([changed])).operators[0]!.message).toContain("Repeated validation failure (2)");
  const mixed = await execute([
    changed,
    { op: "limit", id: "dependent", input: "answer", n: 1 },
    { op: "scan", id: "independent", files: "data/another.csv" },
  ]);
  expect(mixed.operators.map(item => item.status)).toEqual(["error", "blocked", "added"]);
  expect(mixed.operators[0]!.message).toContain("Identical invalid submission paused");
  expect(state.getOperator("dependent")).toBeUndefined();
  expect((await execute([good])).operators[0]!.status).toBe("modified");
  expect((await execute([bad])).operators[0]!.message).not.toContain("Needs inspection");
});

test("successful deletion and a separate agent reset failures; V1 keeps its existing behavior", async () => {
  const f = fixture();
  await f.execute([source, good]);
  await f.execute([bad]);
  await f.execute([bad]);
  expect(await f.tools.deleteOperator.execute({ id: "answer" })).toContain("deleted");
  expect((await f.execute([bad])).operators[0]!.message).not.toContain("Needs inspection");
  const other = fixture();
  expect((await other.execute([bad])).operators[0]!.message).not.toContain("Needs inspection");
  const v1 = fixture("v1");
  for (let i = 0; i < 3; i++) {
    const result = (await v1.execute([{ op: "scan", id: "bad", files: 5 }])).operators[0]!;
    expect(result.message).not.toContain("Needs inspection");
    expect(result.message).not.toContain("submission paused");
  }
});

test("Python preflight failures also escalate without copying submitted callback source into repair hints", async () => {
  const { execute } = fixture();
  await execute([source]);
  const broken = {
    op: "filter",
    id: "answer",
    input: "source",
    columns: ["x"],
    func: "def apply(row):\n    return PRIVATE_CALLBACK_BODY +",
  };
  await execute([broken]);
  const second = (await execute([broken])).operators[0]!;
  expect(second.message).toContain("Repeated validation failure (2)");
  expect(second.diagnostic?.hint).toContain("Needs inspection");
  expect(second.diagnostic?.hint).not.toContain("PRIVATE_CALLBACK_BODY");
  expect(second.diagnostic?.source?.line).toBe(2);
  expect(second.diagnostic?.source?.excerpt).not.toContain("PRIVATE_CALLBACK_BODY");
  const validation = spyOn(codegen, "validateNativeV2");
  try {
    expect((await execute([broken])).operators[0]!.message).toContain("Identical invalid submission paused");
    expect(validation).not.toHaveBeenCalled();
  } finally {
    validation.mockRestore();
  }
  expect((await execute([{ ...broken, func: "def apply(row):\n    return True" }])).operators[0]!.status).toBe("added");
});

test("late preflight validation cannot repopulate a reset task's counters", async () => {
  const { execute, repair } = fixture();
  await execute([source]);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const validation = spyOn(codegen, "validateNativeV2").mockImplementation(async (view, id) => {
    entered.resolve();
    await finish.promise;
    throw new Error(
      "NATIVE_ERROR_V2:" +
        JSON.stringify({
          version: 1,
          operatorId: id,
          operatorRevision: view.revision,
          code: "PYTHON_SYNTAX",
          stage: "compile",
          field: "func",
          message: "invalid syntax",
        })
    );
  });
  const broken = { op: "filter", id: "answer", input: "source", columns: [], func: "def apply(row):\n    return +" };
  try {
    const pending = execute([broken]);
    await entered.promise;
    repair.clear();
    finish.resolve();
    await pending;
    const first = (await execute([broken])).operators[0]!;
    expect(first.message).not.toContain("Needs inspection");
    expect((await execute([broken])).operators[0]!.message).toContain("Repeated validation failure (2)");
  } finally {
    finish.resolve();
    validation.mockRestore();
  }
});

test("graph repairs may reuse identical arguments, and a refused delete does not acknowledge validation errors", async () => {
  const { tools, execute } = fixture();
  await execute([good]);
  await execute([good]);
  const recovered = await execute([good, source]);
  expect(recovered.operators.map(item => item.status)).toEqual(["added", "added"]);
  await execute([{ op: "limit", id: "dependent", input: "answer", n: 1 }]);
  await execute([bad]);
  await execute([bad]);
  expect(await tools.deleteOperator.execute({ id: "answer" })).toContain("[ERROR]");
  expect((await execute([bad])).operators[0]!.message).toContain("Identical invalid submission paused");
});

async function agentFixture() {
  const agent = new TexeraAgent({
    agentId: "validation-repair",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  }) as any;
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  agent.metadataStore = metadata;
  Object.assign(agent.settings, { agentMode: AgentMode.NATIVE, nativeToolMode: "batch", nativeCatalogVersion: "v2" });
  agent.tools = agent.createTools();
  const call = async (name: string, args: unknown, allowError = false) => {
    const result = await agent.handleDebugInput(
      `Function(name=${JSON.stringify(name)}, arguments=${JSON.stringify(JSON.stringify(args))})`
    );
    if (!allowError) expect(result.error).toBeUndefined();
    return agent.getAllSteps().find((step: any) => step.id === agent.getHead()).toolResults[0].output;
  };
  const edit = async (operators = [bad]): Promise<NativeBatchResult> => call("dataflow", { operators });
  await agent.handleDebugInput("Repair repeated invalid arguments.");
  await call("dataflow", { operators: [source, good] });
  const initialHead = agent.getHead();
  return { agent, call, edit, initialHead };
}

test("only inspection of the current diagnostic acknowledges a repair pause, including repeated identical revisions", async () => {
  const { agent, call, edit } = await agentFixture();
  await edit();
  const stale = agent.snapshotStorage.inspectNativeError(agent.getHead(), { operatorId: "answer" }).summary;
  await edit();
  await call("inspectError", { operatorId: "answer", diagnosticId: stale.diagnosticId });
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
  await call("inspectError", { operatorId: "missing" }, true);
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
  const before = agent.getWorkflowState().getWorkflowContent();
  const current = agent.snapshotStorage.inspectNativeError(agent.getHead(), { operatorId: "answer" }).summary;
  const inspected = await call("inspectError", { operatorId: "answer", diagnosticId: current.diagnosticId });
  expect(inspected).toContain("Current error inspection");
  expect(agent.getWorkflowState().getWorkflowContent()).toEqual(before);
  const retry = (await edit()).operators[0]!;
  expect(retry.message).not.toContain("Identical invalid submission paused");
  expect(retry.message).not.toContain("Needs inspection");
});

test("reordered identical arguments keep their actual submitted revision in the paused diagnostic", async () => {
  const { agent, call, edit } = await agentFixture();
  await edit();
  await edit();
  const { op, ...params } = { input: bad.input, aggregations: bad.aggregations, id: bad.id, op: bad.op };
  const result = await call("dataflow", { operators: [{ op, ...params }] });
  expect(result.operators[0].message).toContain("Identical invalid submission paused");
  expect(result.operators[0].diagnostic.code).toBe("INVALID_ARGUMENTS");
  const inspected = agent.snapshotStorage.inspectNativeError(agent.getHead(), { operatorId: "answer" });
  expect(inspected.summary.operatorRevision).toBe(rejectedNativeViewOf(op, params).revision);
  await call("inspectError", { operatorId: "answer" });
  expect((await edit()).operators[0]!.message).not.toContain("Needs inspection");
});

test("repair state survives tool rebuilding, but resets on checkout, new debug task, new model task, and clear", async () => {
  const { agent, edit, initialHead } = await agentFixture();
  await edit();
  await edit();
  agent.tools = agent.createTools();
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
  expect(agent.checkout(initialHead)).toBe(true);
  expect((await edit()).operators[0]!.message).not.toContain("Needs inspection");
  await edit();
  await agent.handleDebugInput("A new task.");
  expect((await edit()).operators[0]!.message).not.toContain("Needs inspection");
  await edit();
  let modelResult: NativeBatchResult | undefined;
  agent.driver = {
    runTurn: async ({ tools }: any) => {
      modelResult = await tools.dataflow.execute({ operators: [bad] });
      return { text: "", messages: [], usage: {} };
    },
  };
  await agent.sendMessage("Another task.");
  expect(modelResult!.operators[0]!.message).not.toContain("Needs inspection");
  agent.clearHistory();
  expect((await edit()).operators[0]!.message).not.toContain("Needs inspection");
});

test("the current repair hint remains visible in DELTA and LATEST after independent work", async () => {
  const { agent, call, edit } = await agentFixture();
  await edit();
  await edit();
  await call("dataflow", { operators: [{ op: "scan", id: "other", files: "data/other.csv" }], observe: [] });
  for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
    const rendered = JSON.stringify(
      assembleContext(agent.getReActSteps(), agent.workflowState, agent.snapshotStorage, mode, {
        agentMode: AgentMode.NATIVE,
        flowLevel: 1,
        dataLevel: 1,
        columnStats: false,
      })
    );
    expect(rendered).toContain("Repeated validation failure (2)");
    expect(rendered).toContain("Needs inspection");
    expect(rendered).toContain("Schema example:");
    expect(rendered).toContain("inspectError");
  }
});
