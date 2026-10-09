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
import { ActionMonitor, compareRequests } from "./state-history-diagnostics";
const event = (type = "retrieve", value = 1) => ({
  action: { type, operator_id: "rows" },
  status: "ok",
  output: { value },
});
test("repeated actions and two-action cycles are alerts only when state is unchanged", () => {
  const m = new ActionMonitor();
  expect(m.observe(event(), "v1")).toEqual([]);
  expect(m.observe(event(), "v1")).toEqual([]);
  expect(m.observe(event(), "v1")).toContain("three_identical_actions");
  const changing = new ActionMonitor();
  for (let i = 0; i < 4; i++) expect(changing.observe(event(), `v${i}`)).toEqual([]);
  const cycle = new ActionMonitor();
  let alerts: string[] = [];
  for (let i = 0; i < 6; i++) alerts = cycle.observe(event("retrieve", i % 2), "v1");
  expect(alerts).toContain("two_action_cycle");
});
test("prefix checks locate changed tool schemas and messages without estimating cached tokens", () => {
  const previous = {
    model: "terra",
    tools: [{ name: "dataflow" }],
    messages: [
      { role: "system", content: "stable" },
      { role: "user", content: "Task 1" },
    ],
  };
  const next = { ...previous, messages: [...previous.messages, { role: "assistant", content: "run" }] };
  expect(compareRequests(previous, next).unchanged_messages).toBe(2);
  expect(compareRequests(previous, { ...next, tools: [] }).changed_fields).toContain("tools");
  const changed = { ...previous, messages: [previous.messages[0], { role: "user", content: "Task 2" }] };
  expect(compareRequests(previous, changed).unchanged_messages).toBe(1);
  expect(compareRequests(previous, changed).first_changed_message).toBe(1);
});
