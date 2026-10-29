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
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import { buildRichScenario, renderText } from "../context/summarize/fixtures";
import { REGISTERED_OPERATOR_NAMES, registeredCatalogText } from "./registered";
import { validateNativeSettings } from "./settings";

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

test("defaults expose two evidence controls and no legacy evidence settings", () => {
  for (const key of removed) expect(Object.hasOwn(DEFAULT_AGENT_SETTINGS, key)).toBe(false);
  // A sample with full-table statistics by default; flow evidence is opt-in.
  expect((DEFAULT_AGENT_SETTINGS as any).dataEvidence).toBe(true);
  expect(DEFAULT_AGENT_SETTINGS.retrievalViews).toEqual(["sample_stats", "full"]);
  expect(DEFAULT_AGENT_SETTINGS.nativeProfileScope).toBe("full");
  expect((DEFAULT_AGENT_SETTINGS as any).flowEvidence).toBe(false);
  expect(Object.hasOwn(DEFAULT_AGENT_SETTINGS, "dataflowReasoning")).toBe(false);
});

for (const data of [false, true])
  for (const flow of [false, true]) {
    test(`explicit data=${data}, flow=${flow} do not inherit legacy flags`, () => {
      const options = { dataEvidence: data, flowEvidence: flow, maxOperatorResultCharLimit: 800 };
      const expected = renderText(buildRichScenario(), options);
      for (const level of [0, 1, 2, 3]) {
        expect(
          renderText(buildRichScenario(), {
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
        ).toBe(expected);
      }
    });
  }

for (const key of ["dataEvidence", "flowEvidence"]) {
  test(`${key} is a boolean, never a truthy level or string`, () => {
    for (const value of [1, "true", null]) {
      expect(() => validateNativeSettings({ [key]: value })).toThrow(/boolean/);
    }
  });
}

test("a catalog shows functions in full or by docstring, and keeps 0 to 50 recent requests", () => {
  for (const value of ["full", "docstring"])
    expect(() => validateNativeSettings({ catalogSource: value })).not.toThrow();
  expect(() => validateNativeSettings({ catalogSource: "none" })).toThrow(
    'catalogSource must be "full" or "docstring"'
  );
  for (const value of [0, 5, 50]) expect(() => validateNativeSettings({ catalogRecent: value })).not.toThrow();
  for (const value of [-1, 2.5, 51, "5"])
    expect(() => validateNativeSettings({ catalogRecent: value })).toThrow(
      "catalogRecent must be an integer between 0 and 50"
    );
});

test("multiRequest is off, transcript or catalog", () => {
  const key: string = "multiRequest";
  for (const value of ["off", "transcript", "catalog"])
    expect(() => validateNativeSettings({ [key]: value })).not.toThrow();
  for (const value of ["on", true, "dependencies"])
    expect(() => validateNativeSettings({ [key]: value })).toThrow(
      'multiRequest must be "off", "transcript" or "catalog"'
    );
});
