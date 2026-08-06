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
      { id: "pct", type: "DataProcessing", numInputPorts: 1, properties: { code: CODE_PCT }, displayName: "Percentile of each score" },
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

function makeTool(log: RecalledTurn[] = turns()) {
  return createRecallStateTool({
    getTurns: () => log,
    getCurrentTurnKey: () => "m-current",
    workflowState: new WorkflowState(),
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
    const out = await run(makeTool(log), { turn: 2 });
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
    const out = await run(makeTool([]), { turn: 1 });
    expect(out).toContain("no earlier turns yet");
  });
});

describe("recallState — the caller chooses the verbosity", () => {
  test("code is on by default; table bodies are not", async () => {
    const out = await run(makeTool(), { turn: 2 });
    expect(out).toContain(CODE_PCT);
    // Shape and schema still orient the model without paying for the rows.
    expect(out).toContain("Result (as of turn 2):");
    expect(out).toContain("player");
    expect(out).not.toContain("player_7");
    expect(out).toContain("table bodies omitted (includeResults=false)");
  });

  test("includeResults=false + includeCode=false is the cheapest possible pull", async () => {
    const out = await run(makeTool(), { turn: 2, includeCode: false });
    expect(out).not.toContain(CODE_PCT);
    expect(out).toContain("code omitted (includeCode=false)");
  });

  test("includeResults=true renders rows, bounded by maxResultChars", async () => {
    const wide = await run(makeTool(), { turn: 2, includeResults: true, maxResultChars: 4000 });
    const narrow = await run(makeTool(), { turn: 2, includeResults: true, maxResultChars: 200 });
    expect(wide).toContain("player_0");
    expect(narrow.length).toBeLessThan(wide.length);
  });

  test("an oversized maxResultChars is clamped, and the model is told", async () => {
    const out = await run(makeTool(), { turn: 2, includeResults: true, maxResultChars: 500000 });
    expect(out).toContain(`clamped to ${RECALL_RESULT_CHARS_MAX}`);
    expect(out.length).toBeLessThan(RECALL_RESULT_CHARS_MAX * 3);
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
