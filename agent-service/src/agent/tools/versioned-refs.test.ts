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
    expect(out).toContain("Missing version for upstream(s): [scores]");
    expect(out).toContain('{"scores": <turn>}');
    expect(out).toContain("versions at turn 1, 3");
  });

  test("a wrong turn is rejected with the valid versions listed", async () => {
    const out = await run(makeTool(store()), { operatorId: "pct", code: PROCESS, upstreams: { scores: 2 } });
    expect(out).toContain("no version at turn 2");
    expect(out).toContain("versions at turn 1, 3");
  });

  test("referencing this turn's own work is valid", async () => {
    const vs = store({ touchedThisTurn: () => new Set(["scores"]) });
    const out = await run(makeTool(vs), { operatorId: "pct", code: PROCESS, upstreams: { scores: 5 } });
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
    expect(out).toContain("fromTurn");
    expect(out).toContain("versions at turn 1, 3");
  });

  test("fromTurn on a brand-new operator is rejected — nothing to derive from", async () => {
    const out = await run(makeTool(store()), {
      operatorId: "fresh",
      code: "def load() -> pd.DataFrame:\n    return pd.DataFrame()",
      fromTurn: 3,
    });
    expect(out).toContain("does not exist yet");
    expect(out).toContain("Drop fromTurn");
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
