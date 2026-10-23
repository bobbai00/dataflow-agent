/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { AgentInfo } from "./agent.service";
import { agentOf, agentsOf, isAgentOf } from "./workflow-agent";

const USER = { uid: 1, name: "user", email: "user@example.com", role: "REGULAR" };

function agent(id: string, workflowId: number | undefined, createdAt: string, bound = true): AgentInfo {
  return {
    id,
    name: id,
    modelType: "test",
    isBaselineMode: false,
    createdAt: new Date(createdAt),
    delegate: bound ? { userInfo: USER, workflowId } : undefined,
  };
}

describe("workflow-agent", () => {
  const a1 = agent("a1", 7, "2026-01-01T00:00:00Z");
  const a2 = agent("a2", 7, "2026-01-02T00:00:00Z");
  const other = agent("other", 8, "2026-01-03T00:00:00Z");
  const unsaved = agent("unsaved", undefined, "2026-01-04T00:00:00Z");
  const zero = agent("zero", 0, "2026-01-05T00:00:00Z");
  const ownerless = agent("ownerless", undefined, "2026-01-06T00:00:00Z", false);

  it("an agent is its workflow's, and one without a workflow id is the unsaved workflow's", () => {
    expect(isAgentOf(a1, 7)).toBe(true);
    expect(isAgentOf(other, 7)).toBe(false);
    expect(isAgentOf(a1, undefined)).toBe(false);
    expect(isAgentOf(unsaved, undefined)).toBe(true);
    expect(isAgentOf(zero, undefined)).toBe(true);
    expect(isAgentOf(ownerless, undefined)).toBe(true);
  });

  it("lists a workflow's agents newest first", () => {
    expect(agentsOf([a1, other, a2, unsaved], 7).map(a => a.id)).toEqual(["a2", "a1"]);
    expect(agentsOf([a1, other, a2, unsaved, zero], undefined).map(a => a.id)).toEqual(["zero", "unsaved"]);
    expect(agentsOf([a1, a2], 9)).toEqual([]);
  });

  it("breaks a tie on creation time in favour of the agent listed later", () => {
    const twin = agent("twin", 7, "2026-01-02T00:00:00Z");
    expect(agentsOf([a2, twin], 7).map(a => a.id)).toEqual(["twin", "a2"]);
    expect(agentsOf([twin, a2], 7).map(a => a.id)).toEqual(["a2", "twin"]);
  });

  it("agentOf is the newest of the workflow's agents, or null", () => {
    expect(agentOf([a1, a2, other], 7)?.id).toBe("a2");
    expect(agentOf([a1, a2, other], 8)?.id).toBe("other");
    expect(agentOf([a1, a2, other], 9)).toBeNull();
    expect(agentOf([], undefined)).toBeNull();
  });
});
