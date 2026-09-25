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
import { analysisMemory } from "./analysis-memory";
import type { TaskEntry } from "./task-entries";

function entries(n: number): TaskEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    task: i + 1,
    request:
      i === 0
        ? "Keep units in fractions; stable population keys. " + "Rule. ".repeat(200) + "FINAL_UNIT_RULE"
        : `Request ${i + 1}: ${"Review the population and its current score. ".repeat(20)}`,
    answer: "Old answer",
    changes: [],
    tables: [],
    from: [],
  }));
}

test("bounded memory preserves complete selected requests, initial conventions and newest work", () => {
  const all = entries(60);
  const messages = analysisMemory(all, [], "Current population", 8000);
  const text = messages.map(m => String(m.content)).join("");
  expect(text.length).toBeLessThanOrEqual(8000);
  expect(text).toContain("FINAL_UNIT_RULE");
  expect(text).toContain("Request 60:");
  expect(text).toContain("recall");
  expect(text).not.toContain("Old answer");
  expect(all).toHaveLength(60);
});

test("large archived entries remain retrievable rather than silently clipped into a false complete record", () => {
  const all = entries(3);
  all[0].request = "BEGIN_LARGE_REQUEST" + "x".repeat(20000) + "IMPORTANT_END";
  const text = analysisMemory(all, [], "Current population", 5000)
    .map(m => String(m.content))
    .join("");
  expect(text.length).toBeLessThanOrEqual(5000);
  expect(text).toContain("Archived requests: 1");
  expect(text).not.toContain("BEGIN_LARGE_REQUEST");
  expect(all[0].request).toEndWith("IMPORTANT_END");
});

test("completed request frames have a stable chronological prefix as the session grows", () => {
  const all = entries(3);
  const a = analysisMemory(all.slice(0, 2), [], "new request", 24000);
  const b = analysisMemory(all, [], "new request", 24000);
  expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, -1));
});

test("current cards cannot exceed the budget even for a large graph", () => {
  const cards = Array.from({ length: 1000 }, (_, i) => `table_${i}: ${"columns and values ".repeat(30)}`);
  const text = analysisMemory(entries(20), cards, "table_999", 8000)
    .map(m => String(m.content))
    .join("");
  expect(text.length).toBeLessThanOrEqual(8000);
  expect(text).toContain("table_999");
  expect(text).toContain("omitted");
});

test("archive indexing also fits the budget beyond a benchmark-length session", () => {
  const text = analysisMemory(entries(2000), [], "Current population", 4000)
    .map(m => String(m.content))
    .join("");
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("recall");
  expect(text).toContain("2000");
});

test("selected exact definitions save an inspection without displacing required requests or breaking the budget", () => {
  const definition = "Shared function score:\ndef score(data):\n    return data.assign(score=data.value * 2)";
  const text = analysisMemory(entries(10), ["scored = process(data, fn=score)"], "score", 8000, [
    { text: definition, priority: 10 },
    { text: "OVERSIZED_DEF" + "x".repeat(10000), priority: 0 },
  ])
    .map(m => String(m.content))
    .join("");
  expect(text.length).toBeLessThanOrEqual(8000);
  expect(text).toContain(definition);
  expect(text).toContain("FINAL_UNIT_RULE");
  expect(text).toContain("Request 10:");
  expect(text).not.toContain("OVERSIZED_DEF");
});
