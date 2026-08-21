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
      content: "**Final Answer:** {\"rows\": 120}",
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
      content: "**Final Answer:** {\"median_pct\": 0.5}",
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
  s.storage.setOperatorResult(
    "a1",
    "scores",
    makeInfo(120, { columnStats: { id: "(numeric): null=0, min=1, max=120" } as any })
  );
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
      sc.storage.setOperatorResult(
        "a1",
        "scores",
        makeInfo(120, { columnStats: { id: "(numeric): null=0, min=1, max=120" } as any })
      );
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
        } as any).map(m => m.content).join("\n")
      );
    };
    // column_stats flips its block on; nothing else moves with it.
    expect(renderWith({ columnStats: true })).toContain("Column Schema and stats");
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
        columnStats: { __table_hints__: "unique key: dbn || 2 duplicate rows" } as any,
      })
    );
    const withHint = String(
      assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
        versionedCatalog: true,
        tableStructureHint: true,
        turnNumberByMessageId: new Map([
          ["m1", 1],
          ["m2", 2],
          ["m3", 3],
        ]),
      } as any)
        .map(m => m.content)
        .join("\n")
    );
    const entry = withHint.slice(withHint.indexOf("#### `pct` (added)"), withHint.indexOf("### Answer", withHint.indexOf("#### `pct`")));
    expect(entry).toContain("Output Table profile:");
    expect(entry).toContain("unique key: dbn");
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

describe("catalogDetail on the versioned catalog", () => {
  function scenarioWithCode(): Scenario {
    const s = scenario();
    // give the turn-1 operator code, as the write tool stores it (the storage
    // returns live snapshot objects, so mutate what turn 1's leaf holds)
    const op = s.storage
      .getAssociatedSnapshot("a1")
      .workflow.operators.find(o => o.operatorID === "scores");
    (op as any).operatorProperties = {
      ...(op as any).operatorProperties,
      code: "def load():\n    return pd.read_csv('scores.csv')",
    };
    return s;
  }

  function renderWith(s: Scenario, catalogDetail: string): string {
    return String(
      assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
        versionedCatalog: true,
        catalogDetail,
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

  test('"code" renders each version\'s code in its own entry', () => {
    const text = renderWith(scenarioWithCode(), "code");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain("```python");
    expect(t1).toContain("pd.read_csv('scores.csv')");
  });

  test('default ("schema") never renders code blocks in entries', () => {
    const text = renderWith(scenarioWithCode(), "schema");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).not.toContain("```python");
  });

  test('"brief" keeps shape and size but drops the column inventory', () => {
    const text = renderWith(scenario(), "brief");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toMatch(/Result: \d+ rows x \d+ cols/);
    expect(t1).not.toContain("— Schema:");
  });

  test('"ids" collapses each entry to id + verb', () => {
    const text = renderWith(scenario(), "ids");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain("#### `scores` (added)");
    expect(t1).not.toContain("Result:");
    expect(t1).not.toContain("Summary:");
  });

  test('"values" renders code AND the categorical vocabulary, verbatim', () => {
    const s = scenarioWithCode();
    const info = s.storage.getOperatorResult("a1", "scores")!;
    (info as any).columnStats = {
      band: '(str): null=0, distinct=3, top_3={"$0-999"=40, "1,000-1,999"=50, "2,000-2,999"=30}',
    };
    const text = renderWith(s, "values");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain("```python");
    expect(t1).toContain("Value vocabulary");
    // the exact spellings survive — including the band that carries no `$`
    expect(t1).toContain('"$0-999"=40');
    expect(t1).toContain('"1,000-1,999"=50');
  });

  test('"values" omits distribution-only columns — no mean/min/max bloat', () => {
    // wids1 turn 35 measured 1,115 stats lines = 33% of a 342 kB context, of
    // which the string vocabularies were 3.3%. Numeric summaries carry no
    // spelling, so they do not belong in a byte-stable catalog entry.
    const s = scenarioWithCode();
    const info = s.storage.getOperatorResult("a1", "scores")!;
    (info as any).columnStats = {
      height: "(numeric): null=239, mean=17.46, min=0, max=115.6",
      plain_id: "(str): null=0, distinct=10000",
      band: '(str): null=0, distinct=2, top_3={"a"=5, "b"=6}',
    };
    const text = renderWith(s, "values");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).toContain('"band"');
    expect(t1).not.toContain("mean=17.46");
    // a high-cardinality string column has no enumerable vocabulary either
    expect(t1).not.toContain('"plain_id"');
  });

  test('"code" does NOT render any value block', () => {
    const s = scenarioWithCode();
    const info = s.storage.getOperatorResult("a1", "scores")!;
    (info as any).columnStats = { band: '(str): distinct=3, top_3={"a"=1}' };
    const text = renderWith(s, "code");
    const t1 = text.slice(text.indexOf("## Turn 1"), text.indexOf("## Turn 2"));
    expect(t1).not.toContain("Value vocabulary");
  });
});
