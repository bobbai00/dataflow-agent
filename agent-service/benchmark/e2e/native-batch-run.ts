/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** No-LLM smoke against a running, separately launched agent service.
 * TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3008 bun run benchmark/e2e/native-batch-run.ts
 */
import { strict as assert } from "node:assert";
import {
  createAgent,
  createComputingUnit,
  createWorkflow,
  deleteAgent,
  deleteWorkflow,
  getReActSteps,
  getSnapshot,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { WorkflowSnapshotStorage } from "../../src/agent/workflow-snapshot-storage";
import { assembleContext } from "../../src/agent/util/context-utils";
import { AgentMode, ContextMode, type ReActStep } from "../../src/types/agent";
import type { OperatorInfo } from "../../src/types/execution";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3008";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const stamp = Date.now();
const cu = await createComputingUnit(token, `batch-smoke-${stamp}`, {
  unitType: "local",
  uri: process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085",
});
const cuid = cu.computingUnit.cuid;
let wid: number | undefined;
let agentId: string | undefined;
const mirroredSteps: ReActStep[] = [];
const mirroredState = new WorkflowState();
const mirroredStorage = new WorkflowSnapshotStorage(id =>
  mirroredSteps.slice(0, mirroredSteps.findIndex(s => s.id === id) + 1).map(s => s.id)
);
let priorResults: Record<string, any> = {};

// Debug calls bypass prepareStep, so the server's async preview has no cached
// model input yet. Render the actual trace and snapshots with the production
// assembler locally; the separate LLM pilot captures the real inputMessages.
async function observationFromService(): Promise<string> {
  const trace = await getReActSteps(agentId!, baseUrl);
  mirroredSteps.splice(0, mirroredSteps.length, ...trace.steps);
  const step = mirroredSteps.at(-1)!;
  const snap = await getSnapshot(agentId!, "head", baseUrl);
  assert.ok(snap.workflow);
  mirroredState.setWorkflowContent(snap.workflow);
  mirroredStorage.createSnapshot(step.id, snap.workflow);
  const edited = new Set(
    (step.toolResults?.[0]?.output?.operators ?? [])
      .filter((op: any) => op.status === "added" || op.status === "modified")
      .map((op: any) => op.id)
  );
  for (const [id, summary] of Object.entries(snap.results)) {
    if (!edited.has(id) && JSON.stringify(priorResults[id]) === JSON.stringify(summary)) continue;
    const entry = summary as any;
    mirroredStorage.setOperatorResult(step.id, id, {
      ...entry,
      operatorID: id,
      result: entry.sampleRecords,
    } as OperatorInfo);
  }
  priorResults = snap.results;
  return assembleContext(mirroredSteps, mirroredState, mirroredStorage, ContextMode.DELTA, {
    agentMode: AgentMode.NATIVE,
    resultSelection: "all",
    flowLevel: 0,
    dataLevel: 0,
    columnStats: false,
  })
    .map(m => m.content)
    .join("\n");
}

function debug(
  name: string,
  args: Record<string, unknown>
): Promise<{ context: string; results: Record<string, any> }> {
  return new Promise<{ context: string; results: Record<string, any> }>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false;
    let completed = false;
    let results: Record<string, any> = {};
    const finish = (error?: Error, context = "") => {
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error);
      else resolve({ context, results });
    };
    const timeout = setTimeout(() => finish(new Error(`Timeout waiting for ${name}`)), 180_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(
          JSON.stringify({
            type: "debug",
            content: `Function(name=${JSON.stringify(name)}, arguments=${JSON.stringify(JSON.stringify(args))})`,
          })
        );
      } else if (frame.type === "error") finish(new Error(frame.error));
      else if (frame.type === "complete") {
        completed = true;
        results = frame.operatorResults;
      } else if (frame.type === "nextContext" && completed) finish(undefined, frame.content);
    };
    ws.onerror = () => finish(new Error("WebSocket error"));
  }).then(async frame => ({ ...frame, context: await observationFromService() }));
}

