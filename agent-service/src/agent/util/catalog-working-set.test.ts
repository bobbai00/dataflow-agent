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
 * The lean dataflow index has to answer two questions the flat alphabetical
 * roster could not:
 *
 *   1. WHICH FRAME IS LIVE. A base table and the narrowed frame derived from it
 *      render as coequal peers, so `water_narrowed` (2988 rows, made at turn 7)
 *      sat beside `water_model_panel` (3146 rows, turn 3) with nothing marking
 *      one as current — and all three catalog reps built turn 8's decile on the
 *      wider one. The `### Working set` block re-asserts the previous turn's
 *      frame above the roster.
 *
 *   2. WHAT THE TRAILING COLUMNS ARE. Derived flags are appended, so a
 *      head-only clip removes exactly the column a later turn must filter on
 *      (`reliable_pool`, hidden in all three pool-carrying operators at nfl
 *      t23). The renderer now drops from the middle instead.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext, renderColumnList } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../context/summarize/fixtures";

const WIDE_COLS = Array.from({ length: 80 }, (_, i) => `metric_col_number_${i.toString().padStart(2, "0")}`);
/** The flag a later turn must filter on — appended last, as derived flags are. */
const TRAILING_FLAG = "reliable_pool";

function render(scenario: Scenario): string {
  return (
    assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      turnHistoryIndex: true,
      userTaskPlacement: "bottom",
      catalogLatestDataflow: true,
      versionedCatalog: true,
    } as any)
      .map(m => m.content)
      .join("\n")
  );
}

/**
 * Turn 1 builds the wide base; turn 2 narrows it. Turn 3 is in progress, so
 * the working set must name turn 2's narrowed frame and the base it read.
 */
function narrowedFrame(): Scenario {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const wideRow: Record<string, unknown> = {};
  for (const c of WIDE_COLS) wideRow[c] = 1;
  wideRow[TRAILING_FLAG] = true;
  const narrowRow = { ...wideRow };

  const sc = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "Load and screen the panel." },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      content: "**Final Answer:** 3146 rows",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc_water_model_panel", input: { operatorId: "water_model_panel" } }],
      workflow: makeWorkflow([{ id: "water_model_panel", displayName: "Screened chemistry panel" }]),
      results: new Map([["water_model_panel", makeInfo(3146, { sampleRows: [wideRow] })]]),
    },
    { id: "u2", stepId: 2, role: "user", messageId: "m2", content: "Narrow it by blank count." },
    {
      id: "a2",
      stepId: 3,
      role: "agent",
      messageId: "m2",
      content: "**Final Answer:** 2988 rows",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc_water_narrowed", input: { operatorId: "water_narrowed" } }],
      workflow: makeWorkflow(
        [
          { id: "water_model_panel", displayName: "Screened chemistry panel" },
          { id: "water_narrowed", displayName: "Narrowed by blank count", numInputPorts: 1 },
        ],
        [["water_model_panel", "water_narrowed"]]
      ),
      results: new Map([
        ["water_model_panel", makeInfo(3146, { sampleRows: [wideRow] })],
        ["water_narrowed", makeInfo(2988, { sampleRows: [narrowRow] })],
      ]),
    },
    { id: "u3", stepId: 4, role: "user", messageId: "m3", content: "Now take the severity top decile." },
  ] as any);
  // Snapshots are what the renderer reads for live operators; attach them the
  // way the driver does — one per action-bearing step, results included.
  for (const step of sc.steps as any[]) {
    if (!step.workflow) continue;
    sc.storage.createSnapshot(step.id, step.workflow);
    for (const [opId, info] of (step.results ?? new Map()) as Map<string, any>) {
      sc.storage.setOperatorResult(step.id, opId, info);
    }
  }
  return sc;
}

describe("lean dataflow index", () => {
  test("names the previous turn's frame, with its row count, as the working set", () => {
    const out = render(narrowedFrame());
    expect(out).toContain("### Working set (as of turn 2)");
    const ws = out.slice(out.indexOf("### Working set"));
    expect(ws).toContain("`water_narrowed` (written turn 2)");
    expect(ws).toContain("2988 rows");
  });

  test("names what that turn read, so the base reads as the parent and not a peer", () => {
    const ws = render(narrowedFrame()).slice(0);
    expect(ws).toContain("`water_model_panel` (read by that turn)");
    // and it still appears in the roster below, as a live operator
    expect(ws).toContain("`water_model_panel` (since turn 1)");
  });

  test("the working set is asserted ABOVE the alphabetical roster", () => {
    const out = render(narrowedFrame());
    expect(out.indexOf("### Working set")).toBeLessThan(out.indexOf("`water_model_panel` (since turn 1)"));
  });

  test("working set columns are never abbreviated", () => {
    const ws = render(narrowedFrame());
    const block = ws.slice(ws.indexOf("### Working set"), ws.indexOf("(since turn 1)"));
    expect(block).toContain(TRAILING_FLAG);
    expect(block).not.toContain("more columns");
  });

  test("no working set before there is a previous turn", () => {
    const first = buildScenario([
      { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "First request." },
    ]);
    expect(render(first)).not.toContain("### Working set");
  });
});

describe("renderColumnList", () => {
  test("short lists render whole", () => {
    expect(renderColumnList(["a", "b", TRAILING_FLAG])).toBe(`a, b, ${TRAILING_FLAG}`);
  });

  test("an overflowing list keeps BOTH ends — the identifier and the derived flag", () => {
    const out = renderColumnList([...WIDE_COLS, TRAILING_FLAG], 300);
    expect(out).toContain(WIDE_COLS[0]);
    expect(out).toContain(TRAILING_FLAG);
    expect(out).toMatch(/… \d+ more columns …/);
  });

  test("it drops from the middle, not the tail", () => {
    // A head-only clip is what hid `reliable_pool` at nfl t23.
    const cols = [...WIDE_COLS, TRAILING_FLAG];
    expect(cols.join(", ").slice(0, 300)).not.toContain(TRAILING_FLAG);
    expect(renderColumnList(cols, 300)).toContain(TRAILING_FLAG);
  });

  test("nothing is elided when the budget just fits", () => {
    const cols = ["alpha", "beta", "gamma"];
    expect(renderColumnList(cols, cols.join(", ").length)).toBe("alpha, beta, gamma");
  });
});
