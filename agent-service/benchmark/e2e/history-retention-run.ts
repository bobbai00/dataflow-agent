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

/** No model calls: check delayed history reads and external-source retention. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import {
  asDataflowActionsResult,
  renderDataflowActionsResult,
  type DataflowAction,
} from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { nativeDebugInput } from "./native-debug-input";

const base = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = process.env.HISTORY_RETENTION_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "history-retention-live-"));
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
const checks: string[] = [];
let token = "",
  agentId = "",
  wid: number | undefined,
  cuid: number | undefined,
  sequence = 0;

async function debug(actions: DataflowAction[] | string) {
  const before = (await getReActSteps(agentId, base)).steps.length;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Live process check timed out"));
    }, 240_000);
    let sent = false,
      finished = false;
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(
          JSON.stringify({
            type: "debug",
            content:
              typeof actions === "string"
                ? actions
                : nativeDebugInput("dataflow", {
                    reasoning: "Verify integer process inputs through the live execution engine.",
                    actions,
                  }),
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
      reject(new Error("Live process socket failed"));
    };
  });
  const { steps } = await getReActSteps(agentId, base);
  save("react-steps.json", steps);
  const result = steps
    .slice(before)
    .flatMap(step => (step.toolResults ?? []).map(item => asDataflowActionsResult(item.output)))
    .filter(Boolean)
    .at(-1)!;
  if (typeof actions === "string") return { result: undefined as any, text: "" };
  assert(result, "Debug actions produced no receipt");
  save(`receipt-${++sequence}.json`, result);
  const text = renderDataflowActionsResult(result);
  writeFileSync(join(directory, `receipt-${sequence}.md`), text);
  return { result, text };
}

const reads: unknown[] = [];
async function readHistory(task: number) {
  const receipt = await debug([
    {
      type: "inspect",
      target: "state",
      task_id: task,
      operator_id: "scores",
      include_implementation: true,
      view: "full",
    },
  ]);
  assert.equal(receipt.result.status, "completed", receipt.text);
  assert(receipt.text.includes("| U146 | 294 |"), receipt.text);
  reads.push({ task, receipt: receipt.text });
  return receipt;
}
async function executions() {
  const response = await fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(response.ok);
  return ((await response.json()) as unknown[]).length;
}
try {
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  cuid = (
    await createComputingUnit(token, `history-retention-${Date.now()}`, {
      unitType: "local",
      uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    })
  ).computingUnit.cuid;
  wid = await createWorkflow(token, `history-retention-${Date.now()}`, new WorkflowState().getWorkflowContent());
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
        multiTask: true,
        stateHistory: true,
        stateLedger: true,
        retrievalViews: ["full", "sample_stats"],
        dataEvidence: true,
        nativeProfileCollection: true,
        fullResultCharLimit: 100000,
        maxOperatorResultCharLimit: 500,
        maxResultRows: 3,
        executionTimeoutMinutes: 1,
        toolTimeoutSeconds: 90,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0 });
  const oldFile = join(directory, "original.csv"),
    updatedFile = join(directory, "updated.csv");
  const rows = (count: number, start: number) =>
    "unit,value,quality\n" +
    Array.from({ length: count }, (_, i) => `U${String(i).padStart(3, "0")},${start + i},${i % 2 === 0 ? 1 : 0}`).join(
      "\n"
    ) +
    "\n";
  writeFileSync(oldFile, rows(150, 1));
  writeFileSync(updatedFile, rows(15, 1000));
  await debug("Task 1: retain the complete qualified scoring population.");
  const first = await debug([
    {
      type: "edit",
      changes: `create operator source: scan(${JSON.stringify(oldFile)})
create operator eligible: filter(lambda row: row["quality"] == 1, doc="Quality-qualified population")
create operator scores: map(lambda row: {"unit": row["unit"], "score": int(row["value"])*2}, doc="Double value")
create edge source.out -> eligible.in
create edge eligible.out -> scores.in`,
    },
    { type: "execute" },
    { type: "retrieve", operator_id: "scores", view: "sample_stats" },
  ]);
  assert.equal(first.result.status, "completed", first.text);
  assert(!first.text.includes("U146"), "Probe unit should be outside the initial preview");
  await debug([{ type: "answer", content: "Saved the 75 qualified scores." }]);
  await debug("Task 2: use the updated population, broaden eligibility and triple the values.");
  const changed = await debug([
    {
      type: "edit",
      changes: `update operator source: scan(${JSON.stringify(updatedFile)})
update operator eligible: filter(lambda row: row["value"] > 0, doc="Positive population")
update operator scores: map(lambda row: {"unit": row["unit"], "score": int(row["value"])*3}, doc="Triple value")`,
    },
    { type: "execute" },
  ]);
  assert.equal(changed.result.status, "completed", changed.text);
  await debug([{ type: "answer", content: "Updated 15 scores under the revised rule." }]);
  for (let task = 3; task <= 17; task++) {
    await debug(`Task ${task}: keep the current analysis; acknowledge the saved result.`);
    if (task === 9 || task === 17) {
      const count = await executions();
      await readHistory(1);
      assert.equal(await executions(), count, "Delayed historical reads must not execute");
      checks.push(`history survives ${task - 1} later requests and multiple changed ancestors`);
    }
    await debug([{ type: "answer", content: `Current scoring definition retained at request ${task}.` }]);
  }
  await debug("Task 18: compare the task-1 working population after a physical overwrite.");
  const count = await executions();
  const fork = await debug([
    { type: "edit", changes: "fork operator scores from task 1 as saved_scores" },
    { type: "retrieve", operator_id: "saved_scores", view: "full" },
  ]);
  assert.equal(fork.result.status, "completed", fork.text);
  assert(fork.text.includes("U148") && fork.text.includes("298"), fork.text);
  assert.equal(await executions(), count, "Fork and saved retrieval must not execute");
  writeFileSync(oldFile, rows(150, 9001));
  await readHistory(1);
  const recomputed = await debug([
    { type: "execute", operator_ids: ["saved_scores"] },
    { type: "retrieve", operator_id: "saved_scores", view: "full" },
  ]);
  assert.equal(recomputed.result.status, "completed", recomputed.text);
  const onNewBytes = recomputed.text.includes("18298");
  const onSavedBytes = recomputed.text.includes("298") && !onNewBytes;
  assert(onNewBytes || onSavedBytes, recomputed.text);
  save("external-overwrite.json", {
    historical_read_stays_original: true,
    fork_execution: onNewBytes ? "old definitions on overwritten external bytes" : "cached original result",
    receipt: recomputed.text,
  });
  checks.push("saved observation survives physical source overwrite; execution behavior recorded separately");
  await debug([{ type: "answer", content: "External overwrite and saved observations checked." }]);
  await debug("Task 19: inspect the original version after physical source deletion.");
  unlinkSync(oldFile);
  await readHistory(1);
  const deleted = await debug([
    { type: "edit", changes: "fork operator scores from task 1 as deleted_probe" },
    { type: "execute", operator_ids: ["deleted_probe"] },
  ]);
  assert(["completed", "error"].includes(deleted.result.status), deleted.text);
  if (deleted.result.status === "error")
    assert(/SCAN_NOT_FOUND|FileNotFound|SOURCE_IO|No such file/.test(deleted.text), deleted.text);
  save("external-deletion.json", {
    historical_read_stays_original: true,
    fork_execution:
      deleted.result.status === "error" ? "cannot recompute missing external input" : "backend cache supplied result",
    receipt: deleted.text,
  });
  checks.push("saved observation survives deletion; recomputation/cache outcome recorded");
  await debug([{ type: "answer", content: "Source deletion and saved observation checked." }]);
  await debug("Task 20: restore task-1 definitions on the current updated input.");
  const restored = await debug([
    { type: "edit", changes: "update operator eligible from task 1\nupdate operator scores from task 1" },
    { type: "execute", operator_ids: ["scores"] },
    { type: "retrieve", operator_id: "scores", view: "full" },
  ]);
  assert.equal(restored.result.status, "completed", restored.text);
  assert(restored.text.includes("2028") && restored.text.includes("2000"), restored.text);
  await readHistory(1);
  checks.push("restoration uses current input; failed independent historical branch remains isolated");
  await debug([{ type: "answer", content: "Restored eight qualified scores on the current input." }]);
  save("historical-reads.json", reads);
  save("report.json", {
    status: "passed",
    checks,
    model_calls: 0,
    requests: 20,
    limitation:
      "This fixture fits within the retained result cap. It does not establish unbounded historical materialization.",
  });
  console.log(JSON.stringify({ directory, checks, model_calls: 0 }));
} catch (error) {
  save("report.json", { status: "failed", checks, error: String(error), model_calls: 0 });
  throw error;
} finally {
  if (agentId && wid !== undefined && cuid !== undefined) {
    const [agentResponse, historyResponse] = await Promise.all([
      fetch(`${base}/api/agents/${agentId}`),
      fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    assert(agentResponse.ok && historyResponse.ok, "Cleanup state unavailable; retaining owned resources");
    assertNativeCleanupSafe(await agentResponse.json(), await historyResponse.json(), { agentId, wid, cuid });
    await deleteAgent(agentId, base);
    await deleteWorkflow(token, wid);
    await terminateComputingUnit(token, cuid);
    save("cleanup.json", { status: "completed", agentId, wid, cuid });
  }
}
