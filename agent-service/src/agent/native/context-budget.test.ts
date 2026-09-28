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
import type { ModelMessage } from "ai";
import { budgetedEntryTexts, estimateTokens, trimActiveMessages } from "./task-context";
import { renderIndexTaskEntry, renderStubTaskEntry, renderTaskEntry, type TaskEntry } from "./task-entries";

const wide = Array.from({ length: 300 }, (_, i) => `Q${i}`);

function entry(task: number): TaskEntry {
  return {
    task,
    request:
      task === 1
        ? "Throughout this analysis report decimals rounded to 3 places; percentages on a 0-100 scale.\nQuestion: Load the survey."
        : `Question: What is the share of group ${task}?`,
    changes: [
      {
        status: "added",
        id: `t${task}`,
        statement: `t${task} = filter(survey, lambda row: row["Q2"] == "g${task}", doc="Keeps group ${task}")`,
        doc: `Keeps group ${task}`,
        rows: 100 + task,
        columns: wide,
      },
    ],
    tables: [],
    answer: `{"share": 0.${task}}`,
    from: [`t${task}`],
  };
}

const entries = Array.from({ length: 12 }, (_, i) => entry(i + 1));
const full = entries.map(e => renderTaskEntry(e, true));

test("a generous allowance keeps every entry whole", () => {
  expect(budgetedEntryTexts(entries, full, 1_000_000)).toEqual(full);
});

const kinds = (texts: string[]) =>
  texts.map(t => (full.includes(t) ? "full" : t.includes("shortened") ? "index" : t.includes("archived") ? "archive" : "stub"));

test("every task stays visible first; the newest then get their whole entries", () => {
  const allowance = estimateTokens(full[11]) * 2 + 1500;
  const texts = budgetedEntryTexts(entries, full, allowance);
  expect(texts.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(allowance);
  expect(kinds(texts)).toEqual([...Array(9).fill("index"), "full", "full", "full"]);
  expect(texts[0]).toContain("rounded to 3 places"); // the first task keeps its rules
  // A shortened entry keeps the table's statement (its doc included), size and
  // answer, not its 300 column names; a doc cut off with a long statement is repeated.
  const index = renderIndexTaskEntry(entries[5]);
  expect(index).toContain('doc="Keeps group 6"); rows=106, cols=300');
  expect(index).not.toContain("Q299");
  const long = { ...entries[5], changes: [{ ...entries[5].changes[0], statement: `t6 = process(survey, fn=f, x="${"y".repeat(300)}", doc="Keeps group 6")` }] };
  expect(renderIndexTaskEntry(long)).toContain("; rows=106, cols=300; doc: Keeps group 6");
});

test("a tighter allowance shortens the newest and leaves the oldest one line each", () => {
  const stubs = entries.slice(1).reduce((sum, e) => sum + estimateTokens(renderStubTaskEntry(e)), 0);
  const widen = estimateTokens(renderIndexTaskEntry(entries[11])) - estimateTokens(renderStubTaskEntry(entries[11]));
  const allowance = estimateTokens(renderIndexTaskEntry(entries[0], true)) + stubs + widen * 4 + 5;
  const texts = budgetedEntryTexts(entries, full, allowance);
  expect(kinds(texts)).toEqual(["index", ...Array(7).fill("stub"), ...Array(4).fill("index")]);
  expect(texts[1]).toBe(renderStubTaskEntry(entries[1]));
});

test("a tiny allowance archives the oldest behind recall and keeps the first task's rules", () => {
  const texts = budgetedEntryTexts(entries, full, 150);
  expect(texts[0]).toContain("rounded to 3 places");
  expect(texts[1]).toMatch(/^## Tasks 2, 3, .*: archived for the context budget; recall a task number/);
});

test("within a task the oldest observations give way first; the last two and every call stay", () => {
  const call = (id: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "dataflow", input: {} }],
  });
  const result = (id: string): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "dataflow", output: { type: "text", value: "x".repeat(6000) } }],
  });
  const messages = [call("a"), result("a"), call("b"), result("b"), call("c"), result("c"), call("d"), result("d")];
  const trimmed = trimActiveMessages(messages, estimateTokens(messages) - 1000);
  const values = trimmed.filter(m => m.role === "tool").map(m => (m.content as any[])[0].output.value as string);
  expect(values[0]).toContain("observation omitted to fit the context budget");
  expect(values.slice(-2).every(v => v.length === 6000)).toBe(true);
  expect(trimmed.filter(m => m.role === "assistant")).toHaveLength(4);
  expect(trimActiveMessages(messages, 1_000_000)).toBe(messages);
});

test("the budget is hard: when the newest observations alone overflow, they are cut to head and tail", () => {
  const call = (id: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "dataflow", input: {} }],
  });
  const result = (id: string, size: number): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "dataflow", output: { type: "text", value: `${id}:${"x".repeat(size)}:end` } }],
  });
  const messages = [call("a"), result("a", 24000), call("b"), result("b", 22000)];
  const room = 4000;
  const trimmed = trimActiveMessages(messages, room);
  expect(estimateTokens(trimmed)).toBeLessThanOrEqual(room);
  const values = trimmed.filter(m => m.role === "tool").map(m => (m.content as any[])[0].output.value as string);
  expect(values.every(v => v.includes("characters omitted to fit the context budget"))).toBe(true);
  expect(values[1].startsWith("b:") && values[1].endsWith(":end")).toBe(true);
});
