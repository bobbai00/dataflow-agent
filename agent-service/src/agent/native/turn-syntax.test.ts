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
import { parseTurn, requestFilePath, type TurnFields } from "./turn-syntax";
import { prepareActions } from "../tools/dataflow-actions";

type View = "sample_stats" | "sample" | "full";
const views = ["sample_stats", "full"] as const;
/** Parse a call's statements, with definitions in `python`. */
const parse = (statements: string, python = "", allowed: readonly View[] = views) =>
  parseTurn({ python, statements }, { views: allowed });
const call = (fields: TurnFields) => parseTurn(fields, { views });

const ANSWER_RULE =
  "the answer is not a statement: to answer, reply with the answer text and no tool call, after show result has displayed what it rests on.";

test("definitions and set lines become one edit first, then the requests; line numbers count statements", () => {
  const python =
    'def ej_band(table, *, high=50, low=25):\n    """Keep communities above high or below low percent EJ population."""\n    return table';
  const parsed = parse(
    `set marine: filter(water, predicate='is_marine')
set bands: ej_band(marine)
set rates: aggregate(bands, by=['band'],
    outputs={'samples': count(), 'exceedances': sum('exceedance')})
show result rates full`,
    python
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const { turn } = parsed;
  expect(turn.definitions).toBe(python);
  expect(turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  const edit = turn.actions[0] as any;
  expect(edit.python).toBe(python);
  // set lines keep their line numbers in statements, so a rejection names the line.
  expect(edit.changes.split("\n")).toEqual([
    "set marine: filter(water, predicate='is_marine')",
    "set bands: ej_band(marine)",
    "set rates: aggregate(bands, by=['band'],",
    "    outputs={'samples': count(), 'exceedances': sum('exceedance')})",
  ]);
  expect(turn.actions[1]).toEqual({ type: "execute", operator_ids: ["rates"] });
  expect(turn.actions[2]).toEqual({ type: "retrieve", operator_ids: ["rates"], view: "full" });
  const show = turn.statements.find(s => s.kind === "show")!;
  expect(show).toMatchObject({ line: 5, resource: "result", ids: ["rates"], view: "full", actionIndexes: [2, 3] });
  expect(turn.statements.filter(s => s.kind === "edit").map(s => s.line)).toEqual([1, 2, 3]);
  expect(turn.ignoredProse).toEqual([]);
  // The action list passes the session's checks before anything runs.
  expect(prepareActions(turn.actions, views).status).toBe("pending");
});

test("an edit written after a request still applies first", () => {
  const parsed = parse("show result a\nset a: scan(files='x.csv')");
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.turn.actions).toEqual([
    { type: "edit", python: "", changes: "\nset a: scan(files='x.csv')" },
    { type: "execute", operator_ids: ["a"] },
    { type: "retrieve", operator_ids: ["a"], view: "sample_stats" },
  ]);
  expect(parsed.turn.statements.map(s => [s.line, s.kind, s.actionIndexes])).toEqual([
    [1, "show", [2, 3]],
    [2, "edit", [1]],
  ]);
});

test("show takes a resource; result defaults to the sample view and accepts columns", () => {
  const parsed = parse(`show result wide[Beach Name, "Sample Date", Enterococcus]
show result a, b
show schema omni from 200
show operator marine
show function ej_band
show builtin join, scan`);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.turn.actions).toEqual([
    { type: "execute", operator_ids: ["wide"] },
    {
      type: "retrieve",
      operator_ids: ["wide"],
      view: "sample_stats",
      columns: ["Beach Name", "Sample Date", "Enterococcus"],
    },
    { type: "execute", operator_ids: ["a", "b"] },
    { type: "retrieve", operator_ids: ["a", "b"], view: "sample_stats" },
    { type: "execute", operator_ids: ["omni"] },
    { type: "inspect", target: "schema", operator_id: "omni", offset: 200, limit: 200 },
    { type: "inspect", target: "operator", operator_id: "marine", include_implementation: true },
    { type: "inspect", target: "namespace", names: ["ej_band"], include_implementation: true },
    { type: "inspect", target: "reference", topic: "operators", operator_names: ["join", "scan"] },
  ]);
  expect(parsed.turn.statements.map(s => s.actionIndexes)).toEqual([[1, 2], [3, 4], [5, 6], [7], [8], [9]]);
  // Without statistics the default view is the plain sample.
  const sample = parse("show result a", "", ["sample", "full"]);
  expect(sample.ok && sample.turn.actions[1]).toEqual({ type: "retrieve", operator_ids: ["a"], view: "sample" });
  // A schema computes its result, then reads the first page.
  const schema = parse("show schema omni");
  expect(schema.ok && schema.turn.actions).toEqual([
    { type: "execute", operator_ids: ["omni"] },
    { type: "inspect", target: "schema", operator_id: "omni" },
  ]);
});

