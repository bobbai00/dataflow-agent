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
import { expect, test } from "bun:test";
import { batchObservedIds } from "../tools/native-batch-tools";
import { buildPath } from "../util/context-utils";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import { entryTable, profileFacts, renderTaskEntry, type TaskEntry } from "./task-entries";
import { selectNativeObservation } from "./evidence";
import { nativeTestTools } from "./test-support";
import { TexeraAgent } from "../texera-agent";
import { withTaskCatalog } from "./task-context";
import { DEFAULT_AGENT_SETTINGS, AgentMode } from "../../types/agent";

test("a task-only path starts from its parent snapshot, including unchanged old errors", () => {
  const steps = [
    { id: "prior", role: "agent", messageId: "one" },
    { id: "user", parentId: "prior", role: "user", messageId: "two", isBegin: true },
    { id: "action", parentId: "user", role: "agent", messageId: "two" },
  ] as any[];
  const storage = new WorkflowSnapshotStorage(id =>
    steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
  );
  const state = new WorkflowState();
  const parent = storage.createSnapshot("prior", state.getWorkflowContent());
  storage.setOperatorResult("prior", "old_failure", { error: "unchanged old failure" } as any);
  storage.createSnapshot("action", state.getWorkflowContent());
  const path = buildPath(steps.slice(1), storage);
  expect(path.initSnapshot).toBe(parent);
  expect(path.path.map(n => n.step.id)).toEqual(["user", "action"]);
});

test("a rejected or thrown native call retains its requested observation scope", () => {
  for (const observe of [undefined, [], ["answer"]]) {
    const step = {
      toolCalls: [{ toolName: "dataflow", toolCallId: "bad", input: { recall: [1, 2, 3, 4], observe } }],
      toolResults: [{ toolCallId: "bad", output: "[ERROR] Too many tasks", isError: true }],
    };
    expect(batchObservedIds(step)).toEqual(new Set(observe ?? []));
  }
  expect(batchObservedIds({ toolCalls: [{ toolName: "other", toolCallId: "x", input: {} }] })).toBeUndefined();
});

const fn = 'def score(rows):\n    return rows.assign(score=rows["x"] / 7.0)';
const entry: TaskEntry = {
  task: 3,
  request: "Use the full population; retain exact precision and original missingness.",
  changes: [
    {
      id: "scores",
      status: "modified",
      statement: 'scores = process(all_rows, fn=score, doc="Keep full population")',
      doc: "Keep full population",
      functions: [fn],
      rows: 14,
      columns: ["x", "score"],
      replaces: 1,
      call: 0,
      step: "Normalize using all rows.",
    },
    {
      id: "ordered",
      status: "added",
      statement: 'ordered = sort(scores, by=[("score", "desc")])',
      rows: 14,
      columns: ["x", "score"],
      call: 0,
      step: "Normalize using all rows.",
    },
    {
      id: "scenario",
      status: "added",
      statement: "scenario = process(other_rows, fn=score)",
      functions: [fn],
      rows: 2,
      columns: ["x", "score"],
      call: 1,
      step: "Compare an independent population.",
    },
  ],
  tables: [
    {
      id: "scores",
      total: 14,
      complete: false,
      text: "x\tscore\n0\t7\t1.0000000000000002\n1\t6\t0.8571428571428571\n2\t5\t0.7142857142857143",
    },
    {
      id: "ordered",
      total: 14,
      complete: false,
      text: "x\tscore\n0\t7\t1.0000000000000002\n1\t6\t0.8571428571428571\n2\t5\t0.7142857142857143",
    },
  ],
  answer: '{"score":1.0000000000000002}',
  from: ["scores"],
};

