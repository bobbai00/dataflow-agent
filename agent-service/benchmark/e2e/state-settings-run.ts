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

/** No model calls: exercise shared settings, alternatives and saved inputs in the live engine.
 * For sandboxed workers, set STATE_SETTINGS_SOURCE_DIR to their mounted data directory.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  deleteAgent,
  getReActSteps,
  getSnapshot,
  type AgentSnapshot,
} from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import type { OperatorBlock } from "../../src/agent/native/observation-format";
import type { TaskRecord } from "../../src/agent/task-history";
import {
  asDataflowActionsResult,
  renderDataflowActionsResult,
  type DataflowAction,
} from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { nativeDebugInput } from "./native-debug-input";

const base = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = process.env.STATE_SETTINGS_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "state-settings-live-"));
mkdirSync(directory, { recursive: true });
const sourceDirectory = process.env.STATE_SETTINGS_SOURCE_DIR
  ? mkdtempSync(join(process.env.STATE_SETTINGS_SOURCE_DIR, "state-settings-"))
  : directory;
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
const checks: string[] = [];
let token = "",
  agentId = "",
  wid: number | undefined,
  cuid: number | undefined,
  sequence = 0,
  failed = false;

async function debug(input: DataflowAction[] | string) {
  const before = (await getReActSteps(agentId, base)).steps.length;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false,
      completed = false,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Live state-settings check timed out")), 240_000);
    ws.onmessage = event => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "init" && !sent) {
          sent = true;
          ws.send(
            JSON.stringify({
              type: "debug",
              content:
                typeof input === "string"
                  ? input
                  : nativeDebugInput("dataflow", {
                      reasoning: "Verify shared settings, independent alternatives and immutable saved inputs.",
                      actions: input,
                    }),
            })
          );
        } else if (frame.type === "complete") completed = true;
        else if (frame.type === "error") finish(new Error(String(frame.error ?? frame.message ?? frame.content)));
        else if (frame.type === "nextContext" && completed) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    ws.onerror = () => finish(new Error("Live state-settings socket failed"));
    ws.onclose = () => {
      if (!settled) finish(new Error("Live state-settings socket closed before completion"));
    };
  });
  const { steps } = await getReActSteps(agentId, base);
  save("react-steps.json", steps);
  if (typeof input === "string") return undefined;
  const result = steps
    .slice(before)
    .flatMap(step => (step.toolResults ?? []).map(item => asDataflowActionsResult(item.output)))
    .filter(Boolean)
    .at(-1);
  assert(result, "Debug actions produced no receipt");
  save(`receipt-${++sequence}.json`, { input, result });
  const text = renderDataflowActionsResult(result);
  writeFileSync(join(directory, `receipt-${sequence}.md`), text);
  assert.equal(result.status, "completed", text);
  return { result, text };
}

async function history(): Promise<TaskRecord[]> {
  const response = await fetch(`${base}/api/agents/${agentId}/task-history`);
  assert(response.ok, "Task history unavailable");
  return ((await response.json()) as { tasks: TaskRecord[] }).tasks;
}

const read = (operator_ids: string[], implementation = false): DataflowAction => ({
  type: "read",
  operator_ids,
  view: "full",
  columns: null,
  include_implementation: implementation,
});
const answer = (content: string, operator_ids: string[]): DataflowAction => ({ type: "answer", content, operator_ids });

function rows(snapshot: AgentSnapshot, id: string): Array<Record<string, unknown>> {
  const result = snapshot.results[id] as
    | { sampleRecords?: Array<Record<string, unknown>>; error?: unknown }
    | undefined;
  assert(result && !result.error && Array.isArray(result.sampleRecords), `${id}: completed records unavailable`);
  return result.sampleRecords;
}

function scores(snapshot: AgentSnapshot, id: string, expected: number[]) {
  const actual = rows(snapshot, id)
    .map(row => ({ id: row.id, score: row.score }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  assert.deepEqual(
    actual,
    expected.map((score, index) => ({ id: ["a", "b", "c"][index], score })),
    id
  );
}

function total(snapshot: AgentSnapshot, id: string, expected: number) {
  assert.deepEqual(rows(snapshot, id), [{ total: expected }], id);
}

function binding(snapshot: AgentSnapshot, id: string, factor: number, savedInput?: string) {
  const workflow = snapshot.workflow;
  assert(workflow);
  const operator = workflow.operators.find(op => op.operatorID === id);
  assert(operator?.nativeOp, `${id}: native definition missing`);
  assert.deepEqual(operator.nativeOp.settings, { factor }, `${id}: bound setting`);
  const inputs = workflow.links.filter(link => link.target.operatorID === id).map(link => link.source.operatorID);
  assert.equal(inputs.length, 1, `${id}: one input expected`);
  if (savedInput) {
    const saved = workflow.operators.find(op => op.operatorID === inputs[0])?.savedResult;
    assert.equal(saved?.taskId, 1, `${id}: saved input task`);
    assert.equal(saved?.operatorId, savedInput, `${id}: saved input identity`);
  } else assert.deepEqual(inputs, ["source"], `${id}: current source binding`);
}

function visibleSettings(receipt: NonNullable<Awaited<ReturnType<typeof debug>>>, expected: Record<string, number>) {
  const blocks = receipt.result.actions
    .filter(action => action.action.type === "read")
    .flatMap(action => (action.output as { operator_blocks?: OperatorBlock[] } | undefined)?.operator_blocks ?? []);
  for (const [id, factor] of Object.entries(expected)) {
    const block = blocks.find(candidate => candidate.id === id);
    assert.equal(
      block?.definition,
      `score(factor=${factor})`,
      `${id}: displayed setting differs from the bound setting`
    );
    assert(block?.functions?.includes("def score(table, factor=1)"), `${id}: shared definition is unavailable`);
  }
}

try {
  const originalFile = join(sourceDirectory, "original.csv"),
    updatedFile = join(sourceDirectory, "updated.csv");
  for (const [name, csv] of Object.entries({
    "original.csv": "id,value\na,1\nb,2\nc,3\n",
    "updated.csv": "id,value\na,10\nb,20\nc,30\n",
  })) {
    writeFileSync(join(sourceDirectory, name), csv);
    if (sourceDirectory !== directory) writeFileSync(join(directory, name), csv);
  }
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  cuid = (
    await createComputingUnit(token, `state-settings-${Date.now()}`, {
      unitType: "local",
      uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    })
  ).computingUnit.cuid;
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0 });
  wid = await createWorkflow(token, `state-settings-${Date.now()}`, new WorkflowState().getWorkflowContent());
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
        catalogStatistics: false,
        catalogRecords: 0,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 2000,
        executionTimeoutMinutes: 1,
        toolTimeoutSeconds: 90,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0 });

  await debug("Task 1: score the three original rows with the default factor.");
  const initialRead = await debug([
    {
      type: "edit",
      changes: `source = scan(${JSON.stringify(originalFile)})
def score(table, factor=1):
    """One row per input ID with score equal to value multiplied by {factor}."""
    result = table[["id"]].copy()
    result["score"] = table["value"] * factor
    return result
base = score(source)
base_total = aggregate(base, total=sum("score"))`,
    },
    { type: "execute", operator_ids: ["base_total"] },
    read(["base", "base_total"], true),
  ]);
  assert(initialRead);
  visibleSettings(initialRead, { base: 1 });
  const initial = await getSnapshot(agentId, "head", base);
  assert(initial.stepId);
  scores(initial, "base", [1, 2, 3]);
  total(initial, "base_total", 6);
  binding(initial, "base", 1);
  save("task-1-snapshot.json", initial);
  await debug([answer("Default scores total 6.", ["base", "base_total"])]);
  const task1 = (await history())[0];
  assert.equal(task1.task_id, 1);
  assert.equal(task1.status, "answered");
  assert(task1.operator_changes?.some(block => block.id === "base" && block.definition?.includes("factor=1")));
  const firstFrame = JSON.stringify(task1);
  checks.push("default shared setting executes and is visible in reads and the completed catalog");

  await debug("Task 2: compute a factor-two alternative while retaining the default scores.");
  const alternativeRead = await debug([
    {
      type: "edit",
      changes: `alternative = score(source, factor=2)
alternative_total = aggregate(alternative, total=sum("score"))`,
    },
    { type: "execute", operator_ids: ["base_total", "alternative_total"] },
    read(["base", "alternative", "base_total", "alternative_total"], true),
  ]);
  assert(alternativeRead);
  visibleSettings(alternativeRead, { base: 1, alternative: 2 });
  const alternative = await getSnapshot(agentId, "head", base);
  scores(alternative, "base", [1, 2, 3]);
  scores(alternative, "alternative", [2, 4, 6]);
  total(alternative, "base_total", 6);
  total(alternative, "alternative_total", 12);
  binding(alternative, "base", 1);
  binding(alternative, "alternative", 2);
  save("task-2-snapshot.json", alternative);
  await debug([answer("Default total 6; separate alternative total 12.", ["base_total", "alternative_total"])]);
  assert.equal(JSON.stringify((await history())[0]), firstFrame);
  checks.push("new-name alternative reuses the shared function without changing the default operator");

  await debug("Task 3: change the default factor to ten, retaining the separate factor-two alternative.");
  const changedRead = await debug([
    { type: "edit", changes: "base = score(source, factor=10)" },
    { type: "execute", operator_ids: ["base_total", "alternative_total"] },
    read(["base", "alternative", "base_total", "alternative_total"], true),
  ]);
  assert(changedRead);
  visibleSettings(changedRead, { base: 10, alternative: 2 });
  const changed = await getSnapshot(agentId, "head", base);
  scores(changed, "base", [10, 20, 30]);
  scores(changed, "alternative", [2, 4, 6]);
  total(changed, "base_total", 60);
  total(changed, "alternative_total", 12);
  binding(changed, "base", 10);
  binding(changed, "alternative", 2);
  save("task-3-snapshot.json", changed);
  await debug([answer("Updated default total 60; alternative total remains 12.", ["base_total", "alternative_total"])]);
  assert.equal(JSON.stringify((await history())[0]), firstFrame);
  checks.push("restating one call updates its existing descendants while the other call keeps its own setting");

  await debug("Task 4: change current input values and independently score the original task-one input.");
  const historicalRead = await debug([
    {
      type: "edit",
      changes: `source = scan(${JSON.stringify(updatedFile)})
historical_score = score(source@1, factor=3)
historical_total = aggregate(historical_score, total=sum("score"))
saved_base = project(base@1, keep=["id", "score"])`,
    },
    { type: "execute", operator_ids: ["base_total", "alternative_total", "historical_total", "saved_base"] },
    read(["base", "alternative", "historical_score", "base@1"], true),
    read(["base_total", "alternative_total", "historical_total", "saved_base"]),
  ]);
  assert(historicalRead);
  visibleSettings(historicalRead, { base: 10, alternative: 2, historical_score: 3, "base@1": 1 });
  const execution = historicalRead.result.actions[1].output as { operators: Array<{ id: string; state: string }> };
  for (const id of ["source@1", "base@1"])
    assert(
      execution.operators.some(op => op.id === id && op.state === "cached"),
      `${id}: saved materialization must be cached`
    );
  const final = await getSnapshot(agentId, "head", base);
  scores(final, "base", [100, 200, 300]);
  scores(final, "alternative", [20, 40, 60]);
  scores(final, "historical_score", [3, 6, 9]);
  scores(final, "saved_base", [1, 2, 3]);
  total(final, "base_total", 600);
  total(final, "alternative_total", 120);
  total(final, "historical_total", 18);
  binding(final, "base", 10);
  binding(final, "alternative", 2);
  binding(final, "historical_score", 3, "source");
  const oldSnapshot = await getSnapshot(agentId, initial.stepId, base);
  scores(oldSnapshot, "base", [1, 2, 3]);
  save("task-4-snapshot.json", final);
  save("task-1-snapshot-after-updates.json", oldSnapshot);
  await debug([
    answer("Current totals 600 and 120; original-input variant total 18; saved base scores stay 1, 2, 3.", [
      "base_total",
      "alternative_total",
      "historical_total",
      "saved_base",
    ]),
  ]);
  checks.push(
    "current inputs recompute both branches; historical input and earlier output remain cached immutable values"
  );

  const tasks = await history();
  assert.equal(tasks.length, 4);
  assert(tasks.every(task => task.status === "answered"));
  assert.equal(JSON.stringify(tasks[0]), firstFrame, "Task-one catalog changed after later edits");
  const steps = (await getReActSteps(agentId, base)).steps;
  assert(
    !steps.some(step => step.usage?.inputTokens || step.usage?.outputTokens),
    "Debug fixture must make no model calls"
  );
  save("task-history.json", tasks);
  save("react-steps.json", steps);
} catch (error) {
  failed = true;
  save("report.json", {
    status: "failed",
    checks,
    error: error instanceof Error ? error.stack : String(error),
    model_calls: 0,
  });
  if (agentId) {
    const captures = await Promise.allSettled([
      getReActSteps(agentId, base).then(trace => save("react-steps.json", trace.steps)),
      getSnapshot(agentId, "head", base).then(snapshot => save("failure-snapshot.json", snapshot)),
    ]);
    save(
      "failure-capture.json",
      captures.map(result =>
        result.status === "fulfilled"
          ? { status: result.status }
          : { status: result.status, error: String(result.reason) }
      )
    );
  }
  throw error;
} finally {
  try {
    if (agentId && wid !== undefined && cuid !== undefined) {
      const [agentResponse, executionResponse] = await Promise.all([
        fetch(`${base}/api/agents/${agentId}`),
        fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      assert(agentResponse.ok && executionResponse.ok, "Cleanup status unavailable; retaining resources");
      assertNativeCleanupSafe(await agentResponse.json(), await executionResponse.json(), { agentId, wid, cuid });
      await deleteAgent(agentId, base);
    }
    if (wid !== undefined) await deleteWorkflow(token, wid);
    if (cuid !== undefined) await terminateComputingUnit(token, cuid);
    if (sourceDirectory !== directory) rmSync(sourceDirectory, { recursive: true });
    save("cleanup.json", { removed: true, agentId, wid, cuid });
    if (!failed) {
      save("report.json", { status: "passed", checks, requests: 4, model_calls: 0 });
      console.log(JSON.stringify({ directory, checks, model_calls: 0 }));
    }
  } catch (error) {
    save("cleanup.json", { removed: false, agentId, wid, cuid, error: String(error) });
    if (!failed) {
      save("report.json", { status: "failed", checks, stage: "cleanup", error: String(error), model_calls: 0 });
      throw error;
    }
  }
}
