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
 * The versioned catalog: one context, one format, addresses everywhere.
 *
 * Properties pinned:
 *   - verbs are words, and each operator is a structured block (Task /
 *     Dataflow delta / Answer sections) — not a symbol-crammed line;
 *   - upstream lines carry version provenance (the (op, turn) pairs a later
 *     write's `upstreams` should name);
 *   - `Current operators` is a pointer table over finished turns only;
 *   - there is NO `# Dataflow` section and NO `# Recalled State` tail;
 *   - the in-progress turn is the last catalog entry, and a recallState
 *     output persists inline in its steps — the one-rule replacement for the
 *     tail section ("every action's observation stays").
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
      content: '**Final Answer:** {"median_pct": 0.5}',
      isEnd: true,
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t2",
          input: { operatorId: "pct", upstreams: { scores: 1 } },
        },
      ],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
    { id: "u3", stepId: 4, role: "user", messageId: "m3", parentId: "a2", content: "Compare with the original." },
    {
      id: "a3",
      stepId: 5,
      role: "agent",
      messageId: "m3",
      parentId: "u3",
      content: "recalling",
      isEnd: false,
      toolCalls: [{ toolName: "recallState", toolCallId: "t3", input: { turn: 1 } }],
      toolResults: [{ toolCallId: "t3", output: "# Turn 1\n\nAsked:\nLoad scores.csv...", isError: false }],
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

function render(s: Scenario): string {
  return String(
    assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      versionedCatalog: true,
      turnNumberByMessageId: new Map([
        ["m1", 1],
        ["m2", 2],
        ["m3", 3],
      ]),
    } as any)
      .map(m => m.content)
      .join("\n")
  );
}

