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

import { strict as assert } from "node:assert";

/** A closed/timed-out debug socket does not establish backend termination. */
export function assertNativeCleanupSafe(
  agent: any,
  history: any,
  expected: { agentId: string; wid: number; cuid: number }
) {
  assert.equal(agent?.id, expected.agentId, "Native smoke agent identity changed");
  assert.equal(agent?.state, "AVAILABLE", "Native smoke agent is not idle; retaining resources");
  assert.equal(agent?.delegate?.workflowId, expected.wid);
  assert.equal(agent?.delegate?.computingUnitId, expected.cuid);
  assert.ok(Array.isArray(history), "Native smoke execution history unavailable");
  assert.ok(
    history.every(row => row?.cuId === expected.cuid && [3, 4, 5, 6].includes(row.status)),
    "Native smoke backend execution is not terminal; retaining resources"
  );
}
