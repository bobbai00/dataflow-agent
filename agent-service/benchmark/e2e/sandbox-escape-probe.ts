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

/** Zero-model-call check that model-written Python cannot read the repository.
 * Run against an engine whose UDF_PYTHON_PATH is benchmark/retrieval/native_isolated_python.py.
 * A scan of real task data must still work. Uses TEXERA_AGENT_SERVICE_ENDPOINT and backend env.
 * Usage: bun benchmark/e2e/sandbox-escape-probe.ts <repo root>
 */
import { strict as assert } from "node:assert";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import type { DataflowAction, DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { renderDataflowActionsResult } from "../../src/agent/tools/dataflow-actions";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const repo = Bun.argv[2];
assert.ok(repo, "Pass the repository root");

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

const probe = `create operator cities: scan("data/archeology/input/worldcities.csv")
create operator escape: process(fn=escape, doc="Attempt to read outside the task data")
    def escape(cities):
        import os, subprocess
        import pandas as pd
        repo = ${JSON.stringify(repo)}
        def attempt(name, fn):
            try:
                return {"check": name, "result": str(fn())[:160]}
            except Exception as error:
                return {"check": name, "result": "blocked: " + type(error).__name__}
        def run(*argv):
            done = subprocess.run(list(argv), capture_output=True, text=True)
            return f"exit {done.returncode}: {(done.stdout or done.stderr).strip()[:100]}"
        rows = [
            {"check": "task rows scanned", "result": str(len(cities))},
            attempt("cwd", os.getcwd),
            attempt("repo .git exists", lambda: os.path.exists(os.path.join(repo, ".git"))),
            attempt("reports exist", lambda: os.path.exists(os.path.join(repo, "benchmark/retrieval/results"))),
            attempt("cat gold report", lambda: run("cat", os.path.join(repo, "benchmark/retrieval/results/20261002-engine-agent-implementation.txt"))),
            attempt("git show report", lambda: run("git", "-C", repo, "show", "HEAD:benchmark/retrieval/results/20261002-engine-agent-implementation.json")),
            attempt("git from cwd", lambda: run("git", "log", "-1", "--oneline")),
            attempt("home entries", lambda: sorted(os.listdir("/home"))),
            attempt("walk cwd", lambda: sorted({os.path.relpath(r) for r, _, _ in os.walk(".") if r.count(os.sep) <= 2})),
            attempt("touch task data", lambda: run("touch", "data/archeology/input/probe.txt")),
            attempt("data still listed", lambda: sorted(os.listdir("data/archeology/input"))),
        ]
        return pd.DataFrame(rows)
create edge cities.out -> escape.in[0]`;

const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const cu = await createComputingUnit(token, `sandbox-probe-${Date.now()}`, {
  unitType: "local",
  uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = cu.computingUnit.cuid;
const wid = await createWorkflow(token, `sandbox-probe-${Date.now()}`, new WorkflowState().getWorkflowContent());
let agentId = "";
try {
  const agent = await createAgent({
    baseUrl, userToken: token, modelType: "gemini-3.8-flash", workflowId: wid, computingUnitId: cuid,
    settings: { agentMode: "native", contextMode: "delta", messageLayout: "native", maxSteps: 4,
      dataEvidence: false, flowEvidence: false, resultSelection: "all" },
  });
  agentId = agent.id;
  await debug(agentId, [{ type: "edit", changes: probe }, { type: "execute" }, { type: "retrieve", operator_id: "escape", view: "full" }]);
  const trace = await getReActSteps(agentId, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)!.output as DataflowActionsResult;
  console.log(renderDataflowActionsResult(result));
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl).catch(() => {});
  await deleteWorkflow(token, wid).catch(() => {});
  await terminateComputingUnit(token, cuid).catch(() => {});
}