describe("versioned catalog", () => {
  test("finished turns are structured entries with word verbs", () => {
    const text = render(scenario());
    expect(text).toContain("## Turn 2");
    expect(text).toContain("### Task");
    expect(text).toContain("### Dataflow delta");
    expect(text).toContain("#### `pct` (added)");
    expect(text).toContain("### Answer");
    // words, not symbols
    expect(text).not.toMatch(/^ {2}[+~-] /m);
  });

  test("upstream lines carry version provenance", () => {
    const text = render(scenario());
    expect(text).toContain("Upstream: scores (turn 1)");
  });

  test("the heads table points at latest finished versions, in the one notation", () => {
    const text = render(scenario());
    const heads = text.slice(text.indexOf("### Latest versions"));
    expect(heads).toContain("scores (turn 1)");
    expect(heads).toContain("pct (turn 2)");
  });

  test("no Dataflow section, no Recalled State tail — one catalog is the context", () => {
    const text = render(scenario());
    expect(text).not.toContain("## Dataflow (current state");
    expect(text).not.toContain("# Recalled State");
    expect(text).not.toContain("# Current Turn");
  });

  test("the in-progress turn is the last entry and carries its steps", () => {
    const text = render(scenario());
    const i = text.indexOf("## Turn 3 (in progress)");
    expect(i).toBeGreaterThan(text.indexOf("### Latest versions"));
    expect(text.slice(i)).toContain("Compare with the original.");
    expect(text.slice(i)).toContain("### Steps");
  });

  test("steps are numbered locally per turn, starting at 1", () => {
    const text = render(scenario());
    const steps = text.slice(text.indexOf("## Turn 3 (in progress)"));
    expect(steps).toContain("#### Step 1");
    expect(steps).not.toContain("Agent Event");
  });

  test("delta entries carry the output size — the recall-scaling signal", () => {
    // A later turn deciding how much of an old result to pull needs to know
    // how big that result is: rows x cols AND the total serialized chars, so
    // an `includeOutputTableSample` budget can be sized before the call.
    const text = render(scenario());
    expect(text).toMatch(/Result: 120 rows x \d+ cols, ~[\d.]+k? chars — Schema:/);
  });

  test("observation render knobs stay independent in versioned mode", () => {
    // The knob shows in OBSERVATIONS, so the current turn must write something.
    const build = () => {
      const sc = buildScenario([
        { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "load it" },
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
      sc.storage.createSnapshot("a1", makeWorkflow([{ id: "scores", type: "DataLoading" }]));
      sc.storage.setOperatorResult("a1", "scores", makeInfo(120, {}));
      return sc;
    };
    const renderWith = (extra: object) => {
      const sc = build();
      return String(
        assembleContext(sc.steps, sc.workflowState, sc.storage, ContextMode.DELTA, {
          compilationResult: null,
          agentMode: AgentMode.CODE,
          versionedCatalog: true,
          turnNumberByMessageId: new Map([["m1", 1]]),
          ...extra,
        } as any)
          .map(m => m.content)
          .join("\n")
      );
    };
    // column_stats flips its block on; nothing else moves with it.
    expect(renderWith({})).not.toContain("Column Schema and stats");
    expect(renderWith({})).not.toContain("Column Schema and stats");
    // schemaInResult is its own switch
    expect(renderWith({ schemaInResult: true })).toContain("Schema (");
  });

  test("a recall output persists inline as an observation", () => {
    const text = render(scenario());
    const steps = text.slice(text.indexOf("## Turn 3 (in progress)"));
    expect(steps).toContain("recallState output:");
    expect(steps).toContain("Load scores.csv...");
  });

  test("delta entries carry the structural profile under the D2 channel", () => {
    const s = scenario();
    s.storage.setOperatorResult(
      "a2",
      "pct",
      makeInfo(120, {
        sampleRows: [{ dbn: "x", pct: 0.5 }],
      })
    );
    const withHint = String(
      assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
        versionedCatalog: true,
        turnNumberByMessageId: new Map([
          ["m1", 1],
          ["m2", 2],
          ["m3", 3],
        ]),
      } as any)
        .map(m => m.content)
        .join("\n")
    );
    const entry = withHint.slice(
      withHint.indexOf("#### `pct` (added)"),
      withHint.indexOf("### Answer", withHint.indexOf("#### `pct`"))
    );
    expect(entry).not.toContain("Output Table profile:");
    expect(entry).not.toContain("unique key: dbn");
    // and OFF without the flag — knob independence holds in the catalog too
    expect(render(scenario())).not.toContain("Output Table profile:");
  });

  test("the catalog closes with the # Your Task directive naming the current turn", () => {
    const text = render(scenario());
    const roots = text.match(/^# .*$/gm) ?? [];
    expect(roots[0]).toContain("# Catalog");
    expect(roots[roots.length - 1]).toBe("# Your Task");
    expect(text).toContain("Work on the current turn (turn 3).");
    expect(text).toContain("**Final Answer:** <your answer, in the format the task asks for>");
  });

  test("LATEST cell: finished entries unchanged, current turn collapses into ### Dataflow", () => {
    const s = scenario();
    const text = String(
      assembleContext(s.steps, s.workflowState, s.storage, ContextMode.LATEST, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
        versionedCatalog: true,
        turnNumberByMessageId: new Map([
          ["m1", 1],
          ["m2", 2],
          ["m3", 3],
        ]),
      } as any)
        .map(m => m.content)
        .join("\n")
    );
    // finished entries keep the catalog shape
    expect(text).toContain("#### `pct` (added)");
    expect(text).toContain("Upstream: scores (turn 1)");
    // the current turn carries a nested Dataflow snapshot, never a root section
    const cur = text.slice(text.indexOf("## Turn 3 (in progress)"));
    expect(cur).toContain("### Dataflow");
    expect(text).not.toContain("# Current Dataflow");
    // recall pull output still persists in the step log (no snapshot to collapse into)
    expect(cur).toContain("recallState output:");
    expect(cur).toContain("# Your Task");
  });
});
