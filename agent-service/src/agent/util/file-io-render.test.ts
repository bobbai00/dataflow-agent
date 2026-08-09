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
 * A7 `Files read:` must render in BOTH context modes.
 *
 * Regression guard for a bug that survived months undetected: `23a5325fc` moved
 * the fact out of the `Result:` body (correctly — it is a CONSUMED fact, and a
 * loader has no `Inputs:` line) but only added the new render to LATEST's
 * serializeOperatorFull. DELTA lost its render and got no replacement, while
 * formatOperatorResult went on computing the line and discarding it, so the code
 * read as if both callers were covered. Measured cost: 0/104 tasks on every
 * DELTA arm across gpt-5-mini, luna and terra — including `A7FileIOFact`, an
 * experiment named for this fact, which therefore measured nothing.
 *
 * Two independent failure modes are pinned here, because fixing either alone
 * leaves the fact invisible:
 *   1. the render site exists in DELTA (the missing half of the refactor);
 *   2. `fileIoFacts` defaults ON for legacy arms (only the gated summarize path
 *      ever set it, so every DELTA arm arrived with it undefined).
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../context/summarize/fixtures";

const FILE_IO_KEY = "__file_io__";
const FILE_IO_VALUE = "files read: 3 [ALABAMA.csv, ALASKA.csv, ARIZONA.csv]";

/** One turn, one multi-file DataLoading operator carrying the worker's fact. */
function multiFileLoadScenario(): Scenario {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "load every state file" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "glob the directory",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "states" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
  ]);
  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "states", type: "DataLoading" }]));
  scenario.storage.setOperatorResult(
    "a1",
    "states",
    makeInfo(150, { columnStats: { [FILE_IO_KEY]: FILE_IO_VALUE } } as never)
  );
  return scenario;
}

const OPTS = { compilationResult: null, agentMode: AgentMode.CODE, maxResultRows: 3 } as const;

function render(mode: ContextMode, extra: Record<string, unknown> = {}): string {
  const scenario = multiFileLoadScenario();
  return String(
    assembleContext(scenario.steps, scenario.workflowState, scenario.storage, mode, { ...OPTS, ...extra })[0].content
  );
}

describe("A7 `Files read:` renders in both context modes", () => {
  test("LATEST renders it (the half that always worked)", () => {
    expect(render(ContextMode.LATEST)).toContain("Files read: 3");
  });

  test("DELTA renders it — the regression this test exists for", () => {
    expect(render(ContextMode.DELTA)).toContain("Files read: 3");
  });

  test("DELTA places it PARALLEL to `result:`, not nested inside it", () => {
    const text = render(ContextMode.DELTA);
    const line = text.split("\n").find(l => l.includes("Files read:"));
    expect(line).toBeDefined();
    // Consumed facts sit at the observation's own indent; everything describing
    // the OUTPUT is indented one level deeper, under `result:`.
    expect(line!).toBe("  Files read: 3 [ALABAMA.csv, ALASKA.csv, ARIZONA.csv]");
    expect(text.indexOf("Files read:")).toBeLessThan(text.indexOf("result:"));
  });

  // The off switch is the summarize patch, NOT a bare `fileIoFacts` option:
  // assembleContext maps (mode, options) through mapLegacyToParams, which does
  // not carry this field, so a top-level `fileIoFacts: false` is silently
  // dropped and the params default (true) wins. This is the same patch shape
  // KramaBench arms use to turn the fact off (`_FILEIO_PATCH`).
  const OFF = {
    summarizePatch: { operators: { defaults: { result: { latest: { column: { fileIoFacts: false } } } } } },
  };

  test("the summarize patch suppresses it in both modes", () => {
    expect(render(ContextMode.DELTA, OFF)).not.toContain("Files read:");
    expect(render(ContextMode.LATEST, OFF)).not.toContain("Files read:");
  });

  test("a bare `fileIoFacts: false` option does NOT suppress it (legacy map drops it)", () => {
    expect(render(ContextMode.DELTA, { fileIoFacts: false })).toContain("Files read:");
  });

  test("a single-file load emits nothing — absence of the fact, not of the render", () => {
    const scenario = multiFileLoadScenario();
    scenario.storage.setOperatorResult("a1", "states", makeInfo(150));
    const text = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, { ...OPTS })[0]
        .content
    );
    expect(text).not.toContain("Files read:");
  });
});
