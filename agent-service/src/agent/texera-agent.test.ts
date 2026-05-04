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
import type { LanguageModel } from "ai";
import { TexeraAgent } from "./texera-agent";
import { INITIAL_STEP_ID, type ReActStep } from "../types/agent";
import type { WorkflowContent } from "../types/workflow";
import type { OperatorInfo } from "../types/execution";

// We never invoke the LLM in these tests (only synchronous tree mechanics +
// `handleDebugInput` plain-text path, which doesn't call generateText).
const stubModel = {} as unknown as LanguageModel;

function makeAgent(): TexeraAgent {
  return new TexeraAgent({
    model: stubModel,
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
        }) as any,
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
  test("HEAD points at INITIAL_STEP_ID with no real steps", () => {
    const agent = makeAgent();
    expect(agent.getHead()).toBe(INITIAL_STEP_ID);
    expect(agent.getAllSteps().length).toBe(0);
    expect(agent.getReActSteps().length).toBe(0);
  });

  test("getAncestorPath() of INITIAL is just [INITIAL]", () => {
    const agent = makeAgent();
    expect(agent.getAncestorPath()).toEqual([INITIAL_STEP_ID]);
  });

  test("getVisibleReActSteps filters out the INITIAL sentinel", () => {
    const agent = makeAgent();
    expect(agent.getVisibleReActSteps()).toEqual([]);
  });
});

describe("TexeraAgent — handleDebugInput plain-text path", () => {
  test("appends a user step and advances HEAD", async () => {
    const agent = makeAgent();
    const result = await agent.handleDebugInput("hello world");

    expect(result.kind).toBe("user_message");
    const steps = agent.getAllSteps();
    expect(steps.length).toBe(1);
    expect(steps[0].role).toBe("user");
    expect(steps[0].content).toBe("hello world");
    expect(steps[0].parentId).toBe(INITIAL_STEP_ID);
    expect(agent.getHead()).toBe(steps[0].id);
  });

  test("two consecutive plain-text inputs form a chain via parentId", async () => {
    const agent = makeAgent();
    await agent.handleDebugInput("first");
    const firstId = agent.getHead();
    await agent.handleDebugInput("second");
    const secondId = agent.getHead();

    expect(firstId).not.toBe(secondId);
    const second = agent.getAllSteps().find(s => s.id === secondId)!;
    expect(second.parentId).toBe(firstId);
    expect(agent.getAncestorPath()).toEqual([INITIAL_STEP_ID, firstId, secondId]);
  });
});

describe("TexeraAgent — clearHistory", () => {
  test("resets HEAD, drops steps, drops snapshot storage", async () => {
    const agent = makeAgent();
    await agent.handleDebugInput("first");
    await agent.handleDebugInput("second");
    expect(agent.getAllSteps().length).toBe(2);

    agent.clearHistory();

    expect(agent.getHead()).toBe(INITIAL_STEP_ID);
    expect(agent.getAllSteps().length).toBe(0);
    expect(agent.getReActSteps().length).toBe(0);
    // Storage should be empty after clear.
    expect(agent.getSnapshotStorage().getWorkflow(INITIAL_STEP_ID)).toBeUndefined();
  });
});

describe("TexeraAgent — importReActSteps", () => {
  test("imports a linear chain and lands HEAD at the leaf", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "a", timestamp: 2 }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 2, role: "agent", content: "b", timestamp: 3 }),
    ];

    const { headId, importedCount } = agent.importReActSteps(steps);

    expect(importedCount).toBe(3);
    expect(headId).toBe("s3");
    expect(agent.getHead()).toBe("s3");
    expect(agent.getAncestorPath()).toEqual([INITIAL_STEP_ID, "s1", "s2", "s3"]);
  });

  test("imports a branched tree; HEAD picks the latest-timestamp leaf", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "root", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "r", timestamp: 1 }),
      makeStep({ id: "left", parentId: "root", messageId: "m2", stepId: 0, role: "agent", content: "L", timestamp: 100 }),
      makeStep({ id: "right", parentId: "root", messageId: "m3", stepId: 0, role: "agent", content: "R", timestamp: 200 }),
    ];

    const { headId } = agent.importReActSteps(steps);
    expect(headId).toBe("right");
    expect(agent.getAncestorPath()).toEqual([INITIAL_STEP_ID, "root", "right"]);
  });

  test("loads provided snapshots into the storage and restores HEAD's workflow", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "a", timestamp: 2 }),
    ];
    const snapshots = {
      s2: workflowWith(["op1", "op2"]),
    };

    agent.importReActSteps(steps, snapshots);

    expect(agent.getHead()).toBe("s2");
    // Live workflow restored from HEAD's snapshot
    const live = agent.getWorkflowState().getAllOperators().map(o => o.operatorID).sort();
    expect(live).toEqual(["op1", "op2"]);
    // Direct storage lookup confirms ancestor walk
    const wf = agent.getSnapshotStorage().getWorkflow("s2");
    expect(wf?.operators.length).toBe(2);
  });

  test("rejects steps with unknown parentId", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "orphan", parentId: "ghost", messageId: "m1", stepId: 0, role: "user", content: "x", timestamp: 1 }),
    ];
    expect(() => agent.importReActSteps(steps)).toThrow(/unknown parentId/);
  });

  test("rejects duplicate step ids", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "dup", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "x", timestamp: 1 }),
      makeStep({ id: "dup", parentId: INITIAL_STEP_ID, messageId: "m2", stepId: 0, role: "user", content: "y", timestamp: 2 }),
    ];
    expect(() => agent.importReActSteps(steps)).toThrow(/duplicate step id/);
  });
});

