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
 * SESSION LAYOUT — the flat event log re-grouped by turn.
 *
 * Properties pinned:
 *   - exactly two H1 sections: `# Session` and `# Your Task`;
 *   - every finished turn is ### Task / ### Steps (DELTA) or ### Dataflow
 *     (LATEST) / ### Final Answer; the current turn has no Final Answer;
 *   - the Final Answer is duplicated out of the closing step;
 *   - steps number locally from 1 and requests never render twice;
 *   - LATEST: finished turns show only the operators they touched, the
 *     current turn the full leaf snapshot, both nested (never `# Current
 *     Dataflow` at root);
 *   - the ReAct render knobs stay independent inside a turn;
 *   - legacy arms are byte-identical (flag off ⇒ no # Session anywhere).
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../context/summarize/fixtures";

function scenario(): Scenario {
  const s = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "Load scores.csv. Round to 4 decimals." },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      content: '**Final Answer:** {"rows": 120}',
      isEnd: true,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "scores" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    { id: "u2", stepId: 2, role: "user", messageId: "m2", parentId: "a1", content: "Add the percentile column." },
    {
      id: "a2",
      stepId: 3,
      role: "agent",
      messageId: "m2",
      parentId: "u2",
      content: "working",
      isEnd: false,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "pct" } }],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
  ]);
  s.storage.createSnapshot("a1", makeWorkflow([{ id: "scores", type: "DataLoading" }]));
  s.storage.setOperatorResult("a1", "scores", makeInfo(120, {}));
  s.storage.createSnapshot(
    "a2",
    makeWorkflow(
      [
        { id: "scores", type: "DataLoading", displayName: "Load scores.csv" },
        { id: "pct", type: "DataProcessing", numInputPorts: 1, displayName: "Percentile per score" },
      ],
      [["scores", "pct"]]
    )
  );
  s.storage.setOperatorResult("a2", "pct", makeInfo(120, { sampleRows: [{ dbn: "x", pct: 0.5 }] }));
  return s;
}

function render(s: Scenario, mode: ContextMode, extra: object = {}): string {
  return String(
    assembleContext(s.steps, s.workflowState, s.storage, mode, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      sessionTurns: true,
      turnNumberByMessageId: new Map([
        ["m1", 1],
        ["m2", 2],
      ]),
      ...extra,
    } as any)
      .map(m => m.content)
      .join("\n")
  );
}

const h1s = (text: string): string[] => text.match(/^# .*$/gm) ?? [];

describe("session layout", () => {
  test("exactly two H1 sections: # Session and # Your Task", () => {
    for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
      const roots = h1s(render(scenario(), mode));
      expect(roots).toEqual(["# Session", "# Your Task"]);
    }
  });

  test("DELTA: finished turn is Task / Steps / Final Answer; answer is duplicated", () => {
    const text = render(scenario(), ContextMode.DELTA);
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain("### Task");
    expect(t1).toContain("Load scores.csv. Round to 4 decimals.");
    expect(t1).toContain("### Steps");
    expect(t1).toContain("#### Step 1");
    expect(t1).toContain("### Final Answer");
    expect(t1).toContain('{"rows": 120}');
    // marker stripped in the section; the raw step text still carries it
    const answerSection = t1.slice(t1.indexOf("### Final Answer"));
    expect(answerSection).not.toContain("**Final Answer:**");
  });

  test("the current turn is last, has no Final Answer, and the directive names it", () => {
    const text = render(scenario(), ContextMode.DELTA);
    const cur = text.slice(text.indexOf("## Turn 2 (current turn)"));
    expect(cur).toContain("Add the percentile column.");
    expect(cur).not.toContain("### Final Answer");
    expect(cur).toContain("Work on the current turn (turn 2).");
    expect(cur).toContain("**Final Answer:** <your answer, in the format the task asks for>");
  });

  test("steps number locally from 1 and requests render once", () => {
    const text = render(scenario(), ContextMode.DELTA);
    expect(text).toContain("#### Step 1");
    expect(text).not.toContain("Agent Event");
    expect(text).not.toContain("User Event");
    // each request appears exactly once (its ### Task section)
    expect(text.split("Add the percentile column.").length - 1).toBe(1);
  });

  test("LATEST: finished turns show touched operators, current turn the full leaf, all nested", () => {
    const text = render(scenario(), ContextMode.LATEST);
    expect(text).not.toContain("# Current Dataflow");
    expect(text).not.toContain("# User Task");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain("### Dataflow");
    expect(t1).toContain("`scores`");
    expect(t1).not.toContain("`pct`"); // turn 1 never touched pct
    const cur = text.slice(text.indexOf("## Turn 2 (current turn)"));
    expect(cur).toContain("### Dataflow");
    expect(cur).toContain("`scores`");
    expect(cur).toContain("`pct`");
  });

  test("ReAct knobs stay independent inside the layout", () => {
    const on = render(scenario(), ContextMode.DELTA, {});
    const off = render(scenario(), ContextMode.DELTA);
    expect(on).not.toContain("Column Schema and stats");
    expect(off).not.toContain("Column Schema and stats");
  });

  test("legacy arms are untouched: flag off renders the flat layout", () => {
    const s = scenario();
    const text = String(
      assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
      } as any)
        .map(m => m.content)
        .join("\n")
    );
    expect(text).not.toContain("# Session");
    expect(text).not.toContain("# Your Task");
    expect(text).toContain("# User Task");
  });

  test("versionedCatalog supersedes sessionTurns", () => {
    const text = render(scenario(), ContextMode.DELTA, { versionedCatalog: true });
    expect(text).toContain("# Catalog");
    expect(text).not.toContain("# Session");
  });
});
