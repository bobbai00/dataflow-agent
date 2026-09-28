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

import { expect, test } from "bun:test";
import { TexeraAgent } from "../texera-agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { executionRequestLimits } from "./workflow-execution-tools";

test("an execution request turns Bun's own timeout off and waits the engine's timeout plus a margin", async () => {
  const limits = executionRequestLimits(600);
  expect(limits.timeout).toBe(false);
  expect(limits.signal.aborted).toBe(false);
  // The deadline is the engine timeout plus 60 s: -59.95 s of engine time leaves 50 ms.
  const soon = executionRequestLimits(-59.95);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(soon.signal.aborted).toBe(true);
  expect((soon.signal.reason as DOMException).name).toBe("TimeoutError");
});

test("the caller's abort still ends an execution request at once", () => {
  const caller = new AbortController();
  const limits = executionRequestLimits(600, caller.signal);
  caller.abort();
  expect(limits.signal.aborted).toBe(true);
  expect((limits.signal.reason as DOMException).name).toBe("AbortError");
});

test("the agent's execution call is sent with those limits and the engine timeout it was configured with", async () => {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const agent = new TexeraAgent({
    agentId: "execution-limits",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  }) as any;
  agent.updateSettings({ executionTimeoutMs: 600_000 });
  agent.delegateConfig = { userToken: "test", workflowId: 7 };
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
  const sent: Array<{ init: any; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_url: unknown, init: any) => {
      sent.push({ init, body: JSON.parse(init.body) });
      return Response.json({ success: true, state: "Completed", operators: {} });
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    await agent.runPostStepExecution(
      [{ toolName: "createOrModifyOperator", toolCallId: "t", input: { operatorId: "source" } }],
      [{ toolCallId: "t", output: "ok" }]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(sent).toHaveLength(1);
  expect(sent[0].body.timeoutSeconds).toBe(600);
  expect(sent[0].init.timeout).toBe(false);
  expect(sent[0].init.signal).toBeInstanceOf(AbortSignal);
});
