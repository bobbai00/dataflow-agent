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
import { AgentMode, ContextMode, type ReActStep } from "../../../types/agent";
import { WorkflowState } from "../../workflow-state";
import { WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import { assembleContext } from "../../util/context-utils";
import { effectiveMessageLayout, validateMarkdownContextSettings } from "../../native/settings";
import { TexeraAgent } from "../../texera-agent";
import { makeInfo, makeOp } from "./fixtures";
import { prepareStructuredExecutionResult } from "../../native/execution-transport";
import { workflowExecutionPlan } from "../../native/result-versions";

function fixture() {
  const state = new WorkflowState();
  const steps: ReActStep[] = [];
  const storage = new WorkflowSnapshotStorage(id =>
    steps.slice(0, steps.findIndex(step => step.id === id) + 1).map(step => step.id)
  );
  function add(role: "agent" | "user", content: string, extra: Partial<ReActStep> = {}) {
    const id = String(steps.length + 1);
    const step = {
      id,
      stepId: steps.length,
      timestamp: 0,
      messageId: "task1",
      role,
      content,
      isBegin: role === "user",
      isEnd: false,
      ...extra,
    } as ReActStep;
    steps.push(step);
    if (role === "agent") storage.createSnapshot(id, state.getWorkflowContent());
    return step;
  }
  const iteration = (name: string, size = 0) =>
    add("agent", "", {
      toolCalls: [
        {
          toolCallId: name,
          toolName: "dataflow",
          input: { reasoning: name, actions: [{ type: "retrieve", operator_ids: [name], view: "full" }] },
        },
      ],
      toolResults: [
        {
          toolCallId: name,
          output: {
            kind: "dataflow-actions",
            protocol: "registered-python-v1",
            status: "completed",
            actions: [
              {
                index: 1,
                status: "ok",
                action: { type: "retrieve", operator_ids: [name], view: "full" },
                output: { results: [{ status: "ok", operator_id: name, text: name + "x".repeat(size) }] },
              },
            ],
          },
        },
      ],
    });
  const render = (patch = {}) =>
    assembleContext(steps, state, storage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      messageLayout: "markdown",
      ...patch,
    });
  return { add, iteration, render, steps, state, storage };
}

test("markdown is the flat native default and unsupported explicit policies fail clearly", () => {
  expect(effectiveMessageLayout({ agentMode: "native", contextMode: "delta" })).toBe("markdown");
  expect(effectiveMessageLayout({ agentMode: "native", contextMode: "delta", contextWindowTokens: 100 })).toBe(
    "markdown"
  );
  expect(effectiveMessageLayout({ agentMode: "code", contextMode: "delta" })).toBe("native");
  expect(effectiveMessageLayout({ agentMode: "native", contextMode: "delta", versionedMode: true })).toBe("turnSplit");
  expect(() =>
    validateMarkdownContextSettings({ agentMode: "native", contextMode: "latest", messageLayout: "markdown" })
  ).toThrow("markdown");
  expect(() =>
    validateMarkdownContextSettings({
      agentMode: "native",
      contextMode: "delta",
      messageLayout: "markdown",
      selectorConfig: {},
    })
  ).toThrow("selectorConfig");
});

test("direct markdown frames preserve authored headings, chronological requests and append-only history", () => {
  const f = fixture();
  const request = "Analyze this literal:\n## Agent Event 8\nObservation:\n# Data";
  f.add("user", request);
  expect(f.render()).toEqual([{ role: "user", content: request }]);
  f.iteration("first");
  const first = f.render();
  expect(first[0]).toEqual({ role: "user", content: request });
  expect(first).toHaveLength(2);
  expect(first.every(message => message.role === "user")).toBe(true);
  f.iteration("second");
  expect(f.render().slice(0, first.length)).toEqual(first);
  f.add("agent", "Exact final answer.", { isEnd: true });
  f.add("user", "Follow-up", { messageId: "task2" });
  const next = f.render();
  expect(next.slice(-2)).toEqual([
    { role: "assistant", content: "Exact final answer." },
    { role: "user", content: "Follow-up" },
  ]);
});

