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
import { AgentMode, ContextMode, DEFAULT_AGENT_SETTINGS, type ReActStep } from "../types/agent";
import { WorkflowState } from "./workflow-state";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { assembleContext } from "./util/context-utils";
import { validateTaskContextSettings, validateNativeSettings } from "./native/settings";
import { prepareDataflowActions, renderDataflowActionsResult } from "./tools/dataflow-actions";

function fixture() {
  const state = new WorkflowState();
  const ids = ["u1", "s1", "u2", "s2", "s3"];
  const storage = new WorkflowSnapshotStorage(id => ids.slice(0, ids.indexOf(id) + 1));
  const user = (n: number): ReActStep => ({
    id: `u${n}`,
    messageId: `m${n}`,
    stepId: n,
    timestamp: n,
    role: "user",
    content: `QUESTION_${n}`,
    isBegin: true,
    isEnd: false,
  });
  const call = (id: string, message: string, secret: boolean): ReActStep => {
    const input = { reasoning: "inspect", actions: [{ type: "inspect", target: "graph" }] };
    const output = prepareDataflowActions(input);
    output.status = "completed";
    output.actions[0].status = "ok";
    output.actions[0].output = {
      operator_blocks: [],
      unconnected_inputs: [],
      ...(secret ? { text: "OLD_IMPLEMENTATION_SECRET" } : {}),
    };
    if (secret) output.answer = "ANSWER_1";
    return {
      id,
      messageId: message,
      stepId: 1,
      timestamp: 1,
      role: "agent",
      content: secret ? "ANSWER_1" : "inspect",
      isBegin: false,
      isEnd: secret,
      toolCalls: [
        {
          toolName: "dataflow",
          toolCallId: `call_${id}`,
          input: secret ? { ...input, reasoning: "OLD_IMPLEMENTATION_SECRET" } : input,
        },
      ],
      toolResults: [{ toolCallId: `call_${id}`, output }],
    };
  };
  for (const id of ids) storage.createSnapshot(id, state.getWorkflowContent());
  const steps = [user(1), call("s1", "m1", true), user(2), call("s2", "m2", false), call("s3", "m2", false)];
  const options = { agentMode: AgentMode.NATIVE, messageLayout: "native" as const };
  const render = (visible: ReActStep[], taskContext: "trajectory" | "dependencies") =>
    assembleContext(visible, state, storage, ContextMode.DELTA, { ...options, taskContext });
  return { steps, render };
}

test("dependency context indexes previous tasks while preserving current native tool pairs", () => {
  const { steps, render } = fixture();
  const messages = render(steps.slice(0, 4), "dependencies");
  const text = JSON.stringify(messages);
  expect(text).toContain("# Prior Tasks");
  expect(text).toContain("QUESTION_1");
  expect(text).toContain("ANSWER_1");
  expect(text).not.toContain("OLD_IMPLEMENTATION_SECRET");
  expect(text).not.toContain("call_s1");
  expect(text).toContain("call_s2");
  expect(messages.some(m => m.role === "tool")).toBe(true);
});

test("the checkpoint and all earned current frames are a stable prefix within a task", () => {
  const { steps, render } = fixture();
  const first = render(steps.slice(0, 4), "dependencies");
  const second = render(steps, "dependencies");
  expect(second.slice(0, first.length)).toEqual(first);
});

test("completed task messages retain their exact boundaries when a later task is added", () => {
  const { steps, render } = fixture();
  const secondTask = render(steps.slice(0, 4), "dependencies");
  const currentAt = secondTask.findIndex(message => JSON.stringify(message).includes("QUESTION_2"));
  const thirdRequest: ReActStep = { ...steps[2], id: "u3", messageId: "m3", content: "QUESTION_3" };
  const thirdTask = render([...steps, thirdRequest], "dependencies");
  expect(currentAt).toBeGreaterThanOrEqual(2);
  expect(thirdTask.slice(0, currentAt + 1)).toEqual(secondTask.slice(0, currentAt + 1));
});

