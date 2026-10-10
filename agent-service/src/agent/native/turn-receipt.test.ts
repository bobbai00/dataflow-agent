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
import { renderTurnReceipt } from "./turn-receipt";
import { parseTurn, type ParsedTurn } from "./turn-syntax";

const views = ["sample_stats", "full"] as const;

function turnOf(text: string): ParsedTurn {
  const parsed = parseTurn(text, { views });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.turn;
}

/** A result whose actions carry the given outputs, in the turn's action order. */
function resultOf(turn: ParsedTurn, outputs: Array<{ status: "ok" | "error" | "skipped"; output: unknown }>): DataflowActionsResult {
  return {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: outputs.some(o => o.status === "error") ? "error" : "completed",
    actions: turn.actions.map((action, i) => ({ index: i + 1, action, status: outputs[i].status, output: outputs[i].output })),
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
  const turn = turnOf(`summary: Marine only; rate = exceedances / samples.
\`\`\`python
def ej_band(table):
    return table
\`\`\`
set marine: filter(water, predicate='is_marine')
set bands: ej_band(marine)
set rates: aggregate(bands, by=['band'], outputs={'samples': count(), 'exceedances': sum('exceedance')})
show result rates full`);
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
          block("marine", "filter", ["water"], "1,204 rows × 10 columns", ["- flow: filter kept=1204/3310, rejected=2106; rejected values: 'Freshwater' × 2098, null × 8"]),
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
  - flow: filter kept=1204/3310, rejected=2106; rejected values: 'Freshwater' × 2098, null × 8
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

test("a rejected edit names the line and nothing else runs", () => {
  const turn = turnOf(`summary: Totals.
set records: scan(files='data/a.csv')
set totals: aggregate(records, outputs={'n': avg('value')})
show result totals`);
  const result = resultOf(turn, [
    { status: "error", output: "ValueError: Changes line 3: unknown reducer 'avg'; use mean. No changes were applied." },
    { status: "skipped", output: "Not run because an earlier action failed." },
    { status: "skipped", output: "Not run because an earlier action failed." },
  ]);
  const text = renderTurnReceipt(result, turn);
  expect(text).toBe(`## edits rejected
ValueError: Changes line 3: unknown reducer 'avg'; use mean.
No edit applied; resend the corrected turn.

## show result totals: not run (an earlier statement failed)`);
});

test("an execution failure names the operator; execute without show lists what ran", () => {
  const turn = turnOf(`summary: Compute.
execute rates
show result rates`);
  const failedExecute = {
    operators: [
      { id: "marine", status: "ok", state: "executed", rows: 1204 },
      { id: "bands", status: "error", state: "failed", message: "- error CALLBACK_RUNTIME: KeyError: 'Violation'\n  - at: ej_band line 6" },
      { id: "rates", status: "error", state: "not run", cause: "upstream `bands` failed" },
    ],
    operator_blocks: [
      block("marine", "filter", ["water"], "1,204 rows × 10 columns"),
      { ...block("bands", "ej_band", ["marine"], ""), state: "failed", issues: ["- error CALLBACK_RUNTIME: KeyError: 'Violation'", "  - at: ej_band line 6"] },
      { ...block("rates", "aggregate", ["bands"], ""), state: "not run" },
    ],
  };
  const result = resultOf(turn, [
    { status: "error", output: failedExecute },
    { status: "error", output: failedExecute },
    { status: "error", output: { results: [{ operator_id: "rates", status: "error", error: "RESULT_FAILED: the last execution of `rates` failed." }] } },
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

test("lookups return their text; a turn rejected before running says so; a missing summary is noted once", () => {
  const turn = turnOf(`Look at the columns.
show schema omni
show builtin join`);
  const result = resultOf(turn, [
    { status: "ok", output: { operators: [{ id: "omni", status: "ok", state: "cached", rows: 2 }], operator_blocks: [{ ...block("omni", "scan", [], "2 rows × 2 columns"), state: "cached" }] } },
    { status: "ok", output: { text: "Schema for `omni`: 1–2 of 2 columns.\n| index | name | type |\n|---|---|---|\n| 0 | \"a\" | str |" } },
    { status: "ok", output: { text: "join(left, right, on=..., how=\"inner\")\n    Join two tables." } },
  ]);
  expect(renderTurnReceipt(result, turn)).toBe(`note: start each turn with a summary: line.

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
    error: "line 3: not a statement; a line starts with summary, set, delete, execute, show, or answer. No actions ran.",
  };
  expect(renderTurnReceipt(rejected)).toBe("## turn rejected\nline 3: not a statement; a line starts with summary, set, delete, execute, show, or answer.");
});

test("an answer turn records the answer; a refused answer shows the reason", () => {
  const turn = turnOf("summary: Done.\nanswer: 27");
  expect(renderTurnReceipt(resultOf(turn, [{ status: "ok", output: "27" }]), turn)).toBe("answer recorded");
  const refused = resultOf(turn, [{ status: "error", output: "answer not accepted: this request asks for the line **Final Answer: <value>**, and the answer has none." }]);
  expect(renderTurnReceipt(refused, turn)).toContain("## answer\n- error ANSWER_REFUSED: answer not accepted");
});
