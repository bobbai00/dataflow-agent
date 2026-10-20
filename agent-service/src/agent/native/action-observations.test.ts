/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from "bun:test";
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import { renderActionObservations } from "./action-observations";

function render(actions: DataflowActionsResult["actions"]) {
  return renderActionObservations({
    kind: "dataflow-actions",
    protocol: "json",
    status: "completed",
    actions,
    operators: [],
    observe: [],
    observationErrors: [],
  });
}
const table = {
  operator_id: "total",
  operator_blocks: [
    { id: "total", kind: "aggregate", state: "completed", result: "1 row × 1 column", columns: ["value float64"] },
  ],
  text: "columns: value float64\nrecords: full; 1 of 1 rows, 1 of 1 column (complete)\n| value |\n| --- |\n| 13.1628 |",
};

test("typed set and delete expose graph receipts, superseded writes and invalidated results", () => {
  const text = render([
    {
      index: 1,
      action: { type: "set", id: "source", operator: "scan", inputs: [], params: { files: ["a.csv"] } },
      status: "ok",
      output: {
        changes: [
          { change: "operator", operator_id: "source", operator: "scan", action: "created" },
          { change: "edge", edge: "source -> total", action: "created" },
        ],
        invalidated_results: ["total"],
        command_results: [{ index: 0, type: "set", operator_id: "source", status: "superseded" }],
        unconnected_inputs: [],
      },
    },
    {
      index: 2,
      action: { type: "delete", ids: ["unused"] },
      status: "ok",
      output: {
        changes: [{ change: "operator", operator_id: "unused", operator: "scan", action: "deleted" }],
        unconnected_inputs: ["consumer.in"],
      },
    },
  ]);
  expect(text).toContain("### 1. set source: ok");
  expect(text).toContain("operator source created (scan)");
  expect(text).toContain("edge source -> total created");
  expect(text).toContain("source superseded by a later write in this atomic phase");
  expect(text).toContain("results invalidated: total");
  expect(text).toContain("### 2. delete unused: ok");
  expect(text).toContain("operator unused deleted");
  expect(text).toContain("consumer.in is unconnected");
});

test("typed read displays actual table values once, even when another requested branch failed", () => {
  for (const status of ["ok", "error"] as const) {
    const text = render([
      {
        index: 1,
        action: { type: "read", ids: ["total", "broken"], view: "full", columns: null },
        status,
        output: {
          tables: [{ ...table, superseded_in_call: true }],
          executions: 1,
          text: table.text,
          operator_blocks: table.operator_blocks,
          ...(status === "error"
            ? {
                errors: ["RESULT_FAILED: broken: missing column amount"],
                error: "RESULT_FAILED: broken: missing column amount",
              }
            : {}),
        },
      },
    ]);
    expect(text).toContain(`### 1. read total, broken: ${status}`);
    expect(text).toContain("13.1628");
    expect(text.match(/13\.1628/g)).toHaveLength(1);
    expect(text).toContain("this result was superseded later in the call");
    if (status === "error") expect(text).toContain("missing column amount");
  }
});

test("rejected typed edits explicitly report atomic rollback and the diagnostic", () => {
  const text = render([
    {
      index: 1,
      action: { type: "delete", ids: ["absent"] },
      status: "error",
      output: { error: "Operator absent does not exist. No changes were applied." },
    },
  ]);
  expect(text).toContain("No changes were applied.");
  expect(text.match(/No changes were applied\./g)).toHaveLength(1);
  expect(text).toContain("UNKNOWN_OPERATOR: Operator absent does not exist.");
});

test("legacy edit and retrieve observations retain their existing rendering", () => {
  const text = render([
    {
      index: 1,
      action: { type: "edit", changes: 'source = scan("a.csv")' },
      status: "ok",
      output: {
        changes: [{ change: "operator", operator_id: "source", operator: "scan", action: "created" }],
        unconnected_inputs: [],
      },
    },
    { index: 2, action: { type: "retrieve", operator_id: "total", view: "full" }, status: "ok", output: table },
  ]);
  expect(text).toBe(
    "### 1. edit: ok\noperator source created (scan)\n\n### 2. retrieve total: ok\n- **total** (aggregate, completed)\n  - result: 1 row × 1 column\n  - columns: value float64\nrecords: full; 1 of 1 rows, 1 of 1 column (complete)\n| value |\n| --- |\n| 13.1628 |"
  );
});
