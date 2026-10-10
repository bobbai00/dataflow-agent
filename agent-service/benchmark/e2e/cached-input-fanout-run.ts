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
import type { DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { dataflowDebugInput, shownResult } from "./native-debug-input";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3015";
if (!process.env.TEXERA_AGENT_SERVICE_ENDPOINT || !process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT)
  throw new Error("Set explicit isolated agent and engine endpoints before running this probe.");
const directory = mkdtempSync(join(tmpdir(), "cached-fanout-e2e-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const unit = await createComputingUnit(token, `cached-fanout-${Date.now()}`, {
  unitType: "local",
  uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const wid = await createWorkflow(token, `cached-fanout-${Date.now()}`, new WorkflowState().getWorkflowContent());
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

async function call(python: string, statements: string, expectedStatus?: string) {
  await debug(dataflowDebugInput(python, statements, ["full"]));
  const trace = await getReActSteps(agentId, baseUrl);
  const receipt = trace.steps.at(-1)?.toolResults?.[0]?.output as DataflowActionsResult;
  save(`call-${++sequence}.json`, { python, statements, receipt });
  save("trace.json", trace.steps);
  if (expectedStatus) assert.equal(receipt?.status, expectedStatus, JSON.stringify(receipt));
  return receipt;
}

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
  const cached = await call(
    "",
    `set source: scan(files=${JSON.stringify(file)})\nshow result source full`,
    "completed"
  );
  assert.ok(String(shownResult(cached, "source").text).includes("2"));
  const compare = `import pandas as pd

def compare(a, b):
    """Count the rows on both input ports."""
    return pd.DataFrame({"left_rows": [len(a)], "right_rows": [len(b)], "sum": [a["value"].sum() + b["value"].sum()]})`;
  const checks: any[] = [];
  for (const fresh of [false, true]) {
    const id = fresh ? "fresh_pair" : "cached_pair";
    const statements = fresh
      ? `set fresh_source: scan(files=${JSON.stringify(join(directory, "fresh.csv"))})\nset ${id}: compare(fresh_source, fresh_source)`
      : `set ${id}: compare(source, source)`;
    const start = performance.now();
    await call(fresh ? "" : compare, statements, "completed");
    // Preserve a timeout as diagnostic evidence rather than failing before the other control.
    const result = await call("", `show result ${id} full`);
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
