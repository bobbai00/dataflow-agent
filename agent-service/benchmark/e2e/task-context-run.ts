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
    { type: "retrieve", operator_id: "total", view: "full" },
  ]);
  await run([{ type: "answer", content: "The sum is 6.", operator_ids: ["total"] }]);
  await debug("Task 2: reuse the sum and add a calculation on the same prepared scores.");
  const cached = await run([
    { type: "execute", operator_ids: ["total"] },
    { type: "retrieve", operator_id: "total", view: "full" },
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
    { type: "retrieve", operator_id: "task2_answer", view: "full" },
  ]);
  await run([
    {
      type: "answer",
      content: "The cached sum is 6. The transformed sum is 14.",
      operator_ids: ["total", "task2_answer"],
    },
  ]);
  let tasks = await history();
  assert(
    tasks[1].dependencies.some((d: any) => d.task_id === 1 && d.references.some((r: any) => r.kind === "compute")),
    JSON.stringify(tasks)
  );
  checks.push("cached data keeps its original task dependency");
  await debug("Task 3: multiply each input score by ten using the same summation rule.");
  await run([
    { type: "edit", changes: `update operator source: ${source(10)}` },
    { type: "execute", operator_ids: ["total"] },
    { type: "retrieve", operator_id: "total", view: "full" },
  ]);
  await run([{ type: "answer", content: "The revised sum is 60." }]);
  tasks = await history();
  assert(
    tasks[2].dependencies.some((d: any) => d.task_id === 1 && d.references.some((r: any) => r.kind === "definition")),
    JSON.stringify(tasks)
  );
  checks.push("an unchanged definition and recomputed data have separate provenance");
  await debug("Task 4: inspect task 2 and compare its original sum with today's sum.");
  const inspection = await run([{ type: "inspect", target: "task", task_id: 2 }]);
  assert(inspection.text.includes("The cached sum is 6."));
  assert(!inspection.text.includes("def load"));
  const local = await run([
    {
      type: "inspect",
      target: "task",
      task_id: 2,
      operator_id: "task2_answer",
      include_implementation: true,
      view: "full",
    },
  ]);
  const localGraph = local.result.actions[0].output.dataflows[0];
  assert.equal(localGraph.operators.length, 5);
  assert.deepEqual(
    localGraph.boundary_inputs.map((input: any) => [input.operator_id, input.task_id]),
    [["source", 1]]
  );
  assert.equal(localGraph.observations.length, 1);
  assert.equal(localGraph.upstream_operator_count, 6);
  assert(local.text.includes("| 14 |"), local.text);
  assert(!local.text.includes("def load"), local.text);
  const expanded = await run([
    { type: "inspect", target: "task", task_id: 1, operator_id: "source", include_implementation: true, view: "full" },
  ]);
  assert(expanded.text.includes("def load"), expanded.text);
  assert.equal(expanded.result.actions[0].output.dataflows[0].operators.length, 1);
  const expandedInput = expanded.result.actions[0].output.dataflows[0].operators[0];
  assert.equal(localGraph.boundary_inputs[0].result.result_version, expandedInput.result.result_version);
  assert.equal(localGraph.boundary_inputs[0].result.producing_step, expandedInput.result.producing_step);
  checks.push(
    "five local operators reuse one pinned input; selective expansion returns the original definition and result"
  );
  const unscoped = await debug([{ type: "inspect", target: "graph" }]);
  assert.equal(unscoped.result.status, "error");
  const scoped = await run([{ type: "inspect", target: "graph", operator_ids: ["task2_answer"] }]);
  assert.deepEqual(
    scoped.result.actions[0].output.operators.map((op: any) => op.id),
    ["task2_answer"]
  );
  checks.push("whole-session graph inspection is rejected; named current operators remain inspectable");
  const branch = await run([
    { type: "inspect", target: "task", task_id: 1, operator_id: null, include_implementation: true, view: "full" },
  ]);
  const graph = branch.result.actions[0].output.dataflows[0];
  assert.equal(branch.result.actions[0].output.selection_basis, "answer");
  assert.deepEqual(graph.roots, ["total"]);
  assert.deepEqual(
    graph.operators.map((op: any) => op.operator_id),
    ["source", "total"]
  );
  assert.equal(graph.edges.length, 1);
  assert(branch.text.includes("def load"), branch.text);
  assert(branch.text.includes("| 6 |"), branch.text);
  assert(!branch.text.includes("[10, 20, 30]"), branch.text);
  checks.push("declared answer roots retrieve their complete original branch and result in one read");
  const old = await run([
    { type: "inspect", target: "state", task_id: 1, operator_id: "total", include_implementation: false, view: "full" },
  ]);
  assert(old.text.includes("| 6 |"), old.text);
  const fork = await run([
    { type: "edit", changes: "fork operator total from task 1 as old_total" },
    { type: "retrieve", operator_id: "old_total", view: "full" },
  ]);
  assert(fork.text.includes("| 6 |"), fork.text);
  assert.deepEqual(
    fork.result.references
      ?.filter((ref: any) => ref.actionIndex === 2 && ref.kind === "read")
      .map((ref: any) => ({ operatorId: ref.operatorId, savedTaskId: ref.savedTaskId })),
    [{ operatorId: "total", savedTaskId: 1 }]
  );
  const restored = await run([
    { type: "edit", changes: "update operator total from task 1" },
    { type: "execute", operator_ids: ["total"] },
    { type: "retrieve", operator_id: "total", view: "full" },
  ]);
  assert(restored.text.includes("| 60 |"), restored.text);
  await run([
    {
      type: "answer",
      content: "The saved sum is 6 and the current sum is 60.",
      operator_ids: ["old_total", "total"],
    },
  ]);
  tasks = await history();
  assert(tasks[3].consulted_tasks.includes(2));
  assert(
    !tasks[3].dependencies.some((d: any) => d.task_id === 2 && d.references.some((r: any) => r.kind === "compute"))
  );
  assert(tasks[3].dependencies.some((d: any) => d.task_id === 1));
  checks.push("task inspection is consultation; saved reads, forks and restores address task 1");
  await debug("Task 5: inspect both task-4 answer versions, remove the current source, then inspect task 1.");
  const versions = await run([
    { type: "inspect", target: "task", task_id: 4, operator_id: null, include_implementation: true, view: "full" },
  ]);
  const savedGraphs = versions.result.actions[0].output.dataflows;
  assert.equal(savedGraphs.length, 2);
  assert(savedGraphs.every((graph: any) => graph.task_id === 4 && graph.operators.length === 0));
  assert.deepEqual(
    savedGraphs.flatMap((graph: any) => graph.boundary_inputs.map((input: any) => [input.operator_id, input.task_id])),
    [
      ["total", 1],
      ["total", 3],
    ]
  );
  assert(versions.text.includes("| 6 |") && versions.text.includes("| 60 |"), versions.text);
  assert(!versions.text.includes("def load"), versions.text);
  checks.push("answer roots from distinct saved versions stay separate and reuse only pinned input references");
  await run([
    { type: "edit", changes: "delete operator source\ndelete operator total" },
    { type: "inspect", target: "task", task_id: 1 },
    { type: "inspect", target: "state", task_id: 1, operator_id: "total", include_implementation: true, view: "full" },
  ]);
  await run([{ type: "answer", content: "Saved task-1 operators remain inspectable after deletion." }]);
  tasks = await history();
  assert.equal(tasks.length, 5);
  assert(tasks.every(t => t.status === "answered"));
  const unknown = await debug([{ type: "inspect", target: "task", task_id: 999 }]);
  assert.equal(unknown.result.status, "error");
  assert(unknown.text.includes("UNKNOWN_TASK"));
  checks.push("deleted operators remain saved; unknown tasks fail explicitly");
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
