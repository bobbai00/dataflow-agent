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
      // The probes read with every view; the default offers only sample_stats and full.
      retrievalViews: ["full", "sample", "sample_stats"],
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
  const retrieve = (operator_id: string): DataflowAction => ({ type: "retrieve", operator_id, view: "sample" });
  const edit = (changes: string): DataflowAction => ({ type: "edit", changes });
  const execute: DataflowAction = { type: "execute" };
  const loader = (last: number, verb = "create") =>
    `${verb} operator source: process(fn=load_source, doc="Three rows with an execution timestamp")\n    def load_source():\n        import pandas as pd\n        import time\n        return pd.DataFrame({"x": [1, 2, ${last}], "stamp": [str(time.time_ns())] * 3})`;
  const other =
    'create operator other: process(fn=load_other, doc="An independent constant table")\n    def load_other():\n        import pandas as pd\n        return pd.DataFrame({"x": [10]})';
  // Execute covers both independent components. The existing scheduler sends
  // each component in its own backend request, even when both are cache hits.
  const initial = await run(
    "initial execution",
    [
      edit(
        `${loader(3)}\n${other}\ncreate operator total: aggregate(sum_x=sum("x"))\ncreate edge source.out -> total.in`
      ),
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
    [edit('update operator total: aggregate(sum_x=sum("x"), n=count())'), execute, retrieve("total")],
    ["ok", "ok", "ok"],
    2
  );
  assert.equal((leaf.snapshot.results.total as any).state, "Completed");
  assert.equal((leaf.snapshot.results.source as any).state, "CompletedFromCache");
  assert.equal((leaf.snapshot.results.other as any).state, "CompletedFromCache");
  await run(
    "stale retrieval fails and skips execute",
    [edit(loader(4, "update")), retrieve("total"), execute],
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
    "missing edge endpoint rejects the entire edit and skips suffix",
    [
      { type: "inspect", target: "graph" },
      edit(
        "create operator good: limit(1)\ncreate operator bad: limit(1)\ncreate edge other.out -> good.in\ncreate edge missing.out -> bad.in"
      ),
      execute,
      retrieve("good"),
    ],
    ["ok", "error", "skipped", "skipped"],
    0
  );
  assert.ok(!partial.snapshot.workflow!.operators.some(op => op.operatorID === "good"));
  assert.ok(!partial.snapshot.workflow!.operators.some(op => op.operatorID === "bad" || op.operatorID === "blocked"));
  assert.doesNotMatch(renderDataflowActionsResult(partial.result), /\bprogram\b/i);
  const rewired = await run(
    "edge change recomputes the receiver",
    [edit("delete edge source.out -> total.in\ncreate edge other.out -> total.in"), execute, retrieve("total")],
    ["ok", "ok", "ok"],
    2
  );
  assert.equal((rewired.snapshot.results.total as any).sampleRecords[0].sum_x, 10);
  assert.equal((rewired.snapshot.results.source as any).state, "CompletedFromCache");
  const joined = await run(
    "self-join uses left and right ports",
    [
      edit(
        'create operator joined: join(on="x")\ncreate edge source.out -> joined.left\ncreate edge source.out -> joined.right'
      ),
      execute,
      retrieve("joined"),
    ],
    ["ok", "ok", "ok"],
    2
  );
  assert.equal(
    (joined.snapshot.results.joined as any).rowCount ??
      (joined.snapshot.results.joined as any).totalRowCount ??
      (joined.snapshot.results.joined as any).outputTuples,
    3
  );
  const deleted = await run(
    "delete removes every incident edge",
    [edit("delete operator joined\ndelete operator other"), retrieve("total")],
    ["ok", "error"],
    0
  );
  const receipt = renderDataflowActionsResult(deleted.result);
  assert.ok(receipt.includes("source.out -> joined.left") && receipt.includes("source.out -> joined.right"));
  assert.ok(receipt.includes("other.out -> total.in"));
  await run(
    "unconnected execute blocks before engine and permits independent retrieval",
    [execute, retrieve("source")],
    ["error", "ok"],
    0
  );
  const restored = await run(
    "reconnect after deletion",
    [edit("create edge source.out -> total.in"), execute, retrieve("total")],
    ["ok", "ok", "ok"],
    1
  );
  assert.equal((restored.snapshot.results.total as any).sampleRecords[0].sum_x, 7);
  const dates = await run(
    "datetime cast survives transport to a native consumer",
    [
      edit(`create operator date_source: process(fn=load_date, doc="One local timestamp")
    def load_date():
        import pandas as pd
        return pd.DataFrame({"when": ["2025-01-01 00:00:00"]})
create operator utc_dates: cast(when=datetime(tz="America/Los_Angeles"))
create operator utc_hour: map(lambda row: {"hour": row["when"].hour}, doc="Hour of the converted UTC timestamp")
create edge date_source.out -> utc_dates.in
create edge utc_dates.out -> utc_hour.in`),
      execute,
      retrieve("utc_hour"),
    ],
    ["ok", "ok", "ok"],
    2
  );
  assert.equal((dates.snapshot.results.utc_hour as any).sampleRecords[0].hour, 8);
  const old = await getSnapshot(agentId, initial.snapshot.stepId!, baseUrl);
  assert.deepEqual(old, initial.snapshot, "Later edits changed an earlier snapshot");
  save("probe-trace.json", (await getReActSteps(agentId, baseUrl)).steps);
}

