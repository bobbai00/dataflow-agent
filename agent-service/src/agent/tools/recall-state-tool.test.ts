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
 * The turn-addressed `recallState` contract.
 *
 * Every bug this tool has had was a contract bug found in a live run, not a
 * logic bug found by reading: turn numbers off by one against the catalogue the
 * model reads, recalled output that did not persist, a render policy that
 * silently dropped the thing the model asked for. Those are all cheap to pin
 * here, so they are pinned here.
 */

import { describe, expect, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { makeInfo, makeWorkflow } from "../context/summarize/fixtures";
import {
  createRecallStateTool,
  RECALL_CALLS_PER_TURN,
  RECALL_RESULT_CHARS_MAX,
  type RecalledTurn,
  type RecallVerb,
} from "./recall-state-tool";

const CODE_PCT = "def process(scores):\n    return scores.assign(pct=scores['score'].rank(pct=True))";

function turns(): RecalledTurn[] {
  const t1Workflow = makeWorkflow([
    { id: "scores", type: "DataLoading", properties: { code: "def load():\n    return pd.read_csv('s.csv')" } },
  ]);
  const t2Workflow = makeWorkflow(
    [
      { id: "scores", type: "DataLoading", properties: { code: "def load():\n    return pd.read_csv('s.csv')" } },
      {
        id: "pct",
        type: "DataProcessing",
        numInputPorts: 1,
        properties: { code: CODE_PCT },
        displayName: "Percentile of each score",
      },
    ],
    [["scores", "pct"]]
  );
  const wide = Array.from({ length: 60 }, (_, i) => ({ player: `player_${i}`, score: i, pct: i / 60 }));
  return [
    {
      turn: 1,
      request: "Load s.csv and tell me how many rows it has.",
      answer: '{"rows": 120}',
      operators: ["scores"],
      verbs: new Map<string, RecallVerb>([["scores", "added"]]),
      workflow: t1Workflow,
      results: new Map([["scores", makeInfo(120)]]),
    },
    {
      turn: 2,
      request: "Add a percentile column. Use average rank divided by n; the lowest score gets 1/n.",
      answer: '{"median_pct": 0.5}',
      operators: ["pct"],
      verbs: new Map<string, RecallVerb>([["pct", "added"]]),
      workflow: t2Workflow,
      results: new Map([["pct", makeInfo(60, { sampleRows: wide })]]),
    },
  ];
}

function makeTool(overrides: { maxResultChars?: number } = {}, log: RecalledTurn[] = turns()) {
  return createRecallStateTool({
    getTurns: () => log,
    getCurrentTurnKey: () => "m-current",
    workflowState: new WorkflowState(),
    ...overrides,
  });
}

const run = (t: unknown, args: Record<string, unknown>): Promise<string> => (t as any).execute(args);

describe("recallState — turn addressing", () => {
  test("a turn comes back with its verbatim request, answer, and operator delta", async () => {
    const out = await run(makeTool(), { turn: 2 });
    expect(out).toContain("# Turn 2");
    // Verbatim, not a gist: the convention stated in the request is the whole
    // reason the model is looking.
    expect(out).toContain("the lowest score gets 1/n");
    expect(out).toContain('{"median_pct": 0.5}');
    expect(out).toContain("+ `pct`");
    expect(out).toContain("Percentile of each score");
    // Turn 2's delta is `pct` alone — `scores` belongs to turn 1.
    expect(out).not.toContain("`scores`");
  });

  test("the verb reflects the snapshot diff, and a deleted operator says so", async () => {
    const log = turns();
    log[1].operators = ["pct", "probe"];
    log[1].verbs = new Map<string, RecallVerb>([
      ["pct", "revised"],
      ["probe", "deleted"],
    ]);
    const out = await run(makeTool({}, log), { turn: 2 });
    expect(out).toContain("~ `pct`");
    expect(out).toContain("- `probe`");
    expect(out).toContain("no longer existed at the end of it");
  });

  test("an out-of-range turn names the range instead of failing silently", async () => {
    const out = await run(makeTool(), { turn: 9 });
    expect(out).toContain("Turn 9 is not available");
    expect(out).toContain("1..2");
  });

  test("the first turn of a session says there is nothing to recall", async () => {
    const out = await run(makeTool({}, []), { turn: 1 });
    expect(out).toContain("no earlier turns yet");
  });
});

describe("recallState — the caller chooses the verbosity", () => {
  test("code is on by default; table bodies are not", async () => {
    const out = await run(makeTool(), { turn: 2 });
    expect(out).toContain(CODE_PCT);
    // Shape and schema still orient the model without paying for the rows —
    // and the header now states the table's TOTAL size (the scaling fact).
    expect(out).toMatch(/Result \(as of turn 2, ~[\d.]+k? chars total\):/);
    expect(out).toContain("player");
    expect(out).not.toContain("player_7");
    expect(out).toContain("table bodies omitted (includeOutputTableSample=0)");
  });

  test("sample=0 + includeCode=false is the cheapest possible pull", async () => {
    const out = await run(makeTool(), { turn: 2, includeCode: false });
    expect(out).not.toContain(CODE_PCT);
    expect(out).toContain("code omitted (includeCode=false)");
  });

  test("a non-zero sample budget renders rows, bounded by that budget", async () => {
    const wide = await run(makeTool(), { turn: 2, includeOutputTableSample: 4000 });
    const narrow = await run(makeTool(), { turn: 2, includeOutputTableSample: 200 });
    expect(wide).toContain("player_0");
    expect(narrow.length).toBeLessThan(wide.length);
  });

  test("an oversized sample budget is clamped, and the clamp TEACHES the way forward", async () => {
    const out = await run(makeTool(), { turn: 2, includeOutputTableSample: 500000 });
    expect(out).toContain(`clamped to ${RECALL_RESULT_CHARS_MAX}`);
    // Not a bare rejection: the note points at the size fact and the narrower
    // channels, so the model narrows instead of retrying with a bigger number.
    expect(out).toContain("total size");
    expect(out).toContain("aggregate");
    expect(out.length).toBeLessThan(RECALL_RESULT_CHARS_MAX * 3);
  });

  test("the ceiling is configurable per arm (recallMaxResultChars)", async () => {
    const t = makeTool({ maxResultChars: 100 });
    const out = await run(t, { turn: 2, includeOutputTableSample: 4000 });
    expect(out).toContain("clamped to 100");
  });

  test("a truncated sample states how much of the table it is", async () => {
    // The fixture table is ~1.6k chars; a 200-char budget must say so.
    const out = await run(makeTool(), { turn: 2, includeOutputTableSample: 200 });
    expect(out).toMatch(/shown: first 200 chars of ~[\d.]+k? chars/);
  });
});

describe("recallState — OPERATOR-LEVEL addressing (v3)", () => {
  function opTool(extra: { maxResultChars?: number } = {}) {
    return createRecallStateTool({
      getTurns: () => turns(),
      getCurrentTurnKey: () => "m-current",
      workflowState: new WorkflowState(),
      operatorLevel: true,
      ...extra,
    });
  }

  test("one ref, one version: code + result with total size, values by default", async () => {
    const out = await run(opTool(), { ref: "pct (turn 2)" });
    expect(out).toContain("# pct (turn 2)");
    expect(out).toContain(CODE_PCT);
    expect(out).toMatch(/Result \(as of turn 2, ~[\d.]+k? chars total\):/);
    // values are the point of a scoped pull — sample rows on by default
    expect(out).toContain("player");
    expect(out).toContain("player_0");
  });

  test("a wrong turn teaches the valid versions in the one notation", async () => {
    const out = await run(opTool(), { ref: "pct (turn 9)" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("pct (turn 2)");
    expect(out).toContain("pick one of those");
  });

  test("an unknown operator and a malformed ref each teach the expected form", async () => {
    expect(await run(opTool(), { ref: "ghost (turn 1)" })).toContain("No finished turn has a version");
    expect(await run(opTool(), { ref: "pct@2" })).toContain('"opId (turn N)"');
  });

  test("sample=0 gives shape/schema only; the ceiling still clamps", async () => {
    const lean = await run(opTool(), { ref: "pct (turn 2)", includeOutputTableSample: 0 });
    expect(lean).not.toContain("player_0");
    expect(lean).toContain("Schema");
    const clamped = await run(opTool({ maxResultChars: 150 }), { ref: "pct (turn 2)", includeOutputTableSample: 9999 });
    expect(clamped).toContain("clamped to 150");
  });
});

describe("recallState — budget", () => {
  test("the per-turn call budget stops a retrieval loop and says what to do instead", async () => {
    const t = makeTool();
    for (let i = 0; i < RECALL_CALLS_PER_TURN; i++) {
      expect(await run(t, { turn: 1 })).toContain("# Turn 1");
    }
    const over = await run(t, { turn: 1 });
    expect(over).toContain("Recall budget for this turn is used up");
  });

  test("the budget resets at a turn boundary", async () => {
    let key = "m-1";
    const t = createRecallStateTool({
      getTurns: () => turns(),
      getCurrentTurnKey: () => key,
      workflowState: new WorkflowState(),
    });
    for (let i = 0; i < RECALL_CALLS_PER_TURN + 1; i++) await run(t, { turn: 1 });
    key = "m-2";
    expect(await run(t, { turn: 1 })).toContain("# Turn 1");
  });
});
