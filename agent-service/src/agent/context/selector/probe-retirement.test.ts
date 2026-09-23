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
import { buildDossier } from "../summarize/dossier";
import { mapLegacyToParams, resolveOperatorParams } from "../summarize/params";
import { summarize } from "../summarize/summarize";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../summarize/fixtures";
import { applyProbeRetirement, extractProbeValues, parseProbeRetirementConfig } from "./probe-retirement";

const CODE_PROBE = "def load():\n    return pd.DataFrame({'sheet_name': pd.ExcelFile('data.xlsx').sheet_names})";
const CODE_LOAD_ENCODED = "def load():\n    return pd.read_excel('data.xlsx', sheet_name=\"B-APM\", skiprows=2)";
const CODE_LOAD_UNRELATED = "def load():\n    return pd.read_excel('data.xlsx', skiprows=2)";
const CODE_CLEAN = "def process(load_bapm):\n    return load_bapm.dropna()";

const PROBE_ROWS = [{ sheet_name: "README" }, { sheet_name: "B-APM" }, { sheet_name: "metadata_sheet" }];

/**
 * Trajectory (event indices; ev 1 is the user step):
 *   ev 2 — create `sheet_probe` (orphan sheet lister) → healthy 3-row result
 *   ev 3 — create `load_bapm` (code encodes sheet_name="B-APM") → healthy
 *   ev 4 — create `clean` consuming load_bapm → healthy (probe now 2 events old)
 */
function retiredProbeScenario(loadCode = CODE_LOAD_ENCODED): Scenario {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "which sheet holds B-APM data?" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "list the sheets",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "t1",
          input: { operatorId: "sheet_probe", code: CODE_PROBE },
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
      content: "load the chosen sheet",
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "load_bapm", code: loadCode } },
      ],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "clean it",
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "clean", code: CODE_CLEAN } },
      ],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
  ]);

  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "sheet_probe", type: "DataLoading" }]));
  scenario.storage.setOperatorResult("a1", "sheet_probe", makeInfo(3, { sampleRows: PROBE_ROWS }));
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow([
      { id: "sheet_probe", type: "DataLoading" },
      { id: "load_bapm", type: "DataLoading" },
    ])
  );
  scenario.storage.setOperatorResult("a2", "load_bapm", makeInfo(200));
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "sheet_probe", type: "DataLoading" },
        { id: "load_bapm", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["load_bapm", "clean"]]
    )
  );
  scenario.storage.setOperatorResult("a3", "clean", makeInfo(180));
  return scenario;
}

function richLatestParams() {
  return mapLegacyToParams(ContextMode.LATEST, {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    schemaInResult: true,
  });
}

describe("probe retirement", () => {
  test("retires a settled orphan probe whose discovery is encoded downstream", () => {
    const scenario = retiredProbeScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const params = applyProbeRetirement(richLatestParams(), dossier, parseProbeRetirementConfig({}));

    const probe = resolveOperatorParams(params, "sheet_probe");
    expect(probe.result.latest.retirementFact).toBeDefined();
    expect(probe.result.latest.retirementFact).toContain('"B-APM"');
    expect(probe.result.latest.retirementFact).toContain("`load_bapm`");

    // Connected operators are untouched.
    expect(resolveOperatorParams(params, "load_bapm").result.latest.retirementFact).toBeUndefined();
    expect(resolveOperatorParams(params, "clean").result.latest.retirementFact).toBeUndefined();
  });

  test("keeps the probe while its discovery is NOT encoded downstream (open source-selection)", () => {
    // biomedical-hard-5-style negative control: the downstream loader does not
    // name any probe value — the sheet choice is still open.
    const scenario = retiredProbeScenario(CODE_LOAD_UNRELATED);
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const params = applyProbeRetirement(richLatestParams(), dossier, parseProbeRetirementConfig({}));
    expect(params).toEqual(richLatestParams());
  });

  test("grace: a freshly created probe never retires", () => {
    const scenario = retiredProbeScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const params = applyProbeRetirement(
      richLatestParams(),
      dossier,
      parseProbeRetirementConfig({ minStepsSinceEdit: 5 })
    );
    expect(params).toEqual(richLatestParams());
  });

  test("does not apply to the DELTA (interleaved) preset", () => {
    const scenario = retiredProbeScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const delta = mapLegacyToParams(ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      schemaInResult: true,
    });
    expect(applyProbeRetirement(delta, dossier, parseProbeRetirementConfig({}))).toEqual(delta);
  });

  test("extractProbeValues keeps worded strings and drops numeric-ish cells", () => {
    const info = makeInfo(4, {
      sampleRows: [
        { name: "B-APM", count: 12, ratio: "0.52", date: "2023-01-04", note: "ok" },
        { name: "beaches_2015.csv", count: 9, ratio: "1.00", date: "2023-01-05", note: "meh" },
      ],
    });
    const values = extractProbeValues(info, 4);
    expect(values).toContain("B-APM");
    expect(values).toContain("beaches_2015.csv");
    expect(values).not.toContain("0.52");
    expect(values).not.toContain("2023-01-04");
    expect(values).not.toContain("ok");
  });

  test("rendered LATEST context replaces the probe table with the fact", () => {
    const scenario = retiredProbeScenario();
    const dossier = buildDossier(scenario.steps, scenario.storage);
    const base = richLatestParams();

    const off = summarize(
      { visibleSteps: scenario.steps, workflowState: scenario.workflowState, snapshotStorage: scenario.storage },
      base
    ).text;
    expect(off).toContain("README");
    expect(off).not.toContain("(probe retired");

    const on = summarize(
      { visibleSteps: scenario.steps, workflowState: scenario.workflowState, snapshotStorage: scenario.storage },
      applyProbeRetirement(base, dossier, parseProbeRetirementConfig({}))
    ).text;
    expect(on).toContain("(probe retired");
    expect(on).toContain('"B-APM"');
    expect(on).not.toContain("README"); // the probe's table body is gone
    expect(on).toContain("Schema (1 cols): sheet_name"); // schema line survives retirement
  });
});
