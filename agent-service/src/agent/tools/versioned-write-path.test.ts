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
 * THE WRITE TOOL, END TO END, WITH VERSIONS THAT MEAN SOMETHING.
 *
 * Two tool sets share one factory, separated by whether a version store with
 * checkout is supplied:
 *
 *   VERSIONED — every upstream names `opId (turn N)`, and that reference is
 *   honored: the live node when it already is that version, a checked-out copy
 *   otherwise. A reference to the operator being written is legal and becomes
 *   `X__tN -> X`.
 *
 *   NON-VERSIONED — no turn ids anywhere; `def process(a, b)` wires to the
 *   latest live nodes by name, exactly as before. Self-reference stays a hard
 *   error, because without checkout there is nothing else it could mean.
 */

import { describe, expect, test } from "bun:test";
import { OperatorVersionStore } from "../operator-version-store";
import { VersionCheckout } from "../version-checkout";
import { WorkflowState } from "../workflow-state";
import { createCreateOrModifyOperatorTool, type OperatorVersionStore as ToolVersionStore } from "./code-op-tools";
import type { OperatorPredicate } from "../../types/workflow";

const LOADER = "DataLoading";
const PROCESSOR = "DataProcessing";

function blank(operatorType: string, displayName: string): OperatorPredicate {
  return {
    operatorID: "unset",
    operatorType,
    customDisplayName: displayName,
    operatorProperties: {},
    inputPorts: [{ portID: "input-0" }],
    outputPorts: [{ portID: "output-0" }],
  } as any;
}

/**
 * A tool wired the way the agent wires it: real graph, real store, real
 * checkout. `schemas`/`workflowUtil` are supplied so the ADD path can run.
 */
