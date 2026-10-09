/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import type { WorkflowContent } from "../../types/workflow";
import { renderSessionState } from "./session-state";

const op = (operatorID: string, type: string, inputs: string[], source: string, registeredName?: string) =>
  ({
    operatorID,
    operatorType: "PythonUDFV2",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    nativeOp: { type, inputs, source, properties: {}, ...(registeredName ? { registeredName } : {}) },
  }) as unknown as WorkflowContent["operators"][number];
const done = (rows: number, columns: string[]): OperatorInfo => ({
  state: "Completed",
  inputTuples: rows,
  outputTuples: rows,
  resultMode: "table",
  totalRowCount: rows,
  resultSchema: columns.map(name => ({ name, type: "str", encoding: "utf8" })),
});
const wide = Array.from({ length: 40 }, (_, index) => `c${index}`).concat("x_o");

test("a later request sees every function, definition, shape, origin and column name once per chain", () => {
  const workflow = {
    operators: [
      op("top5", "Limit", ["ranked"], "set top5: limit(ranked, n=5)"),
      op("loans", "Scan", [], "set loans: scan(files='data/loans.csv')"),
      op("active", "Filter", ["loans"], "set active: filter(loans, predicate='active')"),
      op("ranked", "Process", ["active"], "set ranked: rank_pairs(active,\n    minimum=5)", "rank_pairs"),
      op("summary", "Aggregate", ["active"], "set summary: aggregate(active, outputs={'n': count()})"),
    ],
    links: [],
    nativeNamespace: {
      cells: [],
      bindings: {},
      revision: "r",
      functions: {
        rank_pairs: {
          name: "rank_pairs",
          signature: "(table, *, minimum=5)",
          doc: "Rank lender pairs.\nDetails.",
          source: "",
          exported: true,
        },
        _helper: { name: "_helper", signature: "(x)", doc: "", source: "", exported: false },
      },
    },
  } as unknown as WorkflowContent;
  const results: Record<string, OperatorInfo> = {
    loans: done(41300, wide),
    active: done(411, wide),
    ranked: done(21, [...wide, "rank"]),
    top5: done(5, [...wide, "rank"]),
  };
  const text = renderSessionState({
    workflow,
    result: id => results[id],
    hadResult: id => id === "summary",
    origin: id => ({ loans: 1, active: 3, ranked: 12, top5: 12, summary: 6 })[id],
  });
  expect(text).toBe(
    [
      "## Session state at the start of this request",
      "",
      "Registered functions:",
      "- `rank_pairs(table, *, minimum=5)`: Rank lender pairs.",
      "",
      "| operator | definition | result | task | columns |",
      "|---|---|---|---|---|",
      `| loans | \`scan(files='data/loans.csv')\` | 41,300 rows, 41 columns | 1 | ${wide.join(", ")} |`,
      "| active | `filter(loans, predicate='active')` | 411 of 41,300 rows, 41 columns | 3 | as loans |",
      "| ranked | `rank_pairs(active, minimum=5)` | 21 rows, 42 columns | 12 | active + rank |",
      "| top5 | `limit(ranked, n=5)` | 5 of 21 rows, 42 columns | 12 | as ranked |",
      "| summary | `aggregate(active, outputs={'n': count()})` | stale | 6 |  |",
    ].join("\n")
  );
});

test("a session with nothing registered yet adds nothing", () => {
  const workflow = { operators: [], links: [] } as unknown as WorkflowContent;
  expect(
    renderSessionState({ workflow, result: () => undefined, hadResult: () => false, origin: () => undefined })
  ).toBe("");
});
