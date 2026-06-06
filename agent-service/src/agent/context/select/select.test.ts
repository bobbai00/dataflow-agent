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
import { HISTORY_MODES, historyModeDescriptor } from "./history-mode";
import { buildTimeline } from "./reinjection/timeline";
import type { PathNode } from "../../util/context-utils";

function node(role: "agent" | "user", toolCalls?: any[], toolResults?: any[]): PathNode {
  return {
    step: { id: "s", stepId: 0, role, toolCalls, toolResults } as any,
    snapshot: undefined,
    eventIndex: 0,
  };
}

describe("SELECT history-mode axis", () => {
  test("LATEST is the aggregated pole (axisRank 0)", () => {
    const d = historyModeDescriptor("latest")!;
    expect(d.representation).toBe("aggregated");
    expect(d.axisRank).toBe(0);
  });
  test("DELTA is the bounded trajectory (axisRank 1); full was removed", () => {
    expect(historyModeDescriptor("delta")!.representation).toBe("trajectory");
    expect(historyModeDescriptor("delta")!.axisRank).toBe(1);
    expect(historyModeDescriptor("full")).toBeUndefined();
  });
  test("case-insensitive lookup; unknown ⇒ undefined", () => {
    expect(historyModeDescriptor("LATEST")!.mode).toBe("latest");
    expect(historyModeDescriptor("nope")).toBeUndefined();
  });
  test("modes are ranked monotonically aggregated→trajectory", () => {
    const ranks = HISTORY_MODES.map(m => m.axisRank);
    expect(ranks).toEqual([0, 1]);
  });
});

describe("SELECT reinjection — timeline rung", () => {
  test("renders created/modified/deleted with ok/ERROR status", () => {
    const path = [
      node("agent",
        [{ toolName: "createOrModifyOperator", input: { operatorId: "a" } }],
        [{ output: "ok" }]),
      node("agent",
        [{ toolName: "createOrModifyOperator", input: { operatorId: "a" } }],
        [{ output: "[ERROR] boom" }]),
      node("agent",
        [{ toolName: "deleteOperator", input: { operatorId: "a" } }],
        [{ output: "ok" }]),
    ];
    const t = buildTimeline(path)!;
    expect(t).toContain("1. created `a` → ok");
    expect(t).toContain("2. modified `a` → ERROR boom");
    expect(t).toContain("3. deleted `a` → ok");
  });

  test("undefined when there are no operator actions", () => {
    expect(buildTimeline([node("user")])).toBeUndefined();
    expect(buildTimeline([])).toBeUndefined();
  });

  test("caps at maxEvents and notes omitted count", () => {
    const path = Array.from({ length: 20 }, (_, i) =>
      node("agent", [{ toolName: "createOrModifyOperator", input: { operatorId: `op${i}` } }], [{ output: "ok" }])
    );
    const t = buildTimeline(path, 14)!;
    expect(t).toContain("(… 6 earlier steps …)");
    // last shown event is numbered 20
    expect(t).toContain("20. created `op19` → ok");
  });
});
