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
 * Strict (operatorId, turnId) references on the write path.
 *
 * The rule under test is not the happy path — it is the error contract. Every
 * rejection must name the valid versions and the way forward, because a bare
 * rejection produces verbatim retry loops (measured: 35 identical calls, a
 * full step budget, no answer). And legacy arms must be byte-identical: no
 * version store, no new requirements.
 */

import { describe, expect, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { createCreateOrModifyOperatorTool, type OperatorVersionStore } from "./code-op-tools";

function store(overrides: Partial<OperatorVersionStore> = {}): OperatorVersionStore {
  return {
    versionsOf: (opId: string) =>
      opId === "scores" ? [{ turn: 1, code: "def load(): ..." }, { turn: 3, code: "def load(): v2" }] : [],
    currentTurn: () => 5,
    touchedThisTurn: () => new Set<string>(),
    ...overrides,
  };
}

function wsWith(ids: string[]): WorkflowState {
  const ws = new WorkflowState();
  ws.setWorkflowContent({
    operators: ids.map(
      id =>
        ({
          operatorID: id,
          operatorType: "DataLoading",
          operatorProperties: {},
          inputPorts: [],
          outputPorts: [{ portID: "output-0" }],
        }) as any
    ),
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  return ws;
}

function makeTool(vs?: OperatorVersionStore, ws = wsWith(["scores"])) {
  // No schemas / context needed: the validations under test fire before any
  // state mutation. `scores` exists live so the operator-exists check (which
  // deliberately runs first) does not mask the version checks.
  return createCreateOrModifyOperatorTool(ws, new Map(), undefined, 0, false, true, vs);
}

const run = (t: unknown, args: Record<string, unknown>): Promise<string> =>
  (t as any).execute({ summary: "s", ...args });

const PROCESS = "def process(scores) -> pd.DataFrame:\n    return scores";

describe("strict version refs", () => {
  test("a process() without upstreams is rejected, and the error teaches", async () => {
    const out = await run(makeTool(store()), { operatorId: "pct", code: PROCESS });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("Missing version reference for upstream(s): [scores]");
    expect(out).toContain('"scores (turn N)"');
    expect(out).toContain("scores (turn 1), scores (turn 3)");
  });

  test("a wrong turn is rejected with the valid versions listed", async () => {
    const out = await run(makeTool(store()), { operatorId: "pct", code: PROCESS, upstreams: ["scores (turn 2)"] });
    expect(out).toContain("no version at turn 2");
    expect(out).toContain("scores (turn 1), scores (turn 3)");
  });

  test("referencing this turn's own work is valid", async () => {
    const vs = store({ touchedThisTurn: () => new Set(["scores"]) });
    const out = await run(makeTool(vs), { operatorId: "pct", code: PROCESS, upstreams: ["scores (turn 5)"] });
    // passes version validation; whatever happens later (schema lookup in this
    // bare fixture) is a different stage.
    expect(out).not.toContain("no version at turn");
    expect(out).not.toContain("Missing version");
  });

  test("revising an existing operator requires fromTurn", async () => {
    const out = await run(makeTool(store()), {
      operatorId: "scores",
      code: "def load() -> pd.DataFrame:\n    return pd.DataFrame()",
    });
    expect(out).toContain("this is a revision");
    expect(out).toContain('"scores (turn N)"');
    expect(out).toContain("scores (turn 1), scores (turn 3)");
  });

  test("`from` on a brand-new operator proceeds with a note — the intent (create) is unambiguous", async () => {
    // Rejecting this cost a step per occurrence (65 across three runs) and
    // taught nothing a note doesn't: the operator is created fresh either way.
    const out = await run(makeTool(store()), {
      operatorId: "fresh",
      code: "def load() -> pd.DataFrame:\n    return pd.DataFrame()",
      from: "fresh (turn 3)",
    });
    // passes version validation; whatever happens later (operator-type lookup
    // in this bare fixture) is a different stage.
    expect(out).not.toContain("does not exist yet");
    expect(out).not.toContain("Drop it to create");
  });

  test("missing `from` on a SAME-TURN self-revision defaults with a note", async () => {
    // The only version the new code can derive from is the one this turn just
    // wrote — strictness there fed the rename-sprawl loop. Cross-turn
    // revisions (previous test) stay strict.
    const vs = store({ touchedThisTurn: () => new Set(["scores"]) });
    const out = await run(makeTool(vs), {
      operatorId: "scores",
      code: "def load() -> pd.DataFrame:\n    return pd.DataFrame()",
    });
    expect(out).not.toContain("this is a revision");
    expect(out).toContain('`from` defaulted to "scores (turn 5)"');
  });

  test("a malformed reference is rejected with the exact expected form", async () => {
    const out = await run(makeTool(store()), { operatorId: "pct", code: PROCESS, upstreams: ["scores@1"] });
    expect(out).toContain('Could not parse upstream reference "scores@1"');
    expect(out).toContain('"opId (turn N)"');
  });

  test("input-values channel: first cross-turn reference attaches the version's sample, once", async () => {
    // The catalog names shapes and schemas, not values — so the first write
    // against an old version gets that version's sample values attached to its
    // observation (derivations over inherited state made with numbers in
    // view), and only the first: the note persists in the step log.
    const vs = store({
      versionsOf: (opId: string) =>
        opId === "scores"
          ? [{ turn: 1, code: "def load(): ..." }]
          : opId === "pct"
            ? [{ turn: 2, code: "def process(scores): ..." }]
            : [],
      resultOf: (opId: string, turn: number) =>
        opId === "scores" && turn === 1
          ? { result: [{ player: "a", score: 9 }, { player: "b", score: 7 }], totalRowCount: 120 }
          : undefined,
    });
    const ws = new WorkflowState();
    ws.setWorkflowContent({
      operators: [
        {
          operatorID: "scores",
          operatorType: "DataLoading",
          operatorProperties: {},
          inputPorts: [],
          outputPorts: [{ portID: "output-0" }],
        },
        {
          operatorID: "pct",
          operatorType: "DataProcessing",
          operatorProperties: {},
          inputPorts: [{ portID: "input-0" }],
          outputPorts: [{ portID: "output-0" }],
        },
      ] as any,
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    } as any);
    const t = makeTool(vs, ws);
    const args = {
      operatorId: "pct",
      code: PROCESS,
      upstreams: ["scores (turn 1)"],
      from: "pct (turn 2)",
    };
    const out1 = await run(t, args);
    expect(out1).toContain("Referenced upstream values — scores (turn 1) (120 rows total):");
    expect(out1).toContain("player\tscore");
    const out2 = await run(t, args);
    expect(out2).not.toContain("Referenced upstream values");
  });

  test("legacy arms are untouched: no store, no new requirements", async () => {
    const out = await run(makeTool(undefined, wsWith([])), {
      operatorId: "pct",
      code: PROCESS,
    });
    // fails only on the missing upstream operator, exactly as before —
    // never on a missing version.
    expect(out).not.toContain("Missing version");
    expect(out).toContain("Input parameter(s) not found");
  });
});