function harness(opts: { versioned: boolean }) {
  const ws = new WorkflowState();
  ws.setWorkflowContent({
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  const store = new OperatorVersionStore();
  const checkout = new VersionCheckout({ workflowState: ws, store, newOperator: blank });
  let turn = 1;

  const adapter: ToolVersionStore = {
    versionsOf: (opId: string) =>
      store.versionsOf(opId).map(t => ({ turn: t, code: store.get(opId, t)?.code ?? "" })),
    currentTurn: () => turn,
    touchedThisTurn: () => new Set(store.operatorIds().filter(id => store.has(id, turn))),
    checkout: (opId, t, writing) => checkout.resolve({ operatorId: opId, turn: t }, writing),
    pinnedLabelOf: (opId: string) => checkout.pinnedLabel(opId),
  };

  // The ADD path needs a real metadata store to mint predicates; these tests
  // are about REFERENCE RESOLUTION on existing operators, so operators are
  // seeded directly and the tool exercises the modify/wiring path.
  const tool = createCreateOrModifyOperatorTool(ws, new Map(), undefined, 0, false, true, opts.versioned ? adapter : undefined);
  const run = (args: Record<string, unknown>): Promise<string> => (tool as any).execute({ summary: "s", ...args });

  /** Put an operator into the graph, as an earlier turn would have. */
  const seed = (id: string, code: string, inputs: string[] = []) => {
    ws.addOperator({
      ...blank(inputs.length ? PROCESSOR : LOADER, id),
      operatorID: id,
      operatorProperties: { code },
      inputPorts: inputs.length
        ? inputs.map((_, i) => ({ portID: `input-${i}` }))
        : [{ portID: "input-0" }],
    } as any);
    inputs.forEach((src, i) => {
      ws.addLink({
        linkID: `${src}-->${id}`,
        source: { operatorID: src, portID: "output-0" },
        target: { operatorID: id, portID: `input-${i}` },
      } as any);
    });
  };

  /** Record what the graph now holds for `id` as its version at `turn`. */
  const record = (id: string, inputRefs: { operatorId: string; turn: number }[] = []) => {
    const op = ws.getOperator(id);
    if (!op) return;
    store.recordWrite({
      operatorId: id,
      turn,
      code: String((op.operatorProperties as any)?.code ?? ""),
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
      inputRefs,
    });
  };
  const endTurn = () => {
    store.closeTurn(turn);
    turn += 1;
  };
  return { ws, store, run, record, endTurn, seed, turnNow: () => turn };
}

const codeOf = (ws: WorkflowState, id: string) =>
  String((ws.getOperator(id)?.operatorProperties as Record<string, unknown>)?.code ?? "");
const inputsOf = (ws: WorkflowState, id: string) =>
  ws
    .getAllLinks()
    .filter(l => l.target.operatorID === id)
    .map(l => l.source.operatorID)
    .sort();

describe("versioned mode — references are honored, not just checked", () => {
  test("the NFL call now works: an operator may build on its own earlier version", async () => {
    const h = harness({ versioned: true });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.record("raw");
    h.seed("scored", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    h.record("scored", [{ operatorId: "raw", turn: 1 }]);

    // ...same turn, revise `scored` feeding its own turn-1 version in.
    const out = await h.run({
      operatorId: "scored",
      code: "def process(scored, raw) -> pd.DataFrame:\n    return scored",
      upstreams: ["scored (turn 1)", "raw (turn 1)"],
      from: "scored (turn 1)",
    });

    expect(out).not.toContain("[ERROR]");
    expect(out).toContain("checked out as");
    // the pin exists, carries the OLD code, and feeds the live operator
    expect(codeOf(h.ws, "scored__t1")).toContain("return raw");
    expect(inputsOf(h.ws, "scored")).toEqual(["raw", "scored__t1"]);
    // and the graph is acyclic — no operator consumes itself
    expect(h.ws.getAllLinks().some(l => l.source.operatorID === l.target.operatorID)).toBe(false);
  });

  test("a superseded version is checked out; the live node keeps its new code", async () => {
    const h = harness({ versioned: true });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return 'v1'");
    h.record("raw");
    h.endTurn();
    await h.run({ operatorId: "raw", code: "def load() -> pd.DataFrame:\n    return 'v2'", from: "raw (turn 1)" });
    h.record("raw");
    h.endTurn();
    h.seed("compare", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    h.record("compare", [{ operatorId: "raw", turn: 2 }]);

    const out = await h.run({
      operatorId: "compare",
      code: "def process(raw) -> pd.DataFrame:\n    return raw",
      upstreams: ["raw (turn 1)"],
      from: "compare (turn 3)",
    });
    expect(out).not.toContain("[ERROR]");
    expect(inputsOf(h.ws, "compare")).toEqual(["raw__t1"]);
    expect(codeOf(h.ws, "raw__t1")).toContain("'v1'");
    expect(codeOf(h.ws, "raw")).toContain("'v2'");
  });

  test("referencing the LATEST version wires live — no pin, no clutter", async () => {
    const h = harness({ versioned: true });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.record("raw");
    h.endTurn();
    h.seed("next", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    const before = h.ws.getAllOperators().length;
    await h.run({
      operatorId: "next",
      code: "def process(raw) -> pd.DataFrame:\n    return raw",
      upstreams: ["raw (turn 1)"],
    });
    expect(inputsOf(h.ws, "next")).toEqual(["raw"]);
    expect(h.ws.getAllOperators().length).toBe(before); // no pin created
  });

  test("a checked-out copy cannot be edited — versions are permanent", async () => {
    const h = harness({ versioned: true });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return 'v1'");
    h.record("raw");
    h.endTurn();
    await h.run({ operatorId: "raw", code: "def load() -> pd.DataFrame:\n    return 'v2'", from: "raw (turn 1)" });
    h.record("raw");
    h.endTurn();
    h.seed("c", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    await h.run({
      operatorId: "c",
      code: "def process(raw) -> pd.DataFrame:\n    return raw",
      upstreams: ["raw (turn 1)"],
    });

    const out = await h.run({ operatorId: "raw__t1", code: "def load() -> pd.DataFrame:\n    return 'tampered'" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("cannot be edited");
    expect(codeOf(h.ws, "raw__t1")).toContain("'v1'"); // untouched
  });

  test("an unknown version is refused with the versions that do exist", async () => {
    const h = harness({ versioned: true });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.record("raw");
    h.endTurn();
    h.seed("next", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    const out = await h.run({
      operatorId: "next",
      code: "def process(raw) -> pd.DataFrame:\n    return raw",
      upstreams: ["raw (turn 7)"],
    });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("no version at turn 7");
    expect(out).toContain("raw (turn 1)");
  });
});

describe("non-versioned mode — unchanged, and still protected", () => {
  test("wiring is by name, with no turn ids anywhere", async () => {
    const h = harness({ versioned: false });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.seed("next", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    const out = await h.run({
      operatorId: "next",
      code: "def process(raw) -> pd.DataFrame:\n    return raw",
    });
    expect(out).not.toContain("[ERROR]");
    expect(inputsOf(h.ws, "next")).toEqual(["raw"]);
  });

  test("upstreams are NOT required — the legacy contract is intact", async () => {
    const h = harness({ versioned: false });
    h.seed("a", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.seed("b", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.seed("j", "def process(a, b) -> pd.DataFrame:\n    return a", ["a", "b"]);
    const out = await h.run({
      operatorId: "j",
      code: "def process(a, b) -> pd.DataFrame:\n    return a",
    });
    expect(out).not.toContain("Missing version reference");
    expect(inputsOf(h.ws, "j")).toEqual(["a", "b"]);
  });

  test("self-reference stays a hard error — without checkout it can only be a self-loop", async () => {
    const h = harness({ versioned: false });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.seed("x", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    const out = await h.run({ operatorId: "x", code: "def process(x) -> pd.DataFrame:\n    return x" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("cannot take itself as an input");
    expect(h.ws.getAllLinks().some(l => l.source.operatorID === l.target.operatorID)).toBe(false);
  });

  test("no pins are ever created in this mode", async () => {
    const h = harness({ versioned: false });
    h.seed("raw", "def load() -> pd.DataFrame:\n    return pd.DataFrame()");
    h.seed("n", "def process(raw) -> pd.DataFrame:\n    return raw", ["raw"]);
    await h.run({ operatorId: "n", code: "def process(raw) -> pd.DataFrame:\n    return raw" });
    expect(h.ws.getAllOperators().some(o => o.operatorID.includes("__t"))).toBe(false);
  });
});
