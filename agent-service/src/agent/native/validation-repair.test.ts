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

import { expect, spyOn, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { assembleContext } from "../util/context-utils";
import { createNativeTools, type NativeBatchResult } from "../tools/native-batch-tools";
import { NATIVE_OPERATORS } from "./catalog";
import { NativeValidationRepair } from "./validation-repair";
import { formatNativeDiagnostic } from "./diagnostics";
import { nativeTestTools } from "./test-support";
import * as codegen from "./codegen";

const source = 'source = scan("data/fixture.csv")';
const good = "answer = aggregate(source, n=count())";
// `alias=` is not a reducer call: rejected by the catalog, never by Python.
const bad = 'answer = aggregate(source, alias="n")';

test("a repeated failure carries the operator's signature, never a copy of the submitted arguments", () => {
  for (const def of NATIVE_OPERATORS) {
    const tracker = new NativeValidationRepair();
    const diagnostic = {
      version: 1 as const,
      operatorId: "answer",
      operatorRevision: "rev",
      code: "INVALID_ARGUMENTS",
      stage: "validate" as const,
      message: "detail ".repeat(100),
    };
    tracker.record(def.name, { id: "answer", secret: "PRIVATE_ARGUMENT" }, diagnostic, def.signature);
    const text = formatNativeDiagnostic(
      tracker.record(def.name, { id: "answer", secret: "PRIVATE_ARGUMENT" }, diagnostic, def.signature)
    );
    expect(text).toContain(`Signature: ${def.signature}`);
    expect(text).not.toContain("PRIVATE_ARGUMENT");
  }
});

function fixture() {
  const repair = new NativeValidationRepair();
  const { state, tools } = nativeTestTools(undefined, { nativeValidationRepair: repair });
  const execute = (program: string): Promise<NativeBatchResult> => tools.dataflow.execute({ edits: program });
  return { state, tools, execute, repair };
}

test("two argument failures show the field and signature; identical retries leave the DAG untouched", async () => {
  const { state, execute } = fixture();
  await execute([source, good].join("\n"));
  const before = state.getWorkflowContent();
  const first = (await execute(bad)).operators[0]!;
  expect(first.status).toBe("error");
  expect(first.message).toContain("alias");
  expect(first.message).not.toContain("identical resubmission stays paused");
  const second = (await execute(bad)).operators[0]!;
  expect(second.message).toContain("Repeated validation failure (2)");
  expect(second.message).toContain("alias");
  expect(second.message).toContain("identical resubmission stays paused");
  expect(second.message).toContain('Signature: aggregate(T, by=[], name=reducer("col"), ...)');
  const third = (await execute(bad)).operators[0]!;
  expect(third.message).toContain("Identical invalid submission paused");
  expect(state.getWorkflowContent()).toEqual(before);
  // Whitespace and keyword order are not a correction.
  expect((await execute('answer  =  aggregate( source,   alias = "n" )')).operators[0]!.message).toContain(
    "Identical invalid submission paused"
  );
});

test("a repeated error pattern escalates across changed values, while corrections and independent branches remain eligible", async () => {
  const { state, execute } = fixture();
  await execute([source, good].join("\n"));
  await execute(bad);
  const changed = 'answer = aggregate(source, alias="rows")';
  expect((await execute(changed)).operators[0]!.message).toContain("Repeated validation failure (2)");
  const mixed = await execute(
    [changed, "dependent = limit(answer, 1)", 'independent = scan("data/another.csv")'].join("\n")
  );
  expect(mixed.operators.map(item => item.status)).toEqual(["error", "blocked", "added"]);
  expect(mixed.operators[0]!.message).toContain("Identical invalid submission paused");
  expect(state.getOperator("dependent")).toBeUndefined();
  expect((await execute(good)).operators[0]!.status).toBe("modified");
  expect((await execute(bad)).operators[0]!.message).not.toContain("identical resubmission stays paused");
});

test("successful deletion and a separate agent reset failures", async () => {
  const f = fixture();
  await f.execute([source, good].join("\n"));
  await f.execute(bad);
  await f.execute(bad);
  expect((await f.tools.dataflow.execute({ edits: "", delete: ["answer"] })).operators[0]!.status).toBe("deleted");
  expect((await f.execute(bad)).operators[0]!.message).not.toContain("identical resubmission stays paused");
  const other = fixture();
  expect((await other.execute(bad)).operators[0]!.message).not.toContain("identical resubmission stays paused");
});

test("Python preflight failures also escalate without copying submitted source into repair hints", async () => {
  const { execute } = fixture();
  await execute(source);
  // Variadic parameters pass the catalog's arity check and fail Python's contract check.
  const broken =
    'def PRIVATE_CALLBACK_BODY(row, *rest):\n    return True\nanswer = filter(source, PRIVATE_CALLBACK_BODY, doc="Keeps every row")';
  const first = (await execute(broken)).operators[0]!;
  expect(first.status).toBe("error");
  expect(first.diagnostic?.code).toBe("CALLBACK_SIGNATURE");
  const second = (await execute(broken)).operators[0]!;
  expect(second.message).toContain("Repeated validation failure (2)");
  expect(second.diagnostic?.hint).toContain("identical resubmission stays paused");
  expect(second.diagnostic?.hint).not.toContain("PRIVATE_CALLBACK_BODY");
  const validation = spyOn(codegen, "validateNativeOperator");
  try {
    expect((await execute(broken)).operators[0]!.message).toContain("Identical invalid submission paused");
    expect(validation).not.toHaveBeenCalled();
  } finally {
    validation.mockRestore();
  }
  expect((await execute('answer = filter(source, lambda row: True, doc="Keeps every row")')).operators[0]!.status).toBe(
    "added"
  );
});

test("late preflight validation cannot repopulate a reset task's counters", async () => {
  const { execute, repair } = fixture();
  await execute(source);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const validation = spyOn(codegen, "validateNativeOperator").mockImplementation(async (view, id) => {
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
  const broken = 'answer = filter(source, lambda row: True, doc="Keeps every row")';
  try {
    const pending = execute(broken);
    await entered.promise;
    repair.clear();
    finish.resolve();
    await pending;
    const first = (await execute(broken)).operators[0]!;
    expect(first.message).not.toContain("identical resubmission stays paused");
    expect((await execute(broken)).operators[0]!.message).toContain("Repeated validation failure (2)");
  } finally {
    finish.resolve();
    validation.mockRestore();
  }
});

test("graph repairs may reuse identical arguments, and a refused delete does not acknowledge validation errors", async () => {
  const { tools, execute } = fixture();
  await execute(good);
  await execute(good);
  const recovered = await execute([good, source].join("\n"));
  expect(recovered.operators.map(item => item.status)).toEqual(["added", "added"]);
  await execute("dependent = limit(answer, 1)");
  await execute(bad);
  await execute(bad);
  expect((await tools.dataflow.execute({ edits: "", delete: ["answer"] })).operators[0]!.status).toBe("error");
  expect((await execute(bad)).operators[0]!.message).toContain("Identical invalid submission paused");
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
  Object.assign(agent.settings, { agentMode: AgentMode.NATIVE });
  const currentTools = agent.createTools.bind(agent);
  agent.createTools = () => ({
    ...currentTools(),
    ...createNativeTools(agent.workflowState, {
      metadataStore: agent.metadataStore,
      nativeValidationRepair: agent.nativeValidationRepair,
      settings: agent.settings,
    }),
  });
  agent.tools = agent.createTools();
  const call = async (name: string, args: any, allowError = false) => {
    const input = args;
    const result = await agent.handleDebugInput(
      `Function(name=${JSON.stringify(name)}, arguments=${JSON.stringify(JSON.stringify(input))})`
    );
    const output = agent.getAllSteps().find((step: any) => step.id === agent.getHead()).toolResults[0].output;
    if (!allowError) expect(result.error).toBe(output.error);
    return output;
  };
  const edit = async (program = bad): Promise<NativeBatchResult> => call("dataflow", { edits: program });
  await agent.handleDebugInput("Repair repeated invalid arguments.");
  await call("dataflow", { edits: [source, good].join("\n") });
  const initialHead = agent.getHead();
  return { agent, call, edit, initialHead };
}

test("an identical invalid resubmission stays paused until corrected arguments land", async () => {
  const { agent, call, edit } = await agentFixture();
  await edit();
  await edit();
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
  const before = agent.getWorkflowState().getWorkflowContent();
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
  expect(agent.getWorkflowState().getWorkflowContent()).toEqual(before);
  const fixed = await call("dataflow", { edits: good });
  expect(["added", "modified"]).toContain(fixed.operators[0].status);
  const retry = (await edit()).operators[0]!;
  expect(retry.message).not.toContain("Identical invalid submission paused");
});

test("reordered identical arguments keep their actual submitted revision in the paused diagnostic", async () => {
  const { agent, call, edit } = await agentFixture();
  await edit();
  await edit();
  const result = await call("dataflow", {
    edits: 'answer = aggregate(alias="n", T=source)'.replace('alias="n", T=source', 'source, alias="n"'),
  });
  expect(result.operators[0].message).toContain("Identical invalid submission paused");
  expect(result.operators[0].diagnostic.code).toBe("INVALID_ARGUMENTS");
  const inspected = agent.snapshotStorage.inspectNativeError(agent.getHead(), { operatorId: "answer" });
  expect(inspected.summary.operatorRevision).toBe(result.operators[0].attempted.revision);
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
});

test("repair state survives tool rebuilding, but resets on checkout, new debug task, new model task, and clear", async () => {
  const { agent, edit, initialHead } = await agentFixture();
  await edit();
  await edit();
  agent.tools = agent.createTools();
  expect((await edit()).operators[0]!.message).toContain("Identical invalid submission paused");
  expect(agent.checkout(initialHead)).toBe(true);
  expect((await edit()).operators[0]!.message).not.toContain("identical resubmission stays paused");
  await edit();
  await agent.handleDebugInput("A new task.");
  expect((await edit()).operators[0]!.message).not.toContain("identical resubmission stays paused");
  await edit();
  let modelResult: NativeBatchResult | undefined;
  agent.driver = {
    runTurn: async ({ tools, onStepFinish }: any) => {
      const input = { edits: bad };
      modelResult = await tools.dataflow.execute(input);
      await onStepFinish({
        text: "",
        toolCalls: [{ toolName: "dataflow", toolCallId: "model", input }],
        toolResults: [{ toolCallId: "model", output: modelResult }],
      });
      return { text: "", messages: [], usage: {} };
    },
  };
  await agent.sendMessage("Another task.");
  expect(modelResult!.operators[0]!.message).not.toContain("identical resubmission stays paused");
  agent.clearHistory();
  expect((await edit()).operators[0]!.message).not.toContain("identical resubmission stays paused");
});

test("the current repair hint remains visible in DELTA and LATEST after independent work", async () => {
  const { agent, call, edit } = await agentFixture();
  await edit();
  await edit();
  await call("dataflow", { edits: 'other = scan("data/other.csv")', observe: [] });
  for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
    const rendered = JSON.stringify(
      assembleContext(agent.getReActSteps(), agent.workflowState, agent.snapshotStorage, mode, {
        agentMode: AgentMode.NATIVE,
        flowEvidence: true,
        dataEvidence: true,
      })
    );
    expect(rendered).toContain("Repeated validation failure (2)");
    expect(rendered).toContain("identical resubmission stays paused");
    expect(rendered).toContain("Signature:");
  }
});
