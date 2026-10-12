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

import { describe, expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import type { WorkflowContent } from "../../types/workflow";
import { columnChecks, mapOutput, rowColumns } from "./column-checks";

const lambda = (body: string) => `def apply(row):\n    return ${body}`;

function workflow(ops: Record<string, { type: string; inputs?: string[]; properties?: Record<string, unknown> }>) {
  return {
    operators: Object.entries(ops).map(([operatorID, op]) => ({
      operatorID,
      nativeOp: { type: op.type, inputs: op.inputs ?? [], properties: op.properties ?? {} },
    })),
  } as unknown as WorkflowContent;
}

const results: Record<string, string[]> = {
  players: ["player", "team", "side", "nPlays", "speed", "pressure"],
  teams: ["team", "coach"],
};
const result = (id: string): OperatorInfo | undefined =>
  results[id]
    ? ({
        state: "Completed",
        resultSchema: results[id].map(name => ({ name, type: "str", encoding: "" })),
      } as unknown as OperatorInfo)
    : undefined;

describe("column checks", () => {
  test("lambda reads and map outputs are read from the source", () => {
    expect(rowColumns(lambda("{**row, 'a': row['x'] + row[\"y\"], 'b': row.get('z')}"))).toEqual(["x", "y", "z"]);
    expect(mapOutput(lambda("{**row, 'a': row['x'], 'b': 1}"), ["x", "y"])).toEqual(["x", "y", "a", "b"]);
    expect(mapOutput(lambda("{'player': row['p'], 'score': round(row['s'], 4)}"), ["p", "s"])).toEqual([
      "player",
      "score",
    ]);
    expect(mapOutput(lambda("(\n{**row, 'a': f(row, {'k': 1})}\n    )"), ["x"])).toEqual(["x", "a"]);
    // A call or a computed key leaves the output unknown.
    expect(mapOutput(lambda("build(row)"), ["x"])).toBeUndefined();
    expect(mapOutput(lambda("{**row, name: 1}"), ["x"])).toBeUndefined();
  });

  test("every missing column of the edited operators is named at once, through inferred schemas", () => {
    const graph = workflow({
      players: { type: "Scan" },
      teams: { type: "Scan" },
      exposure: {
        type: "Window",
        inputs: ["players"],
        properties: {
          partitionBy: ["side"],
          columns: [
            { fn: "pct_rank", col: "nPlays", as: "exposure_pct" },
            { fn: "median", col: "nPlays", as: "side_play_median" },
          ],
        },
      },
      scored: {
        type: "Map",
        inputs: ["exposure"],
        properties: { func: lambda("{**row, 'score': row['speed'] + row['pressure_pct'] + row['exposure_pct']}") },
      },
      labeled: {
        type: "Map",
        inputs: ["scored"],
        properties: { func: lambda("{**row, 'group': classify(row['score'], row['side_median'])}") },
      },
      with_coach: {
        type: "Join",
        inputs: ["labeled", "teams"],
        properties: { on: [["team", "club"]], type: "inner" },
      },
      ranked: {
        type: "Sort",
        inputs: ["with_coach"],
        properties: { by: [{ col: "score", desc: true }, { col: "coach" }, { col: "rank" }] },
      },
      counts: {
        type: "Aggregate",
        inputs: ["labeled"],
        properties: { groupBy: ["group"], aggregations: [{ fn: "count", as: "players" }] },
      },
      answer: { type: "Process", inputs: ["ranked", "counts"], properties: { registered: {} } },
      after_answer: { type: "Sort", inputs: ["answer"], properties: { by: [{ col: "anything" }] } },
    });
    const changed = new Set(["exposure", "scored", "labeled", "with_coach", "ranked", "counts", "answer", "after_answer"]);
    expect(columnChecks(graph, changed, result)).toEqual([
      "`scored` names column \"pressure_pct\", which `exposure` does not have; its columns are player, team, side, nPlays, speed, pressure, exposure_pct, side_play_median.",
      "`labeled` names column \"side_median\", which `scored` does not have; its columns are player, team, side, nPlays, speed, pressure, exposure_pct, side_play_median, score.",
      "`with_coach` names column \"club\", which `teams` does not have; its columns are team, coach.",
      "`ranked` names column \"rank\", which `with_coach` does not have; its columns are player, team, side, nPlays, speed, pressure, exposure_pct, side_play_median, score, group, team_right, coach.",
    ]);
    // Only the edited operators are checked, and an unchanged operator's result gives its columns.
    expect(columnChecks(graph, new Set(["counts"]), result)).toEqual([]);
    expect(
      columnChecks(graph, new Set(["ranked"]), id =>
        id === "with_coach"
          ? ({
              state: "Completed",
              resultSchema: [{ name: "score" }, { name: "coach" }, { name: "rank" }],
            } as unknown as OperatorInfo)
          : result(id)
      )
    ).toEqual([]);
  });

  test("project, cast, distinct, unpivot, union and semi joins derive their columns", () => {
    const graph = workflow({
      players: { type: "Scan" },
      teams: { type: "Scan" },
      kept: { type: "Project", inputs: ["players"], properties: { keep: ["player", "speed"], rename: { speed: "v" } } },
      typed: { type: "Cast", inputs: ["kept"], properties: { columns: [{ column: "v", dtype: "float64" }] } },
      one: { type: "Distinct", inputs: ["typed"], properties: { columns: ["player"] } },
      long: { type: "Unpivot", inputs: ["players"], properties: { columns: ["speed", "pressure"], nameColumn: "measure" } },
      both: { type: "Union", inputs: ["one", "long"], properties: { schema: "align" } },
      in_teams: { type: "Join", inputs: ["players", "teams"], properties: { on: "team", type: "semi" } },
      last: { type: "Sort", inputs: ["both"], properties: { by: [{ col: "measure" }, { col: "value" }, { col: "v" }, { col: "speed" }] } },
      coached: { type: "Sort", inputs: ["in_teams"], properties: { by: [{ col: "coach" }] } },
    });
    expect(columnChecks(graph, new Set(Object.keys(results).length ? ["kept", "typed", "one", "long", "both", "in_teams", "last", "coached"] : []), result)).toEqual([
      "`last` names column \"speed\", which `both` does not have; its columns are player, v, team, side, nPlays, measure, value.",
      "`coached` names column \"coach\", which `in_teams` does not have; its columns are player, team, side, nPlays, speed, pressure.",
    ]);
  });
});
