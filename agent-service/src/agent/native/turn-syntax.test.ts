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
import { parseTurn } from "./turn-syntax";
import { prepareRegisteredDataflowActions } from "../tools/dataflow-actions";

const views = ["sample_stats", "full"] as const;
const parse = (text: string, allowed: readonly ("sample_stats" | "sample" | "full")[] = views) =>
  parseTurn(text, { views: allowed });

const TURN = `summary: Marine samples only; EJ bands >50% and <25%; exceedance = Violation == 'Yes'.
\`\`\`python
def ej_band(table, *, high=50, low=25):
    """Keep communities above high or below low percent EJ population."""
    return table
\`\`\`
set marine: filter(water, predicate='is_marine')
set bands: ej_band(marine)
set rates: aggregate(bands, by=['band'],
    outputs={'samples': count(), 'exceedances': sum('exceedance')})
show result rates full`;

test("a full turn becomes one edit, then the requests, with definitions first", () => {
  const parsed = parse(TURN);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const { turn } = parsed;
  expect(turn.summary).toBe("Marine samples only; EJ bands >50% and <25%; exceedance = Violation == 'Yes'.");
  expect(turn.missingSummary).toBe(false);
  expect(turn.definitions).toContain("def ej_band(table, *, high=50, low=25):");
  expect(turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  const edit = turn.actions[0] as any;
  expect(edit.python).toBe(turn.definitions);
  // set/delete lines keep their turn line numbers: lines 7-10 of the turn.
  const changeLines = edit.changes.split("\n");
  expect(changeLines.slice(0, 6).every((line: string) => line === "")).toBe(true);
  expect(changeLines[6]).toBe("set marine: filter(water, predicate='is_marine')");
  expect(changeLines[8]).toBe("set rates: aggregate(bands, by=['band'],");
  expect(changeLines[9]).toBe("    outputs={'samples': count(), 'exceedances': sum('exceedance')})");
  expect(turn.actions[1]).toEqual({ type: "execute", operator_ids: ["rates"] });
  expect(turn.actions[2]).toEqual({ type: "retrieve", operator_ids: ["rates"], view: "full" });
  const show = turn.statements.find(s => s.kind === "show")!;
  expect(show).toMatchObject({ line: 11, resource: "result", ids: ["rates"], view: "full", actionIndexes: [2, 3] });
  expect(turn.statements.filter(s => s.kind === "edit").map(s => s.line)).toEqual([7, 8, 9]);
  // The same actions pass the registered validator the JSON tool uses.
  const prepared = prepareRegisteredDataflowActions({ reasoning: turn.summary, actions: turn.actions }, [...views]);
  expect(prepared.status).toBe("pending");
});

test("show takes a resource; result defaults to the sample view and accepts columns", () => {
  const parsed = parse(`summary: Look.
show result wide[Beach Name, "Sample Date", Enterococcus]
show result a, b
show schema omni from 200
show operator marine
show function ej_band
show builtin join, scan`);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.turn.actions).toEqual([
    { type: "execute", operator_ids: ["wide"] },
    { type: "retrieve", operator_ids: ["wide"], view: "sample_stats", columns: ["Beach Name", "Sample Date", "Enterococcus"] },
    { type: "execute", operator_ids: ["a", "b"] },
    { type: "retrieve", operator_ids: ["a", "b"], view: "sample_stats" },
    { type: "inspect", target: "schema", operator_id: "omni", offset: 200, limit: 200 },
    { type: "inspect", target: "operator", operator_id: "marine", include_implementation: true },
    { type: "inspect", target: "namespace", names: ["ej_band"], include_implementation: true },
    { type: "inspect", target: "reference", topic: "operators", operator_names: ["join", "scan"] },
  ]);
  expect(parsed.turn.statements.map(s => s.actionIndexes)).toEqual([[1, 2], [3, 4], [5], [6], [7], [8]]);
  // Without statistics the default view is the plain sample.
  const sample = parse("summary: Look.\nshow result a", ["sample", "full"]);
  expect(sample.ok && sample.turn.actions[1]).toEqual({ type: "retrieve", operator_ids: ["a"], view: "sample" });
});

