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
import { assertNativeCleanupSafe } from "./native-cleanup";

const expected = { agentId: "owned", wid: 12, cuid: 34 };
const agent = { id: "owned", state: "AVAILABLE", delegate: { workflowId: 12, computingUnitId: 34 } };

test("native cleanup accepts idle, matching terminal executions", () => {
  assertNativeCleanupSafe(agent, [], expected);
  assertNativeCleanupSafe(agent, [3, 4, 5, 6].map(status => ({ status, cuId: 34 })), expected);
});

test("native cleanup refuses running, unknown and foreign executions", () => {
  for (const status of [0, 1, 2, -1, undefined, "3"])
    expect(() => assertNativeCleanupSafe(agent, [{ status, cuId: 34 }], expected)).toThrow();
  expect(() => assertNativeCleanupSafe(agent, [{ status: 3, cuId: 99 }], expected)).toThrow();
  expect(() => assertNativeCleanupSafe(agent, null, expected)).toThrow();
});

test("native cleanup refuses busy or rebound agents", () => {
  expect(() => assertNativeCleanupSafe({ ...agent, state: "RUNNING" }, [], expected)).toThrow();
  expect(() => assertNativeCleanupSafe({ ...agent, id: "foreign" }, [], expected)).toThrow();
  expect(() => assertNativeCleanupSafe({ ...agent, delegate: {} }, [], expected)).toThrow();
});
