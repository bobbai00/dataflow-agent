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
import Ajv from "ajv";
import { nativeBatchSchema } from "../tools/native-batch-tools";

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

test("catalog definitions use executable public syntax, including fixed inputs", () => {
  const state = new WorkflowState();
  const definitions = [
    { id: "source", type: "Scan", properties: { files: "data/a.csv" }, inputs: [] },
    {
      id: "eligible",
      type: "Filter",
      properties: { columns: ["value"], func: "def apply(row):\n    return row['value'] > 0" },
      inputs: ["source"],
    },
    {
      id: "mixed",
      type: "Join",
      properties: { on: "id" },
      inputs: ["source", "task_archive_hidden"],
      taskInputs: ["source", { operator: "eligible", atTask: 1 }],
    },
    { id: "combined", type: "Union", properties: {}, inputs: ["source", "eligible"] },
  ];
  for (const { id, ...nativeOp } of definitions)
    state.addOperator({
      operatorID: id,
      operatorType: "DataProcessing",
      operatorVersion: "1",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      nativeOp: { ...nativeOp, version: "v2" },
    });
  const messages = assembleTaskContext({
    visibleSteps: [{ id: "u1", role: "user", messageId: "one", content: "Continue", isBegin: true } as any],
    workflowState: state,
    snapshotStorage: new WorkflowSnapshotStorage(() => []),
    settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "" },
    compilationResult: null,
  });
  const catalog = messages.find(message => String(message.content).includes("Current operator catalog"))!;
  const specs = String(catalog.content)
    .split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line.split("; schema=")[0]!));
  const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2", { taskHistory: true }));
  expect(validate({ operators: specs })).toBe(true);
  expect(specs[1]).toMatchObject({ op: "filter", input: "source" });
  expect(specs[2]).toMatchObject({ op: "join", left: "source", right: { operator: "eligible", atTask: 1 } });
  expect(JSON.stringify(messages)).not.toContain("task_archive_hidden");
});

test("completed task messages form a stable prefix and observations end the active context", () => {
  const state = new WorkflowState();
  const steps: any[] = [
    { id: "u1", role: "user", messageId: "one", content: "First request", isBegin: true },
    { id: "a1", role: "agent", messageId: "one", content: "First answer", isEnd: true },
    { id: "u2", role: "user", messageId: "two", content: "Second request", isBegin: true },
    { id: "a2", role: "agent", messageId: "two", content: "Second answer", isEnd: true },
    { id: "u3", role: "user", messageId: "three", content: "Third request", isBegin: true },
    {
      id: "a3",
      role: "agent",
      messageId: "three",
      content: "",
      toolCalls: [{ toolName: "dataflow", toolCallId: "c3", input: { operators: [] } }],
      toolResults: [
        { toolCallId: "c3", output: { kind: "native-batch", operators: [], observe: [], observationErrors: [] } },
      ],
    },
  ];
  const storage = new WorkflowSnapshotStorage(() => []);
  storage.createSnapshot("a3", state.getWorkflowContent());
  const render = (visibleSteps: any[]) =>
    assembleTaskContext({
      visibleSteps,
      workflowState: state,
      snapshotStorage: storage,
      settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "" },
      compilationResult: null,
    });
  const second = render(steps.slice(0, 3));
  const third = render(steps);
  expect(third.slice(0, 2)).toEqual(second.slice(0, 2));
  expect(third[0]).toMatchObject({ role: "user", content: "# Task 1\nFirst request" });
  expect(third[1]).toMatchObject({ role: "assistant", content: "First answer" });
  expect(third.at(-1)?.role).toBe("tool");
});

test("an unchanged operator's card is byte-identical as its saved task range advances", () => {
  const state = new WorkflowState();
  for (const [id, type, inputs] of [
    ["source", "Scan", []],
    ["eligible", "Filter", ["source"]],
    ["totals", "Aggregate", ["eligible"]],
  ] as const)
    state.addOperator({
      operatorID: id,
      operatorType: "DataProcessing",
      operatorVersion: "1",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      nativeOp: { type, properties: {}, inputs: [...inputs], version: "v2" },
    });
  const render = (upTo: number) =>
    assembleTaskContext(
      {
        visibleSteps: [{ id: "u1", role: "user", messageId: "one", content: "Next", isBegin: true } as any],
        workflowState: state,
        snapshotStorage: new WorkflowSnapshotStorage(() => []),
        settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "" },
        compilationResult: null,
      },
      {
        available: () => Array.from({ length: upTo }, (_, i) => i + 1),
        catalog: () => [],
      } as any
    ).find(message => String(message.content).startsWith("# Current operator catalog"))!.content as string;
  const [after3, after4] = [render(3), render(4)];
  const cards = (text: string) => text.split("\n").filter(line => line.startsWith("{"));
  // The range advances on every task for every operator. Held inside the cards
  // it changed the text of every card each request, including operators nobody
  // had touched, and made the block longer for no added information.
  expect(cards(after4)).toEqual(cards(after3));
  expect(cards(after3).join("\n")).toContain("totals");
  expect(cards(after3).join("\n")).not.toContain("saved tasks");
  // The ranges themselves still advance, in one block after the cards.
  expect(after3).toContain("# Saved task outputs");
  expect(after3).toContain("source: 1-3");
  expect(after4).toContain("source: 1-4");
});
