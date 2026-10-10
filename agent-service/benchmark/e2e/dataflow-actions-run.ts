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

/** Live native/DELTA task followed by deterministic call and cache checks.
 * Requires a running agent from this branch and the Texera backend. Uses
 * TEXERA_AGENT_SERVICE_ENDPOINT, TEXERA_AGENT_MODEL and normal backend env.
 * Saves actual model inputMessages separately from debug-only contexts.
 * The deterministic probes send `dataflow(python, statements)` calls as debug
 * input; `show result` asks the engine before reading, even when every result
 * is cached, so each probe states the backend requests it expects.
 * Usage: bun benchmark/e2e/dataflow-actions-run.ts [--probes-only | --retrieval-only | --timestamps-only]
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot, runAgentTurn } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import type { RetrievalView } from "../../src/types/agent";
import type { DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { renderDataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { dataflowActionTypes, dataflowDebugInput, shownResult } from "./native-debug-input";

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

async function provision(name: string, settings: Record<string, unknown> = {}) {
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
      ...settings,
    },
  });
  resource.agentId = agent.id;
  return resource;
}

async function debug(agentId: string, python: string, statements: string, views?: readonly RetrievalView[]) {
  const content = dataflowDebugInput(python, statements, views);
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false;
    let finished = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Debug call timed out; inspect retained resources before cleanup."));
    }, 240_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "debug", content }));
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

async function lastResult(agentId: string): Promise<DataflowActionsResult> {
  const trace = await getReActSteps(agentId, baseUrl);
  return trace.steps.flatMap(step => step.toolResults ?? []).at(-1)!.output as DataflowActionsResult;
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

const PROBE_VIEWS: RetrievalView[] = ["sample", "full"];
const LOADERS = `import pandas as pd
import time

def load_source(*, last=3):
    """Three rows with an execution timestamp."""
    return pd.DataFrame({"x": [1, 2, last], "stamp": [str(time.time_ns())] * 3})

def load_other():
    """An independent constant table."""
    return pd.DataFrame({"x": [10]})
`;

async function probes() {
  const { agentId, wid } = await provision("cache", { retrievalViews: PROBE_VIEWS });
  let index = 0;
  /** One call. `statuses` lists each action the call becomes (the edit first,
   * `show result` as an execute then a retrieve); `requests` is the number of
   * backend executions it must start: one per connected component executed. */
  const run = async (name: string, python: string, statements: string, statuses: string[], requests: number) => {
    assert.equal(dataflowActionTypes(python, statements, PROBE_VIEWS).length, statuses.length, `${name}: statuses`);
    const before = await history(wid);
    const context = await debug(agentId, python, statements, PROBE_VIEWS);
    const result = await lastResult(agentId);
    const snapshot = await getSnapshot(agentId, "head", baseUrl);
    const after = await history(wid);
    const text = renderDataflowActionsResult(result);
    save(`probe-${++index}.json`, { name, python, statements, result, snapshot, before, after });
    saveText(`probe-${index}-receipt.md`, text);
    saveText(`probe-${index}-debug-context.txt`, context);
    assert.deepEqual(
      result.actions.map(action => action.status),
      statuses,
      `${name}\n${text}`
    );
    assert.equal(after.length - before.length, requests, `${name}: backend execution count`);
    const states = Object.fromEntries(
      Object.entries(snapshot.results).map(([id, result]: [string, any]) => [id, result.state])
    );
    checks.push({ name, requests, states });
    log(`PASS ${name}: ${requests} new backend executions`);
    return { snapshot, result, text };
  };
  const state = (snapshot: Awaited<ReturnType<typeof getSnapshot>>, id: string) => (snapshot.results[id] as any)?.state;
  // Execute covers both independent components. The scheduler sends each
  // component in its own backend request, even when both are cache hits.
  const initial = await run(
    "initial execution",
    LOADERS,
    "set source: load_source()\nset other: load_other()\nset total: aggregate(source, outputs={'sum_x': sum('x')})\nexecute",
    ["ok", "ok"],
    2
  );
  const cachedRead = await run("show result reuses cached results", "", "show result source, total", ["ok", "ok"], 1);
  for (const id of ["source", "total"]) {
    assert.equal(state(cachedRead.snapshot, id), "CompletedFromCache", id);
    assert.deepEqual(
      (cachedRead.snapshot.results[id] as any).sampleRecords,
      (initial.snapshot.results[id] as any).sampleRecords
    );
  }
  const cachedExecute = await run("unchanged execute", "", "execute\nshow result total", ["ok", "ok", "ok"], 3);
  for (const id of ["source", "total", "other"]) {
    assert.equal(state(cachedExecute.snapshot, id), "CompletedFromCache", id);
    assert.deepEqual(
      (cachedExecute.snapshot.results[id] as any).sampleRecords,
      (initial.snapshot.results[id] as any).sampleRecords
    );
  }
  const leaf = await run(
    "leaf edit keeps ancestors cached",
    "",
    "set total: aggregate(source, outputs={'sum_x': sum('x'), 'n': count()})\nshow result total",
    ["ok", "ok", "ok"],
    1
  );
  assert.equal(state(leaf.snapshot, "total"), "Completed");
  assert.equal(state(leaf.snapshot, "source"), "CompletedFromCache");
  const stale = await run(
    "upstream edit invalidates without execution",
    "",
    "set source: load_source(last=4)",
    ["ok"],
    0
  );
  assert.match(stale.text, /stale until executed: .*total/);
  const independent = await run("independent result survives upstream edit", "", "show result other", ["ok", "ok"], 1);
  assert.equal(state(independent.snapshot, "other"), "CompletedFromCache");
  const revised = await run("upstream edit recomputes descendants", "", "show result total", ["ok", "ok"], 1);
  assert.equal(state(revised.snapshot, "source"), "Completed");
  assert.equal((revised.snapshot.results.total as any).sampleRecords[0].sum_x, 7);
  assert.equal(state(revised.snapshot, "total"), "Completed");
  const partial = await run(
    "an unknown input rejects the entire edit and skips the rest",
    "",
    "set good: limit(other, n=1)\nset bad: limit(missing, n=1)\nshow result good",
    ["error", "skipped", "skipped"],
    0
  );
  assert.ok(!partial.snapshot.workflow!.operators.some(op => op.operatorID === "good"));
  assert.ok(!partial.snapshot.workflow!.operators.some(op => op.operatorID === "bad"));
  assert.match(partial.text, /## edits rejected/);
  assert.doesNotMatch(partial.text, /\bprogram\b/i);
  const rewired = await run(
    "input change recomputes the receiver",
    "",
    "set total: aggregate(other, outputs={'sum_x': sum('x'), 'n': count()})\nshow result total",
    ["ok", "ok", "ok"],
    1
  );
  assert.equal((rewired.snapshot.results.total as any).sampleRecords[0].sum_x, 10);
  assert.equal(state(rewired.snapshot, "other"), "CompletedFromCache");
  const joined = await run(
    "self-join uses left and right ports",
    "",
    "set joined: join(source, source, on='x', how='inner')\nshow result joined",
    ["ok", "ok", "ok"],
    1
  );
  assert.equal(
    (joined.snapshot.results.joined as any).rowCount ??
      (joined.snapshot.results.joined as any).totalRowCount ??
      (joined.snapshot.results.joined as any).outputTuples,
    3
  );
  // Deleting `other` leaves `total` without its input: the edit applies and
  // reports the unconnected input; executing `total` is refused before the engine.
  const deleted = await run(
    "delete removes every incident edge",
    "",
    "delete joined\ndelete other\nshow result total",
    ["ok", "error", "error"],
    0
  );
  const changes = (deleted.result.actions[0].output as any).changes as Array<Record<string, string>>;
  for (const edge of ["source -> joined.left", "source -> joined.right", "other -> total"])
    assert.ok(
      changes.some(change => change.change === "edge" && change.edge === edge && change.action === "removed"),
      `${edge} removed`
    );
  assert.match(deleted.text, /unconnected input: /);
  await run(
    "unconnected execute blocks before the engine and permits independent results",
    "",
    "execute\nshow result source",
    ["error", "ok", "ok"],
    1
  );
  const restored = await run(
    "restate after deletion",
    "",
    "set total: aggregate(source, outputs={'sum_x': sum('x'), 'n': count()})\nshow result total",
    ["ok", "ok", "ok"],
    1
  );
  assert.equal((restored.snapshot.results.total as any).sampleRecords[0].sum_x, 7);
  const dates = await run(
    "datetime cast survives transport to a Python consumer",
    `import pandas as pd

def load_date():
    """One local timestamp."""
    return pd.DataFrame({"when": ["2025-01-01 00:00:00"]})

def utc_hour(table):
    """Hour of the converted UTC timestamp."""
    return pd.DataFrame({"hour": [value.hour for value in table["when"]]})
`,
    "set date_source: load_date()\nset utc_dates: cast(date_source, columns={'when': datetime(tz='America/Los_Angeles')})\nset utc_hours: utc_hour(utc_dates)\nshow result utc_hours",
    ["ok", "ok", "ok"],
    1
  );
  assert.equal((dates.snapshot.results.utc_hours as any).sampleRecords[0].hour, 8);
  const old = await getSnapshot(agentId, initial.snapshot.stepId!, baseUrl);
  assert.deepEqual(old, initial.snapshot, "Later edits changed an earlier snapshot");
  save("probe-trace.json", (await getReActSteps(agentId, baseUrl)).steps);
}

