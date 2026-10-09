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
 * `# Catalog` — every finished turn, rendered the same way.
 *
 * The property under test is uniformity. A session is one conversation, so turn
 * 1 is catalogue entry 1: no separate `# Session Brief`, no cross-reference in
 * place of its text, and no clip that would let a convention stated in turn 1
 * survive while the same convention stated in turn 6 is truncated away.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../context/summarize/fixtures";

const T1_REQUEST =
  "You are working through a long analysis with me.\n\n" +
  "Data files available:\n - data/scores.csv\n - data/teams.csv\n\n" +
  "Percentile convention: average rank divided by n; the lowest score gets 1/n.\n" +
  "Question: how many rows are in scores.csv?";
const T2_REQUEST = "Now add a percentile column using the convention above.\nQuestion: what is the median percentile?";

/** Two finished turns (m1, m2) plus a third in progress (m3). */
function twoTurns(): Scenario {
  const scenario = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: T1_REQUEST },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      content: "**Final Answer:** {\"rows\": 120}",
      isEnd: true,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "scores" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    { id: "u2", stepId: 2, role: "user", messageId: "m2", parentId: "a1", content: T2_REQUEST },
    {
      id: "a2",
      stepId: 3,
      role: "agent",
      messageId: "m2",
      parentId: "u2",
      content: "**Final Answer:** {\"median_pct\": 0.5}",
      isEnd: true,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "pct" } }],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
    { id: "u3", stepId: 4, role: "user", messageId: "m3", parentId: "a2", content: "Roll the percentile back." },
  ]);
  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "scores", type: "DataLoading" }]));
  scenario.storage.setOperatorResult("a1", "scores", makeInfo(120));
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow(
      [
        { id: "scores", type: "DataLoading" },
        { id: "pct", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["scores", "pct"]]
    )
  );
  scenario.storage.setOperatorResult("a2", "pct", makeInfo(120));
  return scenario;
}

function render(scenario: Scenario): string {
  return String(
    assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      turnHistoryIndex: true,
      userTaskPlacement: "bottom",
    } as any)
      .map(m => m.content)
      .join("\n")
  );
}

describe("# Catalog", () => {
  test("there is no separate Session Brief section", () => {
    expect(render(twoTurns())).not.toContain("Session Brief");
  });

  test("turn 1 carries its own text, not a pointer to somewhere else", () => {
    const text = render(twoTurns());
    expect(text).toContain("## Turn 1");
    expect(text).not.toContain("the Session Brief above");
    // The file inventory lives only in turn 1's request, and the agent has no
    // file-listing tool — losing it makes every unlisted file invisible.
    expect(text).toContain("data/teams.csv");
    // A convention stated in turn 1 must survive verbatim, not as a gist.
    expect(text).toContain("the lowest score gets 1/n");
  });

  test("later turns are rendered exactly like turn 1", () => {
    const text = render(twoTurns());
    const t1 = text.indexOf("## Turn 1");
    const t2 = text.indexOf("## Turn 2");
    expect(t1).toBeGreaterThanOrEqual(0);
    expect(t2).toBeGreaterThan(t1);
    expect(text.slice(t1, t2)).toContain("Asked:");
    expect(text.slice(t2)).toContain("Asked:");
    expect(text).toContain("Now add a percentile column using the convention above.");
  });

  test("answers appear whole, with the harness's final-answer marker stripped", () => {
    const text = render(twoTurns());
    expect(text).toContain('{"rows": 120}');
    expect(text).toContain('{"median_pct": 0.5}');
    expect(text).not.toContain("**Final Answer:** {\"rows\"");
  });

  test("the operator delta carries verbs the model can act on", () => {
    const text = render(twoTurns());
    const catalog = text.slice(text.indexOf("# Catalog"), text.indexOf("# Current Turn"));
    expect(catalog).toContain("+ scores");
    expect(catalog).toContain("+ pct");
  });

  test("an operator revised by a later turn is marked at the turn that owned the old version", () => {
    // The anchor for "as it originally was". Without it the model cannot see
    // that a change happened, so it resumes from the newest turn, gets the
    // revised version, and answers confidently wrong.
    const scenario = buildScenario([
      { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "set the threshold" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m1",
        parentId: "u1",
        content: "**Final Answer:** {}",
        isEnd: true,
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "threshold" } }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      { id: "u2", stepId: 2, role: "user", messageId: "m2", parentId: "a1", content: "change the threshold" },
      {
        id: "a2",
        stepId: 3,
        role: "agent",
        messageId: "m2",
        parentId: "u2",
        content: "**Final Answer:** {}",
        isEnd: true,
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "threshold" } }],
        toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
      },
      { id: "u3", stepId: 4, role: "user", messageId: "m3", parentId: "a2", content: "use the ORIGINAL threshold" },
    ]);
    scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "threshold", type: "DataProcessing" }]));
    scenario.storage.setOperatorResult("a1", "threshold", makeInfo(5));
    scenario.storage.createSnapshot("a2", makeWorkflow([{ id: "threshold", type: "DataProcessing" }]));
    scenario.storage.setOperatorResult("a2", "threshold", makeInfo(5));

    const text = render(scenario);
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain("later revised in turn 2");
    // Worded for recallState, which every index arm has — never for a tool the
    // arm might lack.
    expect(t1).toContain("recallState(turn: 1) has this version");
    // Turn 2 owns the current version, so it carries no such marker.
    const t2 = text.slice(text.indexOf("## Turn 2"), text.indexOf("# Current Turn"));
    expect(t2).not.toContain("later revised");
  });

  test("the turn in progress is not catalogued — it is the Current Turn", () => {
    const text = render(twoTurns());
    const catalog = text.slice(text.indexOf("# Catalog"), text.indexOf("# Current Turn"));
    expect(catalog).not.toContain("## Turn 3");
    expect(text).toContain("Roll the percentile back.");
  });
});
