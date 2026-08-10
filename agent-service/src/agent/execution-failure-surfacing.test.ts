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
 * A FAILED EXECUTION MUST LOOK DIFFERENT FROM AN UNRUN OPERATOR.
 *
 * The renderer prints `(not executed)` when an operator has no result. That
 * is honest for something never targeted — and a lie when the engine refused
 * the plan. The model cannot tell the two apart, so it concludes its own code
 * produced nothing and rewrites it under a new name; measured on NFL, one
 * cyclic edge produced 15 turns of that, 5 of them burning the entire 40-step
 * budget (~$0.90 each) on operators that were never the problem.
 *
 * These tests pin the RENDER-level distinction: an errored result must reach
 * the observation as `[ERROR]` text, and an operator with no entry at all
 * must still read `(not executed)`.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../types/agent";
import { assembleContext } from "./util/context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "./context/summarize/fixtures";

function scenarioWith(resultForA: "ok" | "error" | "none"): Scenario {
  const s = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "build it" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "scores" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
  ]);
  s.storage.createSnapshot("a1", makeWorkflow([{ id: "scores", type: "DataLoading" }]));
  if (resultForA === "ok") {
    s.storage.setOperatorResult("a1", "scores", makeInfo(10, {}));
  } else if (resultForA === "error") {
    s.storage.setOperatorResult("a1", "scores", {
      operatorId: "scores",
      state: "ExecutionFailed",
      inputTuples: 0,
      outputTuples: 0,
      resultMode: "error",
      error: "execution failed — Execution request failed: 400 Bad Request - Unable to process JSON",
    } as any);
  }
  return s;
}

const render = (s: Scenario): string =>
  String(
    assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
    } as any)
      .map(m => m.content)
      .join("\n")
  );

describe("execution failure is visible to the model", () => {
  test("an engine refusal renders as an ERROR carrying the reason", () => {
    const text = render(scenarioWith("error"));
    expect(text).toContain("[ERROR]");
    expect(text).toContain("execution failed");
    expect(text).toContain("400");
    // the failure must NOT masquerade as "this operator was never run"
    expect(text).not.toContain("(not executed)");
  });

  test("an operator with no result at all still reads (not executed)", () => {
    // The honest case: nothing ran, nothing failed.
    const text = render(scenarioWith("none"));
    expect(text).toContain("(not executed)");
    expect(text).not.toContain("[ERROR]");
  });

  test("a healthy result is unaffected", () => {
    const text = render(scenarioWith("ok"));
    expect(text).toContain("Output Table");
    expect(text).not.toContain("(not executed)");
    expect(text).not.toContain("execution failed");
  });
});
