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

/** Live engine checks for the shared native observation format.
 * Run with the local stack: bun benchmark/e2e/observation-format-run.ts
 * No model calls; the real action runtime and engine produce every receipt.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import {
  renderDataflowActionsResult,
  asDataflowActionsResult,
  type DataflowAction,
} from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { nativeDebugInput } from "./native-debug-input";

const base = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = mkdtempSync(join(tmpdir(), "observation-format-live-"));
const checks: string[] = [];
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
let token = "",
  agentId = "",
  wid: number | undefined,
  cuid: number | undefined;
async function json<T = Record<string, unknown>>(url: string, auth = false): Promise<T> {
  const response = await fetch(url, auth ? { headers: { Authorization: `Bearer ${token}` } } : {});
  assert.equal(response.status, 200, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json() as Promise<T>;
}
const history = () => json<unknown[]>(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, true);
async function settings(patch: Record<string, unknown>, expected = 200) {
  const response = await fetch(`${base}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  assert.equal(response.status, expected);
}
async function debug(actions: DataflowAction[] | string) {
  const before = (await getReActSteps(agentId, base)).steps.length;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Debug actions timed out"));
    }, 240000);
    let sent = false,
      finished = false;
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        const args = { reasoning: "Validate the observation format against the live engine.", actions };
        ws.send(
          JSON.stringify({
            type: "debug",
            content: typeof actions === "string" ? actions : nativeDebugInput("dataflow", args),
          })
        );
      } else if (frame.type === "complete") finished = true;
      else if (frame.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(String(frame.content)));
      } else if (frame.type === "nextContext" && finished) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Debug socket failed"));
    };
  });
  const { steps } = await getReActSteps(agentId, base);
  save("react-steps.json", steps);
  const fresh = steps.slice(before);
  assert(fresh.length, "Debug input produced no new trace steps");
  const error = fresh.find(step => step.content?.startsWith("[ERROR]"));
  assert(!error, error?.content);
  const result = fresh
    .flatMap(step => (step.toolResults ?? []).map(item => asDataflowActionsResult(item.output)))
    .filter(Boolean)
    .at(-1)!;
  if (typeof actions === "string") return { result: undefined as any, text: "" };
  assert(result, "Debug actions produced no tool result");
  const text = renderDataflowActionsResult(result);
  writeFileSync(join(directory, `receipt-${checks.length}-${Date.now()}.md`), text);
  return { result, text };
}
function passed(name: string) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  cuid = (
    await createComputingUnit(token, `observation-format-${Date.now()}`, {
      unitType: "local",
      uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    })
  ).computingUnit.cuid;
  wid = await createWorkflow(token, `observation-format-${Date.now()}`, new WorkflowState().getWorkflowContent());
  agentId = (
    await createAgent({
      baseUrl: base,
      userToken: token,
      workflowId: wid,
      computingUnitId: cuid,
      modelType: "gpt-5.6-luna",
      settings: {
        agentMode: "native",
        contextMode: "delta",
        messageLayout: "native",
        retrievalViews: ["full", "sample", "sample_stats"],
        dataEvidence: true,
        flowEvidence: true,
        nativeProfileCollection: true,
        multiTask: true,
        stateHistory: true,
        stateLedger: true,
        catalogRecords: 1,
        maxResultRows: 1,
        maxOperatorResultCharLimit: 2000,
      },
    })
  ).id;
  save("settings.json", await json(`${base}/api/agents/${agentId}/settings`));
  const initial = await json<{ systemPrompt: string }>(`${base}/api/agents/${agentId}/system-info`);
  assert(initial.systemPrompt.startsWith("## Role and objective"));
  assert(initial.systemPrompt.includes("### Earlier tasks in the session"));
  assert(initial.systemPrompt.includes("Keep reusable working tables separate from answer tables."));
  assert(!/texera|\{\{/i.test(initial.systemPrompt));
  writeFileSync(join(directory, "system-prompt.txt"), initial.systemPrompt);
  passed("creation settings and generated multi-task prompt");
  const beforeInvalid = await json(`${base}/api/agents/${agentId}/settings`);
  await settings({ maxSteps: 3, tableFormat: "csv" }, 400);
  assert.deepEqual(await json(`${base}/api/agents/${agentId}/settings`), beforeInvalid);
  passed("invalid format PATCH is atomic");
  await debug("Verify the typed records and their observations.");
  const csv = join(directory, "records.csv"),
    wideCsv = join(directory, "wide.csv");
  writeFileSync(csv, "id,label,missing\n9007199254740993,null,\n2,A|B,\n3,,\n");
  writeFileSync(
    wideCsv,
    [
      Array.from({ length: 13 }, (_, i) => `c${i}`).join(","),
      Array.from({ length: 13 }, (_, i) => i).join(","),
      Array.from({ length: 13 }, (_, i) => i + 1).join(","),
    ].join("\n") + "\n"
  );
  const built = await debug([
    {
      type: "edit",
      changes: `create operator source: scan(${JSON.stringify(csv)})\ncreate operator typed: cast(id=int64)\ncreate operator positive: filter(lambda row: row["id"] > 0, doc="Positive identifiers")\ncreate operator wide: scan(${JSON.stringify(wideCsv)})\ncreate edge source.out -> typed.in\ncreate edge typed.out -> positive.in`,
    },
    { type: "execute" },
  ]);
  assert.equal(built.result.status, "completed", built.text);
  assert(built.text.includes("### 1. edit: ok"));
  assert(built.text.includes("- **source** (scan, created)"));
  assert(!built.text.includes('"operators":'));
  passed("edit and execution receipts use operator blocks");
  const executionCount = (await history()).length;
  for (const tableFormat of ["markdown", "tsv"]) {
    await settings({ tableFormat });
    for (const view of ["full", "sample", "sample_stats"] as const) {
      const read = await debug([{ type: "retrieve", operator_id: "positive", view }]);
      assert.equal(read.result.status, "completed", read.text);
      assert(read.text.includes("9007199254740993"));
      assert(read.text.includes('"null"'));
      assert(read.text.includes(`records: ${view};`));
      assert.equal(read.text.includes("statistics:"), view === "sample_stats");
      assert(read.text.includes("- flow:"));
      assert.equal(read.text.includes("| id | label | missing |"), tableFormat === "markdown");
      const wideRead = await debug([{ type: "retrieve", operator_id: "wide", view }]);
      assert(wideRead.text.includes("- c0:"));
    }
  }
  assert.equal((await history()).length, executionCount);
  passed("all views and layouts preserve typed values and never execute on retrieval");
  await settings({ tableFormat: "markdown" });
  const seal = await debug([{ type: "answer", content: "Typed records verified." }]);
  assert(seal.text.includes("#### Task"));
  assert(!seal.text.includes("Typed records verified."));
  const task = Number(/#### Task (\d+)/.exec(seal.text)![1]);
  await debug("Compare the completed task's saved result.");
  const copy = await debug([
    { type: "edit", changes: `fork operator positive from task ${task} as historical` },
    { type: "retrieve", operator_id: "historical", view: "full" },
  ]);
  assert.equal(copy.result.status, "completed", copy.text);
  assert(copy.text.includes(`forked from task ${task}`));
  assert(copy.text.includes("9007199254740993"));
  assert.equal((await history()).length, executionCount);
  passed("sealed catalog and historical copy retain the original result");

  // Execute the prompt's examples rather than a separate hand-written graph.
  const exampleCalls = (heading: string) => {
    const section = initial.systemPrompt.split(heading)[1]?.split("\n### Example:")[0] ?? "";
    const calls = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body));
    assert(calls.length, `Missing prompt example ${heading}`);
    return calls;
  };
  const working = exampleCalls("### Example: build on an earlier task");
  const revise = exampleCalls("### Example: revise a rule for the rest of the session");
  const versions = exampleCalls("### Example: compare with an earlier task and go back");
  const orders = join(directory, "orders.csv");
  const amounts = [
    [20, 24, 10],
    [20, 20, 17],
    [20, 20, 20],
    [21, 21, 21],
    [18, 18, 30],
    [27, 27, 15],
    [24, 24, 24],
    [25, 25, 25],
  ];
  const orderRows = amounts.flatMap((values, i) =>
    values.map(
      (amount, j) =>
        `${3 * i + j + 1},U0${i + 1},${j === 2 && [0, 2, 4, 5, 7].includes(i) ? "cancelled" : "delivered"},${amount}`
    )
  );
  writeFileSync(orders, "order,unit,status,amount\n" + orderRows.join("\n") + "\n");
  const read = (outcome: Awaited<ReturnType<typeof debug>>, id: string) => {
    assert.equal(outcome.result.status, "completed", outcome.text);
    const output = outcome.result.actions.find(
      (item: any) => item.action.type === "retrieve" && item.action.operator_id === id
    )?.output as any;
    assert(output, `No retrieved result for ${id}`);
    return output;
  };
  await settings({ maxResultRows: 0 });
  await debug("Working-state example, task 1: rank delivered-order amounts.");
  const first = await debug(
    working[0].actions.map((action: any) =>
      action.type === "edit"
        ? { ...action, changes: action.changes.replaceAll("data/unit_orders.csv", orders) }
        : action
    )
  );
  assert.equal(read(first, "score").table.totalRows, 8);
  assert.equal(read(first, "report").table.totalRows, 3);
  assert.equal((await debug(working[1].actions)).result.status, "completed");
  await debug("Working-state example, task 2: count coverage on all source orders.");
  const covered = await debug(working[2].actions);
  assert.equal(read(covered, "covered_scores").table.totalRows, 8);
  assert.equal(read(covered, "report").table.totalRows, 5);
  const coveredAnswer = await debug(working[3].actions);
  const savedTask = Number(/#### Task (\d+)/.exec(coveredAnswer.text)![1]);
  passed("prompt examples retain eight working scores behind a top-five answer");
  await debug("Working-state example, task 3: all orders with amounts now contribute.");
  const revised = await debug(revise[0].actions);
  assert(read(revised, "covered_scores").text.includes("| U01 | 54 |"));
  assert.equal((await debug(revise[1].actions)).result.status, "completed");
  await debug("Working-state example, task 4: compare all units with task 2.");
  const beforeReads = (await history()).length;
  const inspected = await debug([
    {
      type: "inspect",
      target: "state",
      operator_id: "score",
      task_id: savedTask,
      include_implementation: false,
      view: "full",
    },
  ]);
  assert.equal(inspected.result.status, "completed", inspected.text);
  assert(inspected.text.includes("| U01 | 44 |"));
  const forked = await debug([
    { type: "edit", changes: `fork operator score from task ${savedTask} as score_t2` },
    { type: "retrieve", operator_id: "score_t2", view: "full" },
  ]);
  assert(read(forked, "score_t2").text.includes("| U01 | 44 |"));
  assert.equal((await history()).length, beforeReads);
  const comparison = await debug(
    versions[0].actions.map((action: any) =>
      action.type === "edit"
        ? { ...action, changes: action.changes.replace(/^fork operator score from task 2 as score_t2\n/, "") }
        : action
    )
  );
  assert.equal(read(comparison, "score_change").table.totalRows, 8);
  assert(read(comparison, "score_change").text.includes("| U01 | 54 | 44 | 10 |"));
  await debug([{ type: "answer", content: '{"comparison":"verified for all eight units"}' }]);
  passed("historical inspection and fork read saved results without execution; comparison uses all rows");
  await debug("Working-state example, task 5: restore delivered-only scoring on the updated source.");
  const changedOrders = join(directory, "orders-updated.csv");
  writeFileSync(changedOrders, "order,unit,status,amount\n" + [...orderRows, "25,U01,delivered,100"].join("\n") + "\n");
  await debug([{ type: "edit", changes: `update operator orders: scan(${JSON.stringify(changedOrders)})` }]);
  await debug(versions[1].actions);
  const restored = await debug([
    ...versions[2].actions.map((action: any) =>
      action.type === "edit"
        ? { ...action, changes: action.changes.replace("from task 2", `from task ${savedTask}`) }
        : action
    ),
    { type: "retrieve", operator_id: "score", view: "full" },
    { type: "retrieve", operator_id: "score_t2", view: "full" },
  ]);
  assert(read(restored, "score").text.includes("| U01 | 144 |"));
  assert(read(restored, "score_t2").text.includes("| U01 | 44 |"));
  passed("restoration uses current inputs while the historical fork keeps its original inputs");
  const fewer = await debug([
    {
      type: "edit",
      changes:
        'update operator covered_scores: filter(lambda row: row["order_count"] >= 3 and row["unit"] in ["U01", "U03"], doc="Two qualifying units")',
    },
    { type: "execute", operator_ids: ["report"] },
    { type: "retrieve", operator_id: "report", view: "full" },
  ]);
  assert.equal(read(fewer, "report").table.totalRows, 2);
  const empty = await debug([
    {
      type: "edit",
      changes: 'update operator covered_scores: filter(lambda row: row["order_count"] >= 5, doc="No qualifying units")',
    },
    { type: "execute", operator_ids: ["report"] },
    { type: "retrieve", operator_id: "report", view: "full" },
  ]);
  assert.equal(read(empty, "report").table.totalRows, 0);
  await debug([{ type: "answer", content: '{"rows":[],"qualifying_units":0}' }]);
  passed("requested top-five reports preserve two-row and empty eligible populations");
  const failure = await debug([
    {
      type: "edit",
      changes:
        'create operator broken: filter(lambda row: row["unknown"] > 0, doc="Exercise a missing column")\ncreate operator blocked: project(keep=["label"])\ncreate edge source.out -> broken.in\ncreate edge broken.out -> blocked.in',
    },
    { type: "execute", operator_ids: ["blocked"] },
    { type: "retrieve", operator_id: "broken", view: "sample" },
  ]);
  assert.equal(failure.result.status, "error");
  assert(failure.text.includes("- error "));
  assert(failure.text.includes("- not run: blocked"));
  assert(!failure.text.includes("NATIVE_ERROR_V2"));
  const rejected = await debug([
    { type: "edit", changes: "create edge absent.out -> positive.in" },
    { type: "execute" },
  ]);
  assert(rejected.text.includes("skipped"));
  passed("runtime failures and skipped actions use canonical issue lines");

  // Ordinary ReAct uses the same structural facts with no ledger and no
  // statistics exposure. All data and expected values are the toy fixture above.
  await settings({ stateLedger: false, dataEvidence: false, flowEvidence: false, retrievalViews: ["full", "sample"] });
  const ordinary = await debug([
    {
      type: "edit",
      changes:
        'update operator covered_scores: filter(lambda row: row["order_count"] >= 3, doc="Units with at least three source orders")\ncreate operator mean_score: aggregate(by=[], average_score=mean("score"))\ncreate edge report.out -> mean_score.in',
    },
    { type: "execute", operator_ids: ["mean_score"] },
    { type: "retrieve", operator_id: "mean_score", view: "full" },
  ]);
  assert(ordinary.text.includes('scope: limit "report": n=5'), ordinary.text);
  assert(read(ordinary, "mean_score").text.includes("| 78 |"));
  assert(!ordinary.text.includes("#### Task"));
  assert(!ordinary.text.includes("statistics:"));
  assert(!ordinary.text.includes("- flow"));
  const beforeScopeReads = (await history()).length;
  const inspectedScope = await debug([
    { type: "inspect", target: "operator", operator_id: "mean_score", include_implementation: false },
    { type: "retrieve", operator_id: "mean_score", view: "sample" },
  ]);
  assert(inspectedScope.text.includes('scope: limit "report": n=5'));
  assert.equal((await history()).length, beforeScopeReads);
  const frozenOrdinary = renderDataflowActionsResult(ordinary.result);
  const repair = exampleCalls("### Example: repair an aggregate that reads a limited report");
  const repairedScope = await debug(repair[0].actions);
  assert(read(repairedScope, "mean_score").text.includes("| 64.5 |"));
  assert(!repairedScope.text.includes('scope: limit "report"'));
  assert.equal(renderDataflowActionsResult(ordinary.result), frozenOrdinary);
  passed("ordinary observations expose limited input ancestry; the generic repair recomputes the full-table mean");

  await debug([{ type: "edit", changes: "update operator report: limit(2)" }]);
  const savedScope = await debug([
    {
      type: "inspect",
      target: "state",
      task_id: savedTask,
      operator_id: "report",
      include_implementation: false,
      view: "full",
    },
    { type: "edit", changes: `fork operator report from task ${savedTask} as report_saved` },
    { type: "retrieve", operator_id: "report_saved", view: "full" },
  ]);
  assert(savedScope.text.includes('scope: limit "report": n=5'));
  assert(savedScope.text.includes('scope: limit "report_saved": n=5'));
  assert.equal(read(savedScope, "report_saved").table.totalRows, 5);
  assert.equal((await history()).length, beforeScopeReads + 1);
  assert.equal(renderDataflowActionsResult(ordinary.result), frozenOrdinary);
  passed("saved and forked scopes keep the old limit after today's definition changes without executing");
  save("summary.json", { passed: true, checks, artifactDirectory: directory });
  console.log(`Artifacts: ${directory}`);
} catch (error) {
  save("summary.json", { passed: false, checks, error: String(error), artifactDirectory: directory });
  throw error;
} finally {
  try {
    if (agentId && wid !== undefined && cuid !== undefined) {
      assertNativeCleanupSafe(await json(`${base}/api/agents/${agentId}`), await history(), { agentId, wid, cuid });
      await deleteAgent(agentId, base);
    }
    if (wid !== undefined) await deleteWorkflow(token, wid);
    if (cuid !== undefined) await terminateComputingUnit(token, cuid);
    save("cleanup.json", { removed: true, agentId, wid, cuid });
  } catch (error) {
    save("cleanup.json", { removed: false, agentId, wid, cuid, error: String(error) });
  }
}
