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
        stateLedger: false,
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
  assert(initial.systemPrompt.includes("Keep complete working tables separate from reports:"));
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
    { type: "edit", changes: `create operator source: scan(${JSON.stringify(csv)})
create operator typed: cast(id=int64)
create operator positive: filter(lambda row: row["id"] > 0, doc="Positive identifiers")
create operator wide: scan(${JSON.stringify(wideCsv)})
create edge source.out -> typed.in
create edge typed.out -> positive.in` },
    { type: "execute", operator_ids: ["positive", "wide"] },
  ]);
  assert.equal(built.result.status, "completed", built.text);
  assert(built.text.includes("- **source** (scan, created)"));
  passed("edit and named execution receipts use operator blocks");
  const executionCount = (await history()).length;
  for (const tableFormat of ["markdown", "tsv"]) {
    await settings({ tableFormat });
    for (const view of ["full", "sample", "sample_stats"] as const) {
      const records = await debug([{ type: "read", operator_ids: ["positive", "wide"], view,
        columns: null, include_implementation: false }]);
      assert.equal(records.result.status, "completed", records.text);
      assert(records.text.includes("9007199254740993"), records.text);
      assert(records.text.includes('"null"'), records.text);
      assert(records.text.includes(`records: ${view};`));
      assert.equal(records.text.includes("statistics:"), view === "sample_stats", records.text);
      assert(records.text.includes("- flow:"), records.text);
      assert.equal(records.text.includes("| id | label | missing |"), tableFormat === "markdown");
      assert(records.text.includes("- c0:"), records.text);
      assert.equal(records.result.actions[0].output.observations.length, 2);
    }
  }
  assert.equal((await history()).length, executionCount);
  passed("multi-ID reads preserve typed values across every view and layout without execution");
  await settings({ tableFormat: "markdown" });
  await debug([{ type: "answer", content: "Typed records verified.", operator_ids: ["positive"] }]);
  await debug("Read earlier records and check definition-only access without execution.");
  const historical = await debug([{ type: "read", operator_ids: ["positive@1"], view: "full",
    columns: ["id", "label"], include_implementation: false }]);
  assert.equal(historical.result.status, "completed", historical.text);
  assert(historical.text.includes("9007199254740993"));
  assert.equal((await history()).length, executionCount);
  passed("historical projection reads the same saved materialization");
  const reduced = await debug([
    { type: "edit", changes: `create operator reduced: process(fn=select_rows, doc="Select the first two positive identifiers")
    def select_rows(table):
        return table.iloc[:2].copy()
create edge positive.out -> reduced.in` },
    { type: "execute", operator_ids: ["reduced"] },
    { type: "read", operator_ids: ["reduced"], view: "full", columns: null, include_implementation: true },
  ]);
  assert.equal(reduced.result.status, "completed", reduced.text);
  assert(reduced.text.includes("returned 2 of 3 input rows"), reduced.text);
  assert(reduced.text.includes("def select_rows"), reduced.text);
  passed("process reduction metadata is mechanically bound to the executed input and result");
  await debug([{ type: "answer", content: "Reduced records verified.", operator_ids: ["reduced"] }]);
  await debug("Check failed definitions and retained independent results.");
  const failed = await debug([
    { type: "edit", changes: `create operator broken: process(fn=fail, doc="Fail deliberately")
    def fail():
        raise ValueError("intentional live fixture failure")` },
    { type: "execute", operator_ids: ["broken"] },
  ]);
  assert.equal(failed.result.status, "error", failed.text);
  const definitions = await debug([{ type: "read", operator_ids: ["broken"], view: null,
    columns: null, include_implementation: true }]);
  assert.equal(definitions.result.status, "completed", definitions.text);
  assert(definitions.text.includes("intentional live fixture failure"));
  const independent = await debug([{ type: "read", operator_ids: ["positive@1"], view: "full",
    columns: null, include_implementation: false }]);
  assert.equal(independent.result.status, "completed", independent.text);
  await debug([{ type: "answer", content: "Independent saved table verified.", operator_ids: ["positive@1"] }]);
  passed("failed operators remain inspectable while independent saved results remain readable");
  await debug("Compute empty and scalar outputs and rank the full working table without a report operator.");
  const final = await debug([
    { type: "edit", changes: `create operator empty: filter(lambda row: row["id"] < 0, doc="No positive identifiers")
create operator scalar: aggregate(by=[], n=count())
create edge positive@1.out -> empty.in
create edge positive@1.out -> scalar.in` },
    { type: "execute", operator_ids: ["empty", "scalar"] },
    { type: "read", operator_ids: ["empty", "scalar"], view: "full", columns: null, include_implementation: false },
  ]);
  assert.equal(final.result.status, "completed", final.text);
  assert(final.text.includes("empty table"), final.text);
  assert(final.text.includes("| 3 |"), final.text);
  const answer = await debug([{ type: "answer", from: "positive@1[id,label] top 2 by id desc" }]);
  assert.equal(answer.result.status, "completed", answer.text);
  assert(answer.result.answer?.includes("9007199254740993"));
  passed("empty/scalar outputs and int64 answer ordering use complete source tables");
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
