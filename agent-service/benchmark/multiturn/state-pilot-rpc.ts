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
/** Benchmark-owned RPC bridge. Replay saved agent actions, never reference code. */
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgent, deleteAgent } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import { nativeDebugInput } from "../e2e/native-debug-input";
import { comparisonAnswer } from "./comparison-answer";
import { replayDebug } from "./state-pilot-debug";

const base = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3071";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
type Resource = { agentId: string; wid: number; cuid: number };
const resources = new Map<string, Resource>();
async function json(path: string, body?: unknown) {
  const response = await fetch(`${base}/api/agents/${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(path.endsWith("/message") ? 1_200_000 : 30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json() as Promise<any>;
}
async function debug(resource: Resource, content: string) {
  const before = (await json(`${resource.agentId}/workflow`)).headId;
  await replayDebug(`${base.replace(/^http/, "ws")}/api/agents/${resource.agentId}/react`, content, {
    confirmCompletion: async () => {
      // This bridge alone writes to its owned agent. A changed head while idle
      // confirms this one submitted action without replaying uncertain edits.
      if ((await json(resource.agentId)).state !== "AVAILABLE") return false;
      return (await json(`${resource.agentId}/workflow`)).headId !== before;
    },
  });
}
async function cleanup(resource: Resource) {
  const state = await json(resource.agentId);
  if (state.state !== "AVAILABLE") {
    await json(`${resource.agentId}/stop`, {});
    for (let n = 0; n < 60; n++) {
      if ((await json(resource.agentId)).state === "AVAILABLE") break;
      await Bun.sleep(500);
    }
  }
  await deleteAgent(resource.agentId, base);
  await terminateComputingUnit(token, resource.cuid);
  await deleteWorkflow(token, resource.wid);
  resources.delete(resource.agentId);
}
async function command(input: any): Promise<any> {
  if (input.action === "create") {
    const cuid = (await createComputingUnit(token, `state-pilot-${Date.now()}`, {
      unitType: "local", uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    })).computingUnit.cuid;
    let wid: number | undefined;
    try {
      wid = await createWorkflow(token, `state-pilot-${Date.now()}`, new WorkflowState().getWorkflowContent());
      const agent = await createAgent({ baseUrl: base, userToken: token, modelType: input.model,
        workflowId: wid, computingUnitId: cuid, settings: input.settings });
      const resource = { agentId: agent.id, wid, cuid };
      resources.set(agent.id, resource);
      return { resource, system: await json(`${agent.id}/system-info`), settings: await json(`${agent.id}/settings`) };
    } catch (error) {
      await terminateComputingUnit(token, cuid);
      if (wid !== undefined) await deleteWorkflow(token, wid);
      throw error;
    }
  }
  const resource = resources.get(input.agentId);
  if (!resource) throw new Error("Unknown benchmark-owned agent");
  const url = resource.agentId;
  if (input.action === "message") {
    const before = new Set((await json(`${url}/react-steps`)).steps.map((s: any) => s.id));
    let response: any;
    try { response = await json(`${url}/message`, { content: input.content }); }
    catch (error) {
      // Never resubmit an uncertain paid request.
      for (let n = 0; n < 1200; n++) {
        if ((await json(url)).state === "AVAILABLE") break;
        await Bun.sleep(1000);
      }
      if ((await json(url)).state !== "AVAILABLE") throw error;
    }
    const all = (await json(`${url}/react-steps`)).steps;
    const steps = all.filter((s: any) => !before.has(s.id));
    const { answer, completed } = comparisonAnswer(steps.filter((s: any) => s.role === "agent"), response?.answer);
    return { answer, completed, steps, headId: (await json(`${url}/workflow`)).headId };
  }
  if (input.action === "clear_cache") {
    const response = await fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource.wid}/cache/clear`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Owned cache clear failed: ${response.status}`);
    return { status: "cleared" };
  }
  if (input.action === "trace") return json(`${url}/react-steps`);
  if (input.action === "capture") {
    const snapshot = await json(`${url}/snapshots/head`);
    console.error(`RPC ${input.id} snapshot captured`);
    const history = await json(`${url}/task-history`);
    console.error(`RPC ${input.id} history captured`);
    const workflow = await json(`${url}/workflow`);
    const observerTables: Record<string, unknown> = {};
    if (input.completeTables) {
      // Private evaluator capture. This engine has no saved-result read
      // endpoint, so every completed table is recorded as not exported rather
      // than reconstructed from the bounded rows the agent saw.
      for (const op of snapshot.workflow?.operators ?? []) {
        const info = snapshot.results?.[op.operatorID];
        if (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)) continue;
        observerTables[op.operatorID] = { complete: false, error: "EXPORT_UNAVAILABLE: no saved-result read endpoint" };
      }
    }
    return { snapshot, history, workflow, headId: workflow.headId, observerTables };
  }
  if (input.action === "checkout") return json(`${url}/checkout`, { stepId: input.stepId });
  if (input.action === "debug") {
    await debug(resource, input.tool ? nativeDebugInput(input.tool, input.args) : input.content);
    return { status: "replayed", headId: (await json(`${url}/workflow`)).headId };
  }
  if (input.action === "delete") { await cleanup(resource); return { status: "deleted" }; }
  throw new Error("Unknown RPC action");
}
try {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const input = JSON.parse(line);
    console.error(`RPC ${input.id} ${input.action} started`);
    let response: unknown;
    try { response = { id: input.id, result: await command(input) }; }
    catch (error) { response = { id: input.id, error: String(error) }; }
    // Large trace/snapshot lines can be truncated by piped console output.
    // Keep bodies in private evaluator artifacts; stdout carries a small receipt.
    const directory = resolve(input.outputDir, "rpc-responses");
    await mkdir(directory, { recursive: true });
    const artifact = resolve(directory, `${input.id}.json`);
    await Bun.write(artifact, JSON.stringify(response));
    console.log(`PILOT_RPC:${JSON.stringify({ id: input.id, artifact })}`);
  }
} finally {
  for (const resource of [...resources.values()]) {
    try { await cleanup(resource); }
    catch (error) { console.error(`Owned resource cleanup failed: ${resource.agentId}: ${String(error)}`); }
  }
}
