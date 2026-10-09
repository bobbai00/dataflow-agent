/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { expect, test } from "bun:test";
import { renderActionObservations } from "./action-observations";
import { prepareRegisteredDataflowActions, runDataflowActions } from "../tools/dataflow-actions";

test("batched retrieval renders one schema per result and retains partial results", async () => {
  const result = prepareRegisteredDataflowActions({
    reasoning: "Read the completed results.",
    actions: [{ type: "retrieve", operator_ids: ["a", "missing", "b"], view: "full" }],
  });
  const entries = [
    {
      operator_id: "a",
      status: "ok",
      operator_blocks: [{ id: "a", kind: "scan", state: "executed", columns: ["x float64", '"Year " str'] }],
      text: 'columns: x float64, "Year " str\n| x | "Year " |\n| --- | --- |\n| -2.15300777 | 2024 |',
      superseded_in_call: true,
    },
    { operator_id: "missing", status: "error", error: "UNKNOWN_OPERATOR: missing" },
    {
      operator_id: "b",
      status: "ok",
      operator_blocks: [{ id: "b", kind: "scan", state: "cached", columns: ["y str"] }],
      text: "records: omitted (budget)",
    },
  ];
  const before = structuredClone(entries);
  await runDataflowActions(result, async () => ({ status: "error", output: { results: entries } }));
  const text = renderActionObservations(result);
  expect(text.match(/columns: x float64, "Year " str/g)).toHaveLength(1);
  expect(text).toContain('  - columns: x float64, "Year " str');
  expect(text).toContain("| -2.15300777 | 2024 |");
  expect(text).toContain("this result was superseded later in the call");
  expect(text).toContain("UNKNOWN_OPERATOR");
  expect(text).toContain("columns: y str");
  expect(text).toContain("records: omitted (budget)");
  expect(entries).toEqual(before);
});