test("execute with and without IDs; delete; definitions alone, in python or in a fence", () => {
  const parsed = parse("execute\nexecute a, b\ndelete old");
  expect(parsed.ok && parsed.turn.actions).toEqual([
    { type: "edit", python: "", changes: "\n\ndelete old" },
    { type: "execute" },
    { type: "execute", operator_ids: ["a", "b"] },
  ]);
  const only = parse("", "def f(t):\n    return t");
  expect(only.ok && only.turn.actions).toEqual([{ type: "edit", python: "def f(t):\n    return t", changes: "" }]);
  const fenced = parse("```python\ndef f(t):\n    return t\n```");
  expect(fenced.ok && fenced.turn.actions).toEqual([{ type: "edit", python: "def f(t):\n    return t", changes: "" }]);
  // Definitions in both places register together, the python field first.
  const both = parse("```python\ndef g(t):\n    return t\n```\nset b: g(a)", "def f(t):\n    return t");
  expect(both.ok && both.turn.definitions).toBe("def f(t):\n    return t\n\ndef g(t):\n    return t");
});

test("answers are replies, never statements: answer: and Final Answer: lines are rejected with the rule", () => {
  const cases: Array<[string, number]> = [
    ["answer: 42", 1],
    ["set a: scan(files='x.csv')\nanswer: 42", 2],
    ["**Final Answer: 42**", 1],
    ["show result a\nFinal Answer: 42", 2],
  ];
  for (const [statements, line] of cases) {
    const parsed = parse(statements);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) continue;
    expect(parsed.line).toBe(line);
    expect(parsed.error).toBe(`line ${line}: ${ANSWER_RULE}`);
  }
});

