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

import { expect, spyOn, test } from "bun:test";
import { TexeraAgent } from "./texera-agent";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { planRegisteredGraphEdit } from "./tools/graph-edits";
import { prepareRegisteredDataflowActions, renderDataflowActionsResult } from "./tools/dataflow-actions";
import type { ReActStep } from "../types/agent";

for (const success of [true, false]) {
  test(`registered action traces retain execution metrics on ${success ? "success" : "failure"}`, async () => {
    const metadataStore = WorkflowSystemMetadata.getInstance();
    metadataStore.seedCodeModeDefaults();
    const agent = new TexeraAgent({
      agentId: `metrics-${success}`,
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    }) as any;
    agent.delegateConfig = { userToken: "test", workflowId: 9876 };
    const plan = await planRegisteredGraphEdit(
      agent.workflowState.getWorkflowContent(),
      "",
      "set source: scan(files='test.csv')",
      { metadataStore }
    );
    agent.workflowState.setWorkflowContent(plan.workflow);
    agent.head = "A";
    agent.snapshotStorage.createSnapshot("A", plan.workflow);
    agent.abortController = new AbortController();
    const input = { reasoning: "Execute requested data.", actions: [{ type: "execute", operator_ids: ["source"] }] };
    const output = prepareRegisteredDataflowActions(input);
    const calls = [{ toolName: "dataflow", toolCallId: "t", input }];
    const results = [{ toolCallId: "t", output }];
    agent.stepsById.set("A", {
      id: "A",
      stepId: 1,
      timestamp: Date.now(),
      role: "agent",
      content: "",
      messageId: "m",
      isBegin: false,
      isEnd: false,
      toolCalls: calls,
      toolResults: results,
    } as ReActStep);
    const phaseMetrics = { version: 1, compilation: "passed", compilationDurationMs: 12, runtimeStartAttempted: true };
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
        success,
        state: success ? "Completed" : "Failed",
        executionId: "123",
        phaseMetrics,
        operators: {
          source: {
            state: success ? "Completed" : "Failed",
            inputTuples: 0,
            outputTuples: success ? 1 : 0,
            resultMode: "table",
            ...(success ? { result: [{ x: 1 }] } : { error: "source missing" }),
          },
        },
      })
    );
    try {
      await agent.runPostStepExecution(calls, results);
      const actionOutput = output.actions[0].output as any;
      expect(actionOutput.execution_runs).toMatchObject([
        { targets: ["source"], executionId: "123", success, state: success ? "Completed" : "Failed", phaseMetrics },
      ]);
      const timing = actionOutput.execution_runs[0].clientTiming;
      for (const field of ["requestToHeadersMs", "responseBodyDecodeMs", "resultPreparationMs", "snapshotStoreMs"]) {
        expect(timing[field]).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(timing[field])).toBe(true);
      }
      expect(output.actions[0].status).toBe(success ? "ok" : "error");
      expect(JSON.stringify(agent.stepsById.get("A").toolResults)).toContain('"compilationDurationMs":12');
      // Structured trace metadata does not add implementation timings to the model prompt.
      expect(renderDataflowActionsResult(output)).not.toContain("compilationDurationMs");
    } finally {
      fetch.mockRestore();
    }
  });
}

test("stopping during preparation cannot proceed to a model request", async () => {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  let modelRequests = 0;
  const agent = new TexeraAgent({
    agentId: "compile-stop",
    modelType: "test",
    driver: {
      runTurn: async (options: any) => {
        await options.prepareStep({ stepNumber: 0, messages: [] });
        modelRequests++;
        return { text: "must not request", messages: [], usage: {} };
      },
    },
    contextAssembler: () => [],
  }) as any;
  agent.delegateConfig = { userToken: "test", workflowId: 9877 };
  agent.refreshWorkflowFromBackend = async () => {};
  const plan = await planRegisteredGraphEdit(
    agent.workflowState.getWorkflowContent(),
    "",
    "set source: scan(files='test.csv')",
    { metadataStore }
  );
  agent.workflowState.setWorkflowContent(plan.workflow);
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    queueMicrotask(() => agent.stop());
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("Missing cancellation signal"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof globalThis.fetch);
  try {
    const result = await agent.sendMessage("Read the data.");
    expect(result.stopped).toBe(true);
    expect(modelRequests).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});
