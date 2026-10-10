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

/** Deterministic registered-Python protocol probe through the live agent and
 * Amber engine. No model request is made. Run from agent-service:
 * bun benchmark/e2e/registered-python-run.ts
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
import {
  renderDataflowActionsResult,
  type DataflowAction,
  type DataflowActionsResult,
} from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = mkdtempSync(join(tmpdir(), "registered-python-live-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const log = (message: string) => console.log(`[registered-python] ${message}`);
const checks: Array<{ name: string; newExecutions: number }> = [];
let token: string;
let cuid: number | undefined;
let resource: { agentId: string; wid: number; cuid: number } | undefined;
let probe = 0;

async function json(url: string, authenticated = false): Promise<any> {
  const response = await fetch(url, authenticated ? { headers: { Authorization: `Bearer ${token}` } } : {});
  assert.equal(response.status, 200, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}
const history = () => json(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource!.wid}`, true);

async function debug(actions: DataflowAction[]): Promise<string> {
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
      () => fail("Debug action timed out; resources require terminal-state checks before cleanup."),
      240_000
    );
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        const args = { reasoning: "Verify registered Python execution and observations.", actions };
        ws.send(
          JSON.stringify({
            type: "debug",
            content: `Function(name="dataflow", arguments=${JSON.stringify(JSON.stringify(args))})`,
          })
        );
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

const edit = (python: string, changes = ""): DataflowAction => ({ type: "edit", python, changes });
const retrieve = (operator_ids: string[]): DataflowAction => ({ type: "retrieve", operator_ids, view: "full" });
const execute = (operator_ids: string[]): DataflowAction => ({ type: "execute", operator_ids });

async function run(name: string, actions: DataflowAction[], statuses: string[], computes: boolean) {
  const before = await history();
  const context = await debug(actions);
  const trace = await getReActSteps(resource!.agentId, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)?.output as DataflowActionsResult;
  const snapshot = await getSnapshot(resource!.agentId, "head", baseUrl);
  const after = await history();
  const newExecutions = after.length - before.length;
  const index = ++probe;
  save(`probe-${index}.json`, { name, actions, result, snapshot, before, after });
  writeFileSync(join(directory, `probe-${index}-observations.md`), renderDataflowActionsResult(result));
  writeFileSync(join(directory, `probe-${index}-context.txt`), context);
  assert.equal(
    result.protocol,
    "registered-python-v1",
    "The live service must run this checkout's registered protocol."
  );
  assert.deepEqual(
    result.actions.map(action => action.status),
    statuses,
    name
  );
  assert.ok(
    computes ? newExecutions > 0 : newExecutions === 0,
    `${name}: unexpected backend execution count ${newExecutions}`
  );
  checks.push({ name, newExecutions });
  log(`PASS ${name}: ${newExecutions} backend executions`);
  return { result, snapshot };
}
const rows = (snapshot: Awaited<ReturnType<typeof getSnapshot>>, id: string): Array<Record<string, any>> =>
  (snapshot.results[id] as any)?.sampleRecords ?? [];

const definitions = `import pandas as pd
COUNTER = 0
def _adjust(value):
    return value + 1
def load_values(*, start=1):
    """Create two synthetic records with a per-invocation counter."""
    global COUNTER
    COUNTER += 1
    return pd.DataFrame({'id': [1, 2], 'value': [start, start + 1], 'invocations': [COUNTER, COUNTER]})
def scale_values(table, *, factor=1):
    """Adjust and scale values without changing input rows."""
    result = table.copy()
    result['value'] = result['value'].apply(_adjust) * factor
    return result
def combine_values(left, right, *, multiplier=1):
    """Combine the value sums of two input tables."""
    return pd.DataFrame({'value': [(left['value'].sum() + right['value'].sum()) * multiplier]})
`;

try {
  log(`Artifacts: ${directory}`);
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const unit = await createComputingUnit(token, `registered-python-${Date.now()}`, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = unit.computingUnit.cuid;
  const wid = await createWorkflow(token, `registered-python-${Date.now()}`, new WorkflowState().getWorkflowContent());
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
      retrievalViews: ["full", "sample_stats"],
      nativeProfileCollection: true,
      dataEvidence: true,
      flowEvidence: true,
      maxSteps: 4,
    },
  });
  resource.agentId = agent.id;
  save("resource.json", resource);
  save("system-info.json", await json(`${baseUrl}/api/agents/${agent.id}/system-info`));
  const sourcePath = join(directory, "records.csv");
  writeFileSync(sourcePath, "id,value\n1,10\n2,20\n");

  const registered = await run(
    "register before graph construction",
    [edit(definitions), { type: "inspect", target: "namespace" }],
    ["ok", "ok"],
    false
  );
  assert.equal(registered.snapshot.workflow?.operators.length, 0);
  assert.ok(registered.snapshot.workflow?.nativeNamespace?.functions.combine_values);
  assert.match(renderDataflowActionsResult(registered.result), /function load_values registered/);

  const initial = await run(
    "zero, one and multiple inputs with keyword settings",
    [
      edit(
        "",
        `set left: load_values()\nset right: load_values(start=3)\nset scaled: scale_values(left, factor=2)\nset combined: combine_values(scaled, right, multiplier=3)\nset independent: scan(files=${JSON.stringify(sourcePath)})`
      ),
      execute(["combined", "independent"]),
      retrieve(["left", "right", "scaled", "combined", "independent"]),
    ],
    ["ok", "ok", "ok"],
    true
  );
  assert.equal(rows(initial.snapshot, "combined")[0].value, 51);
  for (const id of ["left", "right"])
    assert.deepEqual(
      rows(initial.snapshot, id).map(row => row.invocations),
      [1, 1]
    );

  const mixed = await run(
    "mixed retrieval preserves valid targets",
    [retrieve(["combined", "missing", "independent"])],
    ["error"],
    false
  );
  assert.deepEqual(
    (mixed.result.actions[0].output as any).results.map((entry: any) => entry.status),
    ["ok", "error", "ok"]
  );
  assert.deepEqual(mixed.result.observe, ["combined", "independent"]);

  const stale = await run(
    "helper update invalidates without automatic execution",
    [edit("def _adjust(value):\n    return value + 2"), retrieve(["independent", "combined"])],
    ["ok", "error"],
    false
  );
  assert.match(renderDataflowActionsResult(stale.result), /RESULT_STALE/);
  assert.deepEqual(rows(stale.snapshot, "independent"), rows(initial.snapshot, "independent"));
  const revised = await run(
    "explicit execution uses the new shared definition",
    [execute(["combined"]), retrieve(["left", "right", "combined"])],
    ["ok", "ok"],
    true
  );
  assert.equal(rows(revised.snapshot, "combined")[0].value, 63);
  for (const id of ["left", "right"])
    assert.deepEqual(
      rows(revised.snapshot, id).map(row => row.invocations),
      [1, 1]
    );

  const documented = await run(
    "documentation-only edit preserves materialization",
    [edit("", "set scaled: scale_values(left, factor=2, doc='Preserve every source record.')"), retrieve(["combined"])],
    ["ok", "ok"],
    false
  );
  assert.equal(
    (documented.snapshot.results.combined as any).resultVersion.id,
    (revised.snapshot.results.combined as any).resultVersion.id
  );

  const failed = await run(
    "execution error retains independent reads",
    [
      edit("def scale_values(table, *, factor=1):\n    raise ValueError('synthetic conversion failure')"),
      execute(["combined"]),
      retrieve(["independent", "scaled"]),
    ],
    ["ok", "error", "error"],
    true
  );
  assert.match(renderDataflowActionsResult(failed.result), /synthetic conversion failure/);
  assert.equal((failed.result.actions[2].output as any).results[0].status, "ok");

  const repaired = await run(
    "replace the same function and refine its settings",
    [
      edit(
        "def scale_values(table, *, factor=1):\n    result = table.copy()\n    result['value'] = result['value'].apply(_adjust) * factor\n    return result",
        "set scaled: scale_values(left, factor=3)"
      ),
      execute(["combined"]),
      retrieve(["combined"]),
    ],
    ["ok", "ok", "ok"],
    true
  );
  assert.match(renderDataflowActionsResult(repaired.result), /function scale_values updated/);
  assert.equal(rows(repaired.snapshot, "combined")[0].value, 84);

  const rejected = await run(
    "invalid signature rejects namespace and graph together",
    [edit("def scale_values(first, second):\n    return first", "set unpublished: load_values()")],
    ["error"],
    false
  );
  assert.deepEqual(rejected.snapshot.workflow?.nativeNamespace, repaired.snapshot.workflow?.nativeNamespace);
  assert.ok(!rejected.snapshot.workflow?.operators.some(op => op.operatorID === "unpublished"));
  await run(
    "answer is a sole content action",
    [{ type: "answer", content: "The computed combined value is 84." }],
    ["ok"],
    false
  );
  assert.deepEqual(
    await getSnapshot(agent.id, initial.snapshot.stepId!, baseUrl),
    initial.snapshot,
    "A later edit changed a saved snapshot."
  );
  save("trace.json", (await getReActSteps(agent.id, baseUrl)).steps);
  save("summary.json", { passed: true, checks });
  log(`All checks passed. Artifacts: ${directory}`);
} catch (error) {
  save("summary.json", { passed: false, checks, error: error instanceof Error ? error.message : String(error) });
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
