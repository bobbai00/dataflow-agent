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

import { describe, expect, test } from "bun:test";
import { assembleLocalReactContext } from "./context-utils-local-react";
import { WorkflowState } from "../workflow-state";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { ReActStep } from "../../types/agent";

function userStep(id: string, content: string, parentId?: string): ReActStep {
  return {
    id,
    parentId,
    messageId: `msg-${id}`,
    stepId: 0,
    timestamp: Date.now(),
    role: "user",
    content,
    isBegin: true,
    isEnd: true,
  };
}

function agentStep(
  id: string,
  thought: string,
  toolCalls: Array<{ toolName: string; input: any; output?: any }>,
  parentId?: string
): ReActStep {
  return {
    id,
    parentId,
    messageId: `msg-${id}`,
    stepId: 1,
    timestamp: Date.now(),
    role: "agent",
    content: thought,
    isBegin: false,
    isEnd: toolCalls.length === 0,
    toolCalls: toolCalls.map((tc, i) => ({ toolName: tc.toolName, toolCallId: `${id}-${i}`, input: tc.input })),
    toolResults: toolCalls.map((tc, i) => ({
      toolCallId: `${id}-${i}`,
      output: tc.output ?? "",
      isError: false,
    })),
  };
}

function initStep(id: string): ReActStep {
  return {
    id,
    parentId: undefined,
    messageId: `msg-${id}`,
    stepId: 0,
    timestamp: Date.now(),
    role: "agent",
    content: "Initialization.",
    isBegin: true,
    isEnd: true,
    toolCalls: [{ toolName: "initialize", toolCallId: `${id}-init`, input: {} }],
    toolResults: [{ toolCallId: `${id}-init`, output: "ok", isError: false }],
  };
}

/** Compose ws + storage where the only thing tests care about is the
 *  workflow snapshot at HEAD; results map is left empty so no `Result:`
 *  blocks appear (formatOperatorResult coverage is tested elsewhere). */
function makeAgentFixture(steps: ReActStep[]) {
  const ws = new WorkflowState();
  const storage = new WorkflowSnapshotStorage(stepId => {
    const idx = steps.findIndex(s => s.id === stepId);
    if (idx < 0) return [];
    const chain: string[] = [];
    for (let i = 0; i <= idx; i++) chain.push(steps[i].id);
    return chain;
  });
  // No snapshots created → storage falls through to root (empty workflow).
  return { ws, storage };
}

function getContent(result: ReturnType<typeof assembleLocalReactContext>): string {
  const first = result[0];
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}

describe("assembleLocalReactContext", () => {
  test("single user task → Event 1 + sentinel, no dataflow when empty", () => {
    const steps = [userStep("u1", "Compute the answer.")];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain("# Event 1 (User Task)");
    expect(content).toContain("Compute the answer.");
    expect(content).toContain("User's request is: Compute the answer.");
    expect(content).toContain(
      "Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow."
    );
    // Empty workflow → no Current Dataflow section.
    expect(content).not.toContain("# Current Dataflow");
  });

  test("init step is filtered from event numbering", () => {
    const steps = [
      initStep("init"),
      userStep("u1", "Hi.", "init"),
      agentStep("a1", "Thinking.", [
        { toolName: "createOrModifyOperator", input: { operatorId: "x", summary: "S" }, output: "Added operator x" },
      ], "u1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain("# Event 1 (User Task)");
    expect(content).toContain("# Event 2 (Agent Actions)");
    expect(content).not.toContain("Event 3");
    // init step's tool name should not appear as an action bullet.
    expect(content).not.toContain("- initialize(");
  });

  test("action bullet: single-line result, operatorId+summary args, no code", () => {
    const steps = [
      userStep("u1", "task"),
      agentStep("a1", "doing it", [
        {
          toolName: "createOrModifyOperator",
          input: {
            operatorId: "loadData",
            code: "def load():\n    return pd.read_csv('x.csv')",
            summary: "Load x",
          },
          output: "Added operator loadData, input ports: 0, output ports: 1",
        },
      ], "u1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain(
      `- createOrModifyOperator(operatorId="loadData", summary="Load x") (result: Added operator loadData, input ports: 0, output ports: 1)`
    );
    // `code` arg must be redacted from the bullet.
    expect(content).not.toContain("def load()");
    expect(content).not.toContain("code=");
  });

  test("action bullet: multi-line result wrapped on its own block, 4-space indent, closing `)` on its own line", () => {
    const multilineOut =
      "[WARNING] Operator code contains `print(...)` — print output is dropped.\nAdded operator x, input ports: 0, output ports: 1";
    const steps = [
      userStep("u1", "task"),
      agentStep("a1", "thinking", [
        {
          toolName: "createOrModifyOperator",
          input: { operatorId: "x", summary: "S" },
          output: multilineOut,
        },
      ], "u1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain(`- createOrModifyOperator(operatorId="x", summary="S") (result:\n`);
    expect(content).toContain("    [WARNING] Operator code contains");
    expect(content).toContain("    Added operator x, input ports: 0, output ports: 1\n  )");
  });

  test("multiple Actions in one agent step render as multiple bullets under one Actions: heading", () => {
    const steps = [
      userStep("u1", "task"),
      agentStep("a1", "load both", [
        { toolName: "createOrModifyOperator", input: { operatorId: "a", summary: "A" }, output: "Added operator a" },
        { toolName: "createOrModifyOperator", input: { operatorId: "b", summary: "B" }, output: "Added operator b" },
      ], "u1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    const actionsBlock = content.slice(content.indexOf("Actions:"));
    const bulletCount = (actionsBlock.match(/^- createOrModifyOperator/gm) || []).length;
    expect(bulletCount).toBe(2);
    // Single Actions: heading, not duplicated.
    expect((content.match(/^Actions:$/gm) || []).length).toBe(1);
  });

  test("summary values containing quotes get JSON-escaped", () => {
    const steps = [
      userStep("u1", "task"),
      agentStep("a1", "thinking", [
        {
          toolName: "createOrModifyOperator",
          input: { operatorId: "x", summary: 'Has "quotes" in it' },
          output: "ok",
        },
      ], "u1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain(`summary="Has \\"quotes\\" in it"`);
  });

  test("agent step with no tool calls renders Thought but no Actions: heading", () => {
    const steps = [
      userStep("u1", "task"),
      agentStep("a1", "Just thinking, no actions.", [], "u1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain("Thought: Just thinking, no actions.");
    expect(content).not.toContain("Actions:");
  });

  test("latest user task is what gets repeated under `User's request is:`", () => {
    const steps = [
      userStep("u1", "first task"),
      agentStep("a1", "did first", [], "u1"),
      userStep("u2", "second task", "a1"),
    ];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain("User's request is: second task");
    expect(content).not.toContain("User's request is: first task");
    // Both user tasks still show up as Events.
    expect(content).toContain("# Event 1 (User Task)");
    expect(content).toContain("# Event 3 (User Task)");
  });

  test("no user steps at all → sentinel still renders, no User's request line", () => {
    const steps = [initStep("init")];
    const { ws, storage } = makeAgentFixture(steps);
    const content = getContent(assembleLocalReactContext(steps, ws, storage));
    expect(content).toContain(
      "Above is user's request and the steps you already took."
    );
    expect(content).not.toContain("User's request is:");
  });
});