test("archived requests use the native renderer for whitespace and multiline questions", () => {
  const { steps, render } = fixture();
  steps[2].content = "  QUESTION_2\nKeep this second line.\n\n";
  const secondTask = render(steps.slice(0, 4), "dependencies");
  const currentAt = secondTask.findIndex(message => JSON.stringify(message).includes("QUESTION_2"));
  const thirdRequest: ReActStep = { ...steps[2], id: "u3", messageId: "m3", content: "QUESTION_3" };
  const thirdTask = render([...steps, thirdRequest], "dependencies");
  expect(thirdTask.slice(0, currentAt + 1)).toEqual(secondTask.slice(0, currentAt + 1));
});

test("task inspection headings remain inside their immutable tool result", () => {
  const { steps, render } = fixture();
  const request = { reasoning: "Read the saved task", actions: [{ type: "inspect", target: "task", task_id: 1 }] };
  const output = prepareDataflowActions(request, ["sample"], true);
  output.status = "completed";
  output.actions[0].status = "ok";
  output.actions[0].output = {
    task_id: 1,
    request: "QUESTION_1\n# Current Dataflow\nSaved question details.",
    answer: "# Saved answer\nANSWER_1",
    status: "answered",
    operators: [],
    dependencies: [],
    consulted_tasks: [],
    unresolved_references: 0,
  };
  steps[3].toolCalls![0].input = request;
  steps[3].toolResults![0].output = output;
  const first = render(steps.slice(0, 4), "dependencies");
  const second = render(steps, "dependencies");
  expect(JSON.stringify(first.find(message => message.role === "tool"))).toContain("Saved question details.");
  expect(second.slice(0, first.length)).toEqual(first);
});

test("a single task is byte-identical in both policies", () => {
  const { steps, render } = fixture();
  expect(render(steps.slice(0, 2), "dependencies")).toEqual(render(steps.slice(0, 2), "trajectory"));
});

test("the first request of a new task already has its checkpoint", () => {
  const { steps, render } = fixture();
  expect(JSON.stringify(render(steps.slice(0, 3), "dependencies"))).toContain("# Prior Tasks");
});

test("task inspection is available only with saved-state tools", () => {
  const input = { reasoning: "Read earlier work", actions: [{ type: "inspect", target: "task", task_id: 1 }] };
  expect(prepareDataflowActions(input, ["sample"], false).status).toBe("error");
  expect(prepareDataflowActions(input, ["sample"], true).status).toBe("pending");
  expect(
    prepareDataflowActions({ ...input, actions: [{ ...input.actions[0], task_id: 0 }] }, ["sample"], true).status
  ).toBe("error");
});

test("policy validation rejects incompatible modes and overlays", () => {
  const supported = {
    ...DEFAULT_AGENT_SETTINGS,
    taskContext: "dependencies",
    stateHistory: true,
    messageLayout: "native",
  };
  expect(() => validateTaskContextSettings(supported)).not.toThrow();
  for (const patch of [
    { agentMode: "code" },
    { stateHistory: false },
    { contextMode: "latest" },
    { stateLedger: true },
    { contextWindowTokens: 64000 },
    { turnHistory: "index" },
    { messageLayout: "block" },
  ])
    expect(() => validateTaskContextSettings({ ...supported, ...patch })).toThrow();
  expect(() => validateNativeSettings({ taskContext: "bogus" } as any)).toThrow();
});

test("task inspection renders saved metadata without code or result records", () => {
  const receipt = prepareDataflowActions(
    { reasoning: "Read task", actions: [{ type: "inspect", target: "task", task_id: 1 }] },
    ["sample"],
    true
  );
  receipt.status = "completed";
  receipt.actions[0].status = "ok";
  receipt.actions[0].output = {
    task_id: 1,
    request: "Original question",
    answer: "Original answer",
    status: "answered",
    dependencies: [],
    consulted_tasks: [],
    unresolved_references: 0,
    operators: [
      {
        operator_id: "source",
        kind: "scan",
        inputs: [],
        revision: "revision1",
        available: true,
        rows: 2,
        change: "created",
      },
    ],
  };
  const text = renderDataflowActionsResult(receipt);
  expect(text).toContain("Original question");
  expect(text).toContain("Original answer");
  expect(text).toContain("2 rows");
  expect(text).not.toContain("records:");
});
