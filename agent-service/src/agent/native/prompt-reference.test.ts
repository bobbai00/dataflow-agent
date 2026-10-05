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
import { buildNativeModeSystemPrompt, nativeReferenceText } from "../prompts";
import { NATIVE_OPERATORS, graphCatalogText } from "./catalog";
import { TexeraAgent } from "../texera-agent";
import { prepareDataflowActions } from "../tools/dataflow-actions";
import { ContextMode } from "../../types/agent";
import { validateNativeSettings } from "./settings";

test("on-demand prompt retains execution and state contracts with a smaller initial reference", () => {
  const options = { multiTask: true, stateHistory: true, retrievalViews: ["sample_stats", "full"] as const };
  const full = buildNativeModeSystemPrompt(ContextMode.DELTA, options as any);
  expect(buildNativeModeSystemPrompt(ContextMode.DELTA, { ...options, nativePromptDetail: "full" } as any)).toBe(full);
  const lean = buildNativeModeSystemPrompt(ContextMode.DELTA, { ...options, nativePromptDetail: "on_demand" } as any);
  expect(lean.length).toBeLessThan(full.length * 0.75);
  for (const contract of [
    "## Role and objective",
    "## Actions and their effects",
    "Each edit is atomic",
    "occupied",
    "### Understanding observations",
    "sample_stats",
    "from task",
    "operator_ids",
  ])
    expect(lean).toContain(contract);
  expect(lean).toMatch(/"target"\s*:\s*"reference"/);
  expect(lean).not.toContain("{{");
});

test("on-demand reference actions validate for single and multi-task sessions", () => {
  for (const stateHistory of [false, true]) {
    const r = prepareDataflowActions(
      {
        reasoning: "Read the needed contracts.",
        actions: [
          { type: "inspect", target: "reference", topic: "operators", operator_names: ["join", "process"] },
          { type: "inspect", target: "reference", topic: "example", example: "single" },
        ],
      },
      undefined,
      stateHistory
    );
    expect(r.status).toBe("pending");
  }
});

test("unknown reference operators reject the whole call before an edit", () => {
  const r = prepareDataflowActions({
    reasoning: "Read a contract.",
    actions: [
      { type: "edit", changes: 'create operator input: scan("data.csv")' },
      { type: "inspect", target: "reference", topic: "operators", operator_names: ["made_up_operator"] },
    ],
  });
  expect(r.status).toBe("error");
  expect(r.actions).toHaveLength(0);
});

test("prompt detail updates are validated atomically and rebuild the prompt", () => {
  const a = new TexeraAgent({
    agentId: "prompt-reference",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
  a.updateSettings({ multiTask: true });
  const before = a.getSystemInfo().systemPrompt;
  a.updateSettings({ nativePromptDetail: "on_demand" } as any);
  expect((a.getSettings() as any).nativePromptDetail).toBe("on_demand");
  expect(a.getSystemInfo().systemPrompt.length).toBeLessThan(before.length);
  const settings = structuredClone(a.getSettings());
  expect(() => a.updateSettings({ maxSteps: 7, nativePromptDetail: "unknown" } as any)).toThrow();
  expect(a.getSettings()).toEqual(settings);
  a.updateSettings({ nativePromptDetail: "full" } as any);
  expect(a.getSystemInfo().systemPrompt).toBe(before);
  for (const value of [null, true, "unknown"])
    expect(() => validateNativeSettings({ nativePromptDetail: value } as any)).toThrow();
});

test("reference lookup returns only selected contracts and uses the canonical catalog", () => {
  const text = nativeReferenceText({ topic: "operators", operator_names: ["join", "process"] }, {});
  expect(text).toBe(graphCatalogText(["join", "process"]));
  for (const name of ["join", "process"]) expect(text).toContain(NATIVE_OPERATORS.find(o => o.name === name)!.brief);
  expect(text).not.toContain("pivot(");
  expect(() => nativeReferenceText({ topic: "operators", operator_names: ["made_up"] }, {})).toThrow();
});

test("lean examples and retrieved examples use only offered views and features", () => {
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const options = { nativePromptDetail: "on_demand" as const, stateHistory: true, retrievalViews: [view] };
    for (const text of [
      buildNativeModeSystemPrompt(ContextMode.DELTA, options),
      nativeReferenceText({ topic: "example", example: "history" }, options),
    ]) {
      const shown = [...text.matchAll(/"view"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every(v => v === view)).toBe(true);
      expect(text).not.toContain("{{");
    }
  }
  expect(() => nativeReferenceText({ topic: "example", example: "history" }, {})).toThrow(/disabled/);
  expect(() => nativeReferenceText({ topic: "example", example: "statistics" }, { retrievalViews: ["full"] })).toThrow(
    /disabled/
  );
});
