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
import { operatorSignature, taskCatalogMemory, withTaskCatalog } from "./task-context";
import { TaskHistory } from "./task-history";
import { WorkflowState } from "../workflow-state";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { AgentMode, ContextMode, DEFAULT_AGENT_SETTINGS, type ReActStep } from "../../types/agent";
import type { ContextAssemblerInput } from "../llm-drivers/types";
import { assembleContext } from "../util/context-utils";

function fixture(): ContextAssemblerInput {
  const steps: ReActStep[] = (
    [
      { id: "u1", role: "user", messageId: "one", content: "Keep dollars and two decimals", isBegin: true },
      { id: "a1", parentId: "u1", role: "agent", messageId: "one", content: "OLD_ACTION_BODY" },
      { id: "f1", parentId: "a1", role: "agent", messageId: "one", content: "First answer", isEnd: true },
      { id: "u2", parentId: "f1", role: "user", messageId: "two", content: "Current request", isBegin: true },
      {
        id: "a2",
        parentId: "u2",
        role: "agent",
        messageId: "two",
        content: "Current reasoning",
        toolCalls: [
          { toolName: "dataflow", toolCallId: "real-call-id", input: { operators: [], observe: ["missing"] } },
        ],
        toolResults: [
          {
            toolCallId: "real-call-id",
            output: {
              kind: "native-batch",
              operators: [],
              observe: [],
              observationErrors: ["Cannot observe 'missing': operator does not exist."],
            },
          },
        ],
      },
    ] as Array<Partial<ReActStep> & Pick<ReActStep, "id" | "role" | "messageId" | "content">>
  ).map((step, index) => ({ stepId: index, timestamp: index, isBegin: false, isEnd: false, ...step }));
  const state = new WorkflowState();
  state.addOperator({
    operatorID: "source",
    operatorType: "DataLoading",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: { type: "Scan", version: "v2", properties: { files: "data/source.csv" }, inputs: [] },
  });
  return {
    visibleSteps: steps,
    workflowState: state,
    snapshotStorage: new WorkflowSnapshotStorage(id =>
      steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
    ),
    settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "", nativeTaskContext: true, agentMode: AgentMode.NATIVE },
    compilationResult: null,
    turnNumberByMessageId: new Map([
      ["one", 4],
      ["two", 8],
    ]),
  };
}

test("catalog memory preserves numbered requests and final answers, without completed action replay", () => {
  const input = fixture();
  const messages = taskCatalogMemory(input);
  expect(messages[0]).toEqual({ role: "user", content: "# Task 4\nKeep dollars and two decimals" });
  expect(messages[1]).toEqual({ role: "assistant", content: "First answer" });
  expect(JSON.stringify(messages)).not.toContain("OLD_ACTION_BODY");
  expect(JSON.stringify(messages)).not.toContain("Current reasoning");
  expect(JSON.stringify(messages)).not.toContain("providerOptions");
});

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  test(`catalog delegates active ${mode} actions, errors and tool ids to the shared renderer`, async () => {
    const input = fixture();
    input.settings.contextMode = mode;
    const assemble = (value: ContextAssemblerInput) =>
      assembleContext(value.visibleSteps, value.workflowState, value.snapshotStorage, value.settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: mode === ContextMode.DELTA ? "native" : "opBlock",
      });
    const active = assemble({ ...input, visibleSteps: input.visibleSteps.filter(s => s.messageId === "two") });
    const messages = await withTaskCatalog(assemble)(input);
    expect(messages.slice(-active.length)).toEqual(active);
    expect(JSON.stringify(messages)).not.toContain("OLD_ACTION_BODY");
    expect(JSON.stringify(messages)).toContain(mode === ContextMode.DELTA ? "Cannot observe" : "observation errors=1");
    if (mode === ContextMode.DELTA) expect(JSON.stringify(messages)).toContain("real-call-id");
  });
}

test("history availability includes deleted operators, without exposing retained file paths", async () => {
  const input = fixture();
  const history = new TaskHistory(async () => ({
    path: "/private/archive.arrow",
    sha256: "a".repeat(64),
    rowCount: 5,
  }));
  const op = {
    operatorID: "old",
    nativeOp: { type: "UDF", properties: { code: "def load(): pass" }, inputs: [], version: "v2" },
  } as any;
  const info = {
    state: "Completed",
    resultVersion: { id: "v1" },
    materialization: { executionId: "e1" },
    totalRowCount: 5,
  } as any;
  for (const task of [1, 2, 4]) await history.seal(task, [op], new Map([["old", info]]));
  const rendered = JSON.stringify(taskCatalogMemory(input, history));
  expect(rendered).toContain("old: 1-2,4");
  expect(rendered).not.toContain("/private/");
  expect(rendered).not.toContain("def load");
});

test("compact cards name historical inputs publicly and preserve the UDF arity", () => {
  const op = {
    operatorID: "mixed",
    nativeOp: {
      type: "UDF",
      properties: { code: "def process(current, original):\n    return current" },
      inputs: ["today", "task_archive_hidden"],
      taskInputs: ["today", { operator: "old", atTask: 4 }],
    },
  } as any;
  const signature = operatorSignature(op);
  expect(signature).toContain("udf(def process(current, original))");
  expect(signature).toContain("today, old@task4");
  expect(signature).not.toContain("task_archive_hidden");
});

test("a disabled catalog and initialization delegate the original input unchanged", async () => {
  for (const input of [fixture(), { ...fixture(), visibleSteps: [] }]) {
    if (input.visibleSteps.length) input.settings.nativeTaskContext = false;
    let seen: ContextAssemblerInput | undefined;
    const messages = [{ role: "user" as const, content: "unchanged" }];
    expect(
      await withTaskCatalog(value => {
        seen = value;
        return messages;
      })(input)
    ).toBe(messages);
    expect(seen).toBe(input);
  }
});
