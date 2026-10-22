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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TexeraAgent } from "./texera-agent";
import { TraceStore } from "../trace/trace-store";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { type ReActStep } from "../types/agent";
import type { WorkflowContent } from "../types/workflow";
import type { OperatorInfo } from "../types/execution";
import type { LLMDriver, ContextAssembler } from "./llm-drivers/types";

// We never invoke the LLM in these tests (only synchronous tree mechanics +
// `handleDebugInput` plain-text path, which doesn't enter the driver loop).
const stubDriver: LLMDriver = {
  runTurn: async () => ({
    text: "",
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }),
};
const stubAssembler: ContextAssembler = () => [{ role: "user", content: "" }];

function makeAgent(): TexeraAgent {
  return new TexeraAgent({
    driver: stubDriver,
    contextAssembler: stubAssembler,
    modelType: "test-model",
    agentId: "test-agent",
  });
}

function makeStep(overrides: Partial<ReActStep> & Pick<ReActStep, "id">): ReActStep {
  return {
    messageId: "msg-default",
    stepId: 0,
    timestamp: Date.now(),
    role: "agent",
    content: "",
    isBegin: true,
    isEnd: true,
    ...overrides,
  };
}

function emptyWorkflow(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

function workflowWith(operatorIds: string[]): WorkflowContent {
  return {
    ...emptyWorkflow(),
    operators: operatorIds.map(
      id =>
        ({
          operatorID: id,
          operatorType: "TestOp",
          operatorVersion: "1",
          operatorProperties: {},
          inputPorts: [],
          outputPorts: [],
          showAdvanced: false,
        }) as any
    ),
  };
}

function makeOpInfo(opId: string, rows: number): OperatorInfo {
  return {
    operatorID: opId,
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows,
    inputPortShapes: undefined,
    totalRowCount: rows,
    result: undefined,
  } as unknown as OperatorInfo;
}

// ============================================================================
// Tree-mechanics unit tests
// ============================================================================

describe("TexeraAgent — initial state", () => {
  test("HEAD is undefined and step list is empty for a fresh agent", () => {
    const agent = makeAgent();
    expect(agent.getHead()).toBeUndefined();
    expect(agent.getAllSteps().length).toBe(0);
    expect(agent.getReActSteps().length).toBe(0);
  });

  test("getAncestorPath() of an empty agent is []", () => {
    const agent = makeAgent();
    expect(agent.getAncestorPath()).toEqual([]);
  });

  test("getVisibleReActSteps is empty for a fresh agent", () => {
    const agent = makeAgent();
    expect(agent.getVisibleReActSteps()).toEqual([]);
  });
});

describe("TexeraAgent — handleDebugInput plain-text path", () => {
  test("appends a user step as the tree root and advances HEAD", async () => {
    const agent = makeAgent();
    const result = await agent.handleDebugInput("hello world");

    expect(result.kind).toBe("user_message");
    const steps = agent.getAllSteps();
    expect(steps.length).toBe(1);
    expect(steps[0].role).toBe("user");
    expect(steps[0].content).toBe("hello world");
    expect(steps[0].parentId).toBeUndefined();
    expect(agent.getHead()).toBe(steps[0].id);
  });

  test("two consecutive plain-text inputs form a chain via parentId", async () => {
    const agent = makeAgent();
    await agent.handleDebugInput("first");
    const firstId = agent.getHead()!;
    await agent.handleDebugInput("second");
    const secondId = agent.getHead()!;

    expect(firstId).not.toBe(secondId);
    const second = agent.getAllSteps().find(s => s.id === secondId)!;
    expect(second.parentId).toBe(firstId);
    expect(agent.getAncestorPath()).toEqual([firstId, secondId]);
  });
});

describe("TexeraAgent — handleDebugInput agent inputs", () => {
  test("a Reply(...) ends the ongoing task as the agent's reply, after a call whose lines carry its thought", async () => {
    const agent = makeAgent();
    await agent.handleDebugInput("How many rows?");
    const call = await agent.handleDebugInput("Nothing to compute.\nFunction(name='unknownTool', arguments='{}')");
    expect(call.kind).toBe("function_call");
    const callStep = agent.getAllSteps().at(-1)!;
    expect(callStep.role).toBe("agent");
    expect(callStep.content).toBe("Nothing to compute.");
    expect(callStep.toolCalls?.[0]?.toolName).toBe("unknownTool");

    const reply = await agent.handleDebugInput("Reply(text='There are 3 rows.')");
    expect(reply).toEqual({ kind: "reply", stopped: false });
    const steps = agent.getAllSteps();
    const replyStep = steps.at(-1)!;
    expect(replyStep).toMatchObject({ role: "agent", content: "There are 3 rows.", isEnd: true, isBegin: false });
    expect(replyStep.messageId).toBe(steps[0].messageId);
    expect(replyStep.stepId).toBe(callStep.stepId + 1);
    expect(replyStep.parentId).toBe(callStep.id);
    expect(agent.getHead()).toBe(replyStep.id);
    // The task is over: the next agent input starts a task of its own.
    await agent.handleDebugInput("Reply(text='Again.')");
    expect(agent.getAllSteps().at(-1)!.messageId).not.toBe(steps[0].messageId);
  });

  test("a malformed agent input is recorded as an error step", async () => {
    const agent = makeAgent();
    const result = await agent.handleDebugInput("Reply(text='unterminated)");
    expect(result.kind).toBe("function_call");
    expect(result.error).toContain("Failed to parse the agent input");
    expect(agent.getAllSteps().at(-1)!.content).toStartWith("[ERROR]");
  });
});

describe("TexeraAgent — trace store", () => {
  test("a turn's steps, snapshots and end reach the store as they happen, in the order a restore replays", async () => {
    const trace = new TraceStore(":memory:");
    trace.agentCreated({ id: "traced", name: "Bob", model: "test-model", createdAt: Date.now() });
    const agent = new TexeraAgent({
      driver: stubDriver,
      contextAssembler: stubAssembler,
      modelType: "test-model",
      agentId: "traced",
      trace,
    });
    await agent.handleDebugInput("How many rows?");
    await agent.handleDebugInput("Look.\nFunction(name='unknownTool', arguments='{}')");
    await agent.handleDebugInput("Reply(text='There are 3 rows.')");

    const exported = trace.exportAgent("traced")!;
    expect(exported.turns).toEqual([
      expect.objectContaining({ channel: "debug", text: "How many rows?", status: "ok", reply: "There are 3 rows." }),
    ]);
    expect((exported.steps as any[]).map(s => [s.role, s.content, s.is_end, s.tool_calls])).toEqual([
      ["user", "How many rows?", 1, 0],
      ["agent", "Look.", 0, 1],
      ["agent", "There are 3 rows.", 1, 0],
    ]);
    expect((exported.snapshots as any[]).length).toBeGreaterThanOrEqual(1); // the call owns a snapshot
    expect(exported.llm_calls).toEqual([]); // debug inputs call no model
    expect(trace.stepsOf("traced").map(s => s.id)).toEqual(agent.getAllSteps().map(s => s.id));
    trace.close();
  });
});

describe("TexeraAgent — clearHistory", () => {
  test("resets HEAD to undefined, drops steps, drops snapshot storage", async () => {
    const agent = makeAgent();
    await agent.handleDebugInput("first");
    await agent.handleDebugInput("second");
    expect(agent.getAllSteps().length).toBe(2);

    agent.clearHistory();

    expect(agent.getHead()).toBeUndefined();
    expect(agent.getAllSteps().length).toBe(0);
    expect(agent.getReActSteps().length).toBe(0);
  });
});

describe("TexeraAgent — importReActSteps", () => {
  test("imports a linear chain and lands HEAD at the leaf", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: undefined, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "a", timestamp: 2 }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 2, role: "agent", content: "b", timestamp: 3 }),
    ];

    const { headId, importedCount } = await agent.importReActSteps(steps);

    expect(importedCount).toBe(3);
    expect(headId).toBe("s3");
    expect(agent.getHead()).toBe("s3");
    expect(agent.getAncestorPath()).toEqual(["s1", "s2", "s3"]);
  });

  test("imports a branched tree; HEAD picks the latest-timestamp leaf", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "root",
        parentId: undefined,
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "r",
        timestamp: 1,
      }),
      makeStep({
        id: "left",
        parentId: "root",
        messageId: "m2",
        stepId: 0,
        role: "agent",
        content: "L",
        timestamp: 100,
      }),
      makeStep({
        id: "right",
        parentId: "root",
        messageId: "m3",
        stepId: 0,
        role: "agent",
        content: "R",
        timestamp: 200,
      }),
    ];

    const { headId } = await agent.importReActSteps(steps);
    expect(headId).toBe("right");
    expect(agent.getAncestorPath()).toEqual(["root", "right"]);
  });

  test("loads provided snapshots into the storage and restores HEAD's workflow", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: undefined, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "a", timestamp: 2 }),
    ];
    const snapshots = {
      s2: workflowWith(["op1", "op2"]),
    };

    await agent.importReActSteps(steps, snapshots);

    expect(agent.getHead()).toBe("s2");
    // Live workflow restored from HEAD's snapshot
    const live = agent
      .getWorkflowState()
      .getAllOperators()
      .map(o => o.operatorID)
      .sort();
    expect(live).toEqual(["op1", "op2"]);
    // Direct storage lookup confirms ancestor walk
    const wf = agent.getSnapshotStorage().getWorkflow("s2");
    expect(wf?.operators.length).toBe(2);
  });

  test("promotes a step with an unknown parentId to a root", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "orphan",
        parentId: "ghost",
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "x",
        timestamp: 1,
      }),
    ];
    const { headId, importedCount } = await agent.importReActSteps(steps);
    expect(importedCount).toBe(1);
    expect(headId).toBe("orphan");
    // The dangling link is dropped, not preserved.
    expect(agent.getAllSteps()[0].parentId).toBeUndefined();
    expect(agent.getAncestorPath()).toEqual(["orphan"]);
  });

  test("imports an export whose first step references the never-exported initialize root", async () => {
    // Real exports come from getRenderableReActSteps(), which filters out the
    // synthetic `initialize` bootstrap step — so the earliest exported step
    // always points at a parent missing from the archive.
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "s2",
        parentId: "s1-init-not-exported",
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "u",
        timestamp: 1,
      }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 1, role: "agent", content: "a", timestamp: 2 }),
      makeStep({ id: "s4", parentId: "s3", messageId: "m1", stepId: 2, role: "agent", content: "b", timestamp: 3 }),
    ];

    const { headId, importedCount } = await agent.importReActSteps(steps);

    expect(importedCount).toBe(3);
    expect(headId).toBe("s4");
    expect(agent.getAncestorPath()).toEqual(["s2", "s3", "s4"]);
  });

  test("rejects duplicate step ids", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "dup",
        parentId: undefined,
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "x",
        timestamp: 1,
      }),
      makeStep({
        id: "dup",
        parentId: undefined,
        messageId: "m2",
        stepId: 0,
        role: "user",
        content: "y",
        timestamp: 2,
      }),
    ];
    await expect(agent.importReActSteps(steps)).rejects.toThrow(/duplicate step id/);
  });
});

