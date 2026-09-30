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

/** No-LLM smoke of native mode against a running agent service and backend.
 *
 *   TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3061 bun run benchmark/e2e/native-program-run.ts
 *
 * Drives the `dataflow` action tool through the debug transport: a chain with
 * a process loader, observe/hidden receipts, a cached read, an upstream
 * revision that refreshes an existing descendant, a preview window with
 * skip_lines, a statement that does not parse, a partial failure, an
 * execution error that supersedes a success, and a delete through the same tool. It creates and
 * removes its own workflow, agent and computing unit; no model is called.
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

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const stamp = Date.now();
const cu = await createComputingUnit(token, `program-smoke-${stamp}`, {
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
// assembler locally; the LLM pilot captures the real inputMessages.
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
): Promise<{ context: string; results: Record<string, any>; error?: string }> {
  // Expand expression fixtures into the public ordered-action protocol.
  // An empty edit is a cached retrieval; deletion alone does not execute.
  if (name === "dataflow" && !("actions" in args)) {
    const expressions = String(args.edits ?? "");
    const remove = (args.delete ?? []) as string[];
    args = {
      reasoning: "Check the edits and their execution results.",
      actions: [
        ...(expressions || remove.length ? [{ type: "edit", expressions, delete: remove }] : []),
        ...(expressions ? [{ type: "execute" }] : []),
        ...((args.observe ?? []) as string[]).map(operator_id => ({ type: "retrieve", operator_id })),
      ],
    };
  }
  return new Promise<{ context: string; results: Record<string, any>; error?: string }>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false;
    let completed = false;
    let results: Record<string, any> = {};
    let toolError: string | undefined;
    const finish = (error?: Error, context = "") => {
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error);
      else resolve({ context, results, error: toolError });
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
      } else if (frame.type === "error") toolError = String(frame.error);
      else if (frame.type === "complete") {
        completed = true;
        results = frame.operatorResults ?? {};
      } else if (frame.type === "nextContext" && (completed || toolError)) finish(undefined, frame.content);
    };
    ws.onerror = () => finish(new Error("WebSocket error"));
  }).then(async frame => ({ ...frame, context: await observationFromService() }));
}

const lastObservation = (context: string) => context.slice(context.lastIndexOf("Observation:"));

try {
  wid = await createWorkflow(token, `program-smoke-${stamp}`, new WorkflowState().getWorkflowContent());
  const agent = await createAgent({
    baseUrl,
    userToken: token,
    modelType: "gpt-5.6-luna",
    workflowId: wid,
    computingUnitId: cuid,
    settings: {
      agentMode: "native",
      parallelToolCalls: true,
      resultSelection: "all",
      contextMode: "delta",
      flowEvidence: false,
      dataEvidence: false,
    },
  });
  agentId = agent.id;
  const settings = await fetch(`${baseUrl}/api/agents/${agentId}/settings`).then(r => r.json() as Promise<any>);
  assert.equal(settings.agentMode, "native");
  assert.equal(settings.parallelToolCalls, false, "native mode must force provider parallel tool calls off");
  const systemInfo = (await fetch(`${baseUrl}/api/agents/${agentId}/system-info`).then(r => r.json())) as any;
  assert.deepEqual(systemInfo.tools.map((tool: any) => tool.name).sort(), ["dataflow"]);
  assert.ok(systemInfo.systemPrompt.includes("= filter(T, fn"), "prompt must carry the operator reference");
  assert.ok(!systemInfo.systemPrompt.includes("inspectResult"));

  // 1. A chain listed consumers-first, with a process loader; only `total` observed.
  const first = await debug("dataflow", {
    edits: [
      'total = aggregate(positive, sum_x=sum("x"))',
      'positive = filter(source, lambda row: row["x"] is not None and row["x"] > 0, doc="Keeps rows with positive x")',
      "def load_source():",
      "    import pandas as pd",
      "    import time",
      '    return pd.DataFrame({"x": [-1, 1, 3], "label": ["SOURCE_SENTINEL", "one", "three"], "run": [str(time.time_ns())] * 3})',
      'source = process(fn=load_source, doc="Loads three labelled rows")',
    ].join("\n"),
    observe: ["total"],
  });
  for (const id of ["source", "positive", "total"]) {
    assert.ok(first.results[id]?.sampleRecords, `${id} was not materialized: ${JSON.stringify(first.results[id])}`);
    assert.ok(!first.results[id].error, `${id}: ${first.results[id].error}`);
  }
  assert.equal(first.results.total.sampleRecords[0].sum_x, 4);
  assert.match(first.context, /result not requested/);
  // The action carries the loader literal; the observation must not.
  assert.ok(!lastObservation(first.context).includes("SOURCE_SENTINEL"));

  // 2. A cached read does not execute anything.
  const snap1 = await getSnapshot(agentId, "head", baseUrl);
  const second = await debug("dataflow", { edits: "", observe: ["source"] });
  assert.match(second.context, /retrieve: ok/);
  const snap2 = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(
    (snap2.results.source as any).sampleRecords,
    (snap1.results.source as any).sampleRecords,
    "read reran source"
  );

  // 3. Revise an upstream and add a forward-referenced chain through its existing
  //    descendant in one call; no observe means every successful body hides.
  const revision = await debug("dataflow", {
    edits: [
      'answer = project(tagged_total, keep=["sum_x", "tag"])',
      'tagged_total = map(total, lambda row: {**row, "tag": "RECOMPUTED_SENTINEL"}, doc="Adds a constant tag column")',
      'positive = filter(source, lambda row: row["x"] is not None and row["x"] > 1, doc="Keeps rows with x above 1")',
    ].join("\n"),
  });
  assert.equal(revision.results.total.sampleRecords[0].sum_x, 3, "existing downstream aggregate was not refreshed");
  assert.equal(revision.results.answer.sampleRecords[0].sum_x, 3, "new dependent chain saw an old result");
  assert.match(lastObservation(revision.context), /total: ok/);
  assert.match(lastObservation(revision.context), /result not requested/);
  assert.ok(!lastObservation(revision.context).includes("RECOMPUTED_SENTINEL"));
  const latestHidden = renderMirroredContext(ContextMode.LATEST);
  for (const id of ["source", "positive", "total", "tagged_total", "answer"]) assert.ok(latestHidden.includes(id));
  assert.ok(!latestHidden.includes("Output Table:"), "LATEST exposed a result without observe");
  const revisedSnapshot = await getSnapshot(agentId, "head", baseUrl);
  const observed = await debug("dataflow", { edits: "", observe: ["answer"] });
  assert.match(lastObservation(observed.context), /RECOMPUTED_SENTINEL/);
  assert.match(renderMirroredContext(ContextMode.LATEST), /Output Table:/);
  const readSnapshot = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(readSnapshot.results, revisedSnapshot.results, "observe-only call recomputed the workflow");

  // 4. A raw preview window with an offset, executed by the real worker.
  fixtureDir = mkdtempSync(join(tmpdir(), "native-program-preview-"));
  const previewPath = join(fixtureDir, "window.txt");
  writeFileSync(previewPath, "START_ONLY\nHEADER_ONLY\nWINDOW_TWO\nWINDOW_THREE\nWINDOW_FOUR\n");
  const previewWindow = await debug("dataflow", {
    edits: [
      'window_lines = project(window, keep=["line_no", "line"])',
      `window = scan(${JSON.stringify(previewPath)}, preview=2, skip_lines=2)`,
    ].join("\n"),
    observe: ["window_lines"],
  });
  assert.deepEqual(
    previewWindow.results.window_lines?.sampleRecords.map((row: any) => [row.line_no, row.line]),
    [
      [2, "WINDOW_TWO"],
      [3, "WINDOW_THREE"],
    ],
    "Scan preview ignored skip_lines or lost absolute positions"
  );
  const movedWindow = await debug("dataflow", {
    edits: `window = scan(${JSON.stringify(previewPath)}, preview=2, skip_lines=3)`,
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
  assert.match(lastObservation(movedWindow.context), /window_lines: ok/);
  assert.ok(!lastObservation(movedWindow.context).includes("WINDOW_FOUR"), "hidden preview leaked in DELTA");

  // 5. A failed Scan revision surfaces despite observe:[] and supersedes its success.
  const missingWindow = await debug("dataflow", {
    edits: `window = scan(${JSON.stringify(join(fixtureDir, "missing.txt"))}, preview=2, skip_lines=3)`,
    observe: [],
  });
  assert.ok(missingWindow.results.window?.error, "failed Scan revision retained a success");
  assert.match(lastObservation(missingWindow.context), /window: error/);
  assert.match(lastObservation(missingWindow.context), /missing\.txt/);
  assert.ok(!lastObservation(missingWindow.context).includes("WINDOW_FOUR"), "failed revision exposed old data");

  await debug("dataflow", { edits: "", delete: ["window_lines", "window"] });

  // 6. A statement that does not parse fails alone and lands nothing of its own.
  const before = await getSnapshot(agentId, "head", baseUrl);
  const syntax = await debug("dataflow", { edits: "broken = filter(source, lambda row: row['x'] >", observe: [] });
  assert.match(syntax.context, /PROGRAM_SYNTAX[^\n]*line 1/);
  assert.deepEqual(
    (await getSnapshot(agentId, "head", baseUrl)).workflow,
    before.workflow,
    "syntax error changed the DAG"
  );

  // 7. Partial failure: an invalid statement fails, its dependent is blocked, a
  //    valid sibling lands; the execute action is skipped.
  const partial = await debug("dataflow", {
    edits: [
      "invalid = filter(source, 4)",
      "blocked = aggregate(invalid, n=count())",
      'valid = map(positive, lambda row: {**row, "doubled": row["x"] * 2}, doc="Adds doubled = 2 * x")',
    ].join("\n"),
    observe: [],
  });
  assert.match(partial.context, /invalid: error/);
  assert.match(partial.context, /blocked: blocked/);
  assert.match(lastObservation(partial.context), /execute: skipped/);
  assert.ok(!partial.results.valid?.sampleRecords, "a failed edit must skip execute");
  await debug("dataflow", {
    reasoning: "Execute the independent statements that landed.",
    actions: [{ type: "execute" }],
  });

  // 8. An execution error replaces the previous success and is inspectable.
  const failed = await debug("dataflow", {
    edits:
      'valid = map(positive, lambda row: {**row, "doubled": row["not_a_column"] * 2}, doc="Adds doubled from a column that does not exist")',
    observe: [],
  });
  assert.ok(failed.results.valid?.error, "previous successful result must be replaced by the new error");
  assert.match(failed.context, /not_a_column/);
  assert.match(failed.context, /MISSING_COLUMN/);
  // 9. Deleting through the same tool: refused while a consumer reads the
  //    operator, accepted once the consumer goes with it.
  const refused = await debug("dataflow", { edits: "", delete: ["positive"] });
  assert.match(refused.context, /still feeds/);
  const removed = await debug("dataflow", { edits: "", delete: ["valid", "positive", "blocked"] });
  assert.match(removed.context, /deleted operator `valid`/);
  assert.match(removed.context, /`positive` still feeds `total`/, "positive still has a consumer and must survive");
  assert.match(removed.context, /`blocked` not found/, "a never-landed statement is not an operator");
  assert.ok(removed.results.total?.sampleRecords, "deleting a sibling must not disturb the surviving chain");

  const trace = await getReActSteps(agentId, baseUrl);
  console.log(
    JSON.stringify(
      {
        passed: true,
        agentService: baseUrl,
        steps: trace.steps.length,
        operators: Object.keys(readSnapshot.results).length,
      },
      null,
      2
    )
  );
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl).catch(() => undefined);
  if (wid !== undefined) await deleteWorkflow(token, wid).catch(() => undefined);
  await terminateComputingUnit(token, cuid).catch(() => undefined);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
}
