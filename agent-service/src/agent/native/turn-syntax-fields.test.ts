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
import { parseTurnFields } from "./turn-syntax";

const views = ["sample_stats", "full"] as const;
const parse = (fields: Record<string, unknown>) => parseTurnFields(fields, { views });

test("the three fields become the text transport's action list; line numbers count statements", () => {
  const parsed = parse({
    summary: "Marine only.",
    python: "def is_marine(row):\n    return row['type'] == 'Marine'",
    statements:
      "set marine: filter(water, predicate='is_marine')\n\nset rates: aggregate(marine, by=['band'], outputs={'n': count()})\nshow result rates full",
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.turn.fields).toBe(true);
  expect(parsed.turn.summary).toBe("Marine only.");
  expect(parsed.turn.missingSummary).toBe(false);
  expect(parsed.turn.definitions).toBe("def is_marine(row):\n    return row['type'] == 'Marine'");
  expect(parsed.turn.actions).toEqual([
    {
      type: "edit",
      python: "def is_marine(row):\n    return row['type'] == 'Marine'",
      changes:
        "set marine: filter(water, predicate='is_marine')\n\nset rates: aggregate(marine, by=['band'], outputs={'n': count()})",
    },
    { type: "execute", operator_ids: ["rates"] },
    { type: "retrieve", operator_ids: ["rates"], view: "full" },
  ]);
  expect(parsed.turn.statements.map(s => [s.line, s.kind])).toEqual([
    [1, "edit"],
    [3, "edit"],
    [4, "show"],
  ]);
});

test("a fenced python field, a summary line inside statements, and an empty python field are accepted", () => {
  const fenced = parse({
    summary: "",
    python: "```python\ndef f(t):\n    return t\n```",
    statements: "summary: Late summary.\nset b: f(a)\nshow result b",
  });
  expect(fenced.ok).toBe(true);
  if (fenced.ok) {
    expect(fenced.turn.definitions).toBe("def f(t):\n    return t");
    expect(fenced.turn.summary).toBe("Late summary.");
    expect(fenced.turn.missingSummary).toBe(false);
  }
  const bare = parse({ summary: "", python: "", statements: "set raw: scan(files='x.csv')" });
  expect(bare.ok).toBe(true);
  if (bare.ok) {
    expect(bare.turn.missingSummary).toBe(true);
    expect(bare.turn.actions.map(a => a.type)).toEqual(["edit"]);
  }
  const definitionsOnly = parse({ summary: "Register.", python: "def g(t):\n    return t", statements: "" });
  expect(definitionsOnly.ok).toBe(true);
  if (definitionsOnly.ok)
    expect(definitionsOnly.turn.actions).toEqual([{ type: "edit", python: "def g(t):\n    return t", changes: "" }]);
});

test("answers are replies, never statements: answer: and Final Answer: lines are rejected with the rule", () => {
  for (const statements of ["answer: 42", "set a: scan(files='x.csv')\nanswer: 42", "**Final Answer: 42**"]) {
    const parsed = parse({ summary: "Done.", python: "", statements });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("reply with the answer text and no tool call");
  }
});

test("empty fields and prose instead of statements are named", () => {
  const empty = parse({ summary: "Nothing.", python: "", statements: "" });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error).toContain("no statements");
  const missing = parse({});
  expect(missing.ok).toBe(false);
  const prose = parse({ summary: "x", python: "", statements: "set a: scan(files='x.csv')\nLet me look at it." });
  expect(prose.ok).toBe(true);
  if (prose.ok) expect(prose.turn.ignoredProse).toEqual([2]);
  const unknown = parse({ summary: "x", python: "", statements: "show table a" });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok)
    expect(unknown.error).toBe("line 1: show takes a resource: result, schema, operator, function, or builtin.");
});
