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

/** Replay saved callback inputs through cached multi-port execution, without model calls.
 * Manifest: [{operator_id, native_op: {properties: {code}}, inputs: [{operator_id, path}]}].
 * Inputs must be full CSV exports, ordered by input port; duplicate IDs reuse one source.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import type { DataflowAction, DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT;
assert.ok(baseUrl && process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT, "Set isolated service endpoints");
assert.ok(process.argv[2], "Pass a saved-input manifest");
const cases = JSON.parse(readFileSync(process.argv[2], "utf8")) as Array<{
  operator_id: string;
  native_op: { properties: { code: string } };
  inputs: Array<{ operator_id: string; path: string; rows?: number }>;
}>;
const directory = mkdtempSync(join(tmpdir(), "cache-stall-replay-"));
const save = (name: string, data: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + "\n");
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const checks: unknown[] = [];
type SavedResult = { state?: string; sampleRecords?: unknown[]; materialization?: { executionId?: string | number } };

function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value!)
      .map(([k, v]) => `${JSON.stringify(k)}:${pythonLiteral(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

for (const scenario of cases) {
  const label = scenario.operator_id;
  const unit = await createComputingUnit(token, `stall-replay-${Date.now()}`, {
    unitType: "local",
    uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  const cuid = unit.computingUnit.cuid;
  const wid = await createWorkflow(token, `stall-replay-${Date.now()}`, new WorkflowState().getWorkflowContent());
  let agentId = "";
  let sequence = 0;
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
          executionTimeoutMinutes: 0.25,
          toolTimeoutSeconds: 25,
          retrievalViews: ["full"],
        },
      })
    ).id;
    save(`${label}-resources.json`, { agentId, wid, cuid, model_calls: 0 });
    async function actions(items: DataflowAction[]) {
      const input = { reasoning: "Isolate cached input delivery and error propagation.", actions: items };
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl!.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
        let sent = false,
          finished = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Debug action timed out"));
        }, 40_000);
        ws.onmessage = event => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "init" && !sent) {
            sent = true;
            ws.send(
              JSON.stringify({
                type: "debug",
                content: `Function(name="dataflow", arguments=${JSON.stringify(pythonLiteral(input))})`,
              })
            );
          }
          if (frame.type === "complete") finished = true;
          if ((frame.type === "nextContext" && finished) || frame.type === "error") {
            clearTimeout(timer);
            ws.close();
            frame.type === "error" ? reject(new Error(String(frame.message ?? frame.content))) : resolve();
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error("Debug transport failed"));
        };
      });
      const trace = await getReActSteps(agentId, baseUrl);
      const receipt = trace.steps.at(-1)?.toolResults?.[0]?.output as DataflowActionsResult;
      save(`${label}-action-${++sequence}.json`, { input, receipt });
      return { receipt, seconds: (performance.now() - start) / 1000 };
    }
    const unique = [...new Map(scenario.inputs.map(i => [i.operator_id, i])).values()];
    const seeded = await actions([
      {
        type: "edit",
        changes: unique.map(i => `create operator ${i.operator_id}: scan(${JSON.stringify(i.path)})`).join("\n"),
      },
      { type: "execute", operator_ids: unique.map(i => i.operator_id) },
    ]);
    assert.equal(seeded.receipt.status, "completed");
    const edges = (id: string) =>
      scenario.inputs.map((i, port) => `create edge ${i.operator_id}.out -> ${id}.in[${port}]`).join("\n");
    const countId = `${label}_counts`;
    const params = scenario.inputs.map((_, i) => `p${i}`).join(", ");
    const columns = scenario.inputs.map((_, i) => `${JSON.stringify(`port_${i}`)}: [len(p${i})]`).join(", ");
    const counts = await actions([
      {
        type: "edit",
        changes: `create operator ${countId}: process(fn=count_inputs, doc="Verify each input port")\n    def count_inputs(${params}):\n        import pandas as pd\n        return pd.DataFrame({${columns}})\n${edges(countId)}`,
      },
      { type: "execute", operator_ids: [countId] },
      { type: "retrieve", operator_id: countId, view: "full" },
    ]);
    const code = scenario.native_op.properties.code;
    const entry = /^def\s+(\w+)\(/m.exec(code)?.[1];
    assert.ok(entry, "Saved code needs a function entry");
    const callback = await actions([
      {
        type: "edit",
        changes: `create operator ${label}: process(fn=${entry}, doc="Replay original callback")\n${code
          .split("\n")
          .map(l => "    " + l)
          .join("\n")}\n${edges(label)}`,
      },
      { type: "execute", operator_ids: [label] },
      { type: "retrieve", operator_id: label, view: "full" },
    ]);
    const snapshot = await getSnapshot(agentId, "head", baseUrl);
    const results = snapshot.results as Record<string, SavedResult>;
    save(`${label}-snapshot.json`, snapshot);
    const result = {
      label,
      counts_status: counts.receipt.status,
      counts_seconds: counts.seconds,
      callback_status: callback.receipt.status,
      callback_seconds: callback.seconds,
      input_states: Object.fromEntries(unique.map(i => [i.operator_id, results[i.operator_id]?.state])),
      counts: results[countId]?.sampleRecords,
      callback_error: callback.receipt.actions.filter(a => a.status === "error").map(a => a.output),
    };
    checks.push(result);
    console.log(
      JSON.stringify({
        label,
        counts_status: result.counts_status,
        counts_seconds: result.counts_seconds,
        callback_status: result.callback_status,
        callback_seconds: result.callback_seconds,
      })
    );
    if (process.env.CACHE_STALL_ASSERT === "1") {
      assert.equal(result.counts_status, "completed", "Every cached input port must finish");
      if (scenario.inputs.every(i => i.rows !== undefined))
        assert.deepEqual(result.counts, [
          Object.fromEntries(scenario.inputs.map((i, port) => [`port_${port}`, i.rows])),
        ]);
      assert.ok(
        !JSON.stringify(result.callback_error).includes("EXECUTION_TIMEOUT"),
        "A callback error must be reported promptly"
      );
      assert.ok(Object.values(result.input_states).every(state => state === "CompletedFromCache"));
    }
    // Optional storage fault on a table created by THIS probe. Keep the bytes
    // under a temporary name and restore them before deleting its resources.
    if (process.env.CACHE_STALL_FAULT_ROOT && scenario === cases[0]) {
      const source = unique[0].operator_id;
      const saved = results[source];
      const eid = saved?.materialization?.executionId;
      assert.ok(eid, "Need the probe's own materialized source");
      const table = join(
        process.env.CACHE_STALL_FAULT_ROOT,
        "operator-port-result",
        `wid_${wid}_eid_${eid}_globalportid_(logicalOpId=${source},layerName=main,portId=0,isInternal=false,isInput=false)_result`
      );
      const files = [...new Bun.Glob("**/*").scanSync({ cwd: table, onlyFiles: true })]
        .filter(name => !name.startsWith("metadata/") && !name.endsWith(".crc"))
        .map(name => join(table, name));
      assert.ok(files.length, "Need a locally stored data file for fault injection");
      const faultId = `${label}_read_fault`;
      await actions([
        {
          type: "edit",
          changes: `create operator ${faultId}: aggregate(n=count())\ncreate edge ${source}.out -> ${faultId}.in`,
        },
      ]);
      const moved: string[] = [];
      try {
        for (const file of files) {
          renameSync(file, `${file}.probe-backup`);
          moved.push(file);
        }
        const failure = await actions([{ type: "execute", operator_ids: [faultId] }]);
        save("read-failure.json", failure);
        assert.equal(failure.receipt.status, "error");
        assert.ok(
          !JSON.stringify(failure.receipt).includes("EXECUTION_TIMEOUT"),
          "A failed cached read must surface before the deadline"
        );
        assert.match(JSON.stringify(failure.receipt), /No such file|FileNotFound|does not exist/i);
        checks.push({ label: "cached_read_failure", status: failure.receipt.status, seconds: failure.seconds });
      } finally {
        for (const file of moved) renameSync(`${file}.probe-backup`, file);
      }
      const recovery = await actions([
        { type: "execute", operator_ids: [faultId] },
        { type: "retrieve", operator_id: faultId, view: "full" },
      ]);
      save("read-recovery.json", recovery);
      assert.equal(recovery.receipt.status, "completed");
      const recovered = await getSnapshot(agentId, "head", baseUrl);
      assert.deepEqual((recovered.results[faultId] as SavedResult)?.sampleRecords, [{ n: scenario.inputs[0].rows }]);
      checks.push({ label: "cached_read_recovery", status: recovery.receipt.status, seconds: recovery.seconds });
    }
  } finally {
    save("checks.json", { checks, model_calls: 0 });
    if (agentId) {
      await fetch(`${baseUrl}/api/agents/${agentId}/stop`, { method: "POST" });
      await deleteAgent(agentId, baseUrl);
    }
    await deleteWorkflow(token, wid);
    await terminateComputingUnit(token, cuid);
  }
}
save("checks.json", { checks, model_calls: 0 });
console.log(JSON.stringify({ directory }));
