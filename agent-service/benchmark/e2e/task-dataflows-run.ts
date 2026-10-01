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
/** Deterministic live-engine checks; no model calls. Run with the isolated
 * backend profile loaded. Leaves full audit artifacts in its printed directory. */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TexeraAgent } from "../../src/agent/texera-agent";
import { WorkflowState } from "../../src/agent/workflow-state";
import { assembleContext } from "../../src/agent/util/context-utils";
import { AgentMode, ContextMode } from "../../src/types/agent";
import { createComputingUnit, createWorkflow, login } from "../../src/api";
import { env } from "../../src/config/env";
import type { DataflowAction } from "../../src/agent/tools/dataflow-actions";

const directory = mkdtempSync(join(tmpdir(), "task-dataflows-live-"));
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
console.log(`Live check artifacts: ${directory}`);
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const unit = await createComputingUnit(token, `task-dataflows-${Date.now()}`, {
  unitType: "local",
  uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const wid = await createWorkflow(token, `task-dataflows-${Date.now()}`, new WorkflowState().getWorkflowContent());
save("resources.json", { wid, cuid });
let batches: DataflowAction[][] = [];
let sequence = 0;
const agent = new TexeraAgent({
  agentId: `task-live-${Date.now()}`,
  modelType: "scripted-check",
  contextAssembler: ({ visibleSteps, workflowState, snapshotStorage }) =>
    assembleContext(visibleSteps, workflowState, snapshotStorage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      messageLayout: "native",
    }),
  driver: {
    async runTurn(input) {
      for (const [i, actions] of batches.entries()) {
        await input.prepareStep({ stepNumber: i, messages: [] });
        const args = { reasoning: "Check retained task state.", actions };
        const output = await input.tools.dataflow.execute(args);
        const toolCallId = `live-${++sequence}`;
        await input.onStepFinish({
          text: "",
          toolCalls: [{ toolName: "dataflow", toolCallId, input: args }],
          toolResults: [{ toolCallId, output }],
        });
        save(`actions-${sequence}.json`, output);
        console.log(`Action batch ${sequence}: ${output.status}`);
        assert.equal(output.status, "completed", JSON.stringify(output));
      }
      return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
    },
  },
});
await agent.initialize({ userToken: token, workflowId: wid, computingUnitId: cuid });
agent.updateSettings({ taskDataflows: true, statePolicy: true, maxSteps: 10, executionTimeoutMs: 240_000 });
try {
  batches = [
    [
      {
        type: "edit",
        changes: `create operator raw: process(fn=population, doc="Create a known 100-row fixture")
    def population():
        import pandas as pd
        return pd.DataFrame({"id": range(1, 101), "value": [1] * 80 + [0] * 20})
create operator typed: cast(id=int64, value=int64)
create operator eligible: filter(fn=lambda row: row["value"] > 0, doc="Keep positive values")
create operator report: limit(2)
create edge raw.out -> typed.in
create edge typed.out -> eligible.in
create edge eligible.out -> report.in`,
      },
      { type: "execute" },
      { type: "retrieve", operator_id: "report" },
    ],
    [
      {
        type: "answer",
        content: "Two example rows from the eligible population.",
        exports: [{ name: "eligible_population", operator_id: "eligible" }],
        answer_sources: ["report"],
        defaults: [{ name: "population", export_name: "eligible_population" }],
      },
    ],
  ];
  const first = await agent.sendMessage(
    "Keep the positive-value population for later tasks and show two example rows."
  );
  assert.equal(first.error, undefined, first.error);
  const original = agent.getTaskDataflows()[0];
  assert.equal(original.exports.eligible_population.artifact.rowCount, 80);
  assert.equal(original.answer_sources.report.artifact.rowCount, 2);
  save("task-1.json", original);
  batches = [
    [
      { type: "inspect", target: "task", task_id: 1, detail: "outputs" },
      { type: "inspect", target: "defaults" },
    ],
    [
      { type: "reuse_result", task_id: 1, export_name: "eligible_population", operator_id: "saved" },
      { type: "edit", changes: "create operator size: aggregate(n=count())\ncreate edge saved.out -> size.in" },
      { type: "execute" },
      { type: "retrieve", operator_id: "size" },
    ],
    [
      {
        type: "answer",
        content: "80 rows",
        exports: [{ name: "size", operator_id: "size" }],
        answer_sources: ["size"],
        defaults: [],
      },
    ],
  ];
  const second = await agent.sendMessage(
    "How many rows were in the full eligible population? This is a temporary report."
  );
  assert.equal(second.error, undefined, second.error);
  const records = agent.getTaskDataflows();
  assert.equal(records[1].exports.size.info.result![0].n, 80);
  assert.equal(records[1].dependencies[0].task_id, 1);
  assert.equal(records[1].dependencies[0].result_version, original.exports.eligible_population.info.resultVersion!.id);
  assert.deepEqual(records[0], original);
  assert.deepEqual(records[1].default_changes, []);
  save("task-dataflows.json", records);
  save("summary.json", { passed: true, full_population_rows: 80, report_rows: 2, imported_rows: 80, wid, cuid });
  console.log(`Full-table retention and cross-task reuse passed: ${directory}`);
} catch (error) {
  save("summary.json", { passed: false, error: error instanceof Error ? error.message : String(error), wid, cuid });
  throw error;
} finally {
  save("trace.json", agent.getReActSteps());
  save("task-dataflows.json", agent.getTaskDataflows());
}
// Keep workflow/executions for inspecting retention provenance; no shared services are stopped.
process.exit(0);
