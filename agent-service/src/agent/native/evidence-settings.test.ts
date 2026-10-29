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
import { buildScenario, makeInfo, makeWorkflow, renderText } from "../context/summarize/fixtures";
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

/** A loaded table whose result carries column statistics, and a failed step reading it. */
function statsScenario() {
  const scenario = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "Total revenue per region?" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      toolCalls: [{ toolName: "noop", toolCallId: "t1", input: {} }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
  ]);
  scenario.storage.createSnapshot(
    "a1",
    makeWorkflow(
      [
        { id: "sales", type: "CSVFileScan", properties: { fileName: "sales.csv" } },
        { id: "by_region", type: "Aggregate", numInputPorts: 1 },
      ],
      [["sales", "by_region"]]
    )
  );
  scenario.storage.setOperatorResult(
    "a1",
    "sales",
    makeInfo(1000, { columnStats: { region: "(str): null=0, distinct=4", amount: "(numeric): null=12, mean=52.3" } })
  );
  scenario.storage.setOperatorResult("a1", "by_region", makeInfo(0, { error: "KeyError: 'region'" }));
  return scenario;
}

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
      const expected = renderText(statsScenario(), options);
      for (const level of [0, 1, 2, 3]) {
        expect(
          renderText(statsScenario(), {
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