test("prose lines anywhere are ignored and noted, including a copied receipt", () => {
  const prose = parse(
    "I will scan the file first.\nset raw: scan(files='data/a.csv')\nThen I will look at it.\nshow result raw"
  );
  expect(prose.ok).toBe(true);
  if (prose.ok) {
    expect(prose.turn.ignoredProse).toEqual([1, 3]);
    expect(prose.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
    expect(prose.turn.statements.map(s => s.line)).toEqual([2, 4]);
  }
  // Prose that merely begins with a Python word is still prose.
  const words = parse("set a: scan(files='x.csv')\nfrom the receipt I will decide.");
  expect(words.ok && words.turn.ignoredProse).toEqual([2]);
  // A receipt written into statements cannot pass for the engine's reply.
  const copied = parse(
    "set data: scan(files='x.csv')\nshow result data\n\n## edits applied\noperators: data created (scan)"
  );
  expect(copied.ok).toBe(true);
  if (copied.ok) {
    expect(copied.turn.ignoredProse).toEqual([4, 5]);
    expect(copied.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  }
});

test("errors name the line: unknown resource, bad ID, unavailable view, open fence, open parentheses", () => {
  const cases: Array<[string, string]> = [
    ["show table a", "line 1: show takes a resource: result, schema, operator, function, or builtin."],
    ["set a: scan(files='x.csv')\nexecute 9lives", 'line 2: "9lives" is not an operator ID.'],
    ["show result a sample", 'line 1: the view "sample" is unavailable; use sample_stats or full.'],
    [
      "show schema data/biomedical/input/book.xlsx",
      "line 1: show schema takes the ID of an operator, not a path or a call: first `set book: scan(files='<path>')`, then `show schema book`.",
    ],
    ["show operator a b", "line 1: show operator takes one operator ID."],
    ["```python\ndef f(t):\n    return t", "line 1: the ```python fence is not closed."],
    ["set a: aggregate(b, by=['x'],", "line 1: the statement's parentheses are not closed."],
    ["```json\n{}\n```", "line 1: only ```python fences are accepted; they hold definitions."],
    ['show result a["Beach]', "line 1: unclosed quote in the column list."],
    ["show result a[]", "line 1: the column list is empty."],
  ];
  for (const [statements, message] of cases) {
    const parsed = parse(statements);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe(message);
  }
  const empty =
    "no statements: a call has at least one set, delete, execute, or show line in statements, or definitions in python.";
  for (const fields of [{ python: "", statements: "" }, {}, { python: "", statements: "Let me think about it." }]) {
    const parsed = call(fields);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe(empty);
  }
});

test("quotes, comments and multiline literal settings do not confuse the parenthesis tracker", () => {
  const parsed = parse(`set a: scan(files='data/(odd).csv')  # a comment with )
set b: filter(a, predicate='keep')
show result b`);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.turn.statements.map(s => s.line)).toEqual([1, 2, 3]);
  for (const quote of ['"""', "'''"]) {
    const literal = `doc=${quote}Keep this literal:\n) (\nshow result raw\n## edits applied\n${quote})`;
    const multi = parse(`set raw: scan(files='data.csv', ${literal}\nshow result raw`);
    expect(multi.ok).toBe(true);
    if (!multi.ok) continue;
    expect(multi.turn.changes).toContain(literal);
    expect(multi.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
    expect(multi.turn.statements.map(s => [s.line, s.kind])).toEqual([
      [1, "edit"],
      [6, "show"],
    ]);
  }
  const continued = parse(
    "set raw: scan(files='data.csv', doc='line\\\nshow result literal\\\ncontinued')\nshow result raw"
  );
  expect(continued.ok).toBe(true);
  if (continued.ok) {
    expect(continued.turn.changes).toContain("show result literal");
    expect(continued.turn.statements.map(s => [s.line, s.kind])).toEqual([
      [1, "edit"],
      [4, "show"],
    ]);
  }
});

test("fenced fields are unwrapped; a text fence inside statements is read in place; an unlabeled Python fence holds definitions", () => {
  const wrapped = call({
    python: "```python\ndef f(t):\n    return t\n```",
    statements: "````turn\nset b: f(a)\nshow result b\n````",
  });
  expect(wrapped.ok).toBe(true);
  if (wrapped.ok) {
    expect(wrapped.turn.definitions).toBe("def f(t):\n    return t");
    expect(wrapped.turn.statements.map(s => s.line)).toEqual([1, 2]);
  }
  const inPlace = parse(
    "I'll start by scanning the file.\n\n```text\nset records: scan(files='data/a.csv')\nshow result records\n```"
  );
  expect(inPlace.ok).toBe(true);
  if (inPlace.ok) {
    expect(inPlace.turn.ignoredProse).toEqual([1]);
    expect(inPlace.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
    expect(inPlace.turn.statements.map(s => s.line)).toEqual([4, 5]);
  }
  const unlabeled = parse("```\ndef f(t):\n    return t\n```\nset b: f(a)\nshow result b");
  expect(unlabeled.ok).toBe(true);
  if (unlabeled.ok) expect((unlabeled.turn.actions[0] as any).python).toBe("def f(t):\n    return t");
  // A text fence still open at the end of the field closes there.
  const open = parse("```text\nset a: scan(files='x.csv')\nshow result a");
  expect(open.ok && open.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
});

test("a Python fence inside a text fence, a stray closing fence, an unclosed Python fence, and a wide fence", () => {
  const nested = parse(
    "I'll start by examining the files.\n\n````turn\n```python\ndef layers(*, path):\n    return path\n```\nset usa: layers(path='data/usa.gpkg')\nshow result usa\n````"
  );
  expect(nested.ok).toBe(true);
  if (nested.ok) {
    expect(nested.turn.definitions).toBe("def layers(*, path):\n    return path");
    expect(nested.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  }
  const stray = parse("```python\n```\nset raw: scan(files='x.csv', preview=15)\nshow result raw full\n```");
  expect(stray.ok && stray.turn.actions).toEqual([
    { type: "edit", python: "", changes: "\n\nset raw: scan(files='x.csv', preview=15)" },
    { type: "execute", operator_ids: ["raw"] },
    { type: "retrieve", operator_ids: ["raw"], view: "full" },
  ]);
  // A Python fence left open ends at the first statement line.
  const unclosed = parse("```python\ndef f(t):\n    return t\nset b: f(a)\nshow result b");
  expect(unclosed.ok).toBe(true);
  if (unclosed.ok) {
    expect(unclosed.turn.definitions).toBe("def f(t):\n    return t");
    expect(unclosed.turn.statements.map(s => s.line)).toEqual([4, 5]);
  }
  const wide = parse("````python\ndef f(t):\n    return t\n````\nshow function f");
  expect(wide.ok && wide.turn.definitions).toBe("def f(t):\n    return t");
  // Receipt-like text inside Python is source and is kept verbatim.
  const source =
    'def label(table):\n    """Keep the literal receipt examples.\n## edits applied\n## show result data\n    """\n    return table.assign(label="## execute data")';
  const code = parse(`\`\`\`python\n${source}\n\`\`\`\nset out: label(raw)`);
  expect(code.ok && code.turn.definitions).toBe(source);
});

test("Python written in statements without a fence holds definitions up to the next statement", () => {
  const unfenced = parse(
    'import pandas as pd\n\ndef southwest(row):\n    """South-west."""\n    return row[\'lat\'] < 0\n\nset sw: filter(cities, predicate=\'southwest\')\nshow result sw'
  );
  expect(unfenced.ok).toBe(true);
  if (unfenced.ok) {
    expect(unfenced.turn.definitions).toBe(
      'import pandas as pd\n\ndef southwest(row):\n    """South-west."""\n    return row[\'lat\'] < 0'
    );
    expect(unfenced.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
    expect(unfenced.turn.statements.map(s => s.line)).toEqual([7, 8]);
  }
  // Definitions and statements in separate fenced blocks are read in place.
  const blocks = parse(
    "```python\ndef southwest(row):\n    return row['lat'] < 0 and row['lng'] < 0\n```\n\n```text\nset sw: filter(cities, predicate='southwest')\nshow result sw\n```"
  );
  expect(blocks.ok).toBe(true);
  if (blocks.ok) {
    expect(blocks.turn.definitions).toBe("def southwest(row):\n    return row['lat'] < 0 and row['lng'] < 0");
    expect(blocks.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  }
});

test("the starter call reads the first data file the request names", () => {
  expect(requestFilePath("Use data/legal/input/a.csv, then data/legal/input/b.xlsx.")).toBe("data/legal/input/a.csv");
  expect(requestFilePath("Which state had the most reports?")).toBe("data/<folder>/input/<file>");
});