describe("TexeraAgent — checkout (time travel)", () => {
  test("moves HEAD and restores the workflow visible at that step via storage ancestor walk", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "root", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "r", timestamp: 1 }),
      makeStep({ id: "left", parentId: "root", messageId: "m2", stepId: 0, role: "agent", content: "L", timestamp: 100 }),
      makeStep({ id: "right", parentId: "root", messageId: "m3", stepId: 0, role: "agent", content: "R", timestamp: 200 }),
    ];
    const snapshots = {
      left: workflowWith(["L_op"]),
      right: workflowWith(["R_op"]),
    };
    agent.importReActSteps(steps, snapshots);

    // Imported HEAD is "right"
    expect(agent.getWorkflowState().getAllOperators().map(o => o.operatorID)).toEqual(["R_op"]);

    expect(agent.checkout("left")).toBe(true);
    expect(agent.getHead()).toBe("left");
    expect(agent.getWorkflowState().getAllOperators().map(o => o.operatorID)).toEqual(["L_op"]);

    expect(agent.checkout("right")).toBe(true);
    expect(agent.getWorkflowState().getAllOperators().map(o => o.operatorID)).toEqual(["R_op"]);
  });

  test("checkout to an unknown stepId returns false and does not move HEAD", () => {
    const agent = makeAgent();
    const before = agent.getHead();
    expect(agent.checkout("does-not-exist")).toBe(false);
    expect(agent.getHead()).toBe(before);
  });

  test("checkout to a step whose ancestors have no snapshot does not change live workflow", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
    ];
    agent.importReActSteps(steps); // no snapshots provided

    // Pre-populate live workflow externally (e.g. workspace just opened).
    agent.getWorkflowState().setWorkflowContent(workflowWith(["pre-op"]));
    expect(agent.checkout("s1")).toBe(true);
    // No snapshot at s1 or its ancestors → live workflow is left untouched.
    expect(agent.getWorkflowState().getAllOperators().map(o => o.operatorID)).toEqual(["pre-op"]);
  });
});