try {
  wid = await createWorkflow(token, `batch-smoke-${stamp}`, new WorkflowState().getWorkflowContent());
  const agent = await createAgent({
    baseUrl,
    userToken: token,
    modelType: "gpt-5.6-luna",
    workflowId: wid,
    computingUnitId: cuid,
    settings: {
      agentMode: "native",
      nativeToolMode: "batch",
      parallelToolCalls: false,
      resultSelection: "all",
      contextMode: "delta",
      columnStats: false,
      flowLevel: 0,
      dataLevel: 0,
    },
  });
  agentId = agent.id;
  const settings = (await fetch(`${baseUrl}/api/agents/${agentId}/settings`).then(r => r.json())) as any;
  assert.equal(settings.nativeToolMode, "batch");
  assert.equal(settings.parallelToolCalls, false);
  const first = await debug("dataflow", {
    operators: [
      { op: "aggregate", id: "total", input: "positive", aggregations: [{ fn: "sum", col: "x", as: "sum_x" }] },
      { op: "filter", id: "positive", input: "source", predicate: "x > 0" },
      {
        op: "udf",
        id: "source",
        code: 'def load():\n    import pandas as pd\n    import time\n    return pd.DataFrame({"x": [-1, 1, 3], "label": ["SOURCE_SENTINEL", "one", "three"], "run": [str(time.time_ns())] * 3})',
      },
    ],
    observe: ["total"],
  });
  for (const id of ["source", "positive", "total"]) {
    assert.ok(first.results[id]?.sampleRecords, `${id} was not materialized: ${JSON.stringify(first.results[id])}`);
    assert.ok(!first.results[id].error, `${id}: ${first.results[id].error}`);
  }
  assert.equal(first.results.total.sampleRecords[0].sum_x, 4);
  assert.match(first.context, /result not requested/);
  // The action contains the source UDF literal; the observation must not.
  const observation = first.context.slice(first.context.indexOf("Observation:"));
  assert.ok(!observation.includes("SOURCE_SENTINEL"));
  const snap1 = await getSnapshot(agentId, "head", baseUrl);
  const second = await debug("dataflow", { operators: [], observe: ["source"] });
  assert.match(second.context, /observed \(cached\)/);
  const snap2 = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(
    (snap2.results.source as any).sampleRecords,
    (snap1.results.source as any).sampleRecords,
    "observation-only call reran source"
  );
  const inspection = await debug("inspectResult", { operatorId: "positive", maxRows: 2 });
  assert.match(inspection.context, /cached sample only/);
  const partial = await debug("dataflow", {
    operators: [
      { op: "filter", id: "invalid", input: "source", predicate: 4 },
      { op: "aggregate", id: "blocked", input: "invalid", aggregations: [{ fn: "count" }] },
      { op: "compute", id: "valid", input: "positive", columns: { doubled: "x * 2" } },
    ],
    observe: [],
  });
  assert.match(partial.context, /invalid.*error:/);
  assert.match(partial.context, /blocked.*blocked:/);
  assert.ok(partial.results.valid?.sampleRecords);
  const failed = await debug("dataflow", {
    operators: [{ op: "compute", id: "valid", input: "positive", columns: { doubled: "not_a_column * 2" } }],
    observe: [],
  });
  assert.ok(failed.results.valid?.error, "previous successful result must be replaced by the new error");
  assert.match(failed.context, /not_a_column/);
  const trace = await getReActSteps(agentId, baseUrl);
  console.log(
    JSON.stringify(
      {
        passed: true,
        agentService: baseUrl,
        workflowId: wid,
        computingUnitId: cuid,
        steps: trace.steps.length,
        checks: [
          "heterogeneous forward references",
          "all three results materialized",
          "requested output only",
          "read without rerun",
          "cached sample inspection",
          "partial edit outcomes",
          "unrequested execution error",
        ],
      },
      null,
      2
    )
  );
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl);
  if (wid !== undefined) await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
