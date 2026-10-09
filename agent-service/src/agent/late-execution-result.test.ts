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

import { expect, test } from "bun:test";
import { TexeraAgent } from "./texera-agent";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";

for (const scenario of ["success", "operator-error", "execution-error", "abort"] as const) {
  test(`a late ${scenario} cannot write into a newer/aborted snapshot`, async () => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const agent = new TexeraAgent({
      agentId: `late-${scenario}`,
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    }) as any;
    agent.delegateConfig = { userToken: "test", workflowId: 12345 };
    const workflow = {
      operators: [
        {
          operatorID: "source",
          operatorType: "DataLoading",
          operatorProperties: { code: "def load(): pass" },
          inputPorts: [],
          outputPorts: [{ portID: "output-0" }],
        },
      ],
      links: [],
      operatorPositions: {},
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    agent.workflowState.setWorkflowContent(workflow);
    agent.head = "A";
    agent.snapshotStorage.createSnapshot("A", workflow);
    agent.abortController = new AbortController();
    let release!: (response: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => {
      signalStarted = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => {
        signalStarted();
        return new Promise<Response>(resolve => {
          release = resolve;
        });
      },
      { preconnect: originalFetch.preconnect }
    );
    try {
      const pending = agent.runPostStepExecution(
        [{ toolName: "createOrModifyOperator", toolCallId: "t", input: { operatorId: "source" } }],
        [{ toolCallId: "t", output: "ok" }]
      );
      await started;
      if (scenario === "abort") agent.abortController.abort();
      else {
        agent.snapshotStorage.createSnapshot("B", workflow);
        agent.head = "B";
      }
      const info = {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        resultMode: "table",
        result: [{ x: "old" }],
        resultMetadata: { reserved: "old profile" },
      };
      const response =
        scenario === "execution-error"
          ? { success: false, state: "Failed", operators: {}, errors: ["older execution failed"] }
          : {
              success: scenario !== "operator-error",
              state: "Completed",
              operators: {
                source:
                  scenario === "operator-error" ? { ...info, result: undefined, error: "older operator failed" } : info,
              },
            };
      release(Response.json(response));
      await pending;
      expect(agent.snapshotStorage.getOperatorResult("A", "source")).toBeUndefined();
      if (scenario !== "abort") expect(agent.snapshotStorage.getOperatorResult("B", "source")).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
