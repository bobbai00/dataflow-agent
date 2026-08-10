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
 * SELF-REFERENCE AND CYCLES AT THE WRITE BOUNDARY.
 *
 * `def process(X)` while writing `X` is the exact call that killed the NFL
 * session: the graph holds one node per id, so the wiring is `X -> X`, the
 * workflow turns cyclic, and the execution service then refuses every plan
 * with `400 Unable to process JSON` — silently, for 15 turns.
 *
 * The contract under test is the ERROR, not merely the refusal: a rejection
 * that does not say what to do instead produces verbatim retry loops. Each
 * message must name both ways forward (fold the work in, or use a new id).
 */

import { describe, expect, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { createCreateOrModifyOperatorTool } from "./code-op-tools";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";

function op(id: string, inputs: number): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: inputs === 0 ? "DataLoading" : "DataProcessing",
    operatorProperties: { code: `def ${inputs === 0 ? "load()" : "process(x)"}: ...` },
    inputPorts: Array.from({ length: Math.max(inputs, 1) }, (_, i) => ({ portID: `input-${i}` })),
    outputPorts: [{ portID: "output-0" }],
  } as any;
}
function link(s: string, t: string): OperatorLink {
  return {
    linkID: `${s}-->${t}`,
    source: { operatorID: s, portID: "output-0" },
    target: { operatorID: t, portID: "input-0" },
  } as any;
}

function toolOver(ids: [string, number][], links: OperatorLink[] = []) {
  const ws = new WorkflowState();
  ws.setWorkflowContent({
    operators: ids.map(([id, n]) => op(id, n)),
    operatorPositions: {},
    links,
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  return { ws, tool: createCreateOrModifyOperatorTool(ws, new Map(), undefined) };
}
const run = (t: unknown, args: Record<string, unknown>): Promise<string> => (t as any).execute({ summary: "s", ...args });

describe("an operator may not consume its own output", () => {
  test("the NFL call is rejected, and the error names BOTH ways forward", async () => {
    const { tool } = toolOver([
      ["raw", 0],
      ["current_player_scored", 1],
      ["other", 1],
    ]);
    const out = await run(tool, {
      operatorId: "current_player_scored",
      code: "def process(current_player_scored, other) -> pd.DataFrame:\n    return current_player_scored",
    });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("cannot take itself as an input");
    expect(out).toContain("cyclic");
    // both remedies, so the model has somewhere to go
    expect(out).toContain("drop `current_player_scored` from its parameters");
    expect(out).toContain("DIFFERENT operator id");
  });

  test("nothing is mutated by the rejected call", async () => {
    const { ws, tool } = toolOver([
      ["raw", 0],
      ["x", 1],
    ]);
    const linksBefore = ws.getAllLinks().length;
    const codeBefore = ws.getOperator("x")!.operatorProperties.code;
    await run(tool, { operatorId: "x", code: "def process(x) -> pd.DataFrame:\n    return x" });
    expect(ws.getAllLinks().length).toBe(linksBefore);
    expect(ws.getOperator("x")!.operatorProperties.code).toBe(codeBefore);
    // and no self-link snuck in
    expect(ws.getAllLinks().some(l => l.source.operatorID === l.target.operatorID)).toBe(false);
  });

  test("a DOWNSTREAM operator as input is rejected too — the longer cycle", async () => {
    // raw -> a -> b ; feeding b back into a closes a -> b -> a
    const { tool } = toolOver(
      [
        ["raw", 0],
        ["a", 1],
        ["b", 1],
      ],
      [link("raw", "a"), link("a", "b")]
    );
    const out = await run(tool, { operatorId: "a", code: "def process(b) -> pd.DataFrame:\n    return b" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("is downstream of");
    expect(out).toContain("separate operator");
  });

  test("legitimate wiring still works — the guard is not over-broad", async () => {
    // a brand-new operator consuming two existing ones is the normal case
    const { tool } = toolOver(
      [
        ["raw", 0],
        ["a", 1],
        ["b", 1],
      ],
      [link("raw", "a"), link("raw", "b")]
    );
    const out = await run(tool, { operatorId: "c", code: "def process(a, b) -> pd.DataFrame:\n    return a" });
    expect(out).not.toContain("cannot take itself");
    expect(out).not.toContain("is downstream of");
  });

  test("an UPSTREAM operator as input is fine (that is just a normal edge)", async () => {
    const { tool } = toolOver(
      [
        ["raw", 0],
        ["a", 1],
        ["b", 1],
      ],
      [link("raw", "a"), link("a", "b")]
    );
    const out = await run(tool, { operatorId: "b", code: "def process(a) -> pd.DataFrame:\n    return a" });
    expect(out).not.toContain("[ERROR]");
  });
});
