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
import { test, expect } from "bun:test";
import { assembleTaskContext } from "./task-context";
import { WorkflowState } from "../workflow-state";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";

test("task context keeps prior requests, removes past action replay, and selects actual ancestors", () => {
  const state = new WorkflowState();
  const op = (id: string, input?: string) => ({
    operatorID: id,
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: {
      type: "Project",
      properties: { keep: ["value"] },
      inputs: input ? [input] : [],
      version: "v2" as const,
    },
  });
  state.addOperator(op("source"));
  state.addOperator(op("total", "source"));
  state.addOperator(op("unrelated"));
  state.addLink({
    linkID: "s-t",
    source: { operatorID: "source", portID: "output-0" },
    target: { operatorID: "total", portID: "input-0" },
  });
  const steps: any[] = [
    { id: "u1", role: "user", messageId: "one", content: "Keep the original membership fixed", isBegin: true },
    {
      id: "a1",
      role: "agent",
      messageId: "one",
      content: "long historical reasoning NEVER_REPLAY_ME",
      toolCalls: [{ toolName: "dataflow", toolCallId: "c1", input: { operators: [] } }],
    },
    { id: "u2", role: "user", messageId: "two", content: "Update total", isBegin: true },
    {
      id: "a2",
      role: "agent",
      messageId: "two",
      content: "",
      toolCalls: [{ toolName: "dataflow", toolCallId: "c2", input: { operators: [], observe: ["total"] } }],
      toolResults: [
        {
          toolCallId: "c2",
          output: { kind: "native-batch", operators: [], observe: ["total"], observationErrors: [] },
        },
      ],
    },
  ];
  const storage = new WorkflowSnapshotStorage(() => []);
  storage.createSnapshot("a2", state.getWorkflowContent());
  const rendered = JSON.stringify(
    assembleTaskContext({
      visibleSteps: steps,
      workflowState: state,
      snapshotStorage: storage,
      settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "" },
      compilationResult: null,
    })
  );
  expect(rendered).toContain("Task 1");
  expect(rendered).toContain("Task 2");
  expect(rendered).toContain("Keep the original membership fixed");
  expect(rendered).not.toContain("NEVER_REPLAY_ME");
  const details = rendered.split("Selected dependency definitions")[1];
  expect(details).toContain("source");
  expect(details).toContain("total");
  expect(details).not.toContain("unrelated");
});
