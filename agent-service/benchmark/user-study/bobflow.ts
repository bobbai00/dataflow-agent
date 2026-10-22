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

/** BobFlow for the user study: a workflow, a computing unit and an agent per participant, over the REST API. */
import { createComputingUnit, createWorkflow } from "../../src/api";
import { STUDY } from "./study";

const LOCAL_CU_URI = process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085";
const FRONTEND = process.env.FE_BASE ?? "http://localhost:4200";
const EMPTY_WORKFLOW = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400 },
};

export interface AgentApi {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
  patch: (path: string, body: unknown) => Promise<any>;
}

export function agentApi(token: string): AgentApi {
  const base = `${STUDY.agentBase}/api/agents`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const parse = async (response: Response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return {
    get: path => fetch(`${base}${path}`, { headers }).then(parse),
    post: (path, body) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).then(parse),
    patch: (path, body) =>
      fetch(`${base}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) }).then(parse),
  };
}

/** The study's computing unit: the one `STUDY_CUID` names, else a new local one. */
export async function studyComputingUnit(token: string): Promise<number> {
  if (process.env.STUDY_CUID) return Number(process.env.STUDY_CUID);
  const unit = await createComputingUnit(token, "user-study", { unitType: "local", uri: LOCAL_CU_URI });
  return unit.computingUnit.cuid;
}

/**
 * A new workflow with a native agent on it, created as the frontend creates
 * one (every operator carries a one-line doc), with any further settings.
 */
export async function createStudyAgent(
  token: string,
  options: { name: string; model: string; agentName?: string; settings?: Record<string, unknown> }
): Promise<{ api: AgentApi; agent: { id: string; name: string }; wid: number; cuid: number }> {
  const api = agentApi(token);
  const cuid = await studyComputingUnit(token);
  const wid = await createWorkflow(token, options.name, EMPTY_WORKFLOW, "BobFlow user study");
  const agent = await api.post("", {
    modelType: options.model,
    name: options.agentName ?? "Bob",
    workflowId: wid,
    computingUnitId: cuid,
    settings: { operatorDoc: true, ...(options.settings ?? {}) },
  });
  if (!agent.id) throw new Error(`agent creation failed: ${JSON.stringify(agent)}`);
  return { api, agent, wid, cuid };
}

export function studyWorkflowUrl(wid: number): string {
  return `${FRONTEND}/user/workflow/${wid}`;
}
