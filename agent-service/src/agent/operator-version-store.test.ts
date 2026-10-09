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
 * THE VERSION STORE'S CONTRACT.
 *
 * Everything the versioned write path does rests on two properties:
 * a closed version never changes, and each version remembers what it consumed.
 * If either breaks, a reference to `X (turn 3)` stops meaning one fixed thing —
 * which is exactly the failure this store was built to end.
 */

import { describe, expect, test } from "bun:test";
import { OperatorVersionStore } from "./operator-version-store";

const v = (operatorId: string, turn: number, extra: Partial<Parameters<OperatorVersionStore["recordWrite"]>[0]> = {}) => ({
  operatorId,
  turn,
  code: `def load(): return "${operatorId}@${turn}"`,
  operatorType: "DataLoading",
  inputPorts: [],
  outputPorts: [{ portID: "output-0" }],
  inputRefs: [],
  ...extra,
});

describe("composite key (operatorId, turn)", () => {
  test("the same id at different turns is two distinct versions", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    s.closeTurn(1);
    s.recordWrite(v("scores", 3));
    expect(s.get("scores", 1)!.code).toContain("scores@1");
    expect(s.get("scores", 3)!.code).toContain("scores@3");
    expect(s.versionsOf("scores")).toEqual([1, 3]);
    expect(s.size()).toBe(2);
  });

  test("unknown ids and turns simply have no version", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    expect(s.get("scores", 2)).toBeUndefined();
    expect(s.get("ghost", 1)).toBeUndefined();
    expect(s.has("scores", 1)).toBe(true);
    expect(s.versionsOf("ghost")).toEqual([]);
  });

  test("versionsOf is ascending regardless of write order", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("x", 5));
    s.closeTurn(5);
    s.recordWrite(v("x", 2));
    s.closeTurn(2);
    s.recordWrite(v("x", 9));
    expect(s.versionsOf("x")).toEqual([2, 5, 9]);
    expect(s.latestTurnOf("x")).toBe(9);
  });
});

describe("provisional while the turn is open, immutable once closed", () => {
  test("a re-write inside the SAME turn replaces the entry", () => {
    // The turn has not produced a referenceable version yet, so replacing is
    // correct — the model is still deciding what this turn's version IS.
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 4, { code: "first" }));
    s.recordWrite(v("scores", 4, { code: "second" }));
    expect(s.get("scores", 4)!.code).toBe("second");
    expect(s.versionsOf("scores")).toEqual([4]); // not duplicated
    expect(s.get("scores", 4)!.provisional).toBe(true);
  });

  test("closeTurn seals every version of that turn", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("a", 2));
    s.recordWrite(v("b", 2));
    s.recordWrite(v("c", 3));
    s.closeTurn(2);
    expect(s.get("a", 2)!.provisional).toBe(false);
    expect(s.get("b", 2)!.provisional).toBe(false);
    expect(s.get("c", 3)!.provisional).toBe(true); // untouched
    expect(s.isTurnClosed(2)).toBe(true);
  });

  test("writing into a CLOSED turn throws — history is not rewritable", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1, { code: "original" }));
    s.closeTurn(1);
    expect(() => s.recordWrite(v("scores", 1, { code: "tampered" }))).toThrow(/immutable/);
    expect(s.get("scores", 1)!.code).toBe("original");
  });

  test("closeTurn is idempotent", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("a", 1));
    s.closeTurn(1);
    s.closeTurn(1);
    expect(s.get("a", 1)!.provisional).toBe(false);
  });
});

describe("recorded lineage (inputRefs)", () => {
  test("a version remembers the composite keys it consumed", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    s.closeTurn(1);
    s.recordWrite(
      v("pct", 2, {
        operatorType: "DataProcessing",
        inputRefs: [{ operatorId: "scores", turn: 1 }],
      })
    );
    expect(s.get("pct", 2)!.inputRefs).toEqual([{ operatorId: "scores", turn: 1 }]);
  });

  test("lineage is walkable across generations — the checkout chain", () => {
    // scores@1 -> pct@2 -> ranked@3 : rebuilding ranked@3 must be able to
    // find pct@2, and from there scores@1, by lookup alone.
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    s.closeTurn(1);
    s.recordWrite(v("pct", 2, { inputRefs: [{ operatorId: "scores", turn: 1 }] }));
    s.closeTurn(2);
    s.recordWrite(v("ranked", 3, { inputRefs: [{ operatorId: "pct", turn: 2 }] }));
    s.closeTurn(3);

    const chain: string[] = [];
    let refs = s.get("ranked", 3)!.inputRefs;
    while (refs.length > 0) {
      const r = refs[0];
      chain.push(`${r.operatorId}@${r.turn}`);
      refs = s.get(r.operatorId, r.turn)!.inputRefs;
    }
    expect(chain).toEqual(["pct@2", "scores@1"]);
  });
});

describe("resolving which version a reference names", () => {
  test("latestClosedTurnAtOrBefore ignores later versions and open turns", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    s.closeTurn(1);
    s.recordWrite(v("scores", 5));
    s.closeTurn(5);
    s.recordWrite(v("scores", 9)); // still open
    expect(s.latestClosedTurnAtOrBefore("scores", 7)).toBe(5);
    expect(s.latestClosedTurnAtOrBefore("scores", 3)).toBe(1);
    expect(s.latestClosedTurnAtOrBefore("scores", 9)).toBe(5); // 9 is provisional
    expect(s.latestClosedTurnAtOrBefore("scores", 0)).toBeUndefined();
  });

  test("latestTurnOf includes the open turn — that is 'what X is right now'", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    s.closeTurn(1);
    s.recordWrite(v("scores", 4));
    expect(s.latestTurnOf("scores")).toBe(4);
  });

  test("result step pointers attach to the right version", () => {
    const s = new OperatorVersionStore();
    s.recordWrite(v("scores", 1));
    s.recordWrite(v("scores", 2));
    s.setResultStep("scores", 1, "step-a");
    expect(s.get("scores", 1)!.resultStepId).toBe("step-a");
    expect(s.get("scores", 2)!.resultStepId).toBeUndefined();
  });
});
