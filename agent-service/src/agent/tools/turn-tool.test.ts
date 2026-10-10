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
import { asSchema } from "ai";
import { renderDataflowActionsResult, type DataflowActionsResult } from "./dataflow-actions";
import { createTurnTool, prepareTurnToolActions, TURN_TOOL_SCHEMA } from "./turn-tool";

const views = ["sample_stats", "full"] as const;

test("the tool exposes three string fields and prepares the turn's actions with a receipt descriptor", async () => {
  const tool = createTurnTool(views);
  const schema = asSchema(tool.inputSchema).jsonSchema as any;
  expect(schema).toEqual(TURN_TOOL_SCHEMA);
  expect(Object.keys(schema.properties)).toEqual(["summary", "python", "statements"]);
  const result = (await tool.execute!(
    {
      summary: "Totals per group.",
      python: "",
      statements:
        "set records: scan(files='data/a.csv')\nset totals: aggregate(records, by=['g'], outputs={'n': count()})\nshow result totals full",
    },
    { toolCallId: "t1", messages: [] }
  )) as DataflowActionsResult;
  expect(result.status).toBe("pending");
  expect(result.actions.map(item => item.action.type)).toEqual(["edit", "execute", "retrieve"]);
  expect(result.turn?.fields).toBe(true);
  expect(result.turn?.statements.map(s => s.text)).toEqual([
    "set records: scan(files='data/a.csv')",
    "set totals: aggregate(records, by=['g'], outputs={'n': count()})",
    "show result totals full",
  ]);
  expect(result.turn?.missingSummary).toBe(false);
});

test("a rejected call runs nothing and its receipt names the line; arguments sent as text still parse", () => {
  const unavailable = prepareTurnToolActions({ summary: "x", python: "", statements: "show result a sample" }, views);
  expect(unavailable.status).toBe("error");
  expect(unavailable.actions).toEqual([]);
  expect(renderDataflowActionsResult(unavailable)).toBe(
    '## turn rejected\nline 1: the view "sample" is unavailable; use sample_stats or full.'
  );
  const answer = prepareTurnToolActions({ summary: "x", python: "", statements: "answer: 42" }, views);
  expect(renderDataflowActionsResult(answer)).toContain("reply with the answer text and no tool call");
  const malformed = prepareTurnToolActions({ summary: "x", python: 3, statements: "execute" }, views);
  expect(renderDataflowActionsResult(malformed)).toContain(
    "takes an object with the strings summary, python and statements"
  );
  const text = prepareTurnToolActions(JSON.stringify({ summary: "x", python: "", statements: "execute a" }), views);
  expect(text.status).toBe("pending");
  expect(text.actions.map(item => item.action.type)).toEqual(["execute"]);
});

test("the receipt of a turn result is rendered by statement, with a note for an empty summary", () => {
  const result = prepareTurnToolActions({ summary: "", python: "", statements: "execute a" }, views);
  result.actions[0].status = "ok";
  result.actions[0].output = {
    operator_blocks: [{ id: "a", kind: "scan", state: "executed", inputs: [], result: "3 rows × 2 columns" }],
  };
  result.status = "completed";
  expect(renderDataflowActionsResult(result)).toBe(
    "note: the summary field was empty; state the population, definitions and formula the call assumes.\n\n## execute a\nexecuted: a\n- a (scan): 3 rows × 2 columns"
  );
});
