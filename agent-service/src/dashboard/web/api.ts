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

import type {
  AgentInfo,
  ReActStep,
  WorkflowContent,
  OperatorResultSummary,
  SnapshotTreeResponse,
} from "./types";

/** All endpoints live under this prefix server-side (mirrors `env.API_PREFIX`). */
const API_PREFIX = "/api";

/** Thin fetch wrapper with JSON body + error normalization. The dashboard
 *  is loaded by the agent service itself, so relative URLs always hit the
 *  same origin and we never need CORS handling. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_PREFIX + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error ?? text;
    } catch {
      /* not JSON — keep raw */
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  listAgents(): Promise<{ agents: AgentInfo[] }> {
    return request("/agents");
  },

  getAgent(id: string): Promise<AgentInfo & { workflow: WorkflowContent; stepCount: number }> {
    return request(`/agents/${encodeURIComponent(id)}`);
  },

  deleteAgent(id: string): Promise<{ deleted: true }> {
    return request(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  getReActSteps(id: string): Promise<{ steps: ReActStep[]; state: string }> {
    return request(`/agents/${encodeURIComponent(id)}/react-steps`);
  },

  getOperatorResults(id: string): Promise<{ results: Record<string, OperatorResultSummary> }> {
    return request(`/agents/${encodeURIComponent(id)}/operator-results`);
  },

  getSnapshot(
    id: string,
    stepId: string
  ): Promise<{
    stepId: string | null;
    workflow: WorkflowContent | null;
    workflowSourceStepId: string | null;
    results: Record<string, OperatorResultSummary>;
  }> {
    return request(`/agents/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(stepId)}`);
  },

  getSnapshotTree(id: string): Promise<SnapshotTreeResponse> {
    return request(`/agents/${encodeURIComponent(id)}/snapshot-tree`);
  },

  /**
   * Create an empty agent shell. The dashboard's importer uses this as
   * step 1 of the two-call flow; the resulting agent never talks to the
   * LLM (we immediately overwrite its trace via `importReActSteps`), so
   * `modelType` is just a label — we use `"imported"` by convention.
   */
  createAgent(body: { modelType: string; name?: string }): Promise<AgentInfo> {
    return request(`/agents`, { method: "POST", body: JSON.stringify(body) });
  },

  importReActSteps(
    id: string,
    body: { steps: ReActStep[]; snapshots?: Record<string, WorkflowContent> }
  ): Promise<{ status: string; headId: string; importedCount: number }> {
    return request(`/agents/${encodeURIComponent(id)}/import-react-steps`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};