describe("TexeraAgent — checkout (time travel)", () => {
  test("moves HEAD and restores the workflow visible at that step via storage ancestor walk", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "root",
        parentId: undefined,
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "r",
        timestamp: 1,
      }),
      makeStep({
        id: "left",
        parentId: "root",
        messageId: "m2",
        stepId: 0,
        role: "agent",
        content: "L",
        timestamp: 100,
      }),
      makeStep({
        id: "right",
        parentId: "root",
        messageId: "m3",
        stepId: 0,
        role: "agent",
        content: "R",
        timestamp: 200,
      }),
    ];
    const snapshots = {
      left: workflowWith(["L_op"]),
      right: workflowWith(["R_op"]),
    };
    await agent.importReActSteps(steps, snapshots);

    // Imported HEAD is "right"
    expect(
      agent
        .getWorkflowState()
        .getAllOperators()
        .map(o => o.operatorID)
    ).toEqual(["R_op"]);

    expect(agent.checkout("left")).toBe(true);
    expect(agent.getHead()).toBe("left");
    expect(
      agent
        .getWorkflowState()
        .getAllOperators()
        .map(o => o.operatorID)
    ).toEqual(["L_op"]);

    expect(agent.checkout("right")).toBe(true);
    expect(
      agent
        .getWorkflowState()
        .getAllOperators()
        .map(o => o.operatorID)
    ).toEqual(["R_op"]);
  });

  test("checkout to an unknown stepId returns false and does not move HEAD", () => {
    const agent = makeAgent();
    const before = agent.getHead();
    expect(agent.checkout("does-not-exist")).toBe(false);
    expect(agent.getHead()).toBe(before);
  });

  test("checkout to a step whose ancestors own no snapshot restores the empty-root workflow", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: undefined, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
    ];
    await agent.importReActSteps(steps); // no snapshots provided

    // Pre-populate live workflow externally.
    agent.getWorkflowState().setWorkflowContent(workflowWith(["pre-op"]));
    expect(agent.checkout("s1")).toBe(true);
    // s1's associated snapshot falls through to the storage's empty root,
    // which has an empty workflow. Checkout restores that — the prior
    // external state is overwritten.
    expect(agent.getWorkflowState().getAllOperators()).toEqual([]);
  });
});

