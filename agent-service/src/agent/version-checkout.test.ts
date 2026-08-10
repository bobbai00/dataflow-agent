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
 * CHECKOUT — the resolution table, exhaustively.
 *
 * A reference either names what the live node already is (wire to it, free) or
 * names history (materialize it). The tests below pin every branch, because
 * each one used to be the same wrong answer: "wire to the live node".
 *
 * The case that matters most is the last group: referencing the operator you
 * are currently writing. That is the NFL call, and the fix is not a
 * prohibition — the reference resolves to a pin, so the wiring is a DAG and
 * means exactly what the model intended.
 */

import { describe, expect, test } from "bun:test";
import { OperatorVersionStore } from "./operator-version-store";
import { VersionCheckout, pinIdFor } from "./version-checkout";
import { WorkflowState } from "./workflow-state";
import type { OperatorPredicate } from "../types/workflow";

function blankOperator(operatorType: string, displayName: string): OperatorPredicate {
  return {
    operatorID: "unset",
    operatorType,
    customDisplayName: displayName,
    operatorProperties: {},
    inputPorts: [{ portID: "input-0" }],
    outputPorts: [{ portID: "output-0" }],
  } as any;
}

/** A live graph plus a store, wired the way the agent wires them. */
function harness() {
  const ws = new WorkflowState();
  ws.setWorkflowContent({
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  const store = new OperatorVersionStore();
  const makeCheckout = () => new VersionCheckout({ workflowState: ws, store, newOperator: blankOperator });
  const checkout = makeCheckout();

  /** Simulate a turn writing an operator: graph node + recorded version. */
  const write = (id: string, turn: number, code: string, inputs: { operatorId: string; turn: number }[] = []) => {
    if (!ws.getOperator(id)) {
      ws.addOperator({ ...blankOperator(inputs.length ? "DataProcessing" : "DataLoading", id), operatorID: id } as any);
    } else {
      ws.updateOperatorProperties(id, { code });
    }
    store.recordWrite({
      operatorId: id,
      turn,
      code,
      operatorType: inputs.length ? "DataProcessing" : "DataLoading",
      inputPorts: [{ portID: "input-0" }],
      outputPorts: [{ portID: "output-0" }],
      inputRefs: inputs,
    });
  };
  return { ws, store, checkout, write, makeCheckout };
}

const codeOf = (ws: WorkflowState, id: string): string =>
  String((ws.getOperator(id)?.operatorProperties as Record<string, unknown>)?.code ?? "");

describe("a reference the live node already satisfies", () => {
  test("resolves to the live operator — no pin, nothing created", () => {
    const { ws, store, checkout, write } = harness();
    write("scores", 1, "v1");
    store.closeTurn(1);
    const before = ws.getAllOperators().length;
    const r = checkout.resolve({ operatorId: "scores", turn: 1 });
    expect(r).toEqual({ operatorId: "scores", pinned: false });
    expect(ws.getAllOperators().length).toBe(before);
  });
});

describe("a reference to a superseded version", () => {
  test("materializes a pin carrying THAT version's code", () => {
    const { ws, store, checkout, write } = harness();
    write("scores", 1, "code_v1");
    store.closeTurn(1);
    write("scores", 3, "code_v3"); // live node is now v3
    store.closeTurn(3);

    const r = checkout.resolve({ operatorId: "scores", turn: 1 });
    expect(r).toEqual({ operatorId: pinIdFor("scores", 1), pinned: true });
    expect(codeOf(ws, "scores__t1")).toBe("code_v1");
    expect(codeOf(ws, "scores")).toBe("code_v3"); // live untouched
  });

  test("the pin is labeled so renderers can show what it is", () => {
    const { store, checkout, write } = harness();
    write("scores", 1, "v1");
    store.closeTurn(1);
    write("scores", 2, "v2");
    checkout.resolve({ operatorId: "scores", turn: 1 });
    expect(checkout.pinnedLabel("scores__t1")).toBe("scores (turn 1)");
    expect(checkout.isPinned("scores__t1")).toBe(true);
    expect(checkout.isPinned("scores")).toBe(false);
    expect(checkout.pinnedLabel("scores")).toBeUndefined();
  });

  /**
   * The engine validates `operatorProperties` against the operator's JSON schema
   * with `additionalProperties: false`. A pin that carries internal bookkeeping
   * there fails validation on EVERY execution —
   *   "Operator panel_base__t1: - additionalProperties: must NOT have additional properties"
   * — so the pin wires correctly and then can never run, and the model burns
   * steps hand-copying it. Provenance belongs beside the graph.
   */
  test("a pin's properties carry no internal bookkeeping — only what the schema declares", () => {
    const { ws, store, checkout, write } = harness();
    write("scores", 1, "v1");
    store.closeTurn(1);
    write("scores", 2, "v2");
    checkout.resolve({ operatorId: "scores", turn: 1 });
    const props = ws.getOperator("scores__t1")!.operatorProperties as Record<string, unknown>;
    const live = ws.getOperator("scores")!.operatorProperties as Record<string, unknown>;
    expect(Object.keys(props).filter(k => k.startsWith("__"))).toEqual([]);
    // Same key set as a normal operator of that type: nothing extra smuggled in.
    expect(Object.keys(props).sort()).toEqual(Object.keys(live).sort());
  });

  test("a rebuilt checkout still recognizes an existing pin (id pattern + store)", () => {
    // `VersionCheckout` is constructed lazily, so the guard against editing a
    // pin must survive an instance that never materialized it itself.
    const { ws, store, checkout, write, makeCheckout } = harness();
    write("scores", 1, "v1");
    store.closeTurn(1);
    write("scores", 2, "v2");
    checkout.resolve({ operatorId: "scores", turn: 1 });
    const rebuilt = makeCheckout();
    expect(rebuilt.pinnedLabel("scores__t1")).toBe("scores (turn 1)");
    // An operator the model merely NAMED like a pin is not one: no such version.
    expect(ws.getOperator("scores__t1")).toBeDefined();
    expect(rebuilt.pinnedLabel("scores__t9")).toBeUndefined();
    expect(rebuilt.pinnedLabel("plain_op")).toBeUndefined();
  });

  test("referencing the same version twice reuses ONE pin", () => {
    const { ws, store, checkout, write } = harness();
    write("scores", 1, "v1");
    store.closeTurn(1);
    write("scores", 2, "v2");
    const a = checkout.resolve({ operatorId: "scores", turn: 1 });
    const countAfterFirst = ws.getAllOperators().length;
    const b = checkout.resolve({ operatorId: "scores", turn: 1 });
    expect(a).toEqual(b);
    expect(ws.getAllOperators().length).toBe(countAfterFirst);
    expect(checkout.pinnedOperatorIds()).toEqual(["scores__t1"]);
  });

  test("an unknown version is refused, and the error lists the real ones", () => {
    const { store, checkout, write } = harness();
    write("scores", 1, "v1");
    store.closeTurn(1);
    write("scores", 4, "v4");
    const r = checkout.resolve({ operatorId: "scores", turn: 2 }) as { error: string };
    expect(r.error).toContain("no version at turn 2");
    expect(r.error).toContain("scores (turn 1)");
    expect(r.error).toContain("scores (turn 4)");
  });
});

describe("checkout is recursive — the closure travels with the version", () => {
  test("a pin's inputs are pinned too when they have since changed", () => {
    const { ws, store, checkout, write } = harness();
    write("raw", 1, "raw_v1");
    write("clean", 1, "clean_v1", [{ operatorId: "raw", turn: 1 }]);
    store.closeTurn(1);
    // both change later
    write("raw", 5, "raw_v5");
    write("clean", 5, "clean_v5", [{ operatorId: "raw", turn: 5 }]);
    store.closeTurn(5);

    const r = checkout.resolve({ operatorId: "clean", turn: 1 }) as { operatorId: string };
    expect(r.operatorId).toBe("clean__t1");
    // its input must be raw AS OF TURN 1, not today's raw
    expect(codeOf(ws, "clean__t1")).toBe("clean_v1");
    expect(codeOf(ws, "raw__t1")).toBe("raw_v1");
    const links = ws.getAllLinks().filter(l => l.target.operatorID === "clean__t1");
    expect(links.map(l => l.source.operatorID)).toEqual(["raw__t1"]);
  });

  test("an input that never changed is wired live — no needless pin", () => {
    const { ws, store, checkout, write } = harness();
    write("raw", 1, "raw_v1"); // never revised
    write("clean", 1, "clean_v1", [{ operatorId: "raw", turn: 1 }]);
    store.closeTurn(1);
    write("clean", 4, "clean_v4", [{ operatorId: "raw", turn: 1 }]);
    store.closeTurn(4);

    checkout.resolve({ operatorId: "clean", turn: 1 });
    expect(ws.getOperator("raw__t1")).toBeUndefined(); // reused the live node
    const links = ws.getAllLinks().filter(l => l.target.operatorID === "clean__t1");
    expect(links.map(l => l.source.operatorID)).toEqual(["raw"]);
  });

  test("multi-input versions keep input ORDER, which is how ports bind", () => {
    const { ws, store, checkout, write } = harness();
    write("a", 1, "a1");
    write("b", 1, "b1");
    write("joined", 1, "j1", [
      { operatorId: "a", turn: 1 },
      { operatorId: "b", turn: 1 },
    ]);
    store.closeTurn(1);
    write("a", 2, "a2");
    write("b", 2, "b2");
    write("joined", 2, "j2", []);
    store.closeTurn(2);

    checkout.resolve({ operatorId: "joined", turn: 1 });
    const links = ws
      .getAllLinks()
      .filter(l => l.target.operatorID === "joined__t1")
      .sort((x, y) => x.target.portID.localeCompare(y.target.portID));
    expect(links.map(l => l.source.operatorID)).toEqual(["a__t1", "b__t1"]);
    expect(links.map(l => l.target.portID)).toEqual(["input-0", "input-1"]);
  });

  test("deep lineage checks out every generation", () => {
    const { ws, store, checkout, write } = harness();
    write("l0", 1, "l0v1");
    write("l1", 1, "l1v1", [{ operatorId: "l0", turn: 1 }]);
    write("l2", 1, "l2v1", [{ operatorId: "l1", turn: 1 }]);
    store.closeTurn(1);
    for (const id of ["l0", "l1", "l2"]) write(id, 9, `${id}v9`);
    store.closeTurn(9);

    checkout.resolve({ operatorId: "l2", turn: 1 });
    expect(codeOf(ws, "l2__t1")).toBe("l2v1");
    expect(codeOf(ws, "l1__t1")).toBe("l1v1");
    expect(codeOf(ws, "l0__t1")).toBe("l0v1");
  });
});

describe("referencing the operator being written — the NFL case", () => {
  test("resolves to a pin, so the wiring is a DAG instead of a self-loop", () => {
    const { ws, store, checkout, write } = harness();
    // turn 28 wrote `scored`; the same turn now revises it, naming its own
    // turn-28 version as an input.
    write("scored", 28, "scored_v28");

    const r = checkout.resolve({ operatorId: "scored", turn: 28 }, /* writing */ "scored");
    expect(r).toEqual({ operatorId: "scored__t28", pinned: true });
    expect(codeOf(ws, "scored__t28")).toBe("scored_v28");

    // wiring that pin into the live operator is acyclic
    expect(ws.wouldCreateCycle("scored__t28", "scored")).toBe(false);
  });

  test("without the writing hint the same ref stays live — the two differ", () => {
    const { store, checkout, write } = harness();
    write("scored", 28, "v28");
    expect(checkout.resolve({ operatorId: "scored", turn: 28 })).toEqual({
      operatorId: "scored",
      pinned: false,
    });
  });
});