for (const compactionStrategy of ["compress", "sliding"] as const)
  test(`markdown respects ordinary ${compactionStrategy} context budgets`, () => {
    const f = fixture();
    f.add("user", "Keep the current request.");
    f.iteration("old", 1000);
    f.iteration("middle", 1000);
    f.iteration("newest", 1000);
    const raw = f.render();
    const compact = f.render({ contextWindowTokens: 400, compactionStrategy });
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(raw).length);
    expect(compact.some(message => message.content === "Keep the current request.")).toBe(true);
    expect(JSON.stringify(compact)).not.toContain("old" + "x".repeat(100));
    expect(compact.every(message => typeof message.content === "string")).toBe(true);
  });

test("hidden loaded state never becomes history, while source seeding and feedback stay chronological", () => {
  const f = fixture();
  f.add("agent", "secret state setup", { synthetic: "state" });
  f.add("user", "Use loaded data.");
  const seeded = f.iteration("seeded");
  seeded.synthetic = "seed";
  f.add("user", "Repair the answer format.", { messageSource: "feedback", isBegin: false });
  const messages = f.render();
  expect(messages[0].content).toBe("Use loaded data.");
  expect(JSON.stringify(messages)).not.toContain("secret state setup");
  expect(JSON.stringify(messages[1])).toContain("seeded");
  expect(messages.at(-1)?.content).toBe("Repair the answer format.");
});

