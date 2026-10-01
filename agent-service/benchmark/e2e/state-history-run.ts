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

/** Deterministic multi-task actions against the real engine, without model calls. */
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
const directory = mkdtempSync(join(tmpdir(), "state-history-e2e-"));
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
    }, 240_000);
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
async function actions(items: DataflowAction[]) {
  const input = { reasoning: "Verify historical definitions and results.", actions: items };
  await debug(`Function(name="dataflow", arguments=${JSON.stringify(pythonLiteral(input))})`);
  const trace = await getReActSteps(agentId, baseUrl);
  const receipt = trace.steps.at(-1)?.toolResults?.[0]?.output as DataflowActionsResult;
  save(`action-${++sequence}.json`, { input, receipt });
  save("trace.json", trace.steps);
  assert.equal(receipt?.status, "completed", JSON.stringify(receipt));
  return receipt;
}
async function executions() {
  const response = await fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok);
  return ((await response.json()) as any[]).length;
}
const textOf = (receipt: DataflowActionsResult, index: number) => String((receipt.actions[index].output as any).text);

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
        stateHistory: true,
        nativeProfileCollection: true,
        maxOperatorResultCharLimit: 2000,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, directory });
  const settings = await (await fetch(`${baseUrl}/api/agents/${agentId}/settings`)).json();
  assert.equal((settings as { stateHistory: boolean }).stateHistory, true, "The API must report the effective history setting");
  console.log(`Historical-state engine smoke: ${directory}`);
  const oldFile = join(directory, "old.csv"),
    newFile = join(directory, "new.csv");
  writeFileSync(oldFile, "unit,net,quality\nA,10,1\nB,20,0\nC,5,1\n");
  writeFileSync(newFile, "unit,net,quality\nA,100,1\nB,200,0\nC,50,1\nD,7,1\n");
  await debug("Task 1: compute the quality-qualified total.");
  await actions([
    {
      type: "edit",
      changes: `create operator source: scan(${JSON.stringify(oldFile)})
create operator eligible: filter(lambda row: row["net"] > 0 and row["quality"] == 1, doc="Positive net and quality")
create operator total: aggregate(n=count(), amount=sum("net"))
create edge source.out -> eligible.in
create edge eligible.out -> total.in`,
    },
    { type: "execute" },
    { type: "retrieve", operator_id: "total" },
  ]);
  await actions([{ type: "answer", content: "Two units, total 15." }]);
  await debug("Task 2: change the population and remove the quality condition.");
  await actions([
    {
      type: "edit",
      changes: `update operator source: scan(${JSON.stringify(newFile)})
update operator eligible: filter(lambda row: row["net"] > 0, doc="Positive net")`,
    },
    { type: "execute" },
  ]);
  await actions([{ type: "answer", content: "Four units, total 357." }]);
  await debug("Task 3: recover the earlier gate and compare its old and current populations.");
  const before = await executions();
  const read = await actions([
    { type: "inspect", target: "state", task_id: null, operator_id: "total", include_implementation: true },
    { type: "retrieve", task_id: 1, operator_id: "total" },
    { type: "fork", task_id: 1, operator_id: "total", new_operator_id: "old_total" },
    { type: "retrieve", operator_id: "old_total" },
    { type: "retrieve", operator_id: "total" },
  ]);
  assert.equal(await executions(), before, "Inspect, fork and retrieve must not execute");
  assert.ok(textOf(read, 1).includes("15"));
  assert.equal(textOf(read, 1), textOf(read, 3));
  assert.ok(textOf(read, 4).includes("357"));
  const executed = await actions([{ type: "execute" }, { type: "retrieve", operator_id: "old_total" }]);
  assert.ok(textOf(executed, 1).includes("15"));
  assert.equal((executed.actions[1].output as any).historical_state, undefined);
  await actions([
    {
      type: "edit",
      changes: `delete edge old_total__source.out -> old_total__eligible.in
create edge source.out -> old_total__eligible.in`,
    },
    { type: "execute" },
    { type: "retrieve", operator_id: "old_total" },
  ]);
  const snapshot = await getSnapshot(agentId, "head", baseUrl);
  save("final-snapshot.json", snapshot);
  assert.deepEqual((snapshot.results.old_total as any).sampleRecords, [{ n: 3, amount: 157 }]);
  assert.deepEqual((snapshot.results.total as any).sampleRecords, [{ n: 4, amount: 357 }]);
  const original = await actions([{ type: "retrieve", task_id: 1, operator_id: "total" }]);
  assert.ok(textOf(original, 0).includes("15"));
  save("trace.json", (await getReActSteps(agentId, baseUrl)).steps);
  save("checks.json", {
    passed: true,
    saved_result_read_without_execution: true,
    historical_dependency_closure: true,
    old_formula_current_population: true,
    current_baseline_preserved: true,
  });
  console.log("PASS: historical reads, fork execution, rewiring, and baseline isolation");
} catch (error) {
  save("failure.json", { error: error instanceof Error ? error.stack : String(error), agentId, wid, cuid });
  throw error;
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl);
  await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