test("compact entries retain contracts, exact code, values and version facts while sharing exact duplicates", () => {
  const before = renderTaskEntry(entry);
  const after = renderTaskEntry(entry, true);
  expect(after.length).toBeLessThan(before.length * 0.9);
  for (const text of [
    entry.request,
    entry.answer,
    fn,
    "replaces task 1",
    "rows=14",
    "Compare an independent population.",
    "0.8571428571428571",
  ])
    expect(after).toContain(text);
  expect(after.match(/def score\(/g)).toHaveLength(1);
  expect(after).toContain("same displayed rows as scores");
  expect(renderTaskEntry(entry)).toBe(before);
});

test("small complete results can use bounded slack, without claiming a truncated sample is complete", () => {
  const state = new WorkflowState();
  const info = {
    totalRowCount: 15,
    truncated: false,
    resultSchema: [{ name: "label", type: "str" }],
    result: Array.from({ length: 15 }, (_, i) => ({ label: `industry_${i}_${"x".repeat(50)}` })),
  } as any;
  const context = {
    op: { operatorID: "answer", nativeOp: { type: "Process", inputs: [], properties: {} } } as any,
    workflow: state.getWorkflowContent(),
    resolveInput: () => undefined,
    info,
    data: false,
    flow: false,
    maxChars: 700,
    completeSmallTableChars: 1400,
  };
  expect(selectNativeObservation(context).selected).toContain("table.complete");
  expect(selectNativeObservation({ ...context, info: { ...info, truncated: true } }).selected).not.toContain(
    "table.complete"
  );
  expect(selectNativeObservation({ ...context, maxRows: 5 }).selected).not.toContain("table.complete");
});

test("repeated inspection references visible identical text, but changed definitions and new tasks remain readable", async () => {
  let task = "one";
  const { state, tools } = nativeTestTools(undefined, {
    settings: { nativeAnalysisState: true, nativeTaskEfficiency: true },
    activeTaskId: () => task,
  } as any);
  await tools.dataflow.execute({ edits: 'source = scan("data/test.csv")' });
  const read = () => tools.dataflow.execute({ inspect: ["source"] });
  const first = await read();
  const second = await read();
  expect(first.inspection[0]).toContain("Definition source");
  expect(second.inspection[0]).toContain("Already shown in this task");
  expect(second.inspection[0].length).toBeLessThan(first.inspection[0].length);
  await tools.dataflow.execute({ edits: 'source = scan("data/other.csv")' });
  expect((await read()).inspection[0]).toContain("data/other.csv");
  task = "two";
  expect((await read()).inspection[0]).toContain("data/other.csv");
  expect(state.getAllOperators()).toHaveLength(1);
});

test("efficient history remains a byte-stable prefix and keeps definitions instead of selecting them away", async () => {
  const history = { entries: () => [entry], provenance: () => new Map() } as any;
  const decorated = withTaskCatalog(input => [{ role: "user", content: String(input.visibleSteps.length) }], history);
  const input = {
    settings: {
      ...DEFAULT_AGENT_SETTINGS,
      agentMode: AgentMode.NATIVE,
      nativeTaskHistory: true,
      nativeTaskContext: true,
      nativeAnalysisState: true,
      nativeTaskEfficiency: true,
    },
    visibleSteps: [{ id: "u", messageId: "m", role: "user", isBegin: true, content: "Next" }],
    workflowState: new WorkflowState(),
    snapshotStorage: new WorkflowSnapshotStorage(() => []),
    compilationResult: null,
  } as any;
  const first = await decorated(input);
  input.visibleSteps.push({ id: "a", messageId: "m", role: "agent", content: "Action" });
  const second = await decorated(input);
  expect(first[0].content).toContain(fn);
  expect(second[0]).toEqual(first[0]);
  expect(first[0].providerOptions).toEqual({ texera: { taskHistory: true } });
});

test("efficiency format cannot change inside an existing session", async () => {
  const agent = new TexeraAgent({
    agentId: "efficiency-setting",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
  agent.updateSettings({
    nativeTaskHistory: true,
    nativeTaskContext: true,
    nativeAnalysisState: true,
    nativeTaskEfficiency: true,
  });
  expect(agent.getSettings().nativeTaskEfficiency).toBe(true);
  (agent as any).delegateConfig = { userToken: "test", workflowId: 1, computingUnitId: 2 };
  expect((agent as any).buildExecutionConfig().maxOperatorResultCharLimit).toBe(4000);
  (agent as any).stepsById.set("u", { id: "u", role: "user", isBegin: true });
  expect(() => agent.updateSettings({ nativeTaskEfficiency: false })).toThrow("fresh session");
});

test("explicit compaction keeps repeated definitions self-contained", async () => {
  const { tools } = nativeTestTools(undefined, {
    settings: {
      nativeAnalysisState: true,
      nativeTaskEfficiency: true,
      enableCompactTool: true,
    },
    activeTaskId: () => "task-one",
  } as any);
  await tools.dataflow.execute({ edits: 'source = scan("data/test.csv")' });
  const first = await tools.dataflow.execute({ inspect: ["source"] });
  const second = await tools.dataflow.execute({ inspect: ["source"] });
  expect(first.inspection[0]).toContain("Definition source");
  expect(second.inspection[0]).toBe(first.inspection[0]);
});

test("compact entries retain categorical facts when row rendering hides a literal NULL", () => {
  const table = entryTable("labels", {
    totalRowCount: 1,
    result: [{ category: "NULL" }],
    resultSchema: [{ name: "category", type: "str" }],
  } as any)!;
  expect(table.text).toContain("NaN");
  const entry = {
    task: 1,
    request: "Keep category labels exact.",
    answer: '{"count":1}',
    from: ["labels"],
    changes: [
      {
        id: "labels",
        status: "added",
        statement: 'labels = parameters(category="NULL")',
        rows: 1,
        columns: ["category"],
        values: [["category", [["NULL", 1]]]],
      },
    ],
    tables: [table],
  } as any;
  expect(renderTaskEntry(entry, true)).toContain("values: category = NULL 1");
});

test("small-table slack never lowers an explicitly larger result budget", () => {
  const agent = new TexeraAgent({
    agentId: "efficiency-budget",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
  agent.updateSettings({
    nativeTaskHistory: true,
    nativeTaskContext: true,
    nativeAnalysisState: true,
    nativeTaskEfficiency: true,
  });
  (agent as any).delegateConfig = { userToken: "test", workflowId: 1, computingUnitId: 2 };
  for (const [requested, expected] of [
    [1000, 2000],
    [2000, 4000],
    [4000, 5000],
    [10000, 10000],
  ]) {
    agent.updateSettings({ maxOperatorResultCharLimit: requested });
    expect((agent as any).buildExecutionConfig().maxOperatorResultCharLimit).toBe(expected);
  }
});

test("a literal NULL cannot make a real missing count look redundant", () => {
  const info = {
    totalRowCount: 2,
    result: [{ category: null }, { category: "NULL" }],
    resultSchema: [{ name: "category", type: "str" }],
    tableProfile: {
      status: "available",
      coverage: { complete: true },
      columns: {
        category: {
          type: "str",
          nullCount: 1,
          frequencies: { truncated: false, otherCount: 0, values: [{ value: { value: "NULL" }, count: 1 }] },
        },
      },
    },
  } as any;
  const facts = profileFacts(info);
  expect(facts.values).toBeUndefined();
  const task: TaskEntry = {
    task: 1,
    request: "Keep missing values separate from literal categories.",
    answer: "One real missing value.",
    from: ["labels"],
    changes: [{ id: "labels", status: "added", statement: "labels = process(fn=load)", ...facts }],
    tables: [entryTable("labels", info)!],
  };
  expect(renderTaskEntry(task, true)).toContain("missing: category=1");
});
