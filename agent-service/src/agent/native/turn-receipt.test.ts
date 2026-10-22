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
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import { FLOW_LINE, renderTurnReceipt } from "./turn-receipt";
import { parseTurn, type ParsedTurn } from "./turn-syntax";

const views = ["sample_stats", "full"] as const;

/** The parsed statements (and definitions) of one call. */
function turnOf(statements: string, python = ""): ParsedTurn {
  const parsed = parseTurn({ python, statements }, { views });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.turn;
}

/** A result whose actions carry the given outputs, in the turn's action order. */
function resultOf(
  turn: ParsedTurn,
  outputs: Array<{ status: "ok" | "error" | "skipped"; output: unknown }>
): DataflowActionsResult {
  return {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: outputs.some(o => o.status === "error") ? "error" : "completed",
    actions: turn.actions.map((action, i) => ({
      index: i + 1,
      action,
      status: outputs[i].status,
      output: outputs[i].output,
    })),
    operators: [],
    observe: [],
    observationErrors: [],
  };
}

const block = (id: string, kind: string, inputs: string[], result: string, issues: string[] = []) => ({
  id,
  kind,
  state: "executed",
  inputs: inputs.map(input => ({ id: input })),
  result,
  columns: ["band str", "samples int64"],
  issues,
});

test("edits, then show result with the executed upstream, the result, its records and statistics", () => {
  const turn = turnOf(
    `set marine: filter(water, predicate='is_marine')
set bands: ej_band(marine)
set rates: aggregate(bands, by=['band'], outputs={'samples': count(), 'exceedances': sum('exceedance')})
show result rates full`,
    "def ej_band(table):\n    return table"
  );
  const result = resultOf(turn, [
    {
      status: "ok",
      output: {
        operators: [],
        registrations: [{ name: "ej_band", kind: "registered" }],
        changes: [
          { change: "operator", operator_id: "marine", operator: "filter", action: "created" },
          { change: "operator", operator_id: "bands", operator: "ej_band", action: "created" },
          { change: "operator", operator_id: "rates", operator: "aggregate", action: "created" },
          { change: "edge", edge: "marine -> bands", action: "created" },
        ],
        unconnected_inputs: [],
        invalidated_results: [],
      },
    },
    {
      status: "ok",
      output: {
        operators: [
          { id: "marine", status: "ok", state: "executed", rows: 1204 },
          { id: "bands", status: "ok", state: "executed", rows: 611 },
          { id: "rates", status: "ok", state: "executed", rows: 2 },
          { id: "water", status: "ok", state: "cached", rows: 3310 },
        ],
        operator_blocks: [
          { ...block("water", "scan", [], "3,310 rows × 10 columns"), state: "cached" },
          block("marine", "filter", ["water"], "1,204 rows × 10 columns", [
            "- runtime stats: filter kept=1204/3310, rejected=2106; rejected values: 'Freshwater' × 2098, null × 8",
          ]),
          block("bands", "ej_band", ["marine"], "611 rows × 9 columns"),
          block("rates", "aggregate", ["bands"], "2 rows × 3 columns"),
        ],
      },
    },
    {
      status: "ok",
      output: {
        results: [
          {
            status: "ok",
            operator_id: "rates",
            operator_blocks: [block("rates", "aggregate", ["bands"], "2 rows × 3 columns")],
            text: "records: full; 2 of 2 rows, 3 of 3 columns (complete)\n| band | samples | exceedances |\n|---|---|---|\n| high | 134 | 21 |\n| low | 477 | 42 |\nstatistics: full table, 2 of 2 rows, 3 of 3 columns\n| column | type | nulls | distinct | values |\n|---|---|---|---|---|\n| band | str | 0 | 2 | all: high 1; low 1 |",
          },
        ],
      },
    },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toBe(`## edits applied
functions: ej_band registered
operators: marine created (filter), bands created (ej_band), rates created (aggregate)

## show result rates full
executed: marine, bands, rates
upstream:
- marine (filter of water): 1,204 rows × 10 columns
  - runtime stats: filter kept=1204/3310, rejected=2106; rejected values: 'Freshwater' × 2098, null × 8
- bands (ej_band of marine): 611 rows × 9 columns
result rates (aggregate of bands): 2 rows × 3 columns
records: full; 2 of 2 rows, 3 of 3 columns (complete)
| band | samples | exceedances |
|---|---|---|
| high | 134 | 21 |
| low | 477 | 42 |
statistics: full table, 2 of 2 rows, 3 of 3 columns
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| band | str | 0 | 2 | all: high 1; low 1 |`);
});

test("runtime stats lines carry no per-result note; the system prompt explains them", () => {
  const turn = turnOf("execute marine, bands");
  const executed = (issues: string[][]) =>
    resultOf(turn, [
      {
        status: "ok",
        output: {
          operators: [
            { id: "marine", status: "ok", state: "executed", rows: 1204 },
            { id: "bands", status: "ok", state: "executed", rows: 611 },
          ],
          operator_blocks: [
            block("marine", "filter", ["water"], "1,204 rows × 10 columns", issues[0]),
            block("bands", "ej_band", ["marine"], "611 rows × 9 columns", issues[1]),
          ],
        },
      },
    ]);
  const plain = renderTurnReceipt(executed([[], []]), turn);
  expect(FLOW_LINE.test(plain)).toBe(false);
  const flows = renderTurnReceipt(
    executed([
      ["- runtime stats: Filter \"kind\" among 2106 rejected rows, including null-predicate drops, first values seen: \"Freshwater\" × 2098; other=8. Examples, not causes."],
      ["- runtime stats: values of input column \"site\" missing from output column \"site\": \"A\" (1 of 9)."],
    ]),
    turn
  );
  expect(FLOW_LINE.test(flows)).toBe(true);
  expect(flows).not.toContain("note: a `- runtime stats:` line");
});

test("with several requests, each registered function shows its signature, and one without settings says so", () => {
  const turn = turnOf(
    "set units: eligible_units(orders, min_orders=5)",
    "def eligible_units(orders, *, min_orders=5):\n    return orders\n\ndef tidy(table):\n    return table"
  );
  const result = resultOf(turn, [
    {
      status: "ok",
      output: {
        operators: [],
        registrations: [
          { name: "eligible_units", kind: "registered", signature: "(orders, *, min_orders=5)" },
          { name: "tidy", kind: "updated", signature: "(table)" },
        ],
        changes: [{ change: "operator", operator_id: "units", operator: "eligible_units", action: "created" }],
        unconnected_inputs: [],
        invalidated_results: [],
      },
    },
  ]);
  expect(renderTurnReceipt(result, turn)).toBe(`## edits applied
functions:
- eligible_units(orders, *, min_orders=5) registered
- tidy(table) updated (no settings)
operators: units created (eligible_units)`);
});

test("with operator docs on, an edit that sets operators without a doc names them and still applies", () => {
  const turn = turnOf(
    "set records: scan(files='data/a.csv', doc='Reads the orders file.')\nset totals: aggregate(records, outputs={'n': count()})"
  );
  const result = resultOf(turn, [
    {
      status: "ok",
      output: {
        operators: [],
        changes: [
          { change: "operator", operator_id: "records", operator: "scan", action: "created" },
          { change: "operator", operator_id: "totals", operator: "aggregate", action: "created" },
        ],
        unconnected_inputs: [],
        invalidated_results: [],
        missing_docs: ["totals"],
      },
    },
  ]);
  expect(renderTurnReceipt(result, turn)).toBe(`## edits applied
operators: records created (scan), totals created (aggregate)
doc missing: totals; set each again with doc='<one line: what it does and why>' (a doc alone re-runs nothing)`);
});

test("a rejected edit names the line and nothing else runs", () => {
  const turn = turnOf(`set records: scan(files='data/a.csv')
set totals: aggregate(records, outputs={'n': avg('value')})
show result totals`);
  const result = resultOf(turn, [
    {
      status: "error",
      output: "ValueError: Changes line 2: unknown reducer 'avg'; use mean. No changes were applied.",
    },
    { status: "skipped", output: "Not run because an earlier action failed." },
    { status: "skipped", output: "Not run because an earlier action failed." },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toBe(`## edits rejected
ValueError: Changes line 2: unknown reducer 'avg'; use mean.
No edit applied; resend the corrected call.

## show result totals: not run (an earlier statement failed)`);
});

test("an execution failure names the operator; execute without show lists what ran", () => {
  const turn = turnOf(`execute rates
show result rates`);
  const failedExecute = {
    operators: [
      { id: "marine", status: "ok", state: "executed", rows: 1204 },
      {
        id: "bands",
        status: "error",
        state: "failed",
        message: "- error CALLBACK_RUNTIME: KeyError: 'Violation'\n  - at: ej_band line 6",
      },
      { id: "rates", status: "error", state: "not run", cause: "upstream `bands` failed" },
    ],
    operator_blocks: [
      block("marine", "filter", ["water"], "1,204 rows × 10 columns"),
      {
        ...block("bands", "ej_band", ["marine"], ""),
        state: "failed",
        issues: ["- error CALLBACK_RUNTIME: KeyError: 'Violation'", "  - at: ej_band line 6"],
      },
    ],
  };
  const result = resultOf(turn, [
    { status: "error", output: failedExecute },
    { status: "error", output: failedExecute },
    {
      status: "error",
      output: {
        results: [
          { operator_id: "rates", status: "error", error: "RESULT_FAILED: the last execution of `rates` failed." },
        ],
      },
    },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toContain(`## execute rates
executed: marine; failed: bands
- marine (filter of water): 1,204 rows × 10 columns
- bands (ej_band of marine): failed
  - error CALLBACK_RUNTIME: KeyError: 'Violation'
  - at: ej_band line 6
not run: rates.`);
  expect(text).toContain("## show result rates\nexecuted: marine; failed: bands");
  expect(text).toContain("result rates: unavailable\n- error RESULT_FAILED: the last execution of `rates` failed.");
});

test("lookups return their text; ignored prose is noted; a call rejected before running says so", () => {
  const turn = turnOf(`Look at the columns.
show schema omni
show builtin join`);
  const schema = [
    {
      status: "ok" as const,
      output: {
        operators: [{ id: "omni", status: "ok", state: "cached", rows: 2 }],
        operator_blocks: [{ ...block("omni", "scan", [], "2 rows × 2 columns"), state: "cached" }],
      },
    },
    {
      status: "ok" as const,
      output: {
        text: 'Schema for `omni`: 1–2 of 2 columns.\n| index | name | type |\n|---|---|---|\n| 0 | "a" | str |',
      },
    },
  ];
  const result = resultOf(turn, [
    ...schema,
    { status: "ok", output: { text: 'join(left, right, on=..., how="inner")\n    Join two tables.' } },
  ]);
  expect(renderTurnReceipt(result, turn)).toBe(`note: line 1 of statements is not a statement and was ignored.

## show schema omni
Schema for \`omni\`: 1–2 of 2 columns.
| index | name | type |
|---|---|---|
| 0 | "a" | str |

## show builtin join
join(left, right, on=..., how="inner")
    Join two tables.`);
  const rejected: DataflowActionsResult = {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: "error",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
    error: "line 3: show takes a resource: result, schema, operator, function, or builtin. No actions ran.",
  };
  expect(renderTurnReceipt(rejected)).toBe(
    "## call rejected\nline 3: show takes a resource: result, schema, operator, function, or builtin."
  );
  // Several ignored lines are listed in one note.
  const prose = turnOf("Look first.\nshow schema omni\nThen decide.");
  expect(renderTurnReceipt(resultOf(prose, schema), prose)).toStartWith("note: lines 1, 3 of statements");
});

const castFlow =
  "- runtime stats: cast conversion failures=73/100; column value had 73 invalid non-null values converted to null.";
const flowObservation = (id: string, text = castFlow) => ({
  resultVersion: `${id}-v1`,
  chunks: [{ id: "flow.cast.counts", text }],
});

test("show result retains its target's own execution measurements beside the result", () => {
  const turn = turnOf("show result typed full");
  const typed = {
    ...block("typed", "cast", ["raw"], "100 rows × 1 columns", ["- note: check normalized values.", castFlow]),
    flow_observation: flowObservation("typed"),
  };
  const result = resultOf(turn, [
    { status: "ok", output: { operator_blocks: [typed] } },
    {
      status: "ok",
      output: {
        results: [
          {
            operator_id: "typed",
            status: "ok",
            operator_blocks: [block("typed", "cast", ["raw"], "100 rows × 1 columns")],
            text: castFlow,
            observation: flowObservation("typed"),
          },
        ],
      },
    },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toContain(
    `result typed (cast of raw): 100 rows × 1 columns\n- note: check normalized values.\n${castFlow}`
  );
  expect(text.match(/conversion failures=73\/100/g)).toHaveLength(1);
  expect(text).not.toContain("see action");
  expect(JSON.stringify(result)).toContain(castFlow);
});

test("a failed retrieval retains the successful target's execution measurements", () => {
  const turn = turnOf("show result typed full");
  const result = resultOf(turn, [
    {
      status: "ok",
      output: {
        operator_blocks: [
          {
            ...block("typed", "cast", ["raw"], "100 rows × 1 columns", [castFlow]),
            flow_observation: flowObservation("typed"),
          },
        ],
      },
    },
    {
      status: "error",
      output: { results: [{ operator_id: "typed", status: "error", error: "The requested columns are unavailable." }] },
    },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toContain(castFlow);
  expect(text).toContain("result typed: unavailable");
});

test("a capped upstream execution list never marks an unseen measurement as shown", () => {
  const turn = turnOf("show result output full");
  const blocks = Array.from({ length: 9 }, (_, i) => ({
    ...block(`typed${i}`, "cast", ["raw"], "100 rows × 1 columns", [castFlow]),
    flow_observation: flowObservation(`typed${i}`),
  }));
  const upstreamText = `- runtime stats (typed8): ${castFlow.slice(8)} Before output processing.`;
  const observation = {
    resultVersion: "output-v1",
    chunks: [
      {
        id: "flow.upstream.typed8",
        text: upstreamText,
        upstream: { operatorId: "typed8", resultVersion: "typed8-v1", factIds: ["flow.cast.counts"] },
      },
    ],
  };
  const result = resultOf(turn, [
    {
      status: "ok",
      output: { operator_blocks: [...blocks, block("output", "project", ["typed8"], "100 rows × 1 columns")] },
    },
    {
      status: "ok",
      output: {
        results: [
          {
            operator_id: "output",
            status: "ok",
            operator_blocks: [block("output", "project", ["typed8"], "100 rows × 1 columns")],
            text: upstreamText,
            observation,
          },
        ],
      },
    },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toContain("+1 more executed");
  expect(text).toContain(upstreamText);
  expect(text).not.toContain("see action");
  expect(text).not.toContain("- typed8 (cast");
});

test("show schema retains execution evidence and attributed errors even if lookup fails", () => {
  const turn = turnOf("show schema typed");
  const failure = "- error CALLBACK_RUNTIME: invalid column";
  const result = resultOf(turn, [
    {
      status: "error",
      output: {
        operator_blocks: [
          {
            ...block("upstream", "cast", ["raw"], "100 rows × 1 columns", [castFlow]),
            flow_observation: flowObservation("upstream"),
          },
          { ...block("typed", "custom", ["upstream"], "", [failure]), state: "failed" },
        ],
      },
    },
    { status: "error", output: { error: "No completed schema." } },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toContain(castFlow);
  expect(text).toContain("- typed (custom of upstream): failed");
  expect(text).toContain(failure);
  expect(text).toContain("No completed schema.");
});

test("a scanned workbook's receipt lists its sheet names, upstream and as the shown result", () => {
  const sheets = `workbook sheets of "book": "Main", "Details"; scan(..., sheet='name') reads one (the first is read now).`;
  const scan = { ...block("book", "scan", [], "4 rows × 2 columns"), scope: [sheets] };
  const shown = turnOf("show result book");
  const result = resultOf(shown, [
    { status: "ok", output: { operator_blocks: [scan], operators: [{ id: "book", state: "executed", status: "ok" }] } },
    {
      status: "ok",
      output: { results: [{ operator_id: "book", status: "ok", operator_blocks: [scan], text: "records: …" }] },
    },
  ]);
  const text = renderTurnReceipt(result, shown);
  expect(text).toContain(`result book (scan): 4 rows × 2 columns\n- ${sheets}`);
  const upstream = resultOf(turnOf("show result total"), [
    {
      status: "ok",
      output: {
        operator_blocks: [scan, block("total", "aggregate", ["book"], "1 row × 1 column")],
        operators: [],
      },
    },
    {
      status: "ok",
      output: {
        results: [
          {
            operator_id: "total",
            status: "ok",
            operator_blocks: [block("total", "aggregate", ["book"], "1 row × 1 column")],
            text: "records: …",
          },
        ],
      },
    },
  ]);
  expect(renderTurnReceipt(upstream, turnOf("show result total"))).toContain(
    `- book (scan): 4 rows × 2 columns\n  - ${sheets}`
  );
});