async function retrievalProbes() {
  const { agentId, wid } = await provision("retrieval-views");
  const views: RetrievalView[] = ["full", "sample", "sample_stats"];
  const settings = await fetch(`${baseUrl}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      retrievalViews: views,
      fullResultCharLimit: 100000,
      maxOperatorResultCharLimit: 2000,
      maxResultRows: 5,
      dataEvidenceCharLimit: 2000,
      flowEvidenceCharLimit: 2000,
      flowEvidence: true,
    }),
  });
  assert.equal(settings.status, 200);
  await debug(
    agentId,
    `import pandas as pd

def load_rows():
    """One thousand records."""
    return pd.DataFrame({"x": [None if i % 100 == 0 else i for i in range(1000)], "label": ["record-" + str(i) + "q" * 32 for i in range(1000)]})

def above_500(row):
    """Values above 500."""
    return row["x"] is not None and row["x"] > 500
`,
    "set wide: load_rows()\nset projected: project(wide, keep=['x'])\nset filtered: filter(projected, predicate='above_500')\nexecute",
    views
  );
  assert.equal((await lastResult(agentId)).status, "completed");
  const versions: string[] = [];
  const outputs: Record<string, any> = {};
  for (const view of ["sample", "full", "sample_stats"] as const) {
    await debug(agentId, "", `show result wide ${view}`, views);
    const result = await lastResult(agentId);
    assert.equal(result.status, "completed");
    // Showing a result asks the engine; the unchanged result comes from cache.
    assert.ok((result.actions[0].output as any).operators.every((operator: any) => operator.state === "cached"));
    const output = shownResult(result, "wide");
    versions.push(output.result_version);
    outputs[view] = output;
  }
  assert.ok(versions[0] && versions.every(v => v === versions[0]), "Views changed producing result identity");
  assert.equal(outputs.sample.table.returnedRows, 5);
  assert.equal(outputs.full.table.returnedRows, 1000);
  assert.equal(outputs.full.table.complete, true);
  assert.ok(outputs.full.text.length > 2000, "Full view did not read beyond the sample limit");
  assert.equal(outputs.sample_stats.table.returnedRows, 5);
  assert.ok(outputs.sample_stats.text.includes("statistics:"));
  assert.ok(!outputs.sample.text.includes("statistics:"));
  await debug(agentId, "", "show result filtered sample", views);
  const flow = await lastResult(agentId);
  assert.ok(JSON.stringify(flow).includes("Project selection/rename"), "Missing intermediate projection evidence");
  save("retrieval-views.json", { outputs, versions, flow, executions: (await history(wid)).length });
  checks.push({ name: "three retrieval views, automatic upstream evidence and a stable result version", passed: true });
  log("PASS three retrieval views: full=1000 rows, sample=5 rows, stable version, cached results");
}

async function timestampProbe() {
  const { agentId, wid } = await provision("timestamp-observation");
  const views: RetrievalView[] = ["sample_stats"];
  await fetch(`${baseUrl}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retrievalViews: views, maxResultRows: 1, dataEvidenceCharLimit: 2000 }),
  });
  await debug(
    agentId,
    `import pandas as pd

def load_dates():
    """Two known UTC instants."""
    return pd.DataFrame({"when": pd.to_datetime(["2025-01-01T08:00:00Z", "2025-07-01T07:00:00Z"], utc=True)})

def iso_strings(table):
    """The UTC value seen by the next operator."""
    return pd.DataFrame({"iso": [value.isoformat() for value in table["when"]]})
`,
    "set dates: load_dates()\nset date_strings: iso_strings(dates)\nshow result dates, date_strings",
    views
  );
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
  await debug(agentId, "", "show result dates", views);
  const cached = await getSnapshot(agentId, "head", baseUrl);
  save("timestamp-cached-snapshot.json", cached);
  assert.deepEqual((cached.results.dates as any).sampleRecords, dates.sampleRecords);
  assert.equal((cached.results.dates as any).resultVersion.id, dates.resultVersion.id);
  await debug(
    agentId,
    `import pandas as pd

def utc_hours(table):
    """UTC hour from the cached source."""
    return pd.DataFrame({"hour": [value.hour for value in table["when"]]})
`,
    "set date_strings: utc_hours(dates)\nshow result date_strings",
    views
  );
  const downstream = await getSnapshot(agentId, "head", baseUrl);
  save("timestamp-new-consumer-snapshot.json", downstream);
  assert.deepEqual((downstream.results.date_strings as any).sampleRecords, [{ hour: 8 }, { hour: 7 }]);
  assert.equal((downstream.results.dates as any).resultVersion.id, dates.resultVersion.id);
  checks.push({ name: "retrieved UTC timestamps agree with profiles and Python consumers", passed: true });
  log("PASS retrieved UTC timestamps agree with profiles and Python consumers");
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