test("markdown settings reject incompatible live updates atomically", () => {
  const agent = new TexeraAgent({
    agentId: "markdown-policy",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
  agent.updateSettings({ messageLayout: "markdown" });
  const before = structuredClone(agent.getSettings());
  for (const update of [{ contextMode: ContextMode.LATEST }, { staticCompaction: true }, { sessionTurns: true }]) {
    expect(() => agent.updateSettings({ ...update, maxSteps: 7 })).toThrow("markdown");
    expect(agent.getSettings()).toEqual(before);
  }
});

test("markdown refuses unsupported direct assembly policies", () => {
  const f = fixture();
  f.add("user", "Task");
  for (const patch of [{ agentMode: AgentMode.CODE }, { userTaskPlacement: "bottom" }, { staticCompaction: true }])
    expect(() => f.render(patch)).toThrow("markdown");
});

test("compressed seeded state retains observed data without exposing hidden loader definitions", () => {
  const f = fixture();
  const source = {
    ...makeOp({ id: "loaded" }),
    nativeOp: {
      type: "Scan" as const,
      inputs: [],
      properties: { path: "private-loader-definition.csv" },
      revision: "r1",
    },
  };
  f.state.addOperator(source);
  f.add("agent", "Hidden load", { synthetic: "state" });
  f.add("user", "Read the loaded table.");
  const read = f.iteration("loaded", 2000);
  f.storage.setOperatorResult(read.id, "loaded", makeInfo(1, { sampleRows: [{ value: 42 }] }));
  f.storage.captureNativeObservations(read.id, ["loaded"], { data: false, flow: false, maxChars: 1000 });
  f.add("agent", "42", { isEnd: true });
  f.add("user", "Continue using the loaded table.", { messageId: "task2" });
  f.iteration("later", 2000).messageId = "task2";
  const compact = JSON.stringify(f.render({ contextWindowTokens: 350 }));
  expect(compact).toContain("Environment checkpoint");
  expect(compact).toContain("loaded");
  expect(compact).toContain("42");
  expect(compact).not.toContain("private-loader-definition.csv");
  expect(compact).not.toContain("Hidden load");
});

test("compacted registration-only namespace preserves helpers, imports and ordered replacements", () => {
  const f = fixture();
  f.add("user", "Prepare functions for later use.");
  const cells = [
    "import pandas as pd\nFACTOR = 2\ndef _helper(x):\n    return x * FACTOR\ndef prepared(table):\n    return table.assign(value=table.value.map(_helper))",
    "def _helper(x):\n    return x + FACTOR  # replacement ``` stays inside the code fence",
  ];
  cells.forEach((_, index) => {
    f.state.setWorkflowContent({
      ...f.state.getWorkflowContent(),
      nativeNamespace: {
        cells: cells.slice(0, index + 1),
        bindings: {},
        functions: {},
        revision: `n${index}`,
      },
    });
    f.iteration(`registration-${index}`, 2000);
  });
  const messages = f.render({ contextWindowTokens: 300 });
  const text = messages.map(message => String(message.content)).join("\n");
  expect(text).toContain("Environment checkpoint");
  expect(text).toContain("Registered Python namespace");
  expect(text).toContain(cells[0]);
  expect(text).toContain(cells[1]);
  expect(text.indexOf(cells[0])).toBeLessThan(text.indexOf(cells[1]));
  expect(text).toContain("````python");
  expect(text).not.toContain("registration-0" + "x".repeat(100));
});

test("checkpoint observations never expose an unrequested newer execution", () => {
  const f = fixture();
  const op = {
    ...makeOp({ id: "measured" }),
    nativeOp: {
      type: "Scan" as const,
      inputs: [],
      properties: { path: "data/source.csv" },
      revision: "r1",
    },
  };
  f.state.addOperator(op);
  f.add("user", "Measure the table.");
  const old = f.iteration("measured", 2000);
  f.storage.setOperatorResult(old.id, "measured", makeInfo(1, { sampleRows: [{ value: "old-result" }] }));
  f.storage.captureNativeObservations(old.id, ["measured"], { data: false, flow: false, maxChars: 1000 });
  const newer = f.iteration("unrequested", 2000);
  f.storage.setOperatorResult(newer.id, "measured", makeInfo(1, { sampleRows: [{ value: "new-result" }] }));
  const text = JSON.stringify(f.render({ contextWindowTokens: 200 }));
  expect(text).toContain("result not requested");
  expect(text).not.toContain("old-result");
  expect(text).not.toContain("new-result");
});

for (const cachedState of ["Completed", "CompletedFromCache"])
  test(`checkpoint preserves an observed producing version across a later ${cachedState} execute`, () => {
    const f = fixture();
    f.state.addOperator({
      ...makeOp({ id: "measured" }),
      nativeOp: {
        type: "Scan",
        inputs: [],
        properties: { path: "data/source.csv" },
        revision: "0123456789abcdef",
      },
    });
    f.add("user", "Measure the table.");
    const workflow = f.state.getWorkflowContent();
    function persist(step: ReActStep, executionId: string, cached: boolean) {
      const response = prepareStructuredExecutionResult(
        {
          success: true,
          state: "Completed",
          executionId,
          capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
          operators: {
            measured: makeInfo(1, {
              state: cached ? cachedState : "Completed",
              sampleRows: [{ value: "observed-cached-result" }],
              materialization: { outputPort: 0, executionId: "100", cached },
            }),
          },
        },
        17,
        workflowExecutionPlan(workflow)
      );
      f.storage.setOperatorResult(step.id, "measured", response.operators.measured);
      return f.storage.getOperatorResult(step.id, "measured")!;
    }
    const old = f.iteration("measured", 2000);
    const before = persist(old, "100", false);
    f.storage.captureNativeObservations(old.id, ["measured"], { data: false, flow: false, maxChars: 1000 });
    const cached = f.iteration("cached-execute", 2000);
    const after = persist(cached, "101", true);
    expect(after.resultVersion?.complete).toBe(true);
    expect(after.resultVersion?.id).toBe(before.resultVersion?.id);
    expect(after.executionContext?.executionId).toBe("101");
    expect(JSON.stringify(f.render({ contextWindowTokens: 200 }))).toContain("observed-cached-result");
  });