test("execute with and without IDs; delete; an edit-only turn", () => {
  const parsed = parse("summary: Run it.\nexecute\nexecute a, b\ndelete old");
  expect(parsed.ok && parsed.turn.actions).toEqual([
    { type: "edit", python: "", changes: "\n\n\ndelete old" },
    { type: "execute" },
    { type: "execute", operator_ids: ["a", "b"] },
  ]);
  const only = parse("summary: Define.\n```python\ndef f(t):\n    return t\n```");
  expect(only.ok && only.turn.actions).toEqual([{ type: "edit", python: "def f(t):\n    return t", changes: "" }]);
});

test("answer ends the turn, takes the rest of the text, and must stand alone", () => {
  const parsed = parse("summary: Done.\nanswer: 27 states.\n**Final Answer: 27**");
  expect(parsed.ok && parsed.turn.actions).toEqual([{ type: "answer", content: "27 states.\n**Final Answer: 27**" }]);
  const mixed = parse("summary: Done.\nshow result a\nanswer: 27");
  expect(mixed.ok).toBe(false);
  if (!mixed.ok) expect(mixed.error).toContain("line 3: answer must be the only statement");
  const empty = parse("summary: Done.\nanswer:");
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error).toContain("needs the answer text");
});

test("leading prose stands in for a missing summary; prose after a statement does not parse", () => {
  const prose = parse("I will scan the file first.\nset raw: scan(files='data/a.csv')\nshow result raw");
  expect(prose.ok).toBe(true);
  if (prose.ok) {
    expect(prose.turn.missingSummary).toBe(true);
    expect(prose.turn.summary).toBe("I will scan the file first.");
  }
  const trailing = parse("summary: Scan.\nset raw: scan(files='data/a.csv')\nThen I will look at it.");
  expect(trailing.ok).toBe(false);
  if (!trailing.ok) expect(trailing.error).toBe("line 3: not a statement; a line starts with summary, set, delete, execute, show, or answer.");
});

test("errors name the line: unknown resource, bad ID, unavailable view, open fence, open parentheses", () => {
  const cases: Array<[string, string]> = [
    ["summary: x\nshow table a", "line 2: show takes a resource: result, schema, sheets, operator, function, or builtin."],
    ["summary: x\nexecute 9lives", 'line 2: "9lives" is not an operator ID.'],
    ["summary: x\nshow result a sample", 'line 2: the view "sample" is unavailable; use sample_stats or full.'],
    ["summary: x\n```python\ndef f(t):\n    return t", "line 2: the ```python fence is not closed."],
    ["summary: x\nset a: aggregate(b, by=['x'],", "line 2: the statement's parentheses are not closed."],
    ["summary: x\n```json\n{}\n```", "line 2: only ```python fences are accepted; they hold definitions."],
    ["summary: x\nsummary: y", "line 2: one summary line per turn."],
    ["summary: x\nshow result a[\"Beach]", "line 2: unclosed quote in the column list."],
  ];
  for (const [text, message] of cases) {
    const parsed = parse(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe(message);
  }
  const nothing = parse("summary: only a summary");
  expect(nothing.ok).toBe(false);
  if (!nothing.ok) expect(nothing.error).toContain("no statements");
});

test("quotes and comments inside a statement do not confuse the parenthesis tracker", () => {
  const parsed = parse(`summary: Tricky.
set a: scan(files='data/(odd).csv')  # a comment with )
set b: filter(a, predicate='keep')
show result b`);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.turn.statements.map(s => s.line)).toEqual([2, 3, 4]);
});

test("show sheets reads a scanned workbook's retained sheet names; a fenced whole turn is unwrapped", () => {
  const sheets = parse("summary: Sheets.\nshow sheets book");
  expect(sheets.ok && sheets.turn.actions).toEqual([{ type: "inspect", target: "source", operator_id: "book" }]);
  const fenced = parse("````turn\nsummary: Wrapped.\nset a: scan(files='x.csv')\nshow result a\n````");
  expect(fenced.ok).toBe(true);
  if (fenced.ok) expect(fenced.turn.statements.map(s => s.line)).toEqual([2, 3]);
});
