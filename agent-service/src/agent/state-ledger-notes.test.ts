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
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";
import { executionNotes, literalLists, operatorLine, schemaText } from "./state-ledger";

/** A workflow of native views only; the notes read nothing else. */
function workflow(ops: Array<{ id: string; type: string; inputs?: string[]; properties?: Record<string, unknown> }>) {
  return {
    operators: ops.map(op => ({
      operatorID: op.id,
      operatorType: op.type,
      nativeOp: { type: op.type, inputs: op.inputs ?? [], properties: op.properties ?? {}, source: `${op.id} = ${op.type.toLowerCase()}(...)` },
    })),
    links: [],
  } as unknown as WorkflowContent;
}

function result(rows: Array<Record<string, unknown>>, total = rows.length): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: total,
    totalRowCount: total,
    resultMode: "table",
    result: rows,
    resultSchema: Object.keys(rows[0] ?? {}).map(name => ({ name, type: typeof rows[0][name] === "number" ? "int64" : "str", encoding: "" })),
  };
}

const players = Array.from({ length: 86 }, (_, i) => ({ player: `p${i}`, team: `t${i % 8}`, score: i }));

test("a reducer or ranking over a table is told which smaller tables derive from it", () => {
  const wf = workflow([
    { id: "players", type: "Scan" },
    { id: "reliable", type: "Filter", inputs: ["players"], properties: { func: "def apply(row):\n    return row['score'] > 40" } },
    { id: "current", type: "Join", inputs: ["reliable", "names"], properties: { type: "semi" } },
    { id: "names", type: "Scan" },
    { id: "teams", type: "Project", inputs: ["players"], properties: { keep: ["team"] } },
    { id: "leaders", type: "Window", inputs: ["players"], properties: { orderBy: [{ col: "score" }], columns: [{ fn: "rank", as: "rank" }] } },
    { id: "by_team", type: "Aggregate", inputs: ["reliable"], properties: { groupBy: ["team"], aggregations: [{ fn: "count", as: "n" }] } },
  ]);
  const results: Record<string, OperatorInfo> = {
    players: result(players),
    reliable: result(players.slice(0, 42)),
    current: result(players.slice(0, 33)),
    names: result([{ player: "p1" }]),
    teams: result(players.map(p => ({ team: p.team }))),
    leaders: result(players),
    by_team: result([{ team: "t1", n: 5 }]),
  };
  const notes = executionNotes(wf, id => results[id], ["leaders", "by_team", "teams"]);
  expect(notes.get("leaders")).toEqual([
    "note: leaders reads players (86 rows); smaller tables derived from it in state: reliable (42 rows), current (33 rows).",
  ]);
  // The aggregate reads the pool itself: only the pool's own subsets count.
  expect(notes.get("by_team")).toEqual(["note: by_team reads reliable (42 rows); smaller tables derived from it in state: current (33 rows)."]);
  expect(notes.get("teams")).toBeUndefined();
});

test("a filter whose literal list equals a column of a table in state is told so; a limited input is noted only where it changes the computation", () => {
  const units = [{ unit: "Blue Ribbon | American" }, { unit: "Blue Ribbon | Japanese" }, { unit: "The Meatball Shop | American" }, { unit: "The Meatball Shop | Italian" }];
  const wf = workflow([
    { id: "orders", type: "Scan" },
    { id: "review_units", type: "Scan" },
    { id: "top3", type: "Limit", inputs: ["orders"], properties: { n: 3 } },
    { id: "shown", type: "Project", inputs: ["top3"], properties: { keep: ["unit"] } },
    { id: "joined", type: "Join", inputs: ["orders", "top3"], properties: { type: "inner" } },
    {
      id: "review_orders",
      type: "Filter",
      inputs: ["orders"],
      properties: {
        func: 'def apply(row):\n    return row["unit"] in ["Blue Ribbon | American", "Blue Ribbon | Japanese", "The Meatball Shop | American", "The Meatball Shop | Italian"]',
      },
    },
    { id: "own_subset", type: "Filter", inputs: ["review_units"], properties: { func: 'def apply(row):\n    return row["unit"] in ["Blue Ribbon | American", "Blue Ribbon | Japanese", "The Meatball Shop | American", "The Meatball Shop | Italian"]' } },
  ]);
  const orders = Array.from({ length: 20 }, (_, i) => ({ unit: units[i % 4].unit, amount: i }));
  const results: Record<string, OperatorInfo> = {
    orders: result(orders),
    review_units: result(units),
    top3: result(orders.slice(0, 3)),
    shown: result(orders.slice(0, 3).map(o => ({ unit: o.unit }))),
    joined: result(orders.slice(0, 3)),
    review_orders: result(orders),
    own_subset: result(units.slice(0, 2)),
  };
  const notes = executionNotes(wf, id => results[id], ["shown", "joined", "review_orders", "own_subset"]);
  expect(notes.get("review_orders")).toEqual([
    'note: the 4 literals in review_orders equal review_units.unit; join(how="semi") on that table keeps the dependency explicit.',
  ]);
  // The table the filter already reads is not a dependency to add.
  expect(notes.get("own_subset")).toBeUndefined();
  expect(notes.get("shown")).toBeUndefined();
  expect(notes.get("joined")?.join("\n")).toContain("input top3 (right) is a limited table (3 rows); its unlimited parent is orders (20 rows)");
  expect(literalLists(`x in ['a', "b", 'c'] or y in ["only"] or z in ["q", "q"]`)).toEqual([["a", "b", "c"]]);
});

test("ledger lines carry the columns of a completed result within a budget", () => {
  const info = result([{ show_id: "s1", country: "US", country_position: 1, country_count: 1, credit: 1 }]);
  expect(schemaText(info)).toBe("show_id:str, country:str, country_position:int64, country_count:int64, credit:int64");
  expect(schemaText(info, 30)).toBe("show_id:str, country:str, +3 more");
  expect(schemaText(undefined)).toBe("");
  const op = {
    operatorID: "country_long",
    operatorType: "Scan",
    nativeOp: { type: "Scan", inputs: [], properties: { files: "/x/frames/country_long.parquet" }, source: 'country_long = scan("/x/frames/country_long.parquet")' },
  } as unknown as OperatorPredicate;
  const line = operatorLine(op, { ...info, totalRowCount: 10012, outputTuples: 10012 }, { marker: "[loaded]" });
  expect(line).toBe(
    "  country_long  10,012×5  scan [loaded] · scan(country_long.parquet) · columns: show_id:str, country:str, country_position:int64, country_count:int64, credit:int64"
  );
  expect(operatorLine(op, info, { schemaChars: 0 })).not.toContain("columns:");
});
