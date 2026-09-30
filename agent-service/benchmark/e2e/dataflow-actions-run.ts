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

/** Live native/DELTA task followed by deterministic action/cache checks.
 * Requires a running agent from this branch and the Texera backend. Uses
 * TEXERA_AGENT_SERVICE_ENDPOINT, TEXERA_AGENT_MODEL and normal backend env.
 * Saves actual model inputMessages separately from debug-only contexts.
 * Usage: bun benchmark/e2e/dataflow-actions-run.ts [--probes-only]
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot, runAgentTurn } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import type { DataflowAction, DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { renderDataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const model = process.env.TEXERA_AGENT_MODEL ?? "gpt-5.6-luna";
const directory = mkdtempSync(join(tmpdir(), "dataflow-actions-live-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const saveText = (name: string, value: string) => writeFileSync(join(directory, name), value);
const log = (message: string) => console.log(`[dataflow-actions] ${message}`);
const resources: Array<{ agentId: string; wid: number; cuid: number }> = [];
const checks: Array<{ name: string; [key: string]: unknown }> = [];
let cuid: number | undefined;
let token: string;

async function json(url: string, auth = false): Promise<any> {
  const response = await fetch(url, auth ? { headers: { Authorization: `Bearer ${token}` } } : {});
  assert.equal(response.status, 200, `HTTP ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}
const history = (wid: number) => json(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, true);

async function provision(name: string) {
  const wid = await createWorkflow(token, `actions-${name}-${Date.now()}`, new WorkflowState().getWorkflowContent());
  const resource = { agentId: "", wid, cuid: cuid! };
  resources.push(resource);
  const agent = await createAgent({
    baseUrl,
    userToken: token,
    modelType: model,
    workflowId: wid,
    computingUnitId: cuid,
    settings: {
      agentMode: "native",
      contextMode: "delta",
      messageLayout: "native",
      maxSteps: 12,
      dataEvidence: false,
      flowEvidence: false,
      resultSelection: "all",
    },
  });
  resource.agentId = agent.id;
  return resource;
}

async function debug(agentId: string, actions: DataflowAction[]) {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false;
    let finished = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Debug action timed out; inspect retained resources before cleanup."));
    }, 240_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        const args = { reasoning: "Verify action observations and cached results.", actions };
        ws.send(
          JSON.stringify({
            type: "debug",
            content: `Function(name="dataflow", arguments=${JSON.stringify(JSON.stringify(args))})`,
          })
        );
      } else if (frame.type === "complete" || frame.type === "error") finished = true;
      else if (frame.type === "nextContext" && finished) {
        clearTimeout(timer);
        ws.close();
        resolve(frame.content);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Debug WebSocket failed."));
    };
  });
}

function readable(messages: any[]): string {
  return messages
    .map(message => {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part: any) =>
                part.type === "tool-result" && part.output?.type === "text"
                  ? part.output.value
                  : JSON.stringify(part, null, 2)
              )
              .join("\n\n");
      return `=== ${message.role} ===\n${content}`;
    })
    .join("\n\n");
}

async function task() {
  const { agentId, wid } = await provision("task");
  const csv = join(directory, "sales.csv");
  saveText(
    "sales.csv",
    "order_id,region,status,amount\n1,West,completed,120\n2,East,completed,80\n3,West,cancelled,900\n4,West,completed,30\n5,East,completed,20\n6,North,completed,70\n7,North,cancelled,500\n8,East,completed,15\n"
  );
  const prompt = `Using ${csv}, report total completed-order revenue by region, excluding cancelled orders. Return each region and its total in descending revenue order. Inspect the data before choosing a filter.`;
  saveText("task.txt", prompt);
  const info = await json(`${baseUrl}/api/agents/${agentId}/system-info`);
  saveText("system-prompt.txt", info.systemPrompt);
  save("tool-definitions.json", info.tools);
  save("settings.json", await json(`${baseUrl}/api/agents/${agentId}/settings`));
  log(`Running ${model}; artifacts: ${directory}`);
  const loggedSteps = new Set<string>();
  const turn = await runAgentTurn(agentId, prompt, {
    baseUrl,
    timeoutMs: 360_000,
    onStep: step => {
      if (step.role === "agent" && !loggedSteps.has(step.id)) {
        loggedSteps.add(step.id);
        log(`model step ${step.stepId}`);
      }
    },
  });
  const { steps } = await getReActSteps(agentId, baseUrl);
  save("task-trace.json", steps);
  save("task-turn.json", turn);
  save("task-executions.json", await history(wid));
  const requests = steps.filter(step => step.role === "agent" && step.inputMessages?.length);
  for (const [i, step] of requests.entries()) {
    const messages = [{ role: "system", content: info.systemPrompt }, ...step.inputMessages!];
    save(`request-${i + 1}.json`, messages);
    saveText(`request-${i + 1}.txt`, readable(messages));
  }
  const prefixChecks = requests.slice(1).map((step, i) => {
    const previous = requests[i].inputMessages!;
    const current = step.inputMessages!;
    const preserved = JSON.stringify(current.slice(0, previous.length)) === JSON.stringify(previous);
    assert.ok(preserved, `DELTA request ${i + 2} changed the earlier request prefix`);
    return { request: i + 2, previousMessages: previous.length, preserved };
  });
  save("delta-prefix-checks.json", prefixChecks);
  assert.ok(turn.completed && !turn.errors.length, `Live turn failed: ${turn.errors.join("; ")}`);
  for (const [region, total] of [
    ["West", 150],
    ["East", 115],
    ["North", 70],
  ] as const) {
    assert.ok(turn.finalAnswer.includes(region) && turn.finalAnswer.includes(String(total)), "Wrong final totals");
  }
  const snapshot = await getSnapshot(agentId, "head", baseUrl);
  save("task-snapshot.json", snapshot);
  const rows = Object.values(snapshot.results).flatMap((result: any) => result.sampleRecords ?? []);
  for (const [region, amount] of [
    ["West", 150],
    ["East", 115],
    ["North", 70],
  ] as const)
    assert.ok(
      rows.some(row => Object.values(row).includes(region) && Object.values(row).includes(amount)),
      `No computed total for ${region}`
    );
  checks.push({
    name: "real model task",
    model,
    answer: turn.finalAnswer,
    requests: requests.length,
    cachedInputTokens: requests.map(step => step.usage?.cachedInputTokens ?? null),
    prefixChecks,
  });
  log(`Task answer: ${turn.finalAnswer}`);
}

async function probes() {
  const { agentId, wid } = await provision("cache");
  let index = 0;
  const run = async (name: string, actions: DataflowAction[], statuses: string[], newExecutions: number) => {
    const before = await history(wid);
    const context = await debug(agentId, actions);
    const trace = await getReActSteps(agentId, baseUrl);
    const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)!.output as DataflowActionsResult;
    const snapshot = await getSnapshot(agentId, "head", baseUrl);
    const after = await history(wid);
    save(`probe-${++index}.json`, { name, actions, result, snapshot, before, after });
    saveText(`probe-${index}-observations.txt`, renderDataflowActionsResult(result));
    saveText(`probe-${index}-debug-context.txt`, context);
    assert.deepEqual(
      result.actions.map(action => action.status),
      statuses,
      name
    );
    assert.equal(after.length - before.length, newExecutions, `${name}: backend execution count`);
    const states = Object.fromEntries(
      Object.entries(snapshot.results).map(([id, result]: [string, any]) => [id, result.state])
    );
    checks.push({ name, newExecutions, states });
    log(`PASS ${name}: ${newExecutions} new backend executions`);
    return { snapshot, result };
  };
  const retrieve = (operator_id: string): DataflowAction => ({ type: "retrieve", operator_id });
  const edit = (expressions: string): DataflowAction => ({ type: "edit", expressions, delete: [] });
  const execute: DataflowAction = { type: "execute" };
  const loader = (last: number) =>
    `def load_source():\n    import pandas as pd\n    import time\n    return pd.DataFrame({"x": [1, 2, ${last}], "stamp": [str(time.time_ns())] * 3})\nsource = process(fn=load_source, doc="Three rows with an execution timestamp")`;
  const other =
    'def load_other():\n    import pandas as pd\n    return pd.DataFrame({"x": [10]})\nother = process(fn=load_other, doc="An independent constant table")';
  // Execute covers both independent components. The existing scheduler sends
  // each component in its own backend request, even when both are cache hits.
  const initial = await run(
    "initial execution",
    [
      edit(`${loader(3)}\n${other}\ntotal = aggregate(source, sum_x=sum("x"))`),
      execute,
      retrieve("source"),
      retrieve("total"),
    ],
    ["ok", "ok", "ok", "ok"],
    2
  );
  const cachedRead = await run("retrieve without execution", [retrieve("source"), retrieve("total")], ["ok", "ok"], 0);
  assert.deepEqual(cachedRead.snapshot.results, initial.snapshot.results);
  const cachedExecute = await run("unchanged execute", [execute, retrieve("total")], ["ok", "ok"], 2);
  for (const id of ["source", "total", "other"]) {
    const current = cachedExecute.snapshot.results[id] as any;
    assert.equal(current.state, "CompletedFromCache", id);
    assert.deepEqual(current.sampleRecords, (initial.snapshot.results[id] as any).sampleRecords);
  }
  const leaf = await run(
    "leaf edit keeps ancestors cached",
    [edit('total = aggregate(source, sum_x=sum("x"), n=count())'), execute, retrieve("total")],
    ["ok", "ok", "ok"],
    2
  );
  assert.equal((leaf.snapshot.results.total as any).state, "Completed");
  assert.equal((leaf.snapshot.results.source as any).state, "CompletedFromCache");
  assert.equal((leaf.snapshot.results.other as any).state, "CompletedFromCache");
  await run(
    "stale retrieval fails and skips execute",
    [edit(loader(4)), retrieve("total"), execute],
    ["ok", "error", "skipped"],
    0
  );
  await run("independent result survives upstream edit", [retrieve("other")], ["ok"], 0);
  const revised = await run("upstream edit recomputes descendants", [execute, retrieve("total")], ["ok", "ok"], 2);
  assert.equal((revised.snapshot.results.source as any).state, "Completed");
  assert.equal((revised.snapshot.results.total as any).sampleRecords[0].sum_x, 7);
  assert.equal((revised.snapshot.results.total as any).state, "Completed");
  assert.equal((revised.snapshot.results.other as any).state, "CompletedFromCache");
  const partial = await run(
    "missing input preserves valid edits and skips suffix",
    [
      { type: "inspect", target: "graph" },
      edit("good = limit(other, 1)\nbad = limit(missing, 1)\nblocked = limit(bad, 1)"),
      execute,
      retrieve("good"),
    ],
    ["ok", "error", "skipped", "skipped"],
    0
  );
  assert.ok(partial.snapshot.workflow!.operators.some(op => op.operatorID === "good"));
  assert.ok(!partial.snapshot.workflow!.operators.some(op => op.operatorID === "bad" || op.operatorID === "blocked"));
  assert.doesNotMatch(renderDataflowActionsResult(partial.result), /\bprogram\b/i);
  const old = await getSnapshot(agentId, initial.snapshot.stepId!, baseUrl);
  assert.deepEqual(old, initial.snapshot, "Later edits changed an earlier snapshot");
  save("probe-trace.json", (await getReActSteps(agentId, baseUrl)).steps);
}

try {
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const cu = await createComputingUnit(token, `actions-live-${Date.now()}`, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = cu.computingUnit.cuid;
  if (!Bun.argv.includes("--probes-only")) await task();
  await probes();
  save("summary.json", { passed: true, model, checks });
  log(`All checks passed. Artifacts: ${directory}`);
} catch (error) {
  save("summary.json", { passed: false, model, checks, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  let safe = true;
  const cleanup: Array<{ wid: number; removed: boolean; error?: string }> = [];
  for (const resource of resources) {
    try {
      if (resource.agentId) {
        const agent = await json(`${baseUrl}/api/agents/${resource.agentId}`);
        assertNativeCleanupSafe(agent, await history(resource.wid), resource);
        await deleteAgent(resource.agentId, baseUrl);
      }
      await deleteWorkflow(token!, resource.wid);
      cleanup.push({ wid: resource.wid, removed: true });
    } catch (error) {
      safe = false;
      cleanup.push({ wid: resource.wid, removed: false, error: String(error) });
    }
  }
  if (cuid !== undefined && safe) await terminateComputingUnit(token!, cuid);
  save("cleanup.json", { computingUnitId: cuid, terminated: cuid !== undefined && safe, workflows: cleanup });
  if (!safe) log(`Resources retained; see ${join(directory, "cleanup.json")}`);
}
