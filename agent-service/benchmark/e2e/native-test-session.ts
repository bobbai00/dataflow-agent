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
import {
  createAgent,
  createComputingUnit,
  createWorkflow,
  deleteAgent,
  deleteWorkflow,
  getReActSteps,
  getSnapshot,
  getBackendConfig,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { WorkflowSnapshotStorage } from "../../src/agent/workflow-snapshot-storage";
import { assembleContext } from "../../src/agent/util/context-utils";
import { AgentMode, ContextMode, type AgentSettingsApi, type ReActStep } from "../../src/types/agent";
import type { OperatorInfo } from "../../src/types/execution";
import { nativeDebugInput } from "./native-debug-input";
import { assertNativeCleanupSafe } from "./native-cleanup";

/** Real execution via debug; context is assembled from the service's actual
 * snapshots with production code. This is deliberately NOT an LLM input test. */
export async function nativeTestSession(settings: AgentSettingsApi = {}) {
  const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3011";
  const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const name = `native-v2-smoke-${Date.now()}`;
  let cuid: number | undefined, wid: number | undefined, agentId: string | undefined;
  const steps: ReActStep[] = [];
  const state = new WorkflowState();
  const storage = new WorkflowSnapshotStorage(id =>
    steps.slice(0, steps.findIndex(step => step.id === id) + 1).map(step => step.id)
  );
  let priorResults: Record<string, unknown> = {};

  async function close() {
    if (!agentId || wid === undefined || cuid === undefined)
      throw new Error(`Native smoke setup unresolved; retaining resources ${JSON.stringify({ agentId, wid, cuid })}`);
    const read = async (url: string) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(response.ok, `Native smoke cleanup preflight HTTP ${response.status}`);
      return response.json();
    };
    const [agent, history] = await Promise.all([
      read(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`),
      read(`${getBackendConfig().apiEndpoint}/api/executions/${wid}`),
    ]);
    assertNativeCleanupSafe(agent, history, { agentId, wid, cuid });
    await deleteAgent(agentId, baseUrl);
    await deleteWorkflow(token, wid);
    await terminateComputingUnit(token, cuid);
  }

  try {
    cuid = (
      await createComputingUnit(token, name, {
        unitType: "local",
        uri: process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085",
      })
    ).computingUnit.cuid;
    wid = await createWorkflow(token, name, state.getWorkflowContent());
    agentId = (
      await createAgent({
        baseUrl,
        userToken: token,
        workflowId: wid,
        computingUnitId: cuid,
        modelType: "gpt-5.6-luna",
        settings: {
          agentMode: "native",
          nativeToolMode: "batch",
          nativeCatalogVersion: "v2",
          contextMode: "delta",
          resultSelection: "all",
          parallelToolCalls: false,
          flowEvidence: false,
          dataEvidence: false,
          ...settings,
        },
      })
    ).id;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Native smoke setup failed; unresolved resources retained");
    }
    throw error;
  }

  function render(mode: ContextMode): string {
    return assembleContext(steps, state, storage, mode, {
      agentMode: AgentMode.NATIVE,
      resultSelection: "all",
      flowEvidence: false,
      dataEvidence: false,
    })
      .map(message => message.content)
      .join("\n");
  }

  // Plain text starts a user task, letting later Function calls share the
  // production task boundary (including task-scoped validation repair state).
  async function debug(args: Record<string, unknown> | string, tool = "dataflow") {
    const debugInput = typeof args === "string" ? args : nativeDebugInput(tool, args);
    let completionAnswer = "";
    let serviceContext = "";
    const results = await new Promise<Record<string, any>>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
      let sent = false,
        completed = false,
        finished = false;
      let result: Record<string, any> = {};
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        ws.close();
        if (error) reject(error);
        else resolve(result);
      };
      const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${tool}`)), 180_000);
      ws.onmessage = event => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "init" && !sent) {
          sent = true;
          ws.send(
            JSON.stringify({
              type: "debug",
              content: debugInput,
            })
          );
        } else if (frame.type === "error") finish(new Error(frame.error));
        else if (frame.type === "complete") {
          completed = true;
          result = frame.operatorResults;
          completionAnswer = frame.answer ?? "";
        } else if (frame.type === "nextContext" && completed) {
          serviceContext = typeof frame.content === "string" ? frame.content : JSON.stringify(frame.content);
          finish();
        }
      };
      ws.onerror = () => finish(new Error("Native smoke WebSocket error"));
      ws.onclose = () => {
        if (!finished) finish(new Error("Native smoke WebSocket closed before completion"));
      };
    });
    steps.splice(0, steps.length, ...(await getReActSteps(agentId!, baseUrl)).steps);
    const step = steps.at(-1)!;
    if (typeof args === "string") {
      assert.equal(step.role, "user", "Debug endpoint did not start a user task");
      assert.equal(step.content, args);
    } else
      assert.ok(
        step.toolCalls?.some(call => call.toolName === tool),
        `Debug endpoint did not record ${tool}: ${completionAnswer}`
      );
    const snapshot = await getSnapshot(agentId!, "head", baseUrl);
    assert.ok(snapshot.workflow);
    state.setWorkflowContent(snapshot.workflow);
    storage.createSnapshot(step.id, snapshot.workflow);
    const edited = new Set(
      (step.toolResults?.[0]?.output?.operators ?? [])
        .filter((op: any) => ["added", "modified"].includes(op.status))
        .map((op: any) => op.id)
    );
    for (const [id, value] of Object.entries(snapshot.results)) {
      if (!edited.has(id) && JSON.stringify(priorResults[id]) === JSON.stringify(value)) continue;
      const summary = value as any;
      storage.setOperatorResult(step.id, id, { ...summary, result: summary.sampleRecords } as OperatorInfo);
    }
    priorResults = snapshot.results;
    const delta = render(ContextMode.DELTA);
    const latest = render(ContextMode.LATEST);
    const observation = delta.slice(delta.lastIndexOf("Observation:"));
    return { results, snapshot, step, delta, latest, observation, serviceContext };
  }

  return {
    baseUrl,
    agentId: agentId!,
    workflowId: wid!,
    computingUnitId: cuid!,
    debug,
    render,
    close,
    snapshot: () => getSnapshot(agentId!, "head", baseUrl),
    trace: () => getReActSteps(agentId!, baseUrl),
    settings: async (): Promise<AgentSettingsApi> =>
      (await fetch(`${baseUrl}/api/agents/${agentId}/settings`)).json() as Promise<AgentSettingsApi>,
    request: (path: string, method = "GET", body?: unknown) =>
      fetch(`${baseUrl}/api/agents${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}
