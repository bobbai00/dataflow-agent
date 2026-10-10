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
import { asSchema } from "ai";
import { createRegisteredDataflowTool, prepareRegisteredDataflowActions } from "./dataflow-actions";

test("nonblank schema strings admit complete values under constrained-decoder full matching", async () => {
  const schema = await asSchema(createRegisteredDataflowTool(["full"]).inputSchema).jsonSchema;
  const strings: Array<{ path: string; pattern: string }> = [];
  function visit(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return;
    if ("pattern" in value && typeof value.pattern === "string") strings.push({ path, pattern: value.pattern });
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  }
  visit(schema, "schema");
  expect(strings.some(entry => entry.path.endsWith("properties.reasoning"))).toBe(true);
  expect(strings.some(entry => entry.path.endsWith("properties.content"))).toBe(true);
  expect(strings.some(entry => entry.path.endsWith("properties.operator_ids.items"))).toBe(true);
  for (const { path, pattern } of strings) {
    // JSON Schema normally searches. Some strict provider decoders instead
    // require the pattern to describe the whole string, so exercise both.
    const fullMatch = new RegExp(`^(?:${pattern})$`, "u");
    const schemaSearch = new RegExp(pattern, "u");
    for (const value of [
      "Check the current result.",
      "records",
      "southwest_cities",
      "_helper",
      "First line\nSecond line",
      "  result\n",
      "São Paulo",
    ]) {
      expect(fullMatch.test(value), `${path} should accept ${JSON.stringify(value)}`).toBe(true);
      expect(schemaSearch.test(value)).toBe(true);
    }
    for (const value of ["", " ", "\t\r\n", "\u00a0"]) {
      expect(fullMatch.test(value), `${path} should reject whitespace-only text`).toBe(false);
      expect(schemaSearch.test(value)).toBe(false);
    }
  }
});

test("runtime rejects whitespace-only text before running any registered actions", () => {
  const cases = [
    { reasoning: " \n", actions: [{ type: "inspect", target: "graph" }] },
    { reasoning: "Check.", actions: [{ type: "answer", content: " \n" }] },
    { reasoning: "Check.", actions: [{ type: "retrieve", operator_ids: [" \n"], view: "full" }] },
    {
      reasoning: "Check.",
      actions: [{ type: "inspect", target: "namespace", names: [" \n"], include_implementation: true }],
    },
  ];
  for (const input of cases) {
    const result = prepareRegisteredDataflowActions(input, ["full"]);
    expect(result.status).toBe("error");
    expect(result.actions).toEqual([]);
  }
  expect(
    prepareRegisteredDataflowActions(
      { reasoning: "Check results.\nThen answer.", actions: [{ type: "answer", content: "First line\nSecond line" }] },
      ["full"]
    ).status
  ).toBe("pending");
});