describe("TexeraAgent — visibility (branch filtering)", () => {
  test("getReActSteps returns the entire forest; getVisibleReActSteps only HEAD's branch", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "root",
        parentId: undefined,
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "r",
        timestamp: 1,
      }),
      makeStep({
        id: "left",
        parentId: "root",
        messageId: "m2",
        stepId: 0,
        role: "agent",
        content: "L",
        timestamp: 100,
      }),
      makeStep({
        id: "right",
        parentId: "root",
        messageId: "m3",
        stepId: 0,
        role: "agent",
        content: "R",
        timestamp: 200,
      }),
    ];
    await agent.importReActSteps(steps);

    expect(agent.getReActSteps().length).toBe(3); // forest
    expect(agent.getVisibleReActSteps().map(s => s.id)).toEqual(["root", "right"]);

    agent.checkout("left");
    expect(agent.getReActSteps().length).toBe(3); // forest unchanged
    expect(agent.getVisibleReActSteps().map(s => s.id)).toEqual(["root", "left"]);
  });
});

// ============================================================================
// Integration tests — snapshot storage + ReActStep tree
// ============================================================================

describe("TexeraAgent ↔ WorkflowSnapshotStorage integration", () => {
  test("operator-result inheritance walks the active branch's ancestors", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: undefined, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({
        id: "s2",
        parentId: "s1",
        messageId: "m1",
        stepId: 1,
        role: "agent",
        content: "ran A,B,C",
        timestamp: 2,
      }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 2, role: "agent", content: "noop", timestamp: 3 }),
    ];
    await agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.createSnapshot("s2", emptyWorkflow()); // s2 is the action-bearing step
    storage.setOperatorResult("s2", "A", makeOpInfo("A", 100));
    storage.setOperatorResult("s2", "B", makeOpInfo("B", 200));

    // s3 owns no snapshot → its associated snapshot is s2's, so its visible
    // results are s2's.
    const visible = storage.getAllVisibleResults("s3");
    expect(visible.size).toBe(2);
    expect(visible.get("A")?.totalRowCount).toBe(100);
    expect(visible.get("B")?.totalRowCount).toBe(200);
  });

  test("middle-op rewrite WITHOUT downstream re-execution leaves a stale downstream result visible", async () => {
    // Documents the writer-enforced-consistency design property at the agent
    // level. Mirrors the storage-level test, but this time HEAD is set via
    // checkout/import so the path comes from the real ReActStep tree.
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: undefined, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({
        id: "s2",
        parentId: "s1",
        messageId: "m1",
        stepId: 1,
        role: "agent",
        content: "first run",
        timestamp: 2,
      }),
      makeStep({
        id: "s3",
        parentId: "s2",
        messageId: "m1",
        stepId: 2,
        role: "agent",
        content: "rewrite B only",
        timestamp: 3,
      }),
    ];
    await agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.createSnapshot("s2", emptyWorkflow());
    storage.setOperatorResult("s2", "A", makeOpInfo("A", 1));
    storage.setOperatorResult("s2", "B", makeOpInfo("B", 1));
    storage.setOperatorResult("s2", "C", makeOpInfo("C", 1));
    storage.createSnapshot("s3", emptyWorkflow()); // inherits s2's results
    storage.setOperatorResult("s3", "B", makeOpInfo("B", 999));

    const visible = storage.getAllVisibleResults("s3");
    expect(visible.get("A")?.totalRowCount).toBe(1);
    expect(visible.get("B")?.totalRowCount).toBe(999);
    expect(visible.get("C")?.totalRowCount).toBe(1); // STALE; storage has no DAG awareness
  });

  test("middle-op rewrite WITH downstream re-execution at the new step yields a consistent visible map", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: undefined, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({
        id: "s2",
        parentId: "s1",
        messageId: "m1",
        stepId: 1,
        role: "agent",
        content: "first run",
        timestamp: 2,
      }),
      makeStep({
        id: "s3",
        parentId: "s2",
        messageId: "m1",
        stepId: 2,
        role: "agent",
        content: "rewrite B + re-execute downstream",
        timestamp: 3,
      }),
    ];
    await agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.createSnapshot("s2", emptyWorkflow());
    storage.setOperatorResult("s2", "A", makeOpInfo("A", 1));
    storage.setOperatorResult("s2", "B", makeOpInfo("B", 1));
    storage.setOperatorResult("s2", "C", makeOpInfo("C", 1));
    storage.createSnapshot("s3", emptyWorkflow());
    storage.setOperatorResult("s3", "B", makeOpInfo("B", 999));
    storage.setOperatorResult("s3", "C", makeOpInfo("C", 9999)); // mimics runPostStepExecution

    const visible = storage.getAllVisibleResults("s3");
    expect(visible.get("A")?.totalRowCount).toBe(1);
    expect(visible.get("B")?.totalRowCount).toBe(999);
    expect(visible.get("C")?.totalRowCount).toBe(9999);
  });

  test("results on a sibling branch are invisible from the active branch", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "root",
        parentId: undefined,
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "r",
        timestamp: 1,
      }),
      makeStep({
        id: "left",
        parentId: "root",
        messageId: "m2",
        stepId: 0,
        role: "agent",
        content: "L",
        timestamp: 100,
      }),
      makeStep({
        id: "right",
        parentId: "root",
        messageId: "m3",
        stepId: 0,
        role: "agent",
        content: "R",
        timestamp: 200,
      }),
    ];
    await agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.createSnapshot("left", emptyWorkflow());
    storage.createSnapshot("right", emptyWorkflow());
    storage.setOperatorResult("left", "X", makeOpInfo("X", 100));
    storage.setOperatorResult("right", "X", makeOpInfo("X", 200));

    agent.checkout("left");
    expect(storage.getAllVisibleResults("left").get("X")?.totalRowCount).toBe(100);

    agent.checkout("right");
    expect(storage.getAllVisibleResults("right").get("X")?.totalRowCount).toBe(200);
  });

  test("workflow + results stay consistent under checkout (snapshot storage co-evolves with HEAD)", async () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({
        id: "root",
        parentId: undefined,
        messageId: "m1",
        stepId: 0,
        role: "user",
        content: "r",
        timestamp: 1,
      }),
      makeStep({
        id: "left",
        parentId: "root",
        messageId: "m2",
        stepId: 0,
        role: "agent",
        content: "L",
        timestamp: 100,
      }),
      makeStep({
        id: "right",
        parentId: "root",
        messageId: "m3",
        stepId: 0,
        role: "agent",
        content: "R",
        timestamp: 200,
      }),
    ];
    const snapshots = {
      left: workflowWith(["L_op"]),
      right: workflowWith(["R_op"]),
    };
    await agent.importReActSteps(steps, snapshots);

    const storage = agent.getSnapshotStorage();
    storage.setOperatorResult("left", "L_op", makeOpInfo("L_op", 11));
    storage.setOperatorResult("right", "R_op", makeOpInfo("R_op", 22));

    // At "right": only R_op visible
    let workflow = agent
      .getWorkflowState()
      .getAllOperators()
      .map(o => o.operatorID);
    let visible = Array.from(storage.getAllVisibleResults(agent.getHead()!).keys()).sort();
    expect(workflow).toEqual(["R_op"]);
    expect(visible).toEqual(["R_op"]);

    // Switch to "left": only L_op visible
    agent.checkout("left");
    workflow = agent
      .getWorkflowState()
      .getAllOperators()
      .map(o => o.operatorID);
    visible = Array.from(storage.getAllVisibleResults(agent.getHead()!).keys()).sort();
    expect(workflow).toEqual(["L_op"]);
    expect(visible).toEqual(["L_op"]);
  });
});

