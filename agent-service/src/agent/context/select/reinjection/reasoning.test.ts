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
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { buildReasoning, renderReasoning } from "./reasoning";
import type { PathNode } from "../../../util/context-utils";

/** Build a PathNode for an agent step. `calls` is a list of
 *  [toolName, operatorId, output] tuples; `thought` is the step content. */
function agentNode(eventIndex: number, thought: string | undefined, calls: Array<[string, string, unknown]>): PathNode {
  return {
    step: {
      id: `s${eventIndex}`,
      stepId: 0,
      role: "agent",
      content: thought,
      toolCalls: calls.map(([toolName, operatorId]) => ({ toolName, input: { operatorId } })),
      toolResults: calls.map(([, , output]) => ({ output })),
    } as any,
    snapshot: undefined,
    eventIndex,
  };
}

function userNode(eventIndex: number, content: string): PathNode {
  return {
    step: { id: `u${eventIndex}`, stepId: 0, role: "user", content } as any,
    snapshot: undefined,
    eventIndex,
  };
}

describe("buildReasoning — event grouping & verbs", () => {
  test("groups multiple operator actions under one event/thought", () => {
    const path = [
      agentNode(1, "split into a loader fix + a dedup step", [
        ["createOrModifyOperator", "clean_loader", "ok"],
        ["createOrModifyOperator", "dedup", "[ERROR] KeyError 'id'"],
      ]),
    ];
    const r = buildReasoning(path);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].eventIndex).toBe(1);
    expect(r.events[0].thought).toBe("split into a loader fix + a dedup step");
    expect(r.events[0].actions).toEqual([
      { verb: "created", opId: "clean_loader", status: "ok" },
      { verb: "created", opId: "dedup", status: "ERROR KeyError 'id'" },
    ]);
  });

  test("create then modify of the same op is classified by running known-set", () => {
    const path = [
      agentNode(1, "make it", [["createOrModifyOperator", "a", "ok"]]),
      agentNode(2, "fix it", [["createOrModifyOperator", "a", "ok"]]),
    ];
    const r = buildReasoning(path);
    expect(r.events[0].actions[0].verb).toBe("created");
    expect(r.events[1].actions[0].verb).toBe("modified");
  });

  test("delete removes from known-set so a later create reads as created again", () => {
    const path = [
      agentNode(1, "", [["createOrModifyOperator", "a", "ok"]]),
      agentNode(2, "", [["deleteOperator", "a", "ok"]]),
      agentNode(3, "", [["createOrModifyOperator", "a", "ok"]]),
    ];
    const r = buildReasoning(path);
    expect(r.events.map(e => e.actions[0].verb)).toEqual(["created", "deleted", "created"]);
  });
});

describe("buildReasoning — opToEvent (latest-edit grain)", () => {
  test("op maps to its LAST editing event", () => {
    const path = [
      agentNode(6, "create both", [
        ["createOrModifyOperator", "clean_loader", "ok"],
        ["createOrModifyOperator", "dedup", "ok"],
      ]),
      agentNode(7, "fix dedup", [["createOrModifyOperator", "dedup", "ok"]]),
    ];
    const { opToEvent } = buildReasoning(path);
    expect(opToEvent.get("clean_loader")).toBe(6); // only touched at 6
    expect(opToEvent.get("dedup")).toBe(7); // created@6, last edited@7
  });

  test("two ops sharing a latest-edit event both point at it (dedup of the thought)", () => {
    const path = [
      agentNode(4, "build the pair", [
        ["createOrModifyOperator", "a", "ok"],
        ["createOrModifyOperator", "b", "ok"],
      ]),
    ];
    const r = buildReasoning(path);
    expect(r.opToEvent.get("a")).toBe(4);
    expect(r.opToEvent.get("b")).toBe(4);
    // The thought appears exactly once (one event), even though two ops point at it.
    expect(r.events).toHaveLength(1);
    expect(renderReasoning(r, 10)!.match(/build the pair/g)).toHaveLength(1);
  });

  test("deleted op is dropped from opToEvent (no DAG block to point at)", () => {
    const path = [
      agentNode(1, "", [["createOrModifyOperator", "a", "ok"]]),
      agentNode(2, "", [["deleteOperator", "a", "ok"]]),
    ];
    expect(buildReasoning(path).opToEvent.has("a")).toBe(false);
  });
});

describe("buildReasoning — thought / action inclusion", () => {
  test("a thought-only agent step (no tool calls) is still an event", () => {
    const path = [
      {
        step: { id: "s1", stepId: 0, role: "agent", content: "just thinking" } as any,
        snapshot: undefined,
        eventIndex: 1,
      },
    ];
    const r = buildReasoning(path);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].thought).toBe("just thinking");
    expect(r.events[0].actions).toEqual([]);
  });

  test("an action with an empty thought still renders (actions listed)", () => {
    const path = [agentNode(1, "", [["createOrModifyOperator", "a", "ok"]])];
    const block = renderReasoning(buildReasoning(path), 10)!;
    expect(block).toContain("Step 1:");
    expect(block).toContain("  created `a` → ok");
  });

  test("user steps are ignored", () => {
    const path = [userNode(1, "do the task"), agentNode(2, "ok", [["createOrModifyOperator", "a", "ok"]])];
    const r = buildReasoning(path);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].eventIndex).toBe(2);
  });

  test("long thoughts are collapsed to a single bounded line", () => {
    const long = "line one\n" + "x".repeat(400);
    const r = buildReasoning([agentNode(1, long, [["createOrModifyOperator", "a", "ok"]])]);
    expect(r.events[0].thought).not.toContain("\n");
    expect(r.events[0].thought.length).toBeLessThanOrEqual(200);
    expect(r.events[0].thought.endsWith("…")).toBe(true);
  });
});

describe("renderReasoning — slicing & headers", () => {
  test("undefined when there are no events", () => {
    expect(renderReasoning({ events: [], opToEvent: new Map() }, 10)).toBeUndefined();
    expect(renderReasoning(buildReasoning([userNode(1, "hi")]), 10)).toBeUndefined();
  });

  test("caps at k and notes the omitted count, preserving real event indices", () => {
    const path = Array.from({ length: 20 }, (_, i) =>
      agentNode(i + 1, `t${i + 1}`, [["createOrModifyOperator", `op${i}`, "ok"]])
    );
    const block = renderReasoning(buildReasoning(path), 5)!;
    expect(block).toContain("(… 15 earlier steps …)");
    expect(block).toContain('Step 20: "t20"');
    expect(block).toContain("  created `op19` → ok");
    // earlier-than-window events are dropped
    expect(block).not.toContain('Step 1: "t1"');
  });

  test("ERROR status is parsed and truncated from the tool result", () => {
    const block = renderReasoning(
      buildReasoning([agentNode(1, "t", [["createOrModifyOperator", "a", "[ERROR] boom happened\nstack trace..."]])]),
      10
    )!;
    expect(block).toContain("  created `a` → ERROR boom happened");
    expect(block).not.toContain("stack trace");
  });
});
