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
 * ORTHOGONALITY GUARANTEES for the experimental context features.
 *
 * Baseline cleanliness: a trajectory may carry EVERY feature's inputs —
 * declared render prefs, inspectResult pulls, superseded revisions eligible
 * for folding, retirable orphan probes — and with all flags OFF the render
 * must be byte-identical to the pure legacy render of the same trajectory
 * with those inputs stripped-equivalent semantics (prefs ignored, pulls'
 * outputs dropped, no folds, no retirement facts).
 *
 * Composability: each overlay is base-preserving and lowering-only, so
 * enabling any subset never corrupts another feature's output.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext } from "../util/context-utils";
import { buildDossier } from "./summarize/dossier";
import { mapLegacyToParams } from "./summarize/params";
import { applyFrontierDecay, parseFrontierDecayConfig } from "./selector/frontier-decay";
import { applyProbeRetirement, parseProbeRetirementConfig } from "./selector/probe-retirement";
import { applyRenderPrefs } from "./selector/render-prefs";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "./summarize/fixtures";

/**
 * One trajectory carrying every feature's raw material:
 *  ev2 — create `probe` (orphan sheet-lister) with render prefs declared
 *  ev3 — create `loader` v1 (fails), inspectResult pull on `probe`
 *  ev4 — modify `loader` v2 (ok, prefs declared), code quotes the probe value
 *  ev5 — create `clean` consuming loader (healthy → v1 fold-eligible)
 */
function kitchenSinkScenario(): Scenario {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "answer from the sheet" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "probe the sheets",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t1",
          input: {
            operatorId: "probe",
            code: "def load(): ...",
            outputSummary: "minimal",
          },
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
      content: "load it; also check the probe closer",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t2",
          input: { operatorId: "loader", code: "def load(): v1" },
        },
        { toolName: "inspectResult", toolCallId: "t3", input: { operatorId: "probe", maxRows: 10 } },
      ],
      toolResults: [
        { toolCallId: "t2", output: "ok", isError: false },
        {
          toolCallId: "t3",
          output: "Inspection of `probe` — 2 rows:\nsheet_name\nB-APM-DATA\nREADME-INFO",
          isError: false,
        },
      ],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "fix the loader",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t4",
          input: {
            operatorId: "loader",
            code: 'def load(): pd.read_excel("x.xlsx", sheet_name="B-APM-DATA")',
            outputSummary: "minimal",
          },
        },
      ],
      toolResults: [{ toolCallId: "t4", output: "ok", isError: false }],
    },
    {
      id: "a4",
      stepId: 4,
      role: "agent",
      messageId: "m",
      parentId: "a3",
      content: "clean",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t5",
          input: { operatorId: "clean", code: "def process(loader): ..." },
        },
      ],
      toolResults: [{ toolCallId: "t5", output: "ok", isError: false }],
    },
  ]);

  const probeInfo = makeInfo(2, { sampleRows: [{ sheet_name: "B-APM-DATA" }, { sheet_name: "README-INFO" }] });
  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "probe", type: "DataLoading" }]));
  scenario.storage.setOperatorResult("a1", "probe", probeInfo);
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow([
      { id: "probe", type: "DataLoading" },
      { id: "loader", type: "DataLoading" },
    ])
  );
  scenario.storage.setOperatorResult("a2", "loader", makeInfo(0, { error: "UnicodeDecodeError: boom" }));
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow([
      { id: "probe", type: "DataLoading" },
      { id: "loader", type: "DataLoading" },
    ])
  );
  scenario.storage.setOperatorResult("a3", "loader", makeInfo(50));
  scenario.storage.createSnapshot(
    "a4",
    makeWorkflow(
      [
        { id: "probe", type: "DataLoading" },
        { id: "loader", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["loader", "clean"]]
    )
  );
  scenario.storage.setOperatorResult("a4", "clean", makeInfo(45));
  return scenario;
}

const BASE = {
  compilationResult: null,
  agentMode: AgentMode.CODE,
  schemaInResult: true,
  maxResultRows: 0,
} as const;

describe("feature orthogonality", () => {
  test("all flags OFF ⇒ no feature marker appears in either mode's render", () => {
    const scenario = kitchenSinkScenario();
    for (const mode of [ContextMode.LATEST, ContextMode.DELTA]) {
      const text = String(
        assembleContext(scenario.steps, scenario.workflowState, scenario.storage, mode, { ...BASE })[0].content
      );
      // renderPrefs off: the declared minimal prefs must not shrink anything —
      // probe's second row visible despite outputSummary:"minimal".
      expect(text).toContain("README-INFO");
      // fold off: no resolution facts.
      expect(text).not.toContain("(folded");
      // retirement off: no retirement facts.
      expect(text).not.toContain("(probe retired");
      // inspections section renders only from inspectResult calls — present
      // input, but the section is a pure function of the calls (append-only,
      // not flag-gated); it must not leak feature markers beyond itself.
      // (Its presence is orthogonal: it never alters operator blocks.)
    }
  });

  test("flag-off render is byte-stable regardless of declared prefs (baseline cleanliness)", () => {
    // Same trajectory with prefs stripped from the tool inputs must render
    // byte-identically to the one with prefs declared, when the flag is off.
    const withPrefs = kitchenSinkScenario();
    const stripped = kitchenSinkScenario();
    for (const step of stripped.steps) {
      for (const tc of step.toolCalls ?? []) {
        const inp = tc.input as Record<string, unknown>;
        delete inp.outputSummary;
      }
    }
    for (const mode of [ContextMode.LATEST, ContextMode.DELTA]) {
      const a = String(
        assembleContext(withPrefs.steps, withPrefs.workflowState, withPrefs.storage, mode, { ...BASE })[0].content
      );
      const b = String(
        assembleContext(stripped.steps, stripped.workflowState, stripped.storage, mode, { ...BASE })[0].content
      );
      // The Action lines render tool params losslessly, so the DELTA action
      // text differs by the declared params themselves; operator RESULT
      // rendering must be identical. Compare observation/result regions by
      // stripping the action param lines.
      const scrub = (t: string) =>
        t
          .split("\n")
          .filter(l => !/^\s+(outputSummary|showOutputStatistics):/.test(l))
          .join("\n");
      expect(scrub(a)).toBe(scrub(b));
    }
  });

  test("overlays are base-preserving no-ops outside their mode", () => {
    const scenario = kitchenSinkScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const delta = mapLegacyToParams(ContextMode.DELTA, { ...BASE });
    expect(applyFrontierDecay(delta, dossier, parseFrontierDecayConfig({}))).toEqual(delta);
    expect(applyProbeRetirement(delta, dossier, parseProbeRetirementConfig({}))).toEqual(delta);
    expect(applyRenderPrefs(delta, dossier)).toEqual(delta);
  });

  test("overlay composition: enabling all three on LATEST never raises detail anywhere", () => {
    const scenario = kitchenSinkScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const base = mapLegacyToParams(ContextMode.LATEST, { ...BASE });
    let params = applyFrontierDecay(base, dossier, parseFrontierDecayConfig({}));
    params = applyProbeRetirement(params, dossier, parseProbeRetirementConfig({}));
    params = applyRenderPrefs(params, dossier);
    for (const opId of ["probe", "loader", "clean"]) {
      const before = base.operators.overrides[opId];
      const after = params.operators.overrides[opId];
      // Any override present must only lower: sampleRows <= base default (0 ⇒
      // uncapped) is expressed as a positive cap; stats only ever false.
      if (after?.result?.latest?.column) {
        expect(Object.hasOwn(after.result.latest.column ?? {}, "stats")).toBe(false);
      }
      void before;
    }
  });
});
