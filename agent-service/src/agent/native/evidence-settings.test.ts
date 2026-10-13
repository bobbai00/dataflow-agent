/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { expect, test } from "bun:test";
import { AgentMode, ContextMode, DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import { mapLegacyToParams, SummarizeParamsPatchSchema } from "../context/summarize/params";
import { REGISTERED_OPERATOR_NAMES, registeredCatalogText } from "./registered";
import { profileDiff } from "./selection";
import { parseRolePolicyConfig } from "../context/selector/role-policy";
import { TexeraAgent } from "../texera-agent";
import { validateNativeSettings } from "./settings";

const native = { agentMode: AgentMode.NATIVE };
const removed = [
  "flowLevel",
  "dataLevel",
  "columnStats",
  "valueFormat",
  "dataHints",
  "coercionTelemetry",
  "rowLineage",
  "statScopes",
];

test("the prompt's operator index lists every built-in once, signature first", () => {
  const entries = registeredCatalogText().split("\n\n");
  expect(entries).toHaveLength(REGISTERED_OPERATOR_NAMES.length);
  for (const [i, name] of REGISTERED_OPERATOR_NAMES.entries()) expect(entries[i]).toStartWith(`${name}(`);
});

test("nested rendering overrides cannot restore old evidence channels", () => {
  expect(SummarizeParamsPatchSchema.safeParse({ flow: { graphAudit: true } }).success).toBe(false);
  expect(
    SummarizeParamsPatchSchema.safeParse({
      operators: { defaults: { result: { latest: { column: { stats: true } } } } },
    }).success
  ).toBe(false);
});

test("legacy result diffs do not reveal retired column statistics", () => {
  const before = { outputTuples: 5, columnStats: { x: "(numeric): null=0, min=1, max=5" } } as any;
  const after = { outputTuples: 5, columnStats: { x: "(numeric): null=2, min=3, max=5" } } as any;
  expect(profileDiff(before, after)).toBeUndefined();
});

test("role policies cannot restore removed statistics overlays", () => {
  for (const key of [
    "sourceStats",
    "sourceStatsDensity",
    "sourceStructuralHints",
    "interiorStats",
    "nonSourceStats",
    "hintsOnly",
  ]) {
    expect(() => parseRolePolicyConfig({ [key]: true })).toThrow();
  }
});

test("defaults expose two evidence controls and no legacy evidence settings", () => {
  for (const key of removed) expect(Object.hasOwn(DEFAULT_AGENT_SETTINGS, key)).toBe(false);
  // A sample with full-table statistics by default; flow evidence is opt-in.
  expect((DEFAULT_AGENT_SETTINGS as any).dataEvidence).toBe(true);
  expect(DEFAULT_AGENT_SETTINGS.retrievalViews).toEqual(["sample_stats", "full"]);
  expect(DEFAULT_AGENT_SETTINGS.nativeProfileScope).toBe("full");
  expect((DEFAULT_AGENT_SETTINGS as any).flowEvidence).toBe(false);
  expect(Object.hasOwn(DEFAULT_AGENT_SETTINGS, "dataflowReasoning")).toBe(false);
});

for (const key of removed) {
  test(`creation rejects removed ${key} rather than silently migrating it`, () => {
    expect(() => validateNativeSettings({ ...native, [key]: false })).toThrow(/removed/i);
  });
  test(`live update rejects removed ${key} atomically`, () => {
    const agent = new TexeraAgent({
      agentId: `settings-${key}`,
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    const before = structuredClone(agent.getSettings());
    expect(() => agent.updateSettings({ maxSteps: 7, [key]: true } as any)).toThrow(/removed/i);
    expect(agent.getSettings()).toEqual(before);
  });
}

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  for (const data of [false, true])
    for (const flow of [false, true]) {
      test(`${mode}: explicit data=${data}, flow=${flow} do not inherit legacy flags`, () => {
        const options = { dataEvidence: data, flowEvidence: flow, maxOperatorResultCharLimit: 800 };
        const expected = mapLegacyToParams(mode, options as any);
        expect(expected.nativeEvidence).toMatchObject({ data, flow, maxChars: 800, tableFormat: "markdown" });
        for (const level of [0, 1, 2, 3]) {
          expect(
            mapLegacyToParams(mode, {
              ...options,
              flowLevel: level,
              dataLevel: level,
              columnStats: true,
              loaderHint: true,
              lineageErrorContext: true,
              graphAudit: true,
              valueFormatFlags: true,
              tableStructureHint: true,
              coercionTelemetry: true,
            } as any)
          ).toEqual(expected);
        }
      });
    }
}

for (const key of ["dataEvidence", "flowEvidence"]) {
  test(`${key} is a boolean, never a truthy level or string`, () => {
    for (const value of [1, "true", null]) {
      expect(() => validateNativeSettings({ ...native, [key]: value })).toThrow(/boolean/);
    }
  });
}

test("settings of the removed protocols and multi-task state are refused with the reason", () => {
  for (const key of [
    "nativeTransport",
    "dataflowReasoning",
    "nativePromptDetail",
    "multiTask",
    "stateHistory",
    "specAudit",
  ])
    for (const value of [true, false, "text"])
      expect(() => validateNativeSettings({ ...native, [key]: value })).toThrow(
        `${key} was removed; native mode has one protocol, the dataflow(python, statements) tool, and multiRequest for a session with several requests`
      );
});

test("a catalog shows functions in full or by docstring, and keeps 0 to 50 recent requests", () => {
  const settings = (extra: Record<string, unknown>) => ({ ...native, ...extra }) as object;
  for (const value of ["full", "docstring"])
    expect(() => validateNativeSettings(settings({ catalogSource: value }))).not.toThrow();
  expect(() => validateNativeSettings(settings({ catalogSource: "none" }))).toThrow(
    'catalogSource must be "full", "docstring", "ledger" or "index"'
  );
  for (const value of [0, 5, 50])
    expect(() => validateNativeSettings(settings({ catalogRecent: value }))).not.toThrow();
  for (const value of [-1, 2.5, 51, "5"])
    expect(() => validateNativeSettings(settings({ catalogRecent: value }))).toThrow(
      "catalogRecent must be an integer between 0 and 50"
    );
});

test("answerStatement is a boolean", () => {
  const settings = (value: unknown) => ({ ...native, answerStatement: value }) as object;
  expect(() => validateNativeSettings(settings(true))).not.toThrow();
  expect(() => validateNativeSettings(settings("yes"))).toThrow("answerStatement must be a boolean");
});

test("multiRequest is off, transcript or catalog", () => {
  const key: string = "multiRequest";
  for (const value of ["off", "transcript", "catalog"])
    expect(() => validateNativeSettings({ ...native, [key]: value })).not.toThrow();
  for (const value of ["on", true, "dependencies"])
    expect(() => validateNativeSettings({ ...native, [key]: value })).toThrow(
      'multiRequest must be "off", "transcript" or "catalog"'
    );
  // Entries replace earlier requests in the delta context's native transcript only.
  expect(() => validateNativeSettings({ ...native, [key]: "catalog", contextMode: "delta" } as object)).not.toThrow();
  for (const other of [{ contextMode: "latest" }, { messageLayout: "opSplit" }])
    expect(() => validateNativeSettings({ ...native, [key]: "catalog", ...other } as object)).toThrow(
      'multiRequest "catalog" needs contextMode "delta" and messageLayout "native"'
    );
  expect(() =>
    validateNativeSettings({ ...native, [key]: "transcript", contextMode: "latest" } as object)
  ).not.toThrow();
});