describe("TexeraAgent — visibility (branch filtering)", () => {
  test("getReActSteps returns the entire forest; getVisibleReActSteps only HEAD's branch", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "root", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "r", timestamp: 1 }),
      makeStep({ id: "left", parentId: "root", messageId: "m2", stepId: 0, role: "agent", content: "L", timestamp: 100 }),
      makeStep({ id: "right", parentId: "root", messageId: "m3", stepId: 0, role: "agent", content: "R", timestamp: 200 }),
    ];
    agent.importReActSteps(steps);

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
  test("operator-result inheritance walks the active branch's ancestors", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "ran A,B,C", timestamp: 2 }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 2, role: "agent", content: "noop", timestamp: 3 }),
    ];
    agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.setOperatorResult("s2", "A", makeOpInfo("A", 100));
    storage.setOperatorResult("s2", "B", makeOpInfo("B", 200));

    // Reading at s3 (no own results) must inherit from s2 via the ancestor walk
    const visible = storage.getAllVisibleResults("s3");
    expect(visible.size).toBe(2);
    expect(visible.get("A")?.totalRowCount).toBe(100);
    expect(visible.get("B")?.totalRowCount).toBe(200);
  });

  test("middle-op rewrite WITHOUT downstream re-execution leaves a stale downstream result visible", () => {
    // Documents the writer-enforced-consistency design property at the agent
    // level. Mirrors the storage-level test, but this time HEAD is set via
    // checkout/import so the path comes from the real ReActStep tree.
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "first run", timestamp: 2 }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 2, role: "agent", content: "rewrite B only", timestamp: 3 }),
    ];
    agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.setOperatorResult("s2", "A", makeOpInfo("A", 1));
    storage.setOperatorResult("s2", "B", makeOpInfo("B", 1));
    storage.setOperatorResult("s2", "C", makeOpInfo("C", 1));
    storage.setOperatorResult("s3", "B", makeOpInfo("B", 999));

    const visible = storage.getAllVisibleResults("s3");
    expect(visible.get("A")?.totalRowCount).toBe(1);
    expect(visible.get("B")?.totalRowCount).toBe(999);
    expect(visible.get("C")?.totalRowCount).toBe(1); // STALE; storage has no DAG awareness
  });

  test("middle-op rewrite WITH downstream re-execution at the new step yields a consistent visible map", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "s1", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "u", timestamp: 1 }),
      makeStep({ id: "s2", parentId: "s1", messageId: "m1", stepId: 1, role: "agent", content: "first run", timestamp: 2 }),
      makeStep({ id: "s3", parentId: "s2", messageId: "m1", stepId: 2, role: "agent", content: "rewrite B + re-execute downstream", timestamp: 3 }),
    ];
    agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.setOperatorResult("s2", "A", makeOpInfo("A", 1));
    storage.setOperatorResult("s2", "B", makeOpInfo("B", 1));
    storage.setOperatorResult("s2", "C", makeOpInfo("C", 1));
    storage.setOperatorResult("s3", "B", makeOpInfo("B", 999));
    storage.setOperatorResult("s3", "C", makeOpInfo("C", 9999)); // mimics runPostStepExecution

    const visible = storage.getAllVisibleResults("s3");
    expect(visible.get("A")?.totalRowCount).toBe(1);
    expect(visible.get("B")?.totalRowCount).toBe(999);
    expect(visible.get("C")?.totalRowCount).toBe(9999);
  });

  test("results on a sibling branch are invisible from the active branch", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "root", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "r", timestamp: 1 }),
      makeStep({ id: "left", parentId: "root", messageId: "m2", stepId: 0, role: "agent", content: "L", timestamp: 100 }),
      makeStep({ id: "right", parentId: "root", messageId: "m3", stepId: 0, role: "agent", content: "R", timestamp: 200 }),
    ];
    agent.importReActSteps(steps);

    const storage = agent.getSnapshotStorage();
    storage.setOperatorResult("left", "X", makeOpInfo("X", 100));
    storage.setOperatorResult("right", "X", makeOpInfo("X", 200));

    agent.checkout("left");
    expect(storage.getAllVisibleResults("left").get("X")?.totalRowCount).toBe(100);

    agent.checkout("right");
    expect(storage.getAllVisibleResults("right").get("X")?.totalRowCount).toBe(200);
  });

  test("workflow + results stay consistent under checkout (snapshot storage co-evolves with HEAD)", () => {
    const agent = makeAgent();
    const steps: ReActStep[] = [
      makeStep({ id: "root", parentId: INITIAL_STEP_ID, messageId: "m1", stepId: 0, role: "user", content: "r", timestamp: 1 }),
      makeStep({ id: "left", parentId: "root", messageId: "m2", stepId: 0, role: "agent", content: "L", timestamp: 100 }),
      makeStep({ id: "right", parentId: "root", messageId: "m3", stepId: 0, role: "agent", content: "R", timestamp: 200 }),
    ];
    const snapshots = {
      left: workflowWith(["L_op"]),
      right: workflowWith(["R_op"]),
    };
    agent.importReActSteps(steps, snapshots);

    const storage = agent.getSnapshotStorage();
    storage.setOperatorResult("left", "L_op", makeOpInfo("L_op", 11));
    storage.setOperatorResult("right", "R_op", makeOpInfo("R_op", 22));

    // At "right": only R_op visible
    let workflow = agent.getWorkflowState().getAllOperators().map(o => o.operatorID);
    let visible = Array.from(storage.getAllVisibleResults(agent.getHead()).keys()).sort();
    expect(workflow).toEqual(["R_op"]);
    expect(visible).toEqual(["R_op"]);

    // Switch to "left": only L_op visible
    agent.checkout("left");
    workflow = agent.getWorkflowState().getAllOperators().map(o => o.operatorID);
    visible = Array.from(storage.getAllVisibleResults(agent.getHead()).keys()).sort();
    expect(workflow).toEqual(["L_op"]);
    expect(visible).toEqual(["L_op"]);
  });
});
