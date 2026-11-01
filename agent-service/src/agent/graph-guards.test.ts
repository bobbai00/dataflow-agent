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
 * GRAPH SHAPE GUARDS — a workflow the engine cannot execute must never be
 * built.
 *
 * The rule: no operator may consume its own output, directly or through a
 * chain. A single such edge makes the whole workflow cyclic, and the
 * execution service then rejects EVERY subsequent plan with
 * `400 Unable to process JSON` — not just the offending one.
 *
 * Measured cost of the missing guard (NFL, 42-turn session): one self-link at
 * turn 28 left 15 turns cyclic; every operator rendered `(not executed)`; the
 * model read that as "my code produced nothing" and rewrote it under new
 * names until the step budget died — 5 such turns at ~$0.90 each.
 *
 * A registered edit refuses a cycle through any chain (registered.ts and
 * graph-edits.ts reject the final graph); these tests cover the self-link guard
 * in WorkflowState.addLink itself.
 */

import { describe, expect, test } from "bun:test";
import { WorkflowState } from "./workflow-state";
import type { OperatorLink, OperatorPredicate } from "../types/workflow";

function op(id: string, inputs = 1): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: inputs === 0 ? "DataLoading" : "DataProcessing",
    operatorProperties: {},
    inputPorts: Array.from({ length: inputs }, (_, i) => ({ portID: `input-${i}` })),
    outputPorts: [{ portID: "output-0" }],
  } as any;
}

function link(s: string, t: string, port = "input-0"): OperatorLink {
  return {
    linkID: `${s}-->${t}`,
    source: { operatorID: s, portID: "output-0" },
    target: { operatorID: t, portID: port },
  } as any;
}

function stateWith(ids: string[], links: OperatorLink[] = []): WorkflowState {
  const ws = new WorkflowState();
  ws.setWorkflowContent({
    operators: ids.map(id => op(id, id === "src" ? 0 : 1)),
    operatorPositions: {},
    links,
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  return ws;
}

describe("addLink refuses self-links", () => {
  test("a self-link is rejected and the graph is left untouched", () => {
    const ws = stateWith(["src", "a"]);
    const before = ws.getAllLinks().length;
    expect(ws.addLink(link("a", "a"))).toBe(false);
    expect(ws.getAllLinks().length).toBe(before);
  });

  test("an ordinary link is still accepted", () => {
    const ws = stateWith(["src", "a"]);
    expect(ws.addLink(link("src", "a"))).toBe(true);
    expect(ws.getAllLinks().length).toBe(1);
  });
});
