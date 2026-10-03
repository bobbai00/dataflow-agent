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
        const args = JSON.stringify({ reasoning: "Validate the observation format against the live engine.", actions });
        ws.send(
          JSON.stringify({
            type: "debug",
            content:
              typeof actions === "string" ? actions : `Function(name="dataflow", arguments=${JSON.stringify(args)})`,
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
  const result = steps
    .flatMap(step => (step.toolResults ?? []).map(item => asDataflowActionsResult(item.output)))
    .filter(Boolean)
    .at(-1)!;
  if (!result) return { result: undefined as any, text: "" };
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
  assert(initial.systemPrompt.includes("## Multi-task sessions"));
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
  assert(built.text.includes("operators:"));
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
  assert(seal.text.includes("### Catalog: task"));
  assert(!seal.text.includes("Typed records verified."));
  const task = Number(/### Catalog: task (\d+)/.exec(seal.text)![1]);
  await debug("Compare the completed task's saved result.");
  const copy = await debug([
    { type: "edit", changes: `rollback operator positive to task ${task} as historical` },
    { type: "retrieve", operator_id: "historical", view: "full" },
  ]);
  assert.equal(copy.result.status, "completed", copy.text);
  assert(copy.text.includes(`copied from task ${task}`));
  assert(copy.text.includes("9007199254740993"));
  assert.equal((await history()).length, executionCount);
  passed("sealed catalog and historical copy retain the original result");
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
  assert(failure.text.includes("- **blocked** (project, not run)\n  - inputs: `broken`\n  - result: not run"));
  assert(!failure.text.includes("NATIVE_ERROR_V2"));
  const rejected = await debug([
    { type: "edit", changes: "create edge absent.out -> positive.in" },
    { type: "execute" },
  ]);
  assert(rejected.text.includes("skipped"));
  passed("runtime failures and skipped actions use canonical issue lines");
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
