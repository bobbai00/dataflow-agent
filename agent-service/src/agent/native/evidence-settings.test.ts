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
import { nativeBatchCatalogText, nativeBatchSchema } from "../tools/native-batch-tools";
import { nativeOperators } from "./catalog";
import { profileDiff } from "./selection";
import { parseRolePolicyConfig } from "../context/selector/role-policy";
import { TexeraAgent } from "../texera-agent";
import { validateNativeCatalogSettings } from "./settings";

const native = { agentMode: AgentMode.NATIVE, nativeToolMode: "batch", nativeCatalogVersion: "v2" };
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

test("catalog lists all operations without duplicating their tool signatures", () => {
  const catalog = nativeBatchCatalogText("v2");
  expect(catalog.split("\n")).toHaveLength(nativeOperators("v2").length);
  expect(catalog).not.toContain(" — ");
  const variants = (nativeBatchSchema("v2") as any).properties.operators.items.anyOf;
  expect(variants.map((variant: any) => variant.description)).toEqual(nativeOperators("v2").map(op => op.signature));
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
  expect((DEFAULT_AGENT_SETTINGS as any).dataEvidence).toBe(false);
  expect((DEFAULT_AGENT_SETTINGS as any).flowEvidence).toBe(false);
});

for (const key of removed) {
  test(`creation rejects removed ${key} rather than silently migrating it`, () => {
    expect(() => validateNativeCatalogSettings({ ...native, [key]: false })).toThrow(/removed/i);
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
        expect(expected.nativeEvidence).toEqual({ data, flow, maxChars: 800 });
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
      expect(() => validateNativeCatalogSettings({ ...native, [key]: value })).toThrow(/boolean/);
    }
  });
}
