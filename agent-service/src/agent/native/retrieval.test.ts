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
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import { availableRetrievalViews, nativeResultTransportLimit, retrievalOptions } from "./retrieval";
import { prepareDataflowActions } from "../tools/dataflow-actions";

test("a smaller full display cap preserves the stored materialization for later reads", () => {
  const settings = { ...DEFAULT_AGENT_SETTINGS, fullResultCharLimit: 5000 };
  expect(retrievalOptions(settings, "full").maxChars).toBe(5000);
  expect(nativeResultTransportLimit(settings)).toBe(100000);
  expect(availableRetrievalViews(DEFAULT_AGENT_SETTINGS)).toEqual(["sample_stats", "full"]);
  expect(retrievalOptions(DEFAULT_AGENT_SETTINGS, "sample_stats").data).toBe(true);
});

test("history requires operator IDs and can read a bounded saved view in the same inspection", () => {
  const inspect = (operator_id: unknown, task_id: number | null = 2, view: unknown = "sample_stats") =>
    prepareDataflowActions(
      {
        reasoning: "Check the earlier population.",
        actions: [{ type: "inspect", target: "state", operator_id, task_id, include_implementation: false, view }],
      },
      ["sample_stats", "full"],
      true
    );
  expect(inspect(["eligible", "score"]).status).toBe("pending");
  expect(inspect("eligible").status).toBe("pending");
  expect(inspect(null).status).toBe("error");
  expect(inspect([]).status).toBe("error");
  expect(inspect(["eligible", "eligible"]).status).toBe("error");
  expect(inspect("eligible", null, "sample_stats").status).toBe("error");
  expect(inspect("eligible", null, null).status).toBe("pending");
  expect(inspect("eligible", 2, "sample").status).toBe("error");
  expect(
    prepareDataflowActions(
      { reasoning: "Read.", actions: [{ type: "retrieve", operator_id: "eligible", task_id: 2, view: "full" }] },
      undefined,
      true
    ).status
  ).toBe("error");
});
