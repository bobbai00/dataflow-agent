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
import { operatorSignature, TASK_CATALOG_HEADING, taskCatalogMemory, withTaskCatalog } from "./task-context";
import type { ModelMessage } from "ai";
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
    nativeOp: {
      type: "Scan",
      properties: { files: "data/source.csv" },
      inputs: [],
      source: 'source = scan("data/source.csv")',
    },
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
    // The active turn is delegated unchanged and follows the catalog, so every
    // call of the turn extends the previous call's prompt.
    const catalogAt = messages.findIndex(m => String(m.content).startsWith(TASK_CATALOG_HEADING));
    expect(catalogAt).toBe(messages.length - active.length - 1);
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
  // Events, not a span: a span has to be rewritten every task, and it would
  // also claim task 3 holds a version of `old`, which it does not.
  // Task 3 was never sealed, so no version of anything exists at 3 and the line
  // states only the events: created once, last retained at 4.
  expect(rendered).toContain("old = no longer in the graph; created@1; last saved@4");
  expect(rendered).not.toContain("old: 1-2,4");
  expect(rendered).not.toContain("/private/");
  expect(rendered).not.toContain("def load");
});

test("a catalog line states creation and edits once, and does not change while the operator does not", async () => {
  const input = fixture();
  const retain = async () => ({ path: "/tmp/a.arrow", sha256: "a".repeat(64), rowCount: 1 });
  const history = new TaskHistory(retain);
  const view = (revision: string) => ({
    operatorID: "report",
    nativeOp: { type: "UDF", properties: { code: "def load(): pass" }, inputs: [], version: "v2", revision },
  });
  const info = {
    state: "Completed",
    resultVersion: { id: "v1" },
    materialization: { executionId: "e1" },
    totalRowCount: 1,
  } as any;
  for (const [task, revision] of [
    [1, "aaaa"],
    [2, "aaaa"],
    [3, "bbbb"],
    [4, "bbbb"],
  ] as Array<[number, string]>)
    await history.seal(task, [view(revision) as any], new Map([["report", info]]));
  const line = history.provenance().get("report")!;
  expect(line).toEqual({ created: 1, edited: [3], lastSaved: 4, gaps: [] });
  // The operator leaves the graph: task 5 seals without it. Its line is final.
  const before = JSON.stringify(taskCatalogMemory(input, history));
  await history.seal(5, [], new Map());
  expect(JSON.stringify(taskCatalogMemory(input, history))).toBe(before);
  // A task sealed in between that holds no version of it is a permanent gap,
  // so a later reader cannot assume the span is unbroken.
  const gapped = new TaskHistory(retain);
  await gapped.seal(1, [view("aaaa") as any], new Map([["report", info]]));
  await gapped.seal(2, [], new Map());
  await gapped.seal(3, [view("aaaa") as any], new Map([["report", info]]));
  expect(gapped.provenance().get("report")).toEqual({ created: 1, edited: [], lastSaved: 3, gaps: [2] });
  expect(JSON.stringify(taskCatalogMemory(input, gapped))).toContain("created@1 not saved@2; last saved@3");
});

test("a catalog line is the statement as written, and never names a saved table by its internal id", () => {
  // What the program tool produces: the statement text, internal ids in `inputs`.
  const written = {
    operatorID: "mixed",
    nativeOp: {
      type: "Process",
      properties: {},
      inputs: ["today", "task_archive_hidden"],
      taskInputs: ["today", { operator: "old", atTask: 4 }],
      source: "mixed = process(today, at(old, task=4), fn=compare)",
      functions: { compare: "def compare(current, original):\n    return current" },
    },
  } as any;
  expect(operatorSignature(written)).toBe("mixed = process(today, at(old, task=4), fn=compare)");
  // A view with no statement text still names the saved input publicly.
  const bare = { ...written, nativeOp: { ...written.nativeOp, source: undefined } };
  expect(operatorSignature(bare)).toBe("mixed = Process(today, at(old, task=4))");
  for (const view of [written, bare]) expect(operatorSignature(view)).not.toContain("task_archive");
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

test("the catalog is rendered once per task: later calls reuse it, the next task sees the new graph", async () => {
  const input = fixture();
  const decorated = withTaskCatalog(() => [{ role: "user" as const, content: "active" }]);
  const catalogOf = (messages: ModelMessage[]) =>
    String(messages.find(m => String(m.content).startsWith(TASK_CATALOG_HEADING))!.content);
  const first = catalogOf(await decorated(input));
  expect(first).toContain('source = scan("data/source.csv")');
  input.workflowState.addOperator({
    operatorID: "positive",
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: {
      type: "Filter",
      properties: {},
      inputs: ["source"],
      source: 'positive = filter(source, lambda row: row["x"] > 0)',
    },
  });
  // Same task: the table the task just added is in its observations, not here.
  const second = catalogOf(await decorated(input));
  expect(second).toBe(first);
  expect(second).not.toContain("positive");
  // A new task begins from the graph as it now stands.
  input.visibleSteps.push({
    id: "u3",
    parentId: "a2",
    role: "user",
    messageId: "three",
    content: "Next request",
    isBegin: true,
    isEnd: false,
    stepId: 9,
    timestamp: 9,
  } as ReActStep);
  expect(catalogOf(await decorated(input))).toContain('positive = filter(source, lambda row: row["x"] > 0)');
});
