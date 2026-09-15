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

/** Direct engine smoke plus agent-service settings roundtrip.
 * Optional SMOKE_AGENT_TURN=1 makes one small synthetic LLM turn and checks its
 * recorded inputMessages, rather than just the local formatter.
 * WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:8086 TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3009 bun run benchmark/e2e/native-flow-evidence.ts
 */
import assert from "node:assert/strict";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  executeWorkflowSync,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { compileNativeOp } from "../../src/agent/native/codegen";
import type { NativeOpView } from "../../src/agent/native/catalog";
import { formatNativeFlowEvidence } from "../../src/agent/native/flow-evidence";
import { makeWorkflow } from "../../src/agent/context/summarize/fixtures";
import { WorkflowState } from "../../src/agent/workflow-state";
import { buildLogicalPlanForTest } from "../../src/agent/tools/workflow-execution-tools";

const views: Record<string, NativeOpView> = {
  source: {
    type: "UDF",
    inputs: [],
    properties: {
      code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'label':['shared','shared','solo'], 'community':[1,2,1], 'identity':['x','y','z'], 'reading':[10,None,30]})",
    },
  },
  lookup: {
    type: "UDF",
    inputs: [],
    properties: {
      code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'label':['shared','shared'], 'identity':['x','w']})",
    },
  },
  mapped: {
    type: "Compute",
    inputs: ["source"],
    properties: { columns: { passing: "CASE WHEN reading < 100 THEN 1 ELSE 0 END" } },
  },
  grouped: {
    type: "Aggregate",
    inputs: ["mapped"],
    properties: { groupBy: ["label"], aggregations: [{ fn: "sum", col: "passing", as: "passes" }] },
  },
  joined: { type: "Join", inputs: ["source", "lookup"], properties: { on: ["label"], type: "left" } },
};

const baseWorkflow = makeWorkflow(
  Object.entries(views).map(([id, view]) => {
    const compiled = compileNativeOp(view, { flowEvidence: true });
    return { id, type: compiled.operatorType, properties: { code: compiled.code }, numInputPorts: view.inputs.length };
  }),
  Object.entries(views).flatMap(([id, view]) => view.inputs.map((up, i) => [up, id, i] as [string, string, number]))
);
const wf = {
  ...baseWorkflow,
  operators: baseWorkflow.operators.map(op => ({ ...op, nativeOp: views[op.operatorID] })),
};
const state = new WorkflowState();
state.setWorkflowContent(wf);

const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const cu = await createComputingUnit(token, `native-evidence-smoke-${Date.now()}`, {
  unitType: "local",
  uri: process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085",
});
const cuid = cu.computingUnit.cuid;
let wid: number | undefined;
let agentId: string | undefined;
const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3009";
try {
  wid = await createWorkflow(token, `native-evidence-smoke-${Date.now()}`, wf, "temporary direct evidence smoke");
  const agent = await createAgent({
    baseUrl,
    workflowId: wid,
    computingUnitId: cuid,
    userToken: token,
    modelType: "gpt-5.6-luna",
    settings: { agentMode: "native", nativeFlowEvidence: true, columnStats: false, dataLevel: 1, maxSteps: 3 },
  });
  agentId = agent.id;
  const response = await fetch(`${baseUrl}/api/agents/${agentId}/settings`);
  assert(response.ok, "agent settings available");
  const settings = (await response.json()) as any;
  assert.equal((settings.settings ?? settings).nativeFlowEvidence, true, "flag survives HTTP create/get");
  for (const value of [false, true]) {
    const patched: Response = await fetch(`${baseUrl}/api/agents/${agentId}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nativeFlowEvidence: value }),
    });
    assert(patched.ok, "flag accepted by HTTP PATCH schema");
    assert.equal(((await patched.json()) as any).nativeFlowEvidence, value);
  }
  const promptInfo = await fetch(`${baseUrl}/api/agents/${agentId}/system-info`);
  const prompt = ((await promptInfo.json()) as any).systemPrompt;
  assert(prompt.includes("full materialized input/output tables"));
  assert(prompt.includes("not unread files or the whole data lake"));
  const result = await executeWorkflowSync(token, wid, buildLogicalPlanForTest(state, Object.keys(views)), {
    computingUnitId: cuid,
    timeoutSeconds: 120,
    executionName: "native-flow-evidence-smoke",
  });
  assert(result.success, JSON.stringify(result.errors ?? result));
  for (const id of ["mapped", "grouped", "joined"]) {
    const info = result.operators[id];
    assert(!info.error, info.error);
    const evidence = formatNativeFlowEvidence(info);
    assert(evidence, `${id}: structured result metadata reached the service`);
    console.log(`${id}: ${evidence}`);
  }
  assert(formatNativeFlowEvidence(result.operators.mapped)?.includes('"reading" null → "passing" non-null: 1'));
  assert(formatNativeFlowEvidence(result.operators.grouped)?.includes('multiple "community" values in 1/2 groups'));
  assert(formatNativeFlowEvidence(result.operators.joined)?.includes("matched input rows: left 2/3, right 2/2"));
  assert.equal(result.operators.joined.totalRowCount, 5);
  assert(!Object.keys(result.operators.mapped.result?.[0] ?? {}).some(k => k.startsWith("__native_flow_source_")));
  if (process.env.SMOKE_AGENT_TURN === "1") {
    const turn = await fetch(`${baseUrl}/api/agents/${agentId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content:
          'This is a synthetic smoke test. Add exactly these two typed operators: compute with id smoke_mapped, input source, columns {"passing":"CASE WHEN reading < 100 THEN 1 ELSE 0 END"}; join with id smoke_joined, left source, right lookup, on ["label"], type left. After they run, report the measured null transition and matched input-row counts in one sentence. Do not modify other operators.',
      }),
      signal: AbortSignal.timeout(90_000),
    });
    assert(turn.ok, `synthetic agent turn HTTP ${turn.status}`);
    const trace = await getReActSteps(agentId, baseUrl);
    const inputs = JSON.stringify(trace.steps.flatMap(s => s.inputMessages ?? []));
    assert(inputs.includes("Flow evidence (measured):"), "measurements are in actual model inputMessages");
    assert(inputs.includes("matched input rows: left 2/3, right 2/2"));
    assert(inputs.includes("null →"));
    assert(!inputs.includes("__native_flow_evidence__"), "reserved transport is not rendered verbatim");
    console.log("PASS: actual agent inputMessages contain measured evidence without the raw envelope");
  }
  console.log(`PASS: settings on ${baseUrl}, generated measurements on Texera, unchanged user schema`);
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl);
  if (wid !== undefined) await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
