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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * `resumeFrom` — the session as a version tree.
 *
 * The properties pinned here are the ones whose absence produces a silent wrong
 * answer rather than an error:
 *
 *   - turn numbers are GLOBAL, so the catalogue and the tools agree even after
 *     the branch gets shorter than the session (the disagreement that once cost
 *     a turn 44 recall calls and no answer);
 *   - resuming actually changes which state resolves, not just what is drawn;
 *   - the uncommitted-changes guard, since moving after a write strands the
 *     turn's own operators on an abandoned branch and merge is not implemented;
 *   - turns branched away from stay listed, or the tree becomes one-way.
 */

import { describe, expect, test } from "bun:test";
import { TexeraAgent } from "../texera-agent";
import type { ReActStep } from "../../types/agent";
import type { WorkflowContent } from "../../types/workflow";
import type { LLMDriver, ContextAssembler } from "../llm-drivers/types";

const stubDriver: LLMDriver = {
  runTurn: async () => ({ text: "", messages: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
};
const stubAssembler: ContextAssembler = () => [{ role: "user", content: "" }];

function agent(): TexeraAgent {
  return new TexeraAgent({
    driver: stubDriver,
    contextAssembler: stubAssembler,
    modelType: "test-model",
    agentId: "test-agent",
  });
}

function wf(ids: string[]): WorkflowContent {
  return {
    operators: ids.map(id => ({ operatorID: id, operatorType: "TestOp", operatorProperties: {} }) as any),
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

function step(o: Partial<ReActStep> & Pick<ReActStep, "id" | "messageId">): ReActStep {
  return {
    stepId: 0,
    timestamp: Date.now(),
    role: "agent",
    content: "",
    isBegin: true,
    isEnd: true,
    ...o,
  } as ReActStep;
}

/** Three finished turns, each adding one operator, then a fourth in progress. */
async function threeTurns() {
  const a = agent();
  const steps: ReActStep[] = [
    step({ id: "u1", messageId: "m1", role: "user", content: "turn one" }),
    step({
      id: "a1",
      messageId: "m1",
      parentId: "u1",
      content: "built op1",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c1", input: { operatorId: "op1" } }],
    }),
    step({ id: "u2", messageId: "m2", parentId: "a1", role: "user", content: "turn two" }),
    step({
      id: "a2",
      messageId: "m2",
      parentId: "u2",
      content: "built op2",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c2", input: { operatorId: "op2" } }],
    }),
    step({ id: "u3", messageId: "m3", parentId: "a2", role: "user", content: "turn three" }),
    step({
      id: "a3",
      messageId: "m3",
      parentId: "u3",
      content: "built op3",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c3", input: { operatorId: "op3" } }],
    }),
  ];
  await a.importReActSteps(steps, {
    a1: wf(["op1"]),
    a2: wf(["op1", "op2"]),
    a3: wf(["op1", "op2", "op3"]),
  });
  // A fourth turn opens, parented on turn 3, as sendMessage would do.
  const u4 = step({ id: "u4", messageId: "m4", parentId: "a3", role: "user", content: "turn four" });
  (a as any).addStep(u4);
  (a as any).head = "u4";
  (a as any).currentMessageId = "m4";
  return a;
}

describe("resumeFrom", () => {
  test("turn numbers are global and match the ask order", async () => {
    const a = await threeTurns();
    expect(a.turnOrder()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(a.turnNumberOf("m1")).toBe(1);
    expect(a.turnNumberOf("m3")).toBe(3);
  });

  test("resuming rewires which state resolves, not just what is drawn", async () => {
    const a = await threeTurns();
    // Before: turn 4 inherits turn 3 — three operators.
    expect(a.getWorkflowState().getWorkflowContent().operators.map(o => o.operatorID).sort()).toEqual([
      "op1",
      "op2",
      "op3",
    ]);
    const out = a.resumeToTurn(1);
    expect(out.ok).toBe(true);
    // After: the live DAG is turn 1's.
    expect(a.getWorkflowState().getWorkflowContent().operators.map(o => o.operatorID)).toEqual(["op1"]);
    // And the ancestor path no longer runs through turns 2 and 3.
    const seen = a.getVisibleReActSteps().map(s => s.messageId);
    expect(seen).toContain("m1");
    expect(seen).not.toContain("m2");
    expect(seen).not.toContain("m3");
  });

  test("resuming twice is allowed while nothing has been built", async () => {
    const a = await threeTurns();
    expect(a.resumeToTurn(1).ok).toBe(true);
    expect(a.resumeToTurn(2).ok).toBe(true);
    expect(a.getWorkflowState().getWorkflowContent().operators.map(o => o.operatorID).sort()).toEqual([
      "op1",
      "op2",
    ]);
  });

  test("the uncommitted-changes guard blocks a move after the turn builds", async () => {
    const a = await threeTurns();
    (a as any).addStep(
      step({
        id: "a4",
        messageId: "m4",
        parentId: "u4",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c4", input: { operatorId: "op4" } }],
      })
    );
    const out = a.resumeToTurn(1);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("op4");
    expect(out.message).toContain("recallState");
  });

  test("a turn cannot resume from itself, or from a turn that does not exist", async () => {
    const a = await threeTurns();
    expect(a.resumeToTurn(4).ok).toBe(false);
    expect(a.resumeToTurn(9).message).toContain("does not exist");
    expect(a.resumeToTurn(0).ok).toBe(false);
  });

  test("turns branched away from stay listed and stay resumable", async () => {
    const a = await threeTurns();
    a.resumeToTurn(1);
    const off = a.offBranchTurns(a.getVisibleReActSteps()).map(t => t.turn);
    expect(off).toContain(2);
    expect(off).toContain(3);
    // Still reachable: the tree is navigable in both directions.
    expect(a.resumeToTurn(3).ok).toBe(true);
    expect(a.getWorkflowState().getWorkflowContent().operators.length).toBe(3);
  });

  test("the FIRST turn succeeds instead of erroring — an error there loops", async () => {
    // The prompt tells the model to resume before building, so on turn 1 it
    // calls resumeFrom(1). Rejecting that offers no alternative action, and the
    // model retries verbatim: measured at 35 identical failing calls and the
    // whole 40-step budget on nfl turn 1.
    const a = agent();
    (a as any).addStep(step({ id: "u1", messageId: "m1", role: "user", content: "first request" }));
    (a as any).head = "u1";
    (a as any).currentMessageId = "m1";
    const out = a.resumeToTurn(1);
    expect(out.ok).toBe(true);
    expect(out.message).toContain("first turn");
    expect(out.message).toContain("Do not call resumeFrom again");
  });

  test("every rejection tells the model to stop calling it", async () => {
    const a = await threeTurns();
    expect(a.resumeToTurn(99).message).toContain("Do not call resumeFrom again");
    expect(a.resumeToTurn(4).message).toContain("Do not call resumeFrom again");
    // and points at the turn it most likely wanted
    expect(a.resumeToTurn(4).message).toContain("resume from 3");
  });

  test("global numbering survives a resume — the branch shortens, numbers do not shift", async () => {
    const a = await threeTurns();
    a.resumeToTurn(1);
    // Branch is now m1 -> m4, but turn 3 is still turn 3.
    expect(a.turnNumberOf("m3")).toBe(3);
    expect(a.turnNumberOf("m4")).toBe(4);
  });
});