async function retrievalProbes() {
  const { agentId, wid } = await provision("retrieval-views");
  const settings = await fetch(`${baseUrl}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      retrievalViews: ["full", "sample", "sample_stats"],
      fullResultCharLimit: 100000,
      maxOperatorResultCharLimit: 2000,
      maxResultRows: 5,
      dataEvidenceCharLimit: 2000,
      flowEvidenceCharLimit: 2000,
      flowEvidence: true,
    }),
  });
  assert.equal(settings.status, 200);
  await debug(agentId, [
    {
      type: "edit",
      changes: `create operator wide: process(fn=load_rows, doc="One thousand records")
    def load_rows():
        import pandas as pd
        return pd.DataFrame({"x": [None if i % 100 == 0 else i for i in range(1000)], "label": ["record-" + str(i) + "q" * 32 for i in range(1000)]})
create operator projected: project(keep=["x"])
create operator filtered: filter(lambda row: row["x"] is not None and row["x"] > 500, doc="Values above 500")
create edge wide.out -> projected.in
create edge projected.out -> filtered.in`,
    },
    { type: "execute" },
  ]);
  const before = await history(wid);
  const versions: string[] = [];
  const outputs: Record<string, any> = {};
  for (const view of ["sample", "full", "sample_stats"] as const) {
    await debug(agentId, [{ type: "retrieve", operator_id: "wide", view }]);
    const trace = await getReActSteps(agentId, baseUrl);
    const result = trace.steps.flatMap(s => s.toolResults ?? []).at(-1)!.output as DataflowActionsResult;
    assert.equal(result.status, "completed");
    const output = result.actions[0].output as any;
    versions.push(output.result_version);
    outputs[view] = output;
  }
  assert.ok(versions[0] && versions.every(v => v === versions[0]), "Views changed producing result identity");
  assert.equal(outputs.sample.table.returnedRows, 5);
  assert.equal(outputs.full.table.returnedRows, 1000);
  assert.equal(outputs.full.table.complete, true);
  assert.ok(outputs.full.text.length > 2000, "Full view did not read beyond the old sample limit");
  assert.equal(outputs.sample_stats.table.returnedRows, 5);
  assert.ok(outputs.sample_stats.text.includes("statistics: "));
  assert.ok(!outputs.sample.text.includes("Data measurement"));
  await debug(agentId, [{ type: "retrieve", operator_id: "filtered", view: "sample" }]);
  const trace = await getReActSteps(agentId, baseUrl);
  const flow = trace.steps.flatMap(s => s.toolResults ?? []).at(-1)!.output as DataflowActionsResult;
  assert.ok(JSON.stringify(flow).includes("Project selection/rename"), "Missing intermediate projection evidence");
  assert.equal((await history(wid)).length, before.length, "Retrieval triggered an execution");
  save("retrieval-views.json", { outputs, versions, flow, executions: before.length });
  checks.push({
    name: "three retrieval views, automatic upstream evidence, stable version and no execution",
    passed: true,
  });
  log("PASS three retrieval views: full=1000 rows, sample=5 rows, stable version, zero new executions");
}

async function timestampProbe() {
  const { agentId, wid } = await provision("timestamp-observation");
  await fetch(`${baseUrl}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retrievalViews: ["sample_stats"], maxResultRows: 1, dataEvidenceCharLimit: 2000 }),
  });
  await debug(agentId, [
    {
      type: "edit",
      changes: `create operator dates: process(fn=load_dates, doc="Two known UTC instants")
    def load_dates():
        import pandas as pd
        return pd.DataFrame({"when": pd.to_datetime(["2025-01-01T08:00:00Z", "2025-07-01T07:00:00Z"], utc=True)})
create operator date_strings: map(lambda row: {"iso": row["when"].isoformat()}, doc="UTC value seen by the next operator")
create edge dates.out -> date_strings.in`,
    },
    { type: "execute" },
    { type: "retrieve", operator_id: "dates", view: "sample_stats" },
    { type: "retrieve", operator_id: "date_strings", view: "sample_stats" },
  ]);
  const { steps } = await getReActSteps(agentId, baseUrl);
  const snapshot = await getSnapshot(agentId, "head", baseUrl);
  save("timestamp-trace.json", steps);
  save("timestamp-snapshot.json", snapshot);
  save("timestamp-executions.json", await history(wid));
  const dates = snapshot.results.dates as any;
  const strings = snapshot.results.date_strings as any;
  assert.equal(dates.sampleRecords[0].when, "2025-01-01T08:00:00Z");
  assert.equal(dates.sampleRecords[1].when, "2025-07-01T07:00:00Z");
  assert.equal(strings.sampleRecords[0].iso, "2025-01-01T08:00:00+00:00");
  assert.equal(dates.tableProfile.columns.when.min.value, "2025-01-01T08:00:00.000000000+00:00");
  await debug(agentId, [{ type: "execute" }, { type: "retrieve", operator_id: "dates", view: "sample_stats" }]);
  const cached = await getSnapshot(agentId, "head", baseUrl);
  save("timestamp-cached-snapshot.json", cached);
  assert.deepEqual((cached.results.dates as any).sampleRecords, dates.sampleRecords);
  assert.equal((cached.results.dates as any).resultVersion.id, dates.resultVersion.id);
  await debug(agentId, [
    {
      type: "edit",
      changes:
        'update operator date_strings: map(lambda row: {"hour": row["when"].hour}, doc="UTC hour from cached source")',
    },
    { type: "execute" },
    { type: "retrieve", operator_id: "date_strings", view: "sample_stats" },
  ]);
  const downstream = await getSnapshot(agentId, "head", baseUrl);
  save("timestamp-new-consumer-snapshot.json", downstream);
  assert.deepEqual((downstream.results.date_strings as any).sampleRecords, [{ hour: 8 }, { hour: 7 }]);
  assert.equal((downstream.results.dates as any).resultVersion.id, dates.resultVersion.id);
  checks.push({ name: "retrieved UTC timestamps agree with profiles and native consumers", passed: true });
  log("PASS retrieved UTC timestamps agree with profiles and native consumers");
}

try {
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const cu = await createComputingUnit(token, `actions-live-${Date.now()}`, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = cu.computingUnit.cuid;
  if (Bun.argv.includes("--timestamps-only")) await timestampProbe();
  else {
    if (!Bun.argv.includes("--probes-only")) await task();
    if (!Bun.argv.includes("--retrieval-only")) await probes();
    await retrievalProbes();
  }
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
