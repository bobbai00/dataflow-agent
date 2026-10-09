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

/** Two-task registered-Python probe through the live agent and Amber engine,
 * with no model request: an unrelated definition leaving results current, and
 * a `name@N` input that computes the earlier version beside the current one.
 * Run from agent-service:
 * bun benchmark/e2e/registered-versions-run.ts
 * Requires bin/local-dev.sh services from this checkout.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import {
  renderDataflowActionsResult,
  type DataflowAction,
  type DataflowActionsResult,
} from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = mkdtempSync(join(tmpdir(), "registered-versions-live-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const log = (message: string) => console.log(`[registered-versions] ${message}`);
let token: string;
let cuid: number | undefined;
let resource: { agentId: string; wid: number; cuid: number } | undefined;

async function json(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}
const history = () => json(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource!.wid}`);

/** Send one debug frame (a new request, or a dataflow call) and return the next context. */
function debug(content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${resource!.agentId}/react`);
    let sent = false,
      completed = false,
      settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Debug input timed out."), 240_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "debug", content }));
      } else if (frame.type === "complete" || frame.type === "error") completed = true;
      else if (frame.type === "nextContext" && completed) {
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve(frame.content);
      }
    };
    ws.onerror = () => fail("Debug WebSocket failed.");
    ws.onclose = () => {
      if (!settled) fail("Debug WebSocket closed before its final context.");
    };
  });
}
async function call(name: string, actions: DataflowAction[]): Promise<DataflowActionsResult> {
  const args = { reasoning: name, actions };
  await debug(`Function(name="dataflow", arguments=${JSON.stringify(JSON.stringify(args))})`);
  const trace = await getReActSteps(resource!.agentId, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)?.output as DataflowActionsResult;
  writeFileSync(join(directory, `${name.replace(/\W+/g, "-")}.md`), renderDataflowActionsResult(result));
  assert.equal(result.protocol, "registered-python-v1", "The live service must run this checkout's protocol.");
  assert.ok(
    result.actions.every(action => action.status === "ok"),
    `${name}: ${renderDataflowActionsResult(result)}`
  );
  return result;
}
const values = async (id: string) =>
  ((await getSnapshot(resource!.agentId, "head", baseUrl)).results[id] as any)?.sampleRecords?.map(
    (row: any) => row.value
  );

const definitions = `import pandas as pd
RATE = 2
def load_values():
    """Two synthetic values."""
    return pd.DataFrame({'value': [1, 2]})
def priced(table):
    """Multiply value by the rate."""
    return table.assign(value=table['value'] * RATE)
`;

try {
  log(`Artifacts: ${directory}`);
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const unit = await createComputingUnit(token, `registered-versions-${Date.now()}`, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = unit.computingUnit.cuid;
  const wid = await createWorkflow(
    token,
    `registered-versions-${Date.now()}`,
    new WorkflowState().getWorkflowContent()
  );
  resource = { agentId: "", wid, cuid };
  const agent = await createAgent({
    baseUrl,
    userToken: token,
    modelType: process.env.TEXERA_AGENT_MODEL ?? "gpt-5.6-luna",
    workflowId: wid,
    computingUnitId: cuid,
    settings: {
      agentMode: "native",
      contextMode: "delta",
      messageLayout: "native",
      retrievalViews: ["full"],
      multiTask: true,
    },
  });
  resource.agentId = agent.id;

  await debug("Task one: price the values.");
  await call("build and run task one", [
    { type: "edit", python: definitions, changes: "set raw: load_values()\nset prices: priced(raw)" },
    { type: "execute", operator_ids: ["prices"] },
    { type: "retrieve", operator_ids: ["prices"], view: "full" },
  ]);
  assert.deepEqual(await values("prices"), [2, 4]);
  await call("answer task one", [{ type: "answer", content: "2 and 4." }]);
  log("PASS task one computed and answered");

  await debug("Task two: compare with the first rate.");

  const before = (await history()).length;
  const unrelated = await call("register an unrelated function", [
    { type: "edit", python: "def unrelated(table):\n    return table", changes: "" },
  ]);
  const unrelatedText = renderDataflowActionsResult(unrelated);
  assert.doesNotMatch(unrelatedText, /operator prices updated/);
  assert.doesNotMatch(unrelatedText, /Execute before retrieving/);
  log("PASS an unrelated definition leaves results current");

  const compared = await call("compare the first version with the current one", [
    { type: "edit", python: "RATE = 3", changes: "set both: union(prices@1, prices)" },
    { type: "execute", operator_ids: ["both"] },
    { type: "retrieve", operator_ids: ["both"], view: "full" },
  ]);
  assert.match(
    renderDataflowActionsResult(compared),
    /operator prices updated \(priced\); the definitions its function uses changed/
  );
  assert.deepEqual(await values("both"), [2, 4, 3, 6]);
  const head = await getSnapshot(agent.id, "head", baseUrl);
  const copy = head.workflow?.operators.find(op => op.operatorID === "prices@1");
  assert.deepEqual(copy?.nativeOp?.savedFrom, { task: 1, id: "prices" });
  assert.ok((await history()).length > before, "The comparison must execute.");
  await call("answer task two", [
    { type: "answer", content: "The first rate gives 2 and 4; the current gives 3 and 6." },
  ]);
  log("PASS name@N computes the earlier version beside the current one");
  save("trace.json", (await getReActSteps(agent.id, baseUrl)).steps);
  save("summary.json", { passed: true });
  log(`All checks passed. Artifacts: ${directory}`);
} catch (error) {
  save("summary.json", { passed: false, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  let safe = true;
  try {
    if (resource) {
      if (resource.agentId) {
        assertNativeCleanupSafe(await json(`${baseUrl}/api/agents/${resource.agentId}`), await history(), resource);
        await deleteAgent(resource.agentId, baseUrl);
      }
      await deleteWorkflow(token!, resource.wid);
    }
  } catch (error) {
    safe = false;
    save("cleanup-error.json", { error: String(error), resource });
    log(`Resources retained; inspect ${join(directory, "cleanup-error.json")}`);
  }
  if (cuid !== undefined && safe) await terminateComputingUnit(token!, cuid);
}
