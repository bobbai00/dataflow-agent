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

/** No model calls: check task dependencies, immutable inspection and thin context. */
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
const directory = process.env.TASK_CONTEXT_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "task-context-live-"));
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

async function history() {
  const response = await fetch(`${base}/api/agents/${agentId}/task-history`);
  assert(response.ok);
  return ((await response.json()) as { tasks: import("../../src/agent/task-history").TaskRecord[] }).tasks;
}
async function catalogSettings(catalogStatistics: boolean, catalogRecords: number) {
  const response = await fetch(`${base}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalogStatistics, catalogRecords }),
  });
  assert(response.ok);
  const settings = (await response.json()) as { catalogStatistics: boolean; catalogRecords: number };
  assert.equal(settings.catalogStatistics, catalogStatistics);
  assert.equal(settings.catalogRecords, catalogRecords);
}
try {
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  cuid = (
    await createComputingUnit(token, `task-context-${Date.now()}`, {
      unitType: "local",
      uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    })
  ).computingUnit.cuid;
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0 });
  wid = await createWorkflow(token, `task-context-${Date.now()}`, new WorkflowState().getWorkflowContent());
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0 });
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
        taskContext: "dependencies",
        stateLedger: false,
        retrievalViews: ["full", "sample"],
        dataEvidence: false,
        flowEvidence: false,
        nativeProfileCollection: true,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 2000,
        executionTimeoutMinutes: 1,
        toolTimeoutSeconds: 90,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0 });
  const run = async (actions: DataflowAction[]) => {
    const receipt = await debug(actions);
    assert.equal(receipt.result.status, "completed", receipt.text);
    return receipt;
  };
  const source = (scale: number) => `process(fn=load, doc="Three reusable scores")
    def load():
        return pd.DataFrame({"id": ["a", "b", "c"], "score": [${scale}, ${2 * scale}, ${3 * scale}]})`;
  await debug("Task 1: calculate the complete sum of three scores.");
  await run([
    {
      type: "edit",
      changes: `create operator source: ${source(1)}
create operator total: aggregate(sum_score=sum("score"))
create edge source.out -> total.in`,
    },
    { type: "execute", operator_ids: ["total"] },
    { type: "read", operator_ids: ["total"], view: "full", columns: null, include_implementation: false },
  ]);
  await run([{ type: "answer", content: "The sum is 6.", operator_ids: ["total"] }]);
  const initialCatalog = (await history())[0];
  assert(!initialCatalog.operator_records);
  assert(initialCatalog.operator_changes?.every(block => !block.result?.includes("stats full")));
  const firstFrame = JSON.stringify(initialCatalog);
  await catalogSettings(true, 1);
  await debug("Task 2: reuse the sum and add a calculation on the same prepared scores.");
  const cached = await run([
    { type: "execute", operator_ids: ["total"] },
    { type: "read", operator_ids: ["total"], view: "full", columns: null, include_implementation: false },
  ]);
  assert(cached.result.actions[0].output.operators.some((o: any) => o.state === "cached"));
  await run([
    {
      type: "edit",
      changes: `create operator task2_shift: map(lambda row: {"score": row["score"] + 1}, doc="Add one to each score")
create operator task2_doubled: map(lambda row: {"score": row["score"] * 2}, doc="Double each shifted score")
create operator task2_selected: filter(lambda row: row["score"] >= 6, doc="Keep doubled scores at least six")
create operator task2_ranked: sort(by=("score", "desc"))
create operator task2_answer: aggregate(sum_score=sum("score"))
create edge source.out -> task2_shift.in
create edge task2_shift.out -> task2_doubled.in
create edge task2_doubled.out -> task2_selected.in
create edge task2_selected.out -> task2_ranked.in
create edge task2_ranked.out -> task2_answer.in`,
    },
    { type: "execute", operator_ids: ["task2_answer"] },
    { type: "read", operator_ids: ["task2_answer"], view: "full", columns: null, include_implementation: false },
  ]);
  await run([
    {
      type: "answer",
      content: "The cached sum is 6. The transformed sum is 14.",
      operator_ids: ["total", "task2_answer"],
    },
  ]);
  let tasks = await history();
  assert.equal(JSON.stringify(tasks[0]), firstFrame);
  assert(tasks[1].operator_changes?.some(block => block.result?.includes("stats full")));
  assert(tasks[1].operator_records?.task2_answer.includes("| 14 |"));
  const secondFrame = JSON.stringify(tasks[1]);
  await catalogSettings(false, 0);
  assert(
    tasks[1].dependencies.some((d: any) => d.task_id === 1 && d.references.some((r: any) => r.kind === "compute")),
    JSON.stringify(tasks)
  );
  checks.push("cached data keeps its original task dependency");
  await debug("Task 3: multiply each input score by ten using the same summation rule.");
  await run([
    { type: "edit", changes: `update operator source: ${source(10)}` },
    { type: "execute", operator_ids: ["total"] },
    { type: "read", operator_ids: ["total"], view: "full", columns: null, include_implementation: false },
  ]);
  await run([{ type: "answer", content: "The revised sum is 60.", operator_ids: ["total"] }]);
  tasks = await history();
  assert.equal(JSON.stringify(tasks[1]), secondFrame);
  assert(!tasks[2].operator_records);
  assert(tasks[2].operator_changes?.every(block => !block.result?.includes("stats full")));
  checks.push("catalog statistics and retrieved rows default off, can be toggled, and preserve completed frames");
  assert(
    tasks[2].dependencies.some((d: any) => d.task_id === 1 && d.references.some((r: any) => r.kind === "definition")),
    JSON.stringify(tasks)
  );
  checks.push("an unchanged definition and recomputed data have separate provenance");
  await debug("Task 4: read task 2's saved calculation and compare the original sum with today's sum.");
  const inspection = await run([
    { type: "read", operator_ids: ["task2_answer@2", "source@1"], view: "full", columns: null, include_implementation: true },
  ]);
  assert(inspection.text.includes("| 14 |") && inspection.text.includes("def load"), inspection.text);
  assert.equal(inspection.result.actions[0].output.operator_blocks.length, 2);
  assert(inspection.text.includes("task2_ranked@2"), inspection.text);
  checks.push("named reads show direct historical inputs without an expanded ancestor graph");
  const unscoped = await debug([{ type: "inspect", target: "graph" }]);
  assert.equal(unscoped.result.status, "error");
  const branch = await run([
    { type: "edit", changes: "create operator old_total from total@1" },
    { type: "execute", operator_ids: ["old_total"] },
    { type: "read", operator_ids: ["old_total", "total@1"], view: "full", columns: null, include_implementation: false },
  ]);
  assert(branch.text.includes("| 6 |"), branch.text);
  const executed = branch.result.actions[1].output.operators;
  assert.deepEqual(executed.map((op: any) => [op.id, op.state]), [["old_total", "executed"], ["source@1", "cached"]]);
  const restored = await run([
    { type: "edit", changes: "update operator total from total@1" },
    { type: "execute", operator_ids: ["total"] },
    { type: "read", operator_ids: ["total"], view: "full", columns: null, include_implementation: false },
  ]);
  assert(restored.text.includes("| 60 |"), restored.text);
  await run([{ type: "answer", content: "Saved sum 6; current sum 60.", operator_ids: ["old_total", "total"] }]);
  tasks = await history();
  assert(tasks[3].dependencies.some((d: any) => d.task_id === 1));
  checks.push("editable branch uses saved direct inputs; a definition update preserves current inputs");
  await debug("Task 5: delete current operators and inspect both earlier answer sources.");
  await run([
    { type: "edit", changes: "delete operator source\ndelete operator total" },
    { type: "read", operator_ids: ["total@1", "total@3"], view: "full", columns: null, include_implementation: false },
  ]);
  await run([{ type: "answer", content: "Both saved versions remain available.", operator_ids: ["total@1", "total@3"] }]);
  tasks = await history();
  assert.equal(tasks.length, 5);
  assert(tasks.every(t => t.status === "answered"));
  const unknown = await debug([{ type: "read", operator_ids: ["total@999"], view: null, columns: null, include_implementation: false }]);
  assert.equal(unknown.result.status, "error");
  assert(/task 999/i.test(unknown.text), unknown.text);
  checks.push("deleted operators remain saved; an unknown task fails explicitly");
  await debug("Task 6: create an old branch within an ordered edit and adjust its saved input.");
  const ordered = await run([
    { type: "edit", changes: `create operator staged_total: limit(1)
delete operator staged_total
create operator staged_total from total@1
create operator staged_shift: map(lambda row: {"score": row["score"] + 5}, doc="Add five to each original score")
create edge source@1.out -> staged_shift.in
delete edge source@1.out -> staged_total.in
create edge staged_shift.out -> staged_total.in` },
    { type: "execute", operator_ids: ["staged_total"] },
    { type: "read", operator_ids: ["staged_total"], view: "full", columns: null, include_implementation: false },
  ]);
  assert(ordered.text.includes("| 21 |"), ordered.text);
  const rejected = await debug([{ type: "edit", changes: "create operator must_not_land: limit(1)\ncreate operator impossible from absent@1" }]);
  assert.equal(rejected.result.status, "error");
  const workflowResponse = await fetch(`${base}/api/agents/${agentId}/workflow`);
  assert(workflowResponse.ok);
  const current = (await workflowResponse.json()) as { workflow: { operators: Array<{ operatorID: string }> } };
  assert(!current.workflow.operators.some(op => ["must_not_land", "impossible"].includes(op.operatorID)));
  await run([{ type: "answer", content: "Shifted original scores sum to 21.", operator_ids: ["staged_total"] }]);
  tasks = await history();
  assert.equal(tasks.length, 6);
  assert(tasks.every(t => t.status === "answered"));
  checks.push("ordered edits are atomic across historical references and current graph changes");
  const steps = (await getReActSteps(agentId, base)).steps;
  assert(!steps.some((s: any) => s.usage?.inputTokens), "Debug verification must make no model calls");
  save("task-history.json", tasks);
  save("report.json", { status: "passed", checks, model_calls: 0 });
  console.log(JSON.stringify({ directory, checks, model_calls: 0 }));
} catch (error) {
  save("report.json", { status: "failed", checks, error: String(error), model_calls: 0 });
  throw error;
} finally {
  if (agentId && wid !== undefined) {
    const agentResponse = await fetch(`${base}/api/agents/${agentId}`);
    const executionResponse = await fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertNativeCleanupSafe(await agentResponse.json(), await executionResponse.json(), { agentId, wid, cuid: cuid! });
    await deleteAgent(agentId, base);
  }
  if (wid !== undefined) await deleteWorkflow(token, wid);
  if (cuid !== undefined) await terminateComputingUnit(token, cuid);
  save("cleanup.json", { removed: true, agentId, wid, cuid });
}
