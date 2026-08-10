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
 * THE LIVE TURN DIFFS AGAINST WHAT IT INHERITED.
 *
 * The catalog's whole claim is that state renders ONCE, at the turn that
 * created it. That was quietly false: the live turn's steps were diffed
 * against the EMPTY root snapshot, so every operator the session had ever
 * built counted as "changed at step 1" and the first observation re-dumped the
 * entire graph — 238 KB of a 450 KB prompt on a 42-turn task (53%), growing
 * with operator count, re-paid on every step of the turn. Cost tracked graph
 * size (r = +0.98) instead of the work actually in front of the model.
 *
 * The rule: an operator that a PREVIOUS turn built and this turn has not
 * touched must not reappear in this turn's step observations. It is already in
 * the catalog entry that created it.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../context/summarize/fixtures";

/**
 * Turn 1 builds `old_a` and `old_b`; turn 2 (live) touches only `fresh`.
 * Turn 2's step log must mention `fresh` and neither of the inherited ones.
 */
function scenario(): Scenario {
  const s = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "build the base tables" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      content: "**Final Answer:** done",
      isEnd: true,
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "old_a" } },
        { toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "old_b" } },
      ],
      toolResults: [
        { toolCallId: "t1", output: "ok", isError: false },
        { toolCallId: "t2", output: "ok", isError: false },
      ],
    },
    { id: "u2", stepId: 2, role: "user", messageId: "m2", parentId: "a1", content: "now add one more" },
    {
      id: "a2",
      stepId: 3,
      role: "agent",
      messageId: "m2",
      parentId: "u2",
      content: "working",
      isEnd: false,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "fresh" } }],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
  ]);
  const turn1 = makeWorkflow([
    { id: "old_a", type: "DataLoading" },
    { id: "old_b", type: "DataLoading" },
  ]);
  s.storage.createSnapshot("a1", turn1);
  s.storage.setOperatorResult("a1", "old_a", makeInfo(500, { sampleRows: [{ k: "inherited_a" }] }));
  s.storage.setOperatorResult("a1", "old_b", makeInfo(500, { sampleRows: [{ k: "inherited_b" }] }));

  const turn2 = makeWorkflow([
    { id: "old_a", type: "DataLoading" },
    { id: "old_b", type: "DataLoading" },
    { id: "fresh", type: "DataLoading" },
  ]);
  s.storage.createSnapshot("a2", turn2);
  // `old_a` / `old_b` are NOT re-executed this turn: their results inherit from
  // turn 1's snapshot, which is exactly the case that used to re-dump them.
  s.storage.setOperatorResult("a2", "fresh", makeInfo(7, { sampleRows: [{ k: "brand_new" }] }));
  return s;
}

const render = (s: Scenario): string =>
  String(
    assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      versionedCatalog: true,
      turnNumberByMessageId: new Map([
        ["m1", 1],
        ["m2", 2],
      ]),
    } as any)
      .map(m => m.content)
      .join("\n")
  );

describe("the live turn's steps show only this turn's work", () => {
  test("inherited operators do NOT reappear in the live step log", () => {
    const text = render(scenario());
    const live = text.slice(text.indexOf("## Turn 2 (in progress)"));
    expect(live).toContain("fresh");
    // the inherited pair belongs to turn 1's catalog entry, not turn 2's steps
    expect(live).not.toContain("inherited_a");
    expect(live).not.toContain("inherited_b");
  });

  test("their data still appears exactly once — in the entry that created them", () => {
    const text = render(scenario());
    const beforeLive = text.slice(0, text.indexOf("## Turn 2 (in progress)"));
    expect(beforeLive).toContain("old_a");
    expect(beforeLive).toContain("old_b");
  });

  test("the live turn's own result IS shown — the fix does not hide new work", () => {
    const text = render(scenario());
    const live = text.slice(text.indexOf("## Turn 2 (in progress)"));
    expect(live).toContain("brand_new");
  });

  test("turn 1 (nothing inherited) still renders its own work", () => {
    // Guard against over-correcting: with no prior turn there is nothing to
    // inherit, so the first turn's observations must be unaffected.
    const s = scenario();
    const firstTurnOnly = { ...s, steps: s.steps.slice(0, 2) };
    const text = String(
      assembleContext(firstTurnOnly.steps, s.workflowState, s.storage, ContextMode.DELTA, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
        versionedCatalog: true,
        turnNumberByMessageId: new Map([["m1", 1]]),
      } as any)
        .map(m => m.content)
        .join("\n")
    );
    expect(text).toContain("inherited_a");
  });
});
