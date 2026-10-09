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

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../../types/agent";
import { assembleContext } from "../../util/context-utils";
import { buildDossier } from "../summarize/dossier";
import { mapLegacyToParams, resolveOperatorParams } from "../summarize/params";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../summarize/fixtures";
import { applyRenderPrefs, buildRenderPrefRanges, latestRenderPrefs, renderPrefsAt } from "./render-prefs";

const WIDE_ROWS = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, region: `R${i}`, value: `v${i}` }));

/**
 * ev2: create `loader` with prefs (minimal + stats off) → 12-row result
 * ev3: modify `loader` WITHOUT prefs (reset to standard) → 12-row result
 * ev4: create `clean` (no prefs) consuming loader
 */
function prefsScenario(withPrefs = true): Scenario {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "study the file" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load it",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t1",
          input: withPrefs
            ? { operatorId: "loader", code: "def load(): ...", outputSummary: "minimal" }
            : { operatorId: "loader", code: "def load(): ..." },
        },
      ],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "tweak it",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t2",
          input: { operatorId: "loader", code: "def load(): ...v2" },
        },
      ],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "clean",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t3",
          input: { operatorId: "clean", code: "def process(loader): ..." },
        },
      ],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
  ]);
  const loaderOnly = makeWorkflow([{ id: "loader", type: "DataLoading" }]);
  scenario.storage.createSnapshot("a1", loaderOnly);
  scenario.storage.setOperatorResult(
    "a1",
    "loader",
    makeInfo(12, { sampleRows: WIDE_ROWS, columnStats: { region: "(str): null=0, distinct=12" } })
  );
  scenario.storage.createSnapshot("a2", loaderOnly);
  scenario.storage.setOperatorResult(
    "a2",
    "loader",
    makeInfo(12, { sampleRows: WIDE_ROWS, columnStats: { region: "(str): null=0, distinct=12" } })
  );
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "loader", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["loader", "clean"]]
    )
  );
  scenario.storage.setOperatorResult("a3", "clean", makeInfo(10));
  return scenario;
}

const DELTA_OPTS = {
  compilationResult: null,
  agentMode: AgentMode.CODE,
  schemaInResult: true,
  maxResultRows: 0,
} as const;

describe("render prefs — core semantics", () => {
  test("latest landed version wins; an edit without prefs resets to default", () => {
    const scenario = prefsScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    // v2 (ev3) landed without prefs → current prefs are empty.
    expect(latestRenderPrefs(dossier, "loader")).toEqual({ outputSummary: undefined });
    const ranges = buildRenderPrefRanges(dossier);
    // v1's prefs cover [2,3); v2 has none.
    expect(renderPrefsAt(ranges, "loader", 2)?.outputSummary).toBe("minimal");
    expect(renderPrefsAt(ranges, "loader", 3)).toBeUndefined();
  });

  test("applyRenderPrefs (LATEST): lowers rows/stats only for the current version's prefs", () => {
    // Rebuild a scenario where the CURRENT version carries the prefs (one edit only).
    const scenario = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "load",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "t1",
            input: { operatorId: "loader", code: "def load(): ...", outputSummary: "minimal" },
          },
        ],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "loader", type: "DataLoading" }]));
    scenario.storage.setOperatorResult("a1", "loader", makeInfo(12, { sampleRows: WIDE_ROWS }));
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const base = mapLegacyToParams(ContextMode.LATEST, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      schemaInResult: true,
    });
    const params = applyRenderPrefs(base, dossier);
    const op = resolveOperatorParams(params, "loader");
    expect(op.result.latest.tuple.sampleRows).toBe(3);
    expect(Object.hasOwn(op.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("never raises an existing tighter base cap", () => {
    const scenario = prefsScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const base = mapLegacyToParams(ContextMode.LATEST, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      maxResultRows: 2,
    });
    // Current version has no prefs anyway; nothing changes.
    expect(applyRenderPrefs(base, dossier)).toEqual(base);
  });
});

describe("render prefs — DELTA event scoping (critical path)", () => {
  test("a version's prefs govern its own events; later default events render standard; old events never change", () => {
    const scenario = prefsScenario();
    const on = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
        ...DELTA_OPTS,
        renderPrefsEnabled: true,
      })[0].content
    );
    // Event 2 (v1, prefs): minimal rows → row-gap marker for 12 rows @3, no stats block.
    const ev2 = on.slice(on.indexOf("## Agent Event 2"), on.indexOf("## Agent Event 3"));
    expect(ev2).toContain("Output Table: 12 rows");
    expect(ev2).not.toContain("Column Schema and stats");
    // minimal = first 2 + last 1 → rows 0,1 and 11 visible; row 5 hidden
    expect(ev2).toContain("v0");
    expect(ev2).toContain("v11");
    expect(ev2).not.toContain("v5");
    // Event 3 (v2, NO prefs — reset): standard render, stats back.
    const ev3 = on.slice(on.indexOf("## Agent Event 3"), on.indexOf("## Agent Event 4"));
    expect(ev3).not.toContain("Column Schema and stats");
    expect(ev3).toContain("v5");
  });

  test("flag on + prefs never used ⇒ byte-identical to flag off", () => {
    const scenario = prefsScenario(/*withPrefs=*/ false);
    const off = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
        ...DELTA_OPTS,
      })[0].content
    );
    const on = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
        ...DELTA_OPTS,
        renderPrefsEnabled: true,
      })[0].content
    );
    expect(on).toBe(off);
  });

  test("flag off ignores declared prefs entirely", () => {
    const scenario = prefsScenario();
    const off = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
        ...DELTA_OPTS,
      })[0].content
    );
    const ev2 = off.slice(off.indexOf("## Agent Event 2"), off.indexOf("## Agent Event 3"));
    expect(ev2).not.toContain("Column Schema and stats");
    expect(ev2).toContain("v5");
  });
});
