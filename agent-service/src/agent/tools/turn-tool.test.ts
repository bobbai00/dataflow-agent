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
import {
  createDataflowTool,
  CUT_OFF_CALL,
  DATAFLOW_TOOL_DESCRIPTION,
  DATAFLOW_TOOL_SCHEMA,
  prepareDataflowCall,
} from "./turn-tool";

const views = ["sample_stats", "full"] as const;

test("the tool takes two strings and prepares the call's actions with its statements", async () => {
  const tool = createDataflowTool(views);
  expect(tool.description).toBe(DATAFLOW_TOOL_DESCRIPTION);
  expect(tool.strict).toBe(true);
  const schema = asSchema(tool.inputSchema).jsonSchema as any;
  expect(schema).toEqual(DATAFLOW_TOOL_SCHEMA);
  expect(Object.keys(schema.properties)).toEqual(["python", "statements"]);
  expect(schema.required).toEqual(["python", "statements"]);
  expect(JSON.stringify(schema)).not.toMatch(/summary|reasoning|answer/);
  const result = (await tool.execute!(
    {
      python: "",
      statements:
        "set records: scan(files='data/a.csv')\nset totals: aggregate(records, by=['g'], outputs={'n': count()})\nshow result totals full",
    },
    { toolCallId: "t1", messages: [] }
  )) as DataflowActionsResult;
  expect(result.status).toBe("pending");
  expect(result.protocol).toBe("registered-python-v1");
  expect(result.actions.map(item => item.action.type)).toEqual(["edit", "execute", "retrieve"]);
  expect(result.turn?.statements.map(s => s.text)).toEqual([
    "set records: scan(files='data/a.csv')",
    "set totals: aggregate(records, by=['g'], outputs={'n': count()})",
    "show result totals full",
  ]);
  expect(result.turn?.ignoredProse).toEqual([]);
});

test("with optional python only statements are required, and a call without python runs", async () => {
  const tool = createDataflowTool(views, false, true);
  const schema = asSchema(tool.inputSchema).jsonSchema as any;
  expect(tool.strict).toBe(true);
  expect(Object.keys(schema.properties)).toEqual(["python", "statements"]);
  expect(schema.required).toEqual(["statements"]);
  expect(schema.properties.python.description).toContain("leave the field out");
  // The default tool is unchanged.
  expect(asSchema(createDataflowTool(views).inputSchema).jsonSchema).toEqual(DATAFLOW_TOOL_SCHEMA);
  const result = (await tool.execute!({ statements: "execute a" } as any, {
    toolCallId: "t1",
    messages: [],
  })) as DataflowActionsResult;
  expect(result.status).toBe("pending");
  expect(result.actions.map(item => item.action.type)).toEqual(["execute"]);
});

test("a rejected call runs nothing and its receipt says why; arguments sent as text still parse", () => {
  const unavailable = prepareDataflowCall({ python: "", statements: "show result a sample" }, views);
  expect(unavailable.status).toBe("error");
  expect(unavailable.actions).toEqual([]);
  expect(renderDataflowActionsResult(unavailable)).toBe(
    '## call rejected\nline 1: the view "sample" is unavailable; use sample_stats or full.'
  );
  const answer = prepareDataflowCall({ python: "", statements: "answer: 42" }, views);
  expect(renderDataflowActionsResult(answer)).toContain("reply with the answer text and no tool call");
  const malformed = prepareDataflowCall({ python: 3, statements: "execute" }, views);
  expect(renderDataflowActionsResult(malformed)).toBe(
    "## call rejected\ndataflow takes an object with the strings python and statements."
  );
  for (const input of [null, "not json", ["execute"]]) expect(prepareDataflowCall(input, views).status).toBe("error");
  const text = prepareDataflowCall(JSON.stringify({ python: "", statements: "execute a" }), views);
  expect(text.status).toBe("pending");
  expect(text.actions.map(item => item.action.type)).toEqual(["execute"]);
  // A missing field reads as empty.
  expect(prepareDataflowCall({ statements: "execute a" }, views).status).toBe("pending");
  // Duplicate selections are refused before anything runs.
  const duplicate = prepareDataflowCall({ python: "", statements: "show builtin join, join" }, views);
  expect(duplicate.status).toBe("error");
  expect(duplicate.error).toMatch(/unique/);
  expect(duplicate.actions).toEqual([]);
});

test("a call with neither field was cut off at the output limit, and its receipt says so", () => {
  // A provider delivers a tool call cut at the output limit as an empty object.
  for (const input of [{}, "{}", { python: "" }]) {
    const cut = prepareDataflowCall(input, views);
    expect(cut.status).toBe("error");
    expect(cut.actions).toEqual([]);
    expect(renderDataflowActionsResult(cut)).toBe(`## call rejected\n${CUT_OFF_CALL}`);
  }
  expect(CUT_OFF_CALL).toContain("cut off at the output limit, which counts thinking");
  // Definitions alone, from a provider that skips the schema, still register.
  const definitions = prepareDataflowCall({ python: "def f(*, x=1):\n    return x\n" }, views);
  expect(renderDataflowActionsResult(definitions)).not.toContain(CUT_OFF_CALL);
});

test("the receipt of a call is rendered by statement, with a note for ignored prose", () => {
  const result = prepareDataflowCall({ python: "", statements: "Run it now.\nexecute a" }, views);
  result.actions[0].status = "ok";
  result.actions[0].output = {
    operator_blocks: [{ id: "a", kind: "scan", state: "executed", inputs: [], result: "3 rows × 2 columns" }],
  };
  result.status = "completed";
  expect(renderDataflowActionsResult(result)).toBe(
    "note: line 1 of statements is not a statement and was ignored.\n\n## execute a\nexecuted: a\n- a (scan): 3 rows × 2 columns"
  );
});
