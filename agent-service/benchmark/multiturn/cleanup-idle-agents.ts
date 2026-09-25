/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
/** Delete every idle agent on the service together with its workflow and
 * computing unit: the leftovers of smokes whose cleanup could not run. Only
 * AVAILABLE agents are touched; a busy one is listed and skipped. */
import { deleteAgent, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3051";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const agents = ((await (await fetch(`${baseUrl}/api/agents/`)).json()) as { agents: any[] }).agents;
for (const agent of agents) {
  if (agent.state !== "AVAILABLE") {
    console.log(JSON.stringify({ skipped: agent.id, state: agent.state }));
    continue;
  }
  const detail = (await (await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agent.id)}`)).json()) as any;
  const wid = detail.workflowId ?? detail.delegateConfig?.workflowId;
  const cuid = detail.computingUnitId ?? detail.delegateConfig?.computingUnitId;
  await deleteAgent(agent.id, baseUrl);
  const done: Record<string, unknown> = { deleted: agent.id, wid, cuid };
  try {
    if (wid !== undefined) await deleteWorkflow(token, wid);
  } catch (error) {
    done.workflowError = String(error);
  }
  try {
    if (cuid !== undefined) await terminateComputingUnit(token, cuid);
  } catch (error) {
    done.cuError = String(error);
  }
  console.log(JSON.stringify(done));
}
