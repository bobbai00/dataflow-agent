/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { parseReActText } from "./react-text-parser";

describe("parseReActText", () => {
  test("terminal turn: thought only, no actions", () => {
    const out = parseReActText("Thought: The answer is 42.\n");
    expect(out.thought).toBe("The answer is 42.");
    expect(out.actions).toEqual([]);
  });

  test("single action with Python-dict payload", () => {
    const raw = `Thought: I will load the data.
Action: createOrModifyOperator
Action Input: {'operatorId': 'loadData', 'summary': 'Load the CSV'}
Observation:`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("I will load the data.");
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].name).toBe("createOrModifyOperator");
    expect(out.actions[0].input).toEqual({ operatorId: "loadData", summary: "Load the CSV" });
  });

  test("multiple Action / Action Input pairs in one turn", () => {
    const raw = `Thought: Load both files in parallel.

Action: createOrModifyOperator
Action Input: {'operatorId': 'a', 'summary': 'first'}

Action: createOrModifyOperator
Action Input: {'operatorId': 'b', 'summary': 'second'}

Observation:`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(2);
    expect(out.actions[0].input).toEqual({ operatorId: "a", summary: "first" });
    expect(out.actions[1].input).toEqual({ operatorId: "b", summary: "second" });
  });

  test("payload with nested braces and escaped quotes inside double-quoted value", () => {
    // Mirrors the canonical sample: dict-style outer, double-quoted code value
    // that itself contains single-quoted Python strings and {} characters.
    const raw = `Action: createOrModifyOperator
Action Input: {'operatorId': 'filterCands', 'code': "def process(d) -> pd.DataFrame:\\n    return d[~d['Candidate'].isin(['A', 'B'])]\\n", 'summary': 'Filter'}
Observation:`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    const inp = out.actions[0].input;
    expect(inp.operatorId).toBe("filterCands");
    expect(inp.summary).toBe("Filter");
    expect(inp.code).toContain("def process");
    expect(inp.code).toContain("['A', 'B']");
  });

  test("truncates everything from the first Observation: line", () => {
    const raw = `Action: createOrModifyOperator
Action Input: {'operatorId': 'a', 'summary': 'first'}
Observation:
Action: shouldBeIgnored
Action Input: {'operatorId': 'noise'}
Function(name='alsoIgnored', arguments='{...}')`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].input.operatorId).toBe("a");
  });

  test("strict JSON payload still parses", () => {
    const raw = `Action: createOrModifyOperator
Action Input: {"operatorId": "a", "summary": "first"}`;
    const out = parseReActText(raw);
    expect(out.actions[0].input).toEqual({ operatorId: "a", summary: "first" });
  });

  test("True/False/None tokens convert to JSON booleans/null", () => {
    const raw = `Action: t
Action Input: {'a': True, 'b': False, 'c': None}`;
    const out = parseReActText(raw);
    expect(out.actions[0].input).toEqual({ a: true, b: false, c: null });
  });

  test("malformed payload surfaces as __parseError so the loop survives", () => {
    const raw = `Action: createOrModifyOperator
Action Input: {this is not valid at all`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].input.__parseError).toBeDefined();
    expect(out.actions[0].input.__rawInput).toContain("this is not valid");
  });

  test("Action Input not opening with brace records a parse error and keeps going", () => {
    const raw = `Action: t1
Action Input: not an object
Action: t2
Action Input: {'ok': 1}`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(2);
    expect(out.actions[0].input.__parseError).toBeDefined();
    expect(out.actions[1].input).toEqual({ ok: 1 });
  });

  test("leading 'Thought:' label is stripped even when followed by an action", () => {
    const raw = `Thought:    multiline
thought here

Action: t
Action Input: {'k': 1}`;
    const out = parseReActText(raw);
    expect(out.thought.startsWith("multiline")).toBe(true);
  });

  test("no Thought label, just bare text before action", () => {
    const raw = `Some bare reasoning.
Action: t
Action Input: {'k': 1}`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("Some bare reasoning.");
    expect(out.actions[0].input).toEqual({ k: 1 });
  });

  test("strips <Analyze> preamble that appears before the first Thought:", () => {
    const raw = `<Analyze>
I can see the data has been loaded. Let me plan the next steps:
1. group by beach
2. compute violation rate
</Analyze>
Thought: I'll create operators to analyze the data.
Action: createOrModifyOperator
Action Input: {'operatorId': 'groupByBeach', 'summary': 'group by beach'}`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("I'll create operators to analyze the data.");
    // The Analyze block must NOT bleed into the thought.
    expect(out.thought).not.toContain("<Analyze>");
    expect(out.thought).not.toContain("group by beach");
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].input).toEqual({ operatorId: "groupByBeach", summary: "group by beach" });
  });

  test("preamble drop keeps only the FIRST Thought block — later ones stay in the thought", () => {
    const raw = `Some preamble.
Thought: first thought.
More on the first thought.
Thought: this second mention is part of the same thought block.
Action: t
Action Input: {'k': 1}`;
    const out = parseReActText(raw);
    expect(out.thought.startsWith("first thought.")).toBe(true);
    expect(out.thought).toContain("second mention");
    expect(out.thought).not.toContain("Some preamble");
  });

  test("no Thought label and no preamble drop applied (terminal action-only turn)", () => {
    const raw = `Action: t
Action Input: {'k': 1}`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.thought).toBe("");
  });

  test("mid-line 'Action:' (no newline before the label) is still parsed", () => {
    // The local Qwen model under the react-text prompt runs the final thought
    // sentence straight into the label — observed verbatim against the gateway.
    const raw = `Thought: I will create a data-loading operator named 'sales'. The executed snapshot should show the table shape and a sample of rows.Action: createOrModifyOperator
Action Input: {'operatorId': 'sales', 'code': "def load() -> pd.DataFrame:\\n    return pd.read_csv('data/sales.csv')\\n", 'summary': 'Load sales.csv for inspection'}
Observation:`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].name).toBe("createOrModifyOperator");
    expect(out.actions[0].input.operatorId).toBe("sales");
    expect(out.actions[0].input.code).toContain("pd.read_csv('data/sales.csv')");
    // The thought keeps the prose but not the label.
    expect(out.thought.endsWith("a sample of rows.")).toBe(true);
    expect(out.thought).not.toContain("Action:");
  });
});
