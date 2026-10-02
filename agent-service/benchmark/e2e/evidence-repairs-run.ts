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

/** Deterministic graph/evidence/cache verification, with no model calls. */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import {
  renderDataflowActionsResult,
  type DataflowAction,
  type DataflowActionsResult,
} from "../../src/agent/tools/dataflow-actions";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT!;
assert.ok(baseUrl && process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT, "Set isolated endpoints");
const directory = mkdtempSync(join(tmpdir(), "evidence-repairs-"));
const save = (name: string, data: unknown) => writeFileSync(join(directory, name), JSON.stringify(data, null, 2));
const left = join(directory, "left.csv");
const right = join(directory, "right.csv");
writeFileSync(left, "key,year,value\na,2020,10\na,2021,20\nb,2020,30\n");
writeFileSync(right, "key,place\na,north\na,south\nb,east\n");
const token = await login("texera", "texera");
const unit = await createComputingUnit(token, `evidence-repairs-${Date.now()}`, {
  unitType: "local",
  uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const wid = await createWorkflow(token, `evidence-repairs-${Date.now()}`, new WorkflowState().getWorkflowContent());
let agentId = "";
let sequence = 0;
function literal(value: any): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  if (Array.isArray(value)) return `[${value.map(literal).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}:${literal(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
try {
  agentId = (
    await createAgent({
      baseUrl,
      userToken: token,
      modelType: "gpt-5.6-luna",
      workflowId: wid,
      computingUnitId: cuid,
      settings: {
        agentMode: "native",
        contextMode: "delta",
        retrievalViews: ["full", "sample", "sample_stats"],
        flowEvidence: true,
        maxResultRows: 1,
        maxOperatorResultCharLimit: 2000,
        dataEvidenceCharLimit: 2000,
        flowEvidenceCharLimit: 2000,
        executionTimeoutMinutes: 0.5,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, model_calls: 0 });
  async function actions(items: DataflowAction[]) {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
      let sent = false,
        completed = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("debug timeout"));
      }, 45000);
      ws.onmessage = event => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "init" && !sent) {
          sent = true;
          ws.send(
            JSON.stringify({
              type: "debug",
              content: `Function(name="dataflow", arguments=${JSON.stringify(literal({ reasoning: "Verify graph and evidence.", actions: items }))})`,
            })
          );
        }
        if (frame.type === "complete") completed = true;
        if ((frame.type === "nextContext" && completed) || frame.type === "error") {
          clearTimeout(timer);
          ws.close();
          frame.type === "error" ? reject(new Error(String(frame.content ?? frame.message))) : resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("transport failed"));
      };
    });
    const trace = await getReActSteps(agentId, baseUrl);
    const receipt = trace.steps.at(-1)?.toolResults?.[0]?.output as DataflowActionsResult;
    save(`receipt-${++sequence}.json`, { items, receipt, rendered: renderDataflowActionsResult(receipt) });
    return receipt;
  }
  const construction = [
    `create operator source: scan(${JSON.stringify(left)})`,
    `create operator reference: scan(${JSON.stringify(right)})`,
    'create operator selected: project(keep=["key","year","value"])',
    'create operator unique_reference: distinct(columns=["key"])',
    'create operator joined: join(on="key", how="inner", validate="many_to_one")',
    'create operator total: aggregate(value=sum("value"))',
    "create operator unfinished: limit(1)",
    'create operator bad: process(fn=fail, doc="Deliberate failed sibling")\n    def fail(df):\n        raise ValueError("deliberate sibling")',
    "create edge source.out -> selected.in",
    "create edge reference.out -> unique_reference.in",
    "create edge selected.out -> joined.left",
    "create edge unique_reference.out -> joined.right",
    "create edge joined.out -> total.in",
    "create edge source.out -> bad.in[0]",
  ].join("\n");
  const built = await actions([
    { type: "edit", changes: construction },
    { type: "execute", operator_ids: ["total"] },
    { type: "retrieve", operator_id: "source", view: "sample_stats", columns: ["year", "value"] },
    { type: "retrieve", operator_id: "total", view: "full" },
  ]);
  assert.equal(built.status, "completed", JSON.stringify(built));
  const stats = built.actions[2].output as any;
  assert.deepEqual(stats.unavailable_profiles, []);
  assert.match(stats.text, /range=\[2020, 2021\]/);
  assert.match(stats.text, /2020:2, 2021:1/);
  const final = built.actions[3].output as any;
  assert.match(final.text, /removed=1/);
  assert.match(final.text, /north.*south/s);
  assert.match(final.text, /Flow upstream selected/);
  const snapshot = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual((snapshot.results.total as any).sampleRecords, [{ value: 60 }]);
  assert.ok(!snapshot.results.unfinished && !snapshot.results.bad);
  const version = (snapshot.results.total as any).resultVersion;
  const executions = async () => {
    const response = await fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const executionHistory = await executions();
  const read = await actions([
    { type: "retrieve", operator_id: "source", view: "full", columns: ["value"] },
    { type: "retrieve", operator_id: "total", view: "sample_stats" },
  ]);
  assert.equal(read.status, "completed");
  assert.deepEqual(await executions(), executionHistory, "Retrieve must not create an execution");
  assert.ok(!(read.actions[0].output as any).text.includes('"year"'));
  const readSnapshot = await getSnapshot(agentId, "head", baseUrl);
  assert.deepEqual(
    (readSnapshot.results.total as any).resultVersion,
    version,
    "Retrieve must not execute or change producing version"
  );
  const cached = await actions([{ type: "execute", operator_ids: ["total"] }]);
  assert.equal(cached.status, "completed");
  const cachedSnapshot = await getSnapshot(agentId, "head", baseUrl);
  assert.equal((cachedSnapshot.results.total as any).state, "CompletedFromCache");
  const rejected = await actions([
    { type: "edit", changes: "create operator temporary: limit(1)\ncreate edge missing.out -> temporary.in" },
    { type: "execute", operator_ids: ["total"] },
  ]);
  assert.deepEqual(
    rejected.actions.map(a => a.status),
    ["error", "skipped"]
  );
  const graph = await actions([{ type: "inspect", target: "graph" }]);
  assert.ok(!JSON.stringify(graph).includes('"id":"temporary"'));
  const deletion = await actions([
    { type: "edit", changes: "delete operator selected\ncreate edge source.out -> joined.left" },
  ]);
  assert.equal(deletion.status, "completed");
  assert.equal((deletion.actions[0].output as any).changes[0].deleted_edges.length, 2);
  save("checks.json", {
    passed: true,
    model_calls: 0,
    rows: 3,
    distinct_removed: 1,
    total: 60,
    selected_columns: ["year", "value"],
    cached: true,
  });
  console.log(JSON.stringify({ directory, passed: true, model_calls: 0 }));
} finally {
  if (agentId) {
    await fetch(`${baseUrl}/api/agents/${agentId}/stop`, { method: "POST" });
    await deleteAgent(agentId, baseUrl);
  }
  await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
