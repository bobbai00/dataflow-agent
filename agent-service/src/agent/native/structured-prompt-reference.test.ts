/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildNativeModeSystemPrompt, nativeReferenceText, type NativePromptLayoutOptions } from "../prompts";
import { ContextMode } from "../../types/agent";
import { NATIVE_OPERATORS } from "./catalog";
import { structuredSetSchemas } from "./structured-operators";
import { prepareStructuredDataflowActions } from "../tools/structured-dataflow-actions";

const jsonBlocks = (text: string): any[] =>
  [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));

test("JSON operator reference returns only selected actual closed typed schemas", () => {
  const text = nativeReferenceText(
    { topic: "operators", operator_names: ["cast", "process"] },
    { nativeFormat: "json" }
  );
  const schemas = jsonBlocks(text);
  expect(schemas).toEqual(
    structuredSetSchemas().filter(schema => ["cast", "process"].includes(schema.properties.operator.const))
  );
  expect(text).toContain("timezone-naive");
  expect(text).not.toContain("amount=float64");
  expect(text).not.toContain("Import packages inside the function");
  expect(() =>
    nativeReferenceText({ topic: "operators", operator_names: ["made_up"] }, { nativeFormat: "json" })
  ).toThrow();
});

test("JSON prompt states local typed validation without a sampling guarantee", () => {
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { nativeFormat: "json" });
  expect(prompt).toContain("closed typed action schema");
  expect(prompt).toContain("validated locally before actions run");
  expect(prompt).not.toMatch(/strict (?:provider|decoding)|guaranteed schema/i);
  expect(prompt).toContain("ordinary Python");
  expect(prompt).toContain("Calls and actions run in their returned order");
});

test("JSON briefs describe structural fields rather than assignment expressions", () => {
  const text = nativeReferenceText(
    { topic: "operators", operator_names: NATIVE_OPERATORS.map(op => op.name) },
    { nativeFormat: "json" }
  );
  expect(jsonBlocks(text)).toHaveLength(15);
  for (const oldSyntax of [
    "{old: new}",
    "count()",
    'prev=lag("value")',
    'by=[("amount", "desc")',
    "Naive datetimes need a timezone",
  ])
    expect(text).not.toContain(oldSyntax);
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, {
    nativeFormat: "json",
    nativePromptDetail: "on_demand",
  });
  expect(prompt).toContain("topic=operators");
  expect(prompt).not.toContain("{old: new}");
});

test("JSON examples prepare against every available session view", () => {
  for (const view of ["full", "sample", "sample_stats"] as const) {
    for (const example of ["single", "statistics", "history"] as const) {
      const options: NativePromptLayoutOptions = {
        nativeFormat: "json",
        stateHistory: true,
        flowEvidence: true,
        retrievalViews: [view],
      };
      const text = nativeReferenceText({ topic: "example", example }, options);
      const calls = jsonBlocks(text);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const prepared = prepareStructuredDataflowActions(call, {
          views: [view],
          stateHistory: true,
          references: true,
        });
        expect(prepared.error).toBeUndefined();
        expect(prepared.status).toBe("pending");
        for (const action of call.actions)
          if (action.view !== undefined && action.view !== null) expect(action.view).toBe(view);
      }
      const actions = calls.flatMap(call => call.actions);
      expect(actions.some(action => action.type === "set")).toBe(true);
      expect(actions.some(action => action.type === "read")).toBe(true);
      expect(actions.at(-1)).toHaveProperty("source");
      expect(actions.every(action => !["edit", "execute", "retrieve"].includes(action.type))).toBe(true);
    }
  }
  expect(() => nativeReferenceText({ topic: "example", example: "history" }, { nativeFormat: "json" })).toThrow(
    /disabled/
  );
  expect(() =>
    nativeReferenceText({ topic: "example", example: "statistics" }, { nativeFormat: "json", retrievalViews: ["full"] })
  ).toThrow(/disabled/);
});

test("expression reference output remains byte-identical", () => {
  const fixtures: Array<[Parameters<typeof nativeReferenceText>[0], NativePromptLayoutOptions, string]> = [
    [
      { topic: "operators", operator_names: ["join", "process"] },
      {},
      "7b923c34d745fbe6189860dc0cf3b873f01e54c64bb47ea956d285cbc20d887c",
    ],
    [
      { topic: "example", example: "single" },
      { retrievalViews: ["full"] },
      "087ee84a76b1930e6407c615eb1e6ce4fcf2eec41023810f5f85ddf488f62d2d",
    ],
    [
      { topic: "example", example: "history" },
      { stateHistory: true, retrievalViews: ["sample"] },
      "8822d337fd44fe4e62cb1785b88f3e93718f51426ded7734657f778f63031947",
    ],
  ];
  for (const [request, options, expected] of fixtures)
    expect(createHash("sha256").update(nativeReferenceText(request, options)).digest("hex")).toBe(expected);
});
