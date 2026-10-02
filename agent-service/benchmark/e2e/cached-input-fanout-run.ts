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

/** Isolate repeated input ports with cached and fresh producers; no model calls. */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import type { DataflowAction, DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3015";
if (!process.env.TEXERA_AGENT_SERVICE_ENDPOINT || !process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT)
  throw new Error("Set explicit isolated agent and engine endpoints before running this probe.");
const directory = mkdtempSync(join(tmpdir(), "cached-fanout-e2e-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const unit = await createComputingUnit(token, `state-history-${Date.now()}`, {
  unitType: "local",
  uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const wid = await createWorkflow(token, `state-history-${Date.now()}`, new WorkflowState().getWorkflowContent());
let agentId = "";
let sequence = 0;

async function debug(content: string) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false,
      finished = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Debug action timed out"));
    }, 40_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "debug", content }));
      }
      if (frame.type === "complete") finished = true;
      if ((frame.type === "nextContext" && finished) || frame.type === "error") {
        clearTimeout(timer);
        ws.close();
        frame.type === "error" ? reject(new Error(String(frame.message ?? frame.content))) : resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Debug transport failed"));
    };
  });
}

function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value!)
      .map(([k, v]) => `${JSON.stringify(k)}:${pythonLiteral(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function actions(items: DataflowAction[], expectedStatus = "completed") {
  const input = { reasoning: "Verify historical definitions and results.", actions: items };
  await debug(`Function(name="dataflow", arguments=${JSON.stringify(pythonLiteral(input))})`);
  const trace = await getReActSteps(agentId, baseUrl);
  const receipt = trace.steps.at(-1)?.toolResults?.[0]?.output as DataflowActionsResult;
  save(`action-${++sequence}.json`, { input, receipt });
  save("trace.json", trace.steps);
  assert.equal(receipt?.status, expectedStatus, JSON.stringify(receipt));
  return receipt;
}
async function executions() {
  const response = await fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok);
  return ((await response.json()) as any[]).length;
}
const textOf = (receipt: DataflowActionsResult, index: number) =>
  String(
    (receipt.actions[index].output as any).text ??
      (receipt.actions[index].output as any).versions?.[0]?.observation?.text
  );

const started = performance.now();
try {
  agentId = (
    await createAgent({
      baseUrl,
      userToken: token,
      modelType: "gpt-5.6-luna",
      workflowId: wid,
      computingUnitId: cuid,
      settings: {
        agentMode: "native",
        contextMode: "delta",
        retrievalViews: ["full"],
        executionTimeoutMinutes: 0.5,
        toolTimeoutSeconds: 35,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, directory, model_calls: 0, engine_deadline_ms: 30000 });
  const file = join(directory, "tiny.csv");
  writeFileSync(file, "value\n1\n2\n");
  writeFileSync(join(directory, "fresh.csv"), "value\n1\n2\n");
  const cached = await actions([
    { type: "edit", changes: `create operator source: scan(${JSON.stringify(file)})` },
    { type: "execute", operator_ids: ["source"] },
    { type: "retrieve", operator_id: "source", view: "full" },
  ]);
  assert.ok(textOf(cached, 2).includes("2"));
  const pair = (id: string, source: string) => `create operator ${id}: process(fn=compare, doc="Count both input ports")
    def compare(a, b):
        import pandas as pd
        return pd.DataFrame({"left_rows": [len(a)], "right_rows": [len(b)], "sum": [a["value"].sum() + b["value"].sum()]})
create edge ${source}.out -> ${id}.in[0]
create edge ${source}.out -> ${id}.in[1]`;
  const checks: any[] = [];
  for (const fresh of [false, true]) {
    const id = fresh ? "fresh_pair" : "cached_pair";
    const changes = fresh
      ? `create operator fresh_source: scan(${JSON.stringify(join(directory, "fresh.csv"))})\n${pair(id, "fresh_source")}`
      : pair(id, "source");
    const start = performance.now();
    const receipt = await actions([{ type: "edit", changes }]);
    assert.equal(receipt.status, "completed");
    // Preserve a timeout as diagnostic evidence rather than failing before the other control.
    const input = {
      reasoning: "Probe repeated source ports.",
      actions: [
        { type: "execute", operator_ids: [id] },
        { type: "retrieve", operator_id: id, view: "full" },
      ],
    };
    await debug(`Function(name="dataflow", arguments=${JSON.stringify(pythonLiteral(input))})`);
    const result = (await getReActSteps(agentId, baseUrl)).steps.at(-1)?.toolResults?.[0]
      ?.output as DataflowActionsResult;
    save(`${id}.json`, result);
    checks.push({
      fresh,
      status: result.status,
      seconds: (performance.now() - start) / 1000,
      errors: result.actions.filter(a => a.status === "error").map(a => a.output),
    });
  }
  const snapshot = await getSnapshot(agentId, "head", baseUrl);
  save("snapshot.json", snapshot);
  for (const { fresh, status } of checks)
    if (status === "completed")
      assert.deepEqual((snapshot.results[fresh ? "fresh_pair" : "cached_pair"] as any).sampleRecords, [
        { left_rows: 2, right_rows: 2, sum: 6 },
      ]);
  save("checks.json", { checks, elapsed_seconds: (performance.now() - started) / 1000, model_calls: 0 });
  console.log(
    JSON.stringify({ directory, checks: checks.map(({ fresh, status, seconds }) => ({ fresh, status, seconds })) })
  );
} finally {
  if (agentId) {
    await fetch(`${baseUrl}/api/agents/${agentId}/stop`, { method: "POST" });
    await deleteAgent(agentId, baseUrl);
  }
  await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
