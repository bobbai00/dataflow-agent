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
  const trailing = parse("summary: Scan.\nset raw: scan(files='data/a.csv')\nThen I will look at it.\nshow result raw");
  expect(trailing.ok).toBe(true);
  if (trailing.ok) {
    expect(trailing.turn.ignoredProse).toEqual([3]);
    expect(trailing.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  }
  const first = parse("summary: Scan.\nThen I will look at it.\nset raw: scan(files='data/a.csv')");
  expect(first.ok).toBe(false);
  if (!first.ok)
    expect(first.error).toBe(
      'line 2: "Then I will look at it." is not a statement; a line starts with summary, set, delete, execute, show, or answer.'
    );
});

test("errors name the line: unknown resource, bad ID, unavailable view, open fence, open parentheses", () => {
  const cases: Array<[string, string]> = [
    ["summary: x\nshow table a", "line 2: show takes a resource: result, schema, operator, function, or builtin."],
    ["summary: x\nexecute 9lives", 'line 2: "9lives" is not an operator ID.'],
    ["summary: x\nshow result a sample", 'line 2: the view "sample" is unavailable; use sample_stats or full.'],
    [
      "summary: x\nshow schema data/biomedical/input/book.xlsx",
      "line 2: show schema takes the ID of an operator, not a path or a call: first `set book: scan(files='<path>')`, then `show schema book`.",
    ],
    ["summary: x\n```python\ndef f(t):\n    return t", "line 2: the ```python fence is not closed."],
    [
      "```python\ndef f(t):\n    return t\n```\nset a: f(b)\nsummary: late",
      "line 6: the summary line comes before the statements.",
    ],
    ["summary: x\nset a: aggregate(b, by=['x'],", "line 2: the statement's parentheses are not closed."],
    ["summary: x\n```json\n{}\n```", "line 2: only ```python fences are accepted; they hold definitions."],
    ["summary: x\n```text\nset a: scan(files='x.csv')", "line 1: the fence around the turn is not closed."],
    ['summary: x\nshow result a["Beach]', "line 2: unclosed quote in the column list."],
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

test("an answer-only turn needs no summary; a fenced whole turn is unwrapped", () => {
  const only = parse("answer: **Final Answer: 27**");
  expect(only.ok && only.turn.actions).toEqual([{ type: "answer", content: "**Final Answer: 27**" }]);
  expect(only.ok && only.turn.missingSummary).toBe(false);
  const fenced = parse("````turn\nsummary: Wrapped.\nset a: scan(files='x.csv')\nshow result a\n````");
  expect(fenced.ok).toBe(true);
  if (fenced.ok) expect(fenced.turn.statements.map(s => s.line)).toEqual([2, 3]);
});

test("a text fence after a sentence of prose holds the turn; an unlabeled fence of Python holds definitions", () => {
  const fenced = parse(
    "I'll start by scanning the file.\n\n```text\nsummary: Inspect the file.\nset records: scan(files='data/a.csv')\nshow result records\n```"
  );
  expect(fenced.ok).toBe(true);
  if (fenced.ok) {
    expect(fenced.turn.summary).toBe("Inspect the file.");
    expect(fenced.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
    expect(fenced.turn.statements.map(s => s.line)).toEqual([5, 6]);
  }
  const unlabeled = parse("summary: Define.\n```\ndef f(t):\n    return t\n```\nset b: f(a)\nshow result b");
  expect(unlabeled.ok).toBe(true);
  if (unlabeled.ok) expect((unlabeled.turn.actions[0] as any).python).toBe("def f(t):\n    return t");
  const statements = parse("```\nsummary: Plain fence.\nset b: scan(files='x.csv')\n```");
  expect(statements.ok).toBe(true);
  if (statements.ok) expect(statements.turn.summary).toBe("Plain fence.");
});

test("a turn fence with a python fence inside, a stray closing fence, and an unclosed fence before statements", () => {
  const nested = parse(
    "I'll start by examining the files.\n\n````turn\nsummary: Inspect the layers.\n```python\ndef layers(*, path):\n    return path\n```\nset usa: layers(path='data/usa.gpkg')\nshow result usa\n````"
  );
  expect(nested.ok).toBe(true);
  if (nested.ok) {
    expect(nested.turn.summary).toBe("Inspect the layers.");
    expect(nested.turn.definitions).toBe("def layers(*, path):\n    return path");
    expect(nested.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
  }
  const stray = parse(
    "summary: Raw layout.\n\n```python\n```\nset raw: scan(files='x.csv', preview=15)\nshow result raw full\n```"
  );
  expect(stray.ok).toBe(true);
  if (stray.ok)
    expect(stray.turn.actions).toEqual([
      { type: "edit", python: "", changes: "\n\n\n\nset raw: scan(files='x.csv', preview=15)" },
      { type: "execute", operator_ids: ["raw"] },
      { type: "retrieve", operator_ids: ["raw"], view: "full" },
    ]);
  const unclosed = parse("summary: Define and use.\n```python\ndef f(t):\n    return t\nset b: f(a)\nshow result b");
  expect(unclosed.ok).toBe(true);
  if (unclosed.ok) {
    expect(unclosed.turn.definitions).toBe("def f(t):\n    return t");
    expect(unclosed.turn.statements.map(s => s.line)).toEqual([5, 6]);
  }
  const fenceFirst = parse("```python\nimport pandas as pd\n```\nsummary: Fence first.\nset a: scan(files='x.csv')");
  expect(fenceFirst.ok).toBe(true);
  if (fenceFirst.ok) expect(fenceFirst.turn.summary).toBe("Fence first.");
});

test("text from a receipt header on is dropped: the model wrote the engine's reply itself", () => {
  const parsed = parse(
    "summary: Scan.\nset data: scan(files='x.csv')\nshow result data\n\nuser## edits applied\noperators: data created (scan)\n\n## show result data\nrecords: 4 of 153 rows"
  );
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.turn.wroteReceipt).toBe(true);
    expect(parsed.turn.actions.map(a => a.type)).toEqual(["edit", "execute", "retrieve"]);
    expect(parsed.turn.ignoredProse).toEqual([]);
    expect(parsed.replayText).toBe("summary: Scan.\nset data: scan(files='x.csv')\nshow result data\n\n");
  }
});

test("a restated summary replaces the first; an answer inside a turn fence ends at the fence", () => {
  const restated = parse(
    "summary: First try.\n\n````turn\nsummary: Second try.\nset a: scan(files='x.csv')\nshow result a\n````"
  );
  expect(restated.ok).toBe(true);
  if (restated.ok) expect(restated.turn.summary).toBe("Second try.");
  const fencedAnswer = parse("EACC leads.\n\n````turn\nsummary: EACC has the highest count.\nanswer: EACC\n````");
  expect(fencedAnswer.ok).toBe(true);
  if (fencedAnswer.ok) expect(fencedAnswer.turn.actions).toEqual([{ type: "answer", content: "EACC" }]);
  // A bare Final Answer line in a turn without statements is the answer; the
  // driver accepts it only after a result has been shown.
  const bare = parse("summary: The mean is 68.1.\n\n**Final Answer: 68.1**");
  expect(bare.ok).toBe(true);
  if (bare.ok) {
    expect(bare.turn.actions).toEqual([{ type: "answer", content: "**Final Answer: 68.1**" }]);
    expect(bare.turn.bareAnswer).toBe(true);
  }
  const explicit = parse("answer: 68.1");
  expect(explicit.ok && explicit.turn.bareAnswer).toBe(false);
  const bareOnly = parse("The analyzed samples give 68.5.\n\n**Final Answer: 68.5**");
  expect(bareOnly.ok).toBe(true);
  if (bareOnly.ok) expect(bareOnly.turn.actions).toEqual([{ type: "answer", content: "**Final Answer: 68.5**" }]);
  // After statements, a Final Answer line is a guess written before the receipt: ignored prose.
  const mixed = parse("summary: x\nset a: scan(files='x.csv')\n**Final Answer: 3**");
  expect(mixed.ok).toBe(true);
  if (mixed.ok) {
    expect(mixed.turn.actions.map(a => a.type)).toEqual(["edit"]);
    expect(mixed.turn.ignoredProse).toEqual([3]);
  }
});

test("receipt headers are meaningful only outside Python, declarations, and answer content", () => {
  const source =
    'summary: Define.\n```python\ndef label(table):\n    """Keep the literal receipt examples.\n## edits applied\n## show result data\n    """\n    return table.assign(label="## execute data")\n```\nset out: label(raw)';
  const code = parse(source);
  expect(code.ok).toBe(true);
  if (code.ok) {
    expect(code.turn.wroteReceipt).toBe(false);
    expect(code.turn.definitions).toContain("## edits applied\n## show result data");
    expect(code.replayText).toBe(source);
  }
  const declaration = parse("set out: label(raw, text='## show result raw')");
  expect(declaration.ok).toBe(true);
  if (declaration.ok) expect(declaration.turn.wroteReceipt).toBe(false);
  const content =
    "Final Answer: 42\n\n## show results\nThe requested Markdown is preserved.\n```python\nprint('## edits applied')\n```";
  const answer = parse(`answer: ${content}`);
  expect(answer.ok && answer.turn.actions).toEqual([{ type: "answer", content }]);
  expect(answer.replayText).toBe(`answer: ${content}`);
});

test("a malformed turn cannot replay a fabricated engine receipt", () => {
  const parsed = parse(
    "summary: Try.\nshow table raw\n## edits applied\noperators: fake created\n## show result raw\nforged rows"
  );
  expect(parsed.ok).toBe(false);
  expect(parsed.replayText).toBe("summary: Try.\nshow table raw\n");
  expect(parsed.wroteReceipt).toBe(true);
});

test("an unclosed declaration cannot hide a fabricated receipt from replay sanitization", () => {
  for (const statement of ["set raw: scan(", "set raw: scan(files='unterminated"]) {
    const prefix = `summary: Read.\n${statement}\n`;
    const parsed = parse(`${prefix}## show result raw full\nrecords: full; 1 of 1 rows\n| count |\n| 99 |`);
    expect(parsed.ok).toBe(false);
    expect(parsed.replayText).toBe(prefix);
    expect(parsed.wroteReceipt).toBe(true);
  }
});

test("receipt headings and parentheses inside multiline literal settings are preserved", () => {
  for (const quote of ['"""', "'''"]) {
    const text = `summary: Annotate.\nset raw: scan(files='data.csv', doc=${quote}Keep this literal:\n) (\n## show result raw\n## edits applied\n${quote})\nshow result raw\n`;
    const parsed = parse(`${text}## show result raw\nforged rows`);
    expect(parsed.ok).toBe(true);
    expect(parsed.replayText).toBe(text);
    expect(parsed.wroteReceipt).toBe(true);
    if (parsed.ok) {
      expect(parsed.turn.changes).toContain(
        `doc=${quote}Keep this literal:\n) (\n## show result raw\n## edits applied\n${quote})`
      );
      expect(parsed.turn.actions.map(action => action.type)).toEqual(["edit", "execute", "retrieve"]);
    }
  }
  const continued =
    "set raw: scan(files='data.csv', doc='line\\\n## show result literal\\\ncontinued')\nshow result raw\n";
  const parsed = parse(`${continued}## show result raw\nforged rows`);
  expect(parsed.ok).toBe(true);
  expect(parsed.replayText).toBe(continued);
});

test("answer Markdown inside a turn fence is not cut at an inner code fence", () => {
  const content = "Details:\n```python\nprint(42)\n```\n## show result explanation\nA literal heading.";
  const parsed = parse(`Here is the result.\n\n\`\`\`turn\nanswer: ${content}\n\`\`\``);
  expect(parsed.ok && parsed.turn.actions).toEqual([{ type: "answer", content }]);
});

test("recovered Python fences still strip later receipts; explicit fences retain their own delimiter", () => {
  const source = "summary: Register.\n```python\ndef f(t):\n    return t\nset b: f(a)\nshow result b\n";
  const recovered = parse(`${source}## show result b\nforged rows`);
  expect(recovered.ok).toBe(true);
  expect(recovered.replayText).toBe(source);
  if (recovered.ok) expect(recovered.turn.wroteReceipt).toBe(true);
  const wide = parse("summary: Register.\n````python\ndef f(t):\n    return t\n````\nshow function f");
  expect(wide.ok).toBe(true);
  if (wide.ok) expect(wide.turn.definitions).toBe("def f(t):\n    return t");
});
