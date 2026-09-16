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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let fixtureDir: string | undefined;
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
  return renderMirroredContext(ContextMode.DELTA);
}

function renderMirroredContext(mode: ContextMode): string {
  return assembleContext(mirroredSteps, mirroredState, mirroredStorage, mode, {
    agentMode: AgentMode.NATIVE,
    resultSelection: "all",
    flowEvidence: false,
    dataEvidence: false,
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
      flowEvidence: false,
      dataEvidence: false,
      enableInspectTool: true, // Legacy clients must not resurrect the removed tool.
    },
  });
  agentId = agent.id;
  const settings = (await fetch(`${baseUrl}/api/agents/${agentId}/settings`).then(r => r.json())) as any;
  assert.equal(settings.nativeToolMode, "batch");
  assert.equal(settings.parallelToolCalls, false);
  assert.equal(settings.enableInspectTool, false);
  const systemInfo = (await fetch(`${baseUrl}/api/agents/${agentId}/system-info`).then(r => r.json())) as any;
  assert.deepEqual(systemInfo.tools.map((tool: any) => tool.name).sort(), ["dataflow", "deleteOperator"]);
  assert.ok(!systemInfo.systemPrompt.includes("inspectResult"));
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
  const patched = await fetch(`${baseUrl}/api/agents/${agentId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enableInspectTool: true }),
  });
  assert.ok(patched.ok);
  const inspection = await debug("inspectResult", { operatorId: "positive", maxRows: 2 }).catch(error => ({
    context: String(error),
  }));
  assert.match(inspection.context, /Tool .*inspectResult.* not found/);
  const afterRejected = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(afterRejected.workflow, snap2.workflow, "removed tool changed the DAG");
  assert.deepEqual(afterRejected.results, snap2.results, "removed tool changed cached results");
  // Revise an upstream and add a forward-referenced chain through its existing
  // descendant in the same call. No observe means all successful bodies hide.
  const revision = await debug("dataflow", {
    operators: [
      { op: "project", id: "answer", input: "tagged_total", keep: ["sum_x", "tag"] },
      { op: "compute", id: "tagged_total", input: "total", columns: { tag: "'RECOMPUTED_SENTINEL'" } },
      { op: "filter", id: "positive", input: "source", predicate: "x > 1" },
    ],
  });
  assert.equal(revision.results.total.sampleRecords[0].sum_x, 3, "existing downstream aggregate was not refreshed");
  assert.equal(revision.results.answer.sampleRecords[0].sum_x, 3, "new dependent chain saw an old result");
  const revisionObservation = revision.context.slice(revision.context.lastIndexOf("Observation:"));
  assert.match(revisionObservation, /total.*re-executed/);
  assert.match(revisionObservation, /result not requested/);
  assert.ok(!revisionObservation.includes("RECOMPUTED_SENTINEL"));
  // LATEST still includes the current DAG, but no successful table bodies.
  const latestHidden = renderMirroredContext(ContextMode.LATEST);
  for (const id of ["source", "positive", "total", "tagged_total", "answer"]) assert.ok(latestHidden.includes(id));
  // The rejected legacy request has no result content. Only the current
  // dataflow follows the latest observe selection.
  const currentDataflow = latestHidden.split("# Inspections")[0];
  assert.ok(!currentDataflow.includes("Output Table:"), "LATEST exposed a result without observe");
  const revisedSnapshot = await getSnapshot(agentId, "head", baseUrl);
  const observed = await debug("dataflow", { operators: [], observe: ["answer"] });
  assert.match(observed.context.slice(observed.context.lastIndexOf("Observation:")), /RECOMPUTED_SENTINEL/);
  assert.match(renderMirroredContext(ContextMode.LATEST).split("# Inspections")[0], /Output Table:/);
  const readSnapshot = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(readSnapshot.results, revisedSnapshot.results, "observe-only call recomputed the workflow");

  // The agent and local shared backend see the same filesystem. Keep fixtures
  // scoped to this run, and execute the real generated Scan code in a worker.
  fixtureDir = mkdtempSync(join(tmpdir(), "native-batch-preview-"));
  const previewPath = join(fixtureDir, "window.txt");
  writeFileSync(previewPath, "START_ONLY\nHEADER_ONLY\nWINDOW_TWO\nWINDOW_THREE\nWINDOW_FOUR\n");
  const previewWindow = await debug("dataflow", {
    operators: [
      { op: "project", id: "window_lines", input: "window", keep: ["line_no", "line"] },
      { op: "scan", id: "window", files: previewPath, preview: 2, skipLines: 2 },
    ],
    observe: ["window_lines"],
  });
  assert.deepEqual(
    previewWindow.results.window_lines?.sampleRecords.map((row: any) => [row.line_no, row.line]),
    [
      [2, "WINDOW_TWO"],
      [3, "WINDOW_THREE"],
    ],
    "Scan preview ignored skipLines or lost absolute positions"
  );
  const movedWindow = await debug("dataflow", {
    operators: [{ op: "scan", id: "window", files: previewPath, preview: 2, skipLines: 3 }],
    observe: [],
  });
  assert.deepEqual(
    movedWindow.results.window_lines?.sampleRecords.map((row: any) => [row.line_no, row.line]),
    [
      [3, "WINDOW_THREE"],
      [4, "WINDOW_FOUR"],
    ],
    "same-shaped Scan revision did not refresh the existing descendant"
  );
  const movedObservation = movedWindow.context.slice(movedWindow.context.lastIndexOf("Observation:"));
  assert.match(movedObservation, /window_lines.*re-executed/);
  assert.ok(!movedObservation.includes("WINDOW_FOUR"), "hidden preview leaked in DELTA");
  assert.ok(
    !renderMirroredContext(ContextMode.LATEST).split("# Inspections")[0].includes("WINDOW_FOUR"),
    "hidden preview leaked in LATEST"
  );
  const beforeWindowRead = await getSnapshot(agentId, "head", baseUrl);
  const windowRead = await debug("dataflow", { operators: [], observe: ["window_lines"] });
  const afterWindowRead = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(afterWindowRead.results, beforeWindowRead.results, "preview observation triggered execution");
  assert.match(windowRead.context.slice(windowRead.context.lastIndexOf("Observation:")), /WINDOW_FOUR/);
  assert.match(renderMirroredContext(ContextMode.LATEST).split("# Inspections")[0], /WINDOW_FOUR/);
  // A failed Scan revision must surface despite observe:[] and supersede its
  // successful table. Repairing that same ID must refresh the dependent again.
  const missingWindow = await debug("dataflow", {
    operators: [{ op: "scan", id: "window", files: join(fixtureDir, "missing.txt"), preview: 2, skipLines: 3 }],
    observe: [],
  });
  assert.ok(missingWindow.results.window?.error, "failed Scan revision retained a success");
  const missingObservation = missingWindow.context.slice(missingWindow.context.lastIndexOf("Observation:"));
  assert.match(missingObservation, /Scan `window` failed:/);
  assert.match(missingObservation, /missing\.txt/);
  assert.match(renderMirroredContext(ContextMode.LATEST), /Scan `window` failed:/);
  assert.match(renderMirroredContext(ContextMode.LATEST), /missing\.txt/);
  assert.ok(!missingObservation.includes("WINDOW_FOUR"), "failed revision exposed its old successful data");
  const repairedWindow = await debug("dataflow", {
    operators: [{ op: "scan", id: "window", files: previewPath, preview: 2, skipLines: 2 }],
    observe: ["window_lines"],
  });
  assert.ok(!repairedWindow.results.window?.error, "repaired Scan still has an error");
  assert.deepEqual(
    repairedWindow.results.window_lines?.sampleRecords.map((row: any) => [row.line_no, row.line]),
    [
      [2, "WINDOW_TWO"],
      [3, "WINDOW_THREE"],
    ],
    "repair did not recompute the existing dependent"
  );
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
          "removed result-inspection tool rejected despite legacy enable flag",
          "upstream revision plus new dependent chain on existing DAG",
          "downstream result refreshed despite unchanged aggregate row count",
          "omitted observe hides successful bodies in DELTA and LATEST",
          "explicit observe retrieves the refreshed result without recomputation",
          "Scan preview offset and absolute source positions through a real worker",
          "same-shaped preview revision refreshes the existing descendant",
          "preview bodies hidden without observe in DELTA and LATEST",
          "cached preview observation without recomputation",
          "unrequested Scan failure replaces prior success and remains visible",
          "Scan repair with the same ID refreshes its existing dependent",
          "partial edit outcomes",
          "unrequested execution error",
        ],
      },
      null,
      2
    )
  );
} finally {
  try {
    // Attempt all cleanup even if one endpoint fails; never touch another
    // test's workflow or the shared Texera service itself.
    const cleanup = await Promise.allSettled([
      agentId ? deleteAgent(agentId, baseUrl) : Promise.resolve(),
      wid !== undefined ? deleteWorkflow(token, wid) : Promise.resolve(),
      terminateComputingUnit(token, cuid),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") {
        console.error("Smoke cleanup failed:", result.reason);
        process.exitCode = 1;
      }
    }
  } finally {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  }
}
