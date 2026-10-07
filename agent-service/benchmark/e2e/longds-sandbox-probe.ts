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

/** Zero-model-call check that model-written Python in a LongDS session cannot
 * read gold answers, reference material or the repository, while a scan of the
 * session's own data still works. Run against an engine whose UDF_PYTHON_PATH is
 * benchmark/retrieval/native_isolated_python.py.
 * Usage: bun benchmark/e2e/longds-sandbox-probe.ts <repo root> <data file> <gold file>
 */
import { strict as assert } from "node:assert";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import type { DataflowAction, DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { renderDataflowActionsResult } from "../../src/agent/tools/dataflow-actions";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const [repo, dataFile, goldFile] = Bun.argv.slice(2);
assert.ok(repo && dataFile && goldFile, "Pass the repository root, a session data file and a gold file");

async function debug(agentId: string, actions: DataflowAction[]) {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false;
    const timer = setTimeout(() => (ws.close(), reject(new Error("Debug action timed out"))), 240_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        const args = { reasoning: "Probe the execution sandbox.", actions };
        ws.send(JSON.stringify({ type: "debug", content: `Function(name="dataflow", arguments=${JSON.stringify(JSON.stringify(args))})` }));
      } else if (frame.type === "complete" || frame.type === "error") {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => (clearTimeout(timer), ws.close(), reject(new Error("Debug WebSocket failed")));
  });
}

const probe = `events = scan(${JSON.stringify(dataFile)})
def escape(events):
    """One row per attempt to read or write outside the session's data, with its result."""
    import os, subprocess
    repo, gold = ${JSON.stringify(repo)}, ${JSON.stringify(goldFile)}
    def attempt(name, fn):
        try:
            return {"check": name, "result": str(fn())[:160]}
        except Exception as error:
            return {"check": name, "result": "blocked: " + type(error).__name__}
    def run(*argv):
        done = subprocess.run(list(argv), capture_output=True, text=True)
        return f"exit {done.returncode}: {(done.stdout or done.stderr).strip()[:100]}"
    rows = [
        {"check": "session rows scanned", "result": str(len(events))},
        attempt("cwd", os.getcwd),
        attempt("gold file exists", lambda: os.path.exists(gold)),
        attempt("cat gold file", lambda: run("cat", gold)),
        attempt("reference material listed", lambda: sorted(os.listdir(os.path.join(repo, "benchmark/longds/DataMind")))),
        attempt("repo .git exists", lambda: os.path.exists(os.path.join(repo, ".git"))),
        attempt("git log in repo", lambda: run("git", "-C", repo, "log", "-1", "--oneline")),
        attempt("home entries", lambda: sorted(os.listdir("/home"))),
        attempt("/var/tmp entries", lambda: sorted(os.listdir("/var/tmp"))[:5]),
        attempt("write into the data", lambda: run("touch", os.path.join(os.path.dirname(${JSON.stringify(dataFile)}), "probe.txt"))),
    ]
    return pd.DataFrame(rows)
attempts = escape(events)`;

const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const cu = await createComputingUnit(token, `longds-sandbox-probe-${Date.now()}`, {
  unitType: "local",
  uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = cu.computingUnit.cuid;
const wid = await createWorkflow(token, `longds-sandbox-probe-${Date.now()}`, new WorkflowState().getWorkflowContent());
let agentId = "";
try {
  const agent = await createAgent({
    baseUrl, userToken: token, modelType: "gpt-5.6-luna", workflowId: wid, computingUnitId: cuid,
    settings: { agentMode: "native", contextMode: "delta", messageLayout: "native", maxSteps: 4,
      dataEvidence: false, flowEvidence: false, resultSelection: "all" },
  });
  agentId = agent.id;
  await debug(agentId, [{ type: "edit", changes: probe }, { type: "execute" }, { type: "retrieve", operator_id: "attempts", view: "full" }]);
  const trace = await getReActSteps(agentId, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)!.output as DataflowActionsResult;
  console.log(renderDataflowActionsResult(result));
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl).catch(() => {});
  await deleteWorkflow(token, wid).catch(() => {});
  await terminateComputingUnit(token, cuid).catch(() => {});
}
