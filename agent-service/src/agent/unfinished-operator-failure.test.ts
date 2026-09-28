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
import { TexeraAgent } from "./texera-agent";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";

const died =
  "EXECUTION_FAILURE: java.lang.RuntimeException: The Python worker for operator source exited with code 143 " +
  "(killed by signal 15, SIGTERM) while the operator was running; the operator produced no complete result.";

/** Runs one post-step execution against an engine that answers with `response`. */
async function executeAgainst(response: Record<string, unknown>) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const agent = new TexeraAgent({
    agentId: `unfinished-${Math.random()}`,
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  }) as any;
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json(response), { preconnect: originalFetch.preconnect });
  try {
    await agent.runPostStepExecution(
      [{ toolName: "createOrModifyOperator", toolCallId: "t", input: { operatorId: "source" } }],
      [{ toolCallId: "t", output: "ok" }]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return agent.snapshotStorage.getOperatorResult("A", "source");
}

test("an operator the engine never finished gets the run's failure, not an empty unexplained result", async () => {
  // What the engine returns when the operator's Python worker is killed mid-run:
  // its (empty) result table exists, so the entry carries zero rows and no error.
  const stored = await executeAgainst({
    success: false,
    state: "Failed",
    operators: {
      source: {
        operatorId: "source",
        state: "Uninitialized",
        inputTuples: 0,
        outputTuples: 0,
        resultMode: "table",
        result: [],
        totalRowCount: 0,
      },
    },
    errors: [died],
  });
  expect(stored.state).toBe("ExecutionFailed");
  expect(stored.error).toContain("exited with code 143 (killed by signal 15, SIGTERM)");
});

test("a completed operator keeps its result when another part of the run fails", async () => {
  const stored = await executeAgainst({
    success: false,
    state: "Failed",
    operators: {
      source: {
        operatorId: "source",
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        resultMode: "table",
        result: [{ x: 1 }],
      },
    },
    errors: [died.replace("operator source", "operator other")],
  });
  expect(stored.state).toBe("Completed");
  expect(stored.error).toBeUndefined();
  expect(stored.result).toEqual([{ x: 1 }]);
});