// ============================================================================
// initialize(delegateConfig) — bootstrap (workflow load + snapshot seed +
// baseline execution + synthetic agent step)
// ============================================================================

interface MockEndpoint {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

function installFetchMock(endpoints: MockEndpoint[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const ep of endpoints) {
      if (ep.match(url, init)) {
        return await ep.respond(url, init);
      }
    }
    // Default: opaque empty 200 so unrelated endpoints (e.g. metadata) don't crash init.
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Stubs the operator-metadata endpoint with a permissive `TestOp` schema so
 * `validateWorkflow` doesn't reject our synthetic operators before
 * `executeWorkflowHttp` even fires.
 */
function metadataEndpoint(): MockEndpoint {
  return {
    match: url => url.includes("/api/resources/operator-metadata"),
    respond: () =>
      jsonResponse({
        operators: [
          {
            operatorType: "TestOp",
            jsonSchema: { type: "object", additionalProperties: true },
            additionalMetadata: { userFriendlyName: "Test", operatorDescription: "" },
          },
        ],
        groups: [],
      }),
  };
}

describe("TexeraAgent.initialize(delegateConfig) — delegate bootstrap", () => {
  let restore: () => void = () => {};
  let restoreMetadata: () => void = () => {};

  beforeEach(() => {
    // Other suites can initialize the process-wide metadata cache (including
    // through server.ts). Then initialize() correctly skips the mocked metadata
    // endpoint, but TestOp is unknown and these fixtures never reach execution.
    // Isolate this fixture's cache, not production initialization behavior.
    const lookup = spyOn(WorkflowSystemMetadata, "getInstance").mockReturnValue(new WorkflowSystemMetadata());
    restoreMetadata = () => lookup.mockRestore();
  });

  afterEach(() => {
    restore();
    restoreMetadata();
  });

  test("bootstrap fixtures start with uninitialized metadata, regardless of earlier test files", () => {
    expect(makeAgent().getMetadataStore().isInitialized()).toBe(false);
  });

  test("creates an `initialize` step as the tree root anchoring both workflow + results", async () => {
    const wf = workflowWith(["op1", "op2"]);
    restore = installFetchMock([
      metadataEndpoint(),
      {
        match: url => url.includes("/api/workflow/") && !url.includes("/persist"),
        respond: () => jsonResponse({ wid: 42, name: "TestWF", content: wf }),
      },
      {
        match: url => url.includes("/api/execution/"),
        respond: () =>
          jsonResponse({
            success: true,
            state: "Completed",
            operators: {
              // `result: []` (any array) is what the real backend sends when
              // an op has been materialized. `persistOperatorResults` treats a
              // missing `result` field — with no `error` either — as a
              // backend-side stub for an unmaterialized op and skips it. So
              // the mock has to mirror the real backend's shape for a
              // Completed operator.
              op1: {
                state: "Completed",
                inputTuples: 0,
                outputTuples: 5,
                resultMode: "table",
                totalRowCount: 5,
                result: [],
              },
              op2: {
                state: "Completed",
                inputTuples: 5,
                outputTuples: 5,
                resultMode: "table",
                totalRowCount: 5,
                result: [],
              },
            },
          }),
      },
    ]);

    const agent = makeAgent();
    await agent.initialize({ userToken: "tok", workflowId: 42 });

    // Exactly one root-level `initialize` agent step
    const allSteps = agent.getAllSteps();
    expect(allSteps.length).toBe(1);
    const init = allSteps[0];
    expect(init.role).toBe("agent");
    expect(init.parentId).toBeUndefined();
    expect(init.toolCalls?.[0]?.toolName).toBe("initialize");
    expect(init.toolResults?.[0]?.isError).toBe(false);

    // HEAD = init step; workflow snapshot anchored there
    expect(agent.getHead()).toBe(init.id);
    const storage = agent.getSnapshotStorage();
    const resolved = storage.getResolvedWorkflow(init.id);
    expect(resolved?.value.operators.length).toBe(2);
    expect(resolved?.sourceStepId).toBe(init.id);

    // Per-op results visible at the init step
    const visible = storage.getAllVisibleResults(init.id);
    expect(visible.size).toBe(2);
    expect(visible.get("op1")?.totalRowCount).toBe(5);
    expect(visible.get("op2")?.totalRowCount).toBe(5);
  });

  test("execution failure: init step still recorded with the error captured in storage", async () => {
    const wf = workflowWith(["op1"]);
    restore = installFetchMock([
      metadataEndpoint(),
      {
        match: url => url.includes("/api/workflow/") && !url.includes("/persist"),
        respond: () => jsonResponse({ wid: 7, name: "BrokenWF", content: wf }),
      },
      {
        match: url => url.includes("/api/execution/"),
        respond: () =>
          jsonResponse({
            success: false,
            state: "Failed",
            operators: {
              op1: { state: "Failed", inputTuples: 0, outputTuples: 0, resultMode: "table", error: "boom" },
            },
          }),
      },
    ]);

    const agent = makeAgent();
    await agent.initialize({ userToken: "tok", workflowId: 7 });

    // Init step recorded with isError=true; workflow snapshot anchored there.
    const init = agent.getAllSteps()[0];
    expect(init).toBeDefined();
    expect(init.toolResults?.[0]?.isError).toBe(true);
    expect(agent.getSnapshotStorage().getWorkflow(init.id)?.operators.length).toBe(1);

    // Error preserved in OperatorInfo on the init step (uniform error path).
    const opResult = agent.getSnapshotStorage().getOperatorResult(init.id, "op1");
    expect(opResult?.error).toBe("boom");
  });

  test("workflow load failure: init step is still recorded with an empty workflow, no crash", async () => {
    restore = installFetchMock([
      {
        match: url => url.includes("/api/workflow/") && !url.includes("/persist"),
        respond: () => new Response("not found", { status: 404 }),
      },
    ]);

    const agent = makeAgent();
    await agent.initialize({ userToken: "tok", workflowId: 99 });

    // Under the unified init path, every successful `initialize()` records
    // an init step. A workflow-load failure leaves the agent with the
    // step anchored on an empty workflow rather than skipping the step.
    const allSteps = agent.getAllSteps();
    expect(allSteps.length).toBe(1);
    const init = allSteps[0];
    expect(init.role).toBe("agent");
    expect(init.toolCalls?.[0]?.toolName).toBe("initialize");
    expect(init.parentId).toBeUndefined();
    expect(agent.getHead()).toBe(init.id);
    // Init snapshot exists, with an empty workflow.
    const wf = agent.getSnapshotStorage().getWorkflow(init.id);
    expect(wf.operators).toEqual([]);
  });

  test("empty workflow (zero operators): records init step, anchors snapshot, skips execute call", async () => {
    const wf = workflowWith([]);
    let executionCalled = false;
    restore = installFetchMock([
      metadataEndpoint(),
      {
        match: url => url.includes("/api/workflow/") && !url.includes("/persist"),
        respond: () => jsonResponse({ wid: 1, name: "Empty", content: wf }),
      },
      {
        match: url => url.includes("/api/execution/"),
        respond: () => {
          executionCalled = true;
          return jsonResponse({ success: true, state: "Completed", operators: {} });
        },
      },
    ]);

    const agent = makeAgent();
    await agent.initialize({ userToken: "tok", workflowId: 1 });

    expect(executionCalled).toBe(false);
    const init = agent.getAllSteps()[0];
    expect(init).toBeDefined();
    expect(init.parentId).toBeUndefined();
    expect(init.toolCalls?.[0]?.toolName).toBe("initialize");
    expect(agent.getSnapshotStorage().getWorkflow(init.id)?.operators.length).toBe(0);
  });

  test("uniform error persistence: sibling op errors land in storage, not just the requested op", async () => {
    // Drives executeOperatorAndFormat through createExecuteOperatorTool, with
    // a mixed-success backend response (one op succeeds with rows, sibling
    // errors). Both must be persisted at HEAD.
    const wf = workflowWith(["primary", "sibling"]);
    restore = installFetchMock([
      metadataEndpoint(),
      {
        match: url => url.includes("/api/workflow/") && !url.includes("/persist"),
        respond: () => jsonResponse({ wid: 11, name: "Mixed", content: wf }),
      },
      {
        match: url => url.includes("/api/execution/"),
        respond: () =>
          jsonResponse({
            success: true,
            state: "Completed",
            operators: {
              primary: {
                state: "Completed",
                inputTuples: 0,
                outputTuples: 3,
                resultMode: "table",
                totalRowCount: 3,
                result: [{ a: 1 }, { a: 2 }, { a: 3 }],
              },
              sibling: {
                state: "Failed",
                inputTuples: 0,
                outputTuples: 0,
                resultMode: "table",
                error: "sibling exploded",
              },
            },
          }),
      },
    ]);

    const agent = makeAgent();
    await agent.initialize({ userToken: "tok", workflowId: 11 });

    const baseline = agent.getAllSteps()[0];
    const visible = agent.getSnapshotStorage().getAllVisibleResults(baseline.id);
    expect(visible.size).toBe(2);
    expect(visible.get("primary")?.totalRowCount).toBe(3);
    // Sibling's error is preserved in storage — proves the writer no longer
    // drops errored sibling ops on the floor.
    expect(visible.get("sibling")?.error).toBe("sibling exploded");
  });
});
