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
 * Every probe is one `dataflow(python, statements)` call sent as debug input.
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
import { dataflowActionTypes, dataflowDebugInput, shownResult } from "./native-debug-input";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = mkdtempSync(join(tmpdir(), "registered-python-live-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const log = (message: string) => console.log(`[registered-python] ${message}`);
const checks: Array<{ name: string; newExecutions: number }> = [];
const views: RetrievalView[] = ["full", "sample_stats"];
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

/** One call. `statuses` lists the expected status of each action the call
 * becomes: the edit first (when it has definitions or set/delete lines), then
 * `execute`, and `show result` as an execute followed by a retrieve. Showing
 * a result asks the engine even when every result is cached. */
async function run(name: string, python: string, statements: string, statuses: string[], computes: boolean) {
  assert.equal(dataflowActionTypes(python, statements, views).length, statuses.length, `${name}: expected statuses`);
  const before = await history();
  const context = await debug(python, statements);
  const trace = await getReActSteps(resource!.agentId, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)?.output as DataflowActionsResult;
  const snapshot = await getSnapshot(resource!.agentId, "head", baseUrl);
  const after = await history();
  const newExecutions = after.length - before.length;
  const index = ++probe;
  const text = renderDataflowActionsResult(result);
  save(`probe-${index}.json`, { name, python, statements, result, snapshot, before, after });
  writeFileSync(join(directory, `probe-${index}-receipt.md`), text);
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
  return { result, snapshot, text };
}
const rows = (snapshot: Awaited<ReturnType<typeof getSnapshot>>, id: string): Array<Record<string, any>> =>
  (snapshot.results[id] as any)?.sampleRecords ?? [];
const executeStates = (result: DataflowActionsResult) =>
  result.actions
    .filter(item => item.action.type === "execute")
    .flatMap(item => ((item.output as any)?.operators ?? []) as Array<{ id: string; state: string }>);

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
      retrievalViews: views,
      nativeProfileCollection: true,
      dataEvidence: true,
      flowEvidence: true,
      maxSteps: 4,
    },
  });
  resource.agentId = agent.id;
  save("resource.json", resource);
  const info = await json(`${baseUrl}/api/agents/${agent.id}/system-info`);
  save("system-info.json", info);
  assert.deepEqual(
    info.tools.map((tool: any) => tool.name),
    ["dataflow"]
  );
  const sourcePath = join(directory, "records.csv");
  writeFileSync(sourcePath, "id,value\n1,10\n2,20\n");

  const registered = await run(
    "register before graph construction",
    definitions,
    "show function load_values, scale_values, combine_values",
    ["ok", "ok"],
    false
  );
  assert.equal(registered.snapshot.workflow?.operators.length, 0);
  assert.ok(registered.snapshot.workflow?.nativeNamespace?.functions.combine_values);
  assert.match(registered.text, /load_values registered/);
  assert.match(registered.text, /## show function load_values, scale_values, combine_values/);

  const initial = await run(
    "zero, one and multiple inputs with keyword settings",
    "",
    [
      "set left: load_values()",
      "set right: load_values(start=3)",
      "set scaled: scale_values(left, factor=2)",
      "set combined: combine_values(scaled, right, multiplier=3)",
      `set independent: scan(files=${JSON.stringify(sourcePath)})`,
      "execute combined, independent",
      "show result left, right, scaled, combined, independent full",
    ].join("\n"),
    ["ok", "ok", "ok", "ok"],
    true
  );
  assert.equal(rows(initial.snapshot, "combined")[0].value, 51);
  for (const id of ["left", "right"])
    assert.deepEqual(
      rows(initial.snapshot, id).map(row => row.invocations),
      [1, 1]
    );

  // The unknown target stops the execution before the engine; the results
  // that exist are still shown, each with its own status.
  const mixed = await run(
    "mixed retrieval preserves valid targets",
    "",
    "show result combined, missing, independent full",
    ["error", "error"],
    false
  );
  assert.deepEqual(
    (mixed.result.actions[1].output as any).results.map((entry: any) => entry.status),
    ["ok", "error", "ok"]
  );
  assert.deepEqual(mixed.result.observe, ["combined", "independent"]);

  const stale = await run(
    "helper update invalidates without automatic execution",
    "def _adjust(value):\n    return value + 2",
    "",
    ["ok"],
    false
  );
  assert.match(stale.text, /stale until executed: .*combined/);
  assert.deepEqual(rows(stale.snapshot, "independent"), rows(initial.snapshot, "independent"));
  const revised = await run(
    "explicit execution uses the new shared definition",
    "",
    "execute combined\nshow result left, right, combined full",
    ["ok", "ok", "ok"],
    true
  );
  assert.equal(rows(revised.snapshot, "combined")[0].value, 63);
  for (const id of ["left", "right"])
    assert.deepEqual(
      rows(revised.snapshot, id).map(row => row.invocations),
      [1, 1]
    );

  // Showing a result always asks the engine; unchanged operators come back from cache.
  const cachedShow = await run(
    "showing an unchanged result reuses the cache",
    "",
    "show result combined full",
    ["ok", "ok"],
    true
  );
  assert.ok(executeStates(cachedShow.result).every(operator => operator.state === "cached"));
  assert.equal(
    (cachedShow.snapshot.results.combined as any).resultVersion.id,
    (revised.snapshot.results.combined as any).resultVersion.id
  );
  const documented = await run(
    "documentation-only edit preserves materialization",
    "",
    "set scaled: scale_values(left, factor=2, doc='Preserve every source record.')",
    ["ok"],
    false
  );
  assert.doesNotMatch(documented.text, /stale until executed/);
  assert.equal(
    (documented.snapshot.results.combined as any).resultVersion.id,
    (revised.snapshot.results.combined as any).resultVersion.id
  );

  const failed = await run(
    "execution error retains independent reads",
    "def scale_values(table, *, factor=1):\n    raise ValueError('synthetic conversion failure')",
    "execute combined\nshow result independent, scaled full",
    ["ok", "error", "error", "error"],
    true
  );
  assert.match(failed.text, /synthetic conversion failure/);
  assert.equal(shownResult(failed.result, "independent").status, "ok");
  assert.equal(shownResult(failed.result, "scaled").status, "error");

  const repaired = await run(
    "replace the same function and refine its settings",
    "def scale_values(table, *, factor=1):\n    result = table.copy()\n    result['value'] = result['value'].apply(_adjust) * factor\n    return result",
    "set scaled: scale_values(left, factor=3)\nshow result combined full",
    ["ok", "ok", "ok"],
    true
  );
  assert.match(repaired.text, /scale_values updated/);
  assert.equal(rows(repaired.snapshot, "combined")[0].value, 84);

  const rejected = await run(
    "invalid signature rejects namespace and graph together",
    "def scale_values(first, second):\n    return first",
    "set unpublished: load_values()",
    ["error"],
    false
  );
  assert.match(rejected.text, /## edits rejected/);
  assert.deepEqual(rejected.snapshot.workflow?.nativeNamespace, repaired.snapshot.workflow?.nativeNamespace);
  assert.ok(!rejected.snapshot.workflow?.operators.some(op => op.operatorID === "unpublished"));
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
