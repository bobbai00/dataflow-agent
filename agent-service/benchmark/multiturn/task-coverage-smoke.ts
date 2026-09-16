/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
/** Fault injection: scripted model actions through the production agent loop
 * and real engine. This is a correctness smoke, not a paid-model evaluation. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TexeraAgent } from "../../src/agent/texera-agent";
import { AgentMode } from "../../src/types/agent";
import { WorkflowState } from "../../src/agent/workflow-state";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  getBackendConfig,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { assertNativeCleanupSafe } from "../e2e/native-cleanup";

const out = resolve(process.argv[2] ?? "/tmp/texera-task-history/coverage-smoke");
mkdirSync(out, { recursive: true });
const file = out + "/full.csv";
writeFileSync(file, "value\n" + Array.from({ length: 12 }, (_, i) => i + 1).join("\n") + "\n");
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const name = `task-coverage-${Date.now()}`;
const cuid = (await createComputingUnit(token, name, { unitType: "local", uri: process.env.TEXERA_LOCAL_CU_URI }))
  .computingUnit.cuid;
const wid = await createWorkflow(token, name, new WorkflowState().getWorkflowContent());
let nextBatch: any;
let directAnswer: string | undefined;
let batchResult: any;
const agent = new TexeraAgent({
  agentId: name,
  modelType: "scripted-fault-injection",
  contextAssembler: () => [],
  driver: {
    runTurn: async input => {
      batchResult = await (agent as any).tools.dataflow.execute(nextBatch);
      await input.onStepFinish({
        text: "",
        toolCalls: [{ toolName: "dataflow", toolCallId: "call", input: nextBatch }],
        toolResults: [{ toolCallId: "call", output: batchResult }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      directAnswer = input.getFinalAnswer?.();
      return {
        text: directAnswer ?? "Direct completion was refused.",
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  },
});
await agent.initialize({ userToken: token, workflowId: wid, computingUnitId: cuid });
agent.updateSettings({
  agentMode: AgentMode.NATIVE,
  nativeToolMode: "batch",
  nativeCatalogVersion: "v2",
  nativeTaskHistory: true,
  nativeDirectReturn: true,
  nativeTaskContext: true,
  nativeCompactPrompt: true,
});
let request = 0;
const run = async (batch: any) => {
  nextBatch = batch;
  const result = await agent.sendMessage(`Coverage regression task ${++request}`);
  assert.equal(result.error, undefined);
  await Bun.write(
    `${out}/${request}.json`,
    JSON.stringify({ batch, result, batchResult, steps: agent.getAllSteps() }, null, 2)
  );
};
try {
  await run({
    operators: [
      { op: "scan", id: "source", files: file, preview: 5 },
      { op: "aggregate", id: "total", input: "source", aggregations: [{ fn: "count", as: "count" }] },
    ],
    return: { operator: "total", format: "row" },
  });
  assert.equal(directAnswer, undefined);
  assert.match(batchResult.observationErrors.join("\n"), /raw discovery previews: source/);
  await run({ operators: [{ op: "scan", id: "source", files: file }], return: { operator: "total", format: "row" } });
  assert.deepEqual(JSON.parse(directAnswer!), { count: 12 });
  await run({
    operators: [{ op: "project", id: "historical_count", input: { operator: "total", atTask: 1 }, keep: ["count"] }],
    return: { operator: "historical_count", format: "row" },
  });
  assert.equal(directAnswer, undefined);
  assert.match(batchResult.observationErrors.join("\n"), /source at task 1/);
  const summary = {
    passed: true,
    real_engine: getBackendConfig().executionEndpoint,
    model_calls: 0,
    checks: [
      "complete aggregate over a raw probe cannot directly finish",
      "full scan repairs current descendants",
      "historical preview origin survives current source repair",
    ],
  };
  await Bun.write(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  const response = await fetch(`${getBackendConfig().apiEndpoint}/api/executions/${wid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok);
  assertNativeCleanupSafe(
    { id: name, state: agent.getState(), delegate: { workflowId: wid, computingUnitId: cuid } },
    await response.json(),
    { agentId: name, wid, cuid }
  );
  await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
