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

import type { AgentInfo } from "./agent.service";

/**
 * Which agents are a workflow's. An agent is made for the workflow that is
 * open at the time; one made before its workflow was saved carries no workflow
 * id and counts as the unsaved workflow's (`workflowId` undefined).
 */
export function isAgentOf(agent: AgentInfo, workflowId: number | undefined): boolean {
  return (agent.delegate?.workflowId || undefined) === workflowId;
}

/** The workflow's agents, newest first (a tie goes to the one listed later). */
export function agentsOf(agents: readonly AgentInfo[], workflowId: number | undefined): AgentInfo[] {
  const time = (agent: AgentInfo) => new Date(agent.createdAt).getTime() || 0;
  return agents
    .map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => isAgentOf(agent, workflowId))
    .sort((a, b) => time(b.agent) - time(a.agent) || b.index - a.index)
    .map(({ agent }) => agent);
}

/** The agent the panel chats with for the workflow: its newest, or null. */
export function agentOf(agents: readonly AgentInfo[], workflowId: number | undefined): AgentInfo | null {
  return agentsOf(agents, workflowId)[0] ?? null;
}
