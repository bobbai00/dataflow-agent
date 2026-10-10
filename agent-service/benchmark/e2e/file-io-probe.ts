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

/** Live check that a registered loader may read a file with open(). The
 * engine's static UDF scan rejects open() unless UDF_PYTHON_ALLOW_FILE_IO=true.
 * No model request is made. Run from agent-service:
 * bun benchmark/e2e/file-io-probe.ts
 * Requires bin/local-dev.sh services from this checkout. Artifacts go to /tmp.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import type { RetrievalView } from "../../src/types/agent";
import { renderDataflowActionsResult, type DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { dataflowDebugInput } from "./native-debug-input";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = mkdtempSync(join(tmpdir(), "file-io-probe-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const log = (message: string) => console.log(`[file-io-probe] ${message}`);
const views: RetrievalView[] = ["full", "sample_stats"];
let token: string;
let cuid: number | undefined;
let resource: { agentId: string; wid: number; cuid: number } | undefined;

async function json(url: string, authenticated = false): Promise<any> {
  const response = await fetch(url, authenticated ? { headers: { Authorization: `Bearer ${token}` } } : {});
  assert.equal(response.status, 200, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}
const history = () => json(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource!.wid}`, true);

async function debug(python: string, statements: string): Promise<string> {
  const content = dataflowDebugInput(python, statements, views);
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
    const timer = setTimeout(
      () => fail("Debug call timed out; resources require terminal-state checks before cleanup."),
      240_000
    );
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

const loaders = `import pandas as pd
def load_with_open(*, path):
    """Read a CSV through the builtin open()."""
    with open(path, encoding='utf-8') as source:
        return pd.read_csv(source)
`;

try {
  log(`Artifacts: ${directory}`);
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const unit = await createComputingUnit(token, `file-io-probe-${Date.now()}`, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = unit.computingUnit.cuid;
  const wid = await createWorkflow(token, `file-io-probe-${Date.now()}`, new WorkflowState().getWorkflowContent());
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
      retrievalViews: views,
      nativeProfileCollection: true,
      dataEvidence: true,
      flowEvidence: true,
      maxSteps: 4,
    },
  });
  resource.agentId = agent.id;
  save("resource.json", resource);
  const sourcePath = join(directory, "records.csv");
  writeFileSync(sourcePath, "id,value\n1,10\n2,20\n");

  const before = await history();
  const context = await debug(
    loaders,
    `set rows: load_with_open(path=${JSON.stringify(sourcePath)})\nshow result rows full`
  );
  const trace = await getReActSteps(agent.id, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)?.output as DataflowActionsResult;
  const snapshot = await getSnapshot(agent.id, "head", baseUrl);
  save("probe.json", { result, snapshot, before, after: await history() });
  writeFileSync(join(directory, "probe-receipt.md"), renderDataflowActionsResult(result));
  writeFileSync(join(directory, "probe-context.txt"), context);
  assert.equal(result.protocol, "registered-python-v1", "The live service must run this checkout's protocol.");
  assert.deepEqual(
    result.actions.map(action => action.status),
    ["ok", "ok", "ok"],
    renderDataflowActionsResult(result)
  );
  assert.equal(((snapshot.results.rows as any)?.sampleRecords ?? []).length, 2, "the loader read both records");
  save("trace.json", trace.steps);
  save("summary.json", { passed: true });
  log(`PASS a registered loader may call open(). Artifacts: ${directory}`);
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
  save("cleanup.json", { resource, removed: safe, computingUnitTerminated: cuid !== undefined && safe });
}
