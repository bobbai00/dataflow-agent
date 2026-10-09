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
import { WorkflowState } from "./workflow-state";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { planGraphEdit } from "./tools/graph-edits";
import { buildTaskGraph, renderTaskIndex, taskHistoryFromSteps, type TaskReference } from "./task-history";
import type { ReActStep } from "../types/agent";
import { forkState } from "./state-history";
import { describeOperator, operatorBlock, type ObservationFormatOptions } from "./native/observation-format";
import { resultScope } from "./native/result-scope";

async function fixture() {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const graph = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    'create operator source: scan("data.csv")',
    { metadataStore }
  );
  const ids = ["s1", "s2", "s3"];
  const storage = new WorkflowSnapshotStorage(id => ids.slice(0, ids.indexOf(id) + 1));
  for (const id of ids) storage.createSnapshot(id, graph.workflow);
  storage.setOperatorResult("s1", "source", {
    state: "Completed",
    inputTuples: 0,
    outputTuples: 2,
    totalRowCount: 2,
    result: [{ x: 1 }, { x: 2 }],
    resultMode: "table",
    resultSchema: [{ name: "x", type: "int64", encoding: "" }],
  });
  const reference = (kind: TaskReference["kind"] = "compute", extra = {}): TaskReference => ({
    actionIndex: 1,
    kind,
    operatorId: "source",
    producingStepId: "s1",
    operatorRevision: graph.workflow.operators[0].nativeOp!.revision,
    ...extra,
  });
  const end = (n: number, references: TaskReference[] = []): ReActStep => ({
    id: `s${n}`,
    messageId: `m${n}`,
    stepId: n,
    timestamp: n,
    role: "agent",
    content: `answer ${n}`,
    isBegin: false,
    isEnd: true,
    toolResults: [
      {
        toolCallId: `call${n}`,
        output: {
          kind: "dataflow-actions",
          status: "completed",
          answer: `answer ${n}`,
          actions: [{ index: 1, action: { type: "execute", operator_ids: ["source"] }, status: "ok" }],
          references,
          operators: [],
          observe: [],
          observationErrors: [],
        },
      },
    ],
  });
  const task = (n: number, references: TaskReference[] = []) => ({
    taskId: n,
    stepId: `s${n}`,
    request: `question ${n}`,
    answer: `answer ${n}`,
    steps: [end(n, references)],
    status: "answered" as const,
  });
  return { storage, task, reference, end, graph };
}

test("task dependencies follow the original producer, not each snapshot inheriting its result", async () => {
  const { storage, task, reference } = await fixture();
  const graph = buildTaskGraph(storage, [task(1), task(2), task(3, [reference()])]);
  expect(graph[2].dependencies.map(d => d.task_id)).toEqual([1]);
  expect(graph[2].dependencies[0].references[0].operator_id).toBe("source");
});

test("new definitions in the current task are not reported as unknown earlier-task provenance", async () => {
  const { storage, task, reference } = await fixture();
  const graph = buildTaskGraph(storage, [task(1, [reference("definition")])]);
  expect(graph[0].dependencies).toEqual([]);
  expect(graph[0].unresolved_references).toBe(0);
});

test("historical consultation is distinct from computation", async () => {
  const { storage, task, reference } = await fixture();
  const graph = buildTaskGraph(storage, [task(1), task(2, [reference("consultation", { savedTaskId: 1 })])]);
  expect(graph[1].dependencies).toEqual([]);
  expect(graph[1].consulted_tasks).toEqual([1]);
});

test("an upstream recomputation changes data provenance even when its operator revision does not", async () => {
  const { storage, task, reference } = await fixture();
  const graph = buildTaskGraph(storage, [task(1), task(2), task(3, [reference("compute", { producingStepId: "s2" })])]);
  expect(graph[2].dependencies.map(d => d.task_id)).toEqual([2]);
});

test("explicit saved-task references preserve forks and restores under new IDs", async () => {
  const { storage, task, reference } = await fixture();
  const graph = buildTaskGraph(storage, [
    task(1),
    task(2),
    task(3, [reference("definition", { savedTaskId: 1, operatorId: "old_source" })]),
  ]);
  expect(graph[2].dependencies.map(d => d.task_id)).toEqual([1]);
});

test("skipped actions and unknown provenance do not fabricate dependency edges", async () => {
  const { storage, task, reference } = await fixture();
  const second = task(2, [reference()]);
  (second.steps[0].toolResults![0].output as any).actions[0].status = "skipped";
  const third = task(3, [reference("read", { producingStepId: "missing", operatorRevision: undefined })]);
  expect(
    buildTaskGraph(storage, [task(1), second, third])
      .slice(1)
      .every(t => t.dependencies.length === 0)
  ).toBe(true);
});

test("partial execution failures retain dependencies of independently completed operators", async () => {
  const { storage, task, reference } = await fixture();
  const second = task(2, [reference()]);
  (second.steps[0].toolResults![0].output as any).actions[0].status = "error";
  expect(buildTaskGraph(storage, [task(1), second])[1].dependencies.map(d => d.task_id)).toEqual([1]);
});

test("loaded-task offsets apply to every request without numbering the seed", async () => {
  const { storage, end } = await fixture();
  const user: ReActStep = {
    id: "u1",
    messageId: "m1",
    stepId: 1,
    timestamp: 1,
    role: "user",
    content: "next question",
    isBegin: true,
    isEnd: false,
  };
  expect(taskHistoryFromSteps([user, end(1)], storage, undefined, 4)[0].taskId).toBe(5);
});

test("read-only task indexes contain questions, answers and references without record dumps", async () => {
  const { storage, task, reference } = await fixture();
  const text = renderTaskIndex(buildTaskGraph(storage, [task(1), task(2, [reference()])]));
  expect(text).toContain("question 1");
  expect(text).toContain("answer 2");
  expect(text).toContain("task 1");
  expect(text).not.toContain('scan("data.csv")');
  expect(text).not.toContain("x: 1");
});

test("read-only task cards show parent task IDs without inventing operator edits", async () => {
  const { storage, task, reference } = await fixture();
  const text = renderTaskIndex(buildTaskGraph(storage, [task(1), task(2, [reference()])]));
  expect(text).toContain("Dependencies: task 1");
  expect(text).not.toContain("Operators:");
  expect(text).not.toContain("via source");
  expect(text).not.toContain("[compute");
});

test("task catalogs show edited operators in canonical blocks before the answer", async () => {
  const { storage, task, graph } = await fixture();
  const first = task(1);
  const receipt = first.steps[0].toolResults![0].output as any;
  receipt.actions.unshift({
    index: 0,
    action: { type: "edit", changes: 'create operator source: scan("data.csv")' },
    status: "ok",
    output: { operator_blocks: [{ id: "source", state: "created" }] },
  });
  const text = renderTaskIndex(buildTaskGraph(storage, [first]));
  const expected = operatorBlock(
    describeOperator(graph.workflow.operators[0], storage.getOperatorResult("s1", "source"), {
      state: "created",
      implementation: false,
    })
  );
  expect(text).toContain(expected);
  expect(text.indexOf("Question:")).toBeLessThan(text.indexOf("Operators:"));
  expect(text.indexOf("Operators:")).toBeLessThan(text.indexOf("Answer:"));
  expect(text).not.toContain("x: 1");
});

test("catalog blocks keep declarations and edit order with process bodies on demand", async () => {
  const { storage, task, graph } = await fixture();
  const metadataStore = WorkflowSystemMetadata.getInstance();
  const plan = await planGraphEdit(
    graph.workflow,
    'create operator scores: process(fn=score_rows, doc="Complete working scores")\n' +
      "    def score_rows(df):\n        return df.assign(score=df.x * 2)\n" +
      "create edge source.out -> scores.in\n" +
      "create operator report: limit(5)\ncreate edge scores.out -> report.in",
    { metadataStore }
  );
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.createSnapshot("s2", plan.workflow);
  const second = task(2);
  const receipt = second.steps[0].toolResults![0].output as any;
  receipt.actions = [
    {
      index: 1,
      action: { type: "edit", changes: "recorded edit" },
      status: "ok",
      output: {
        operator_blocks: [
          { id: "scores", state: "created" },
          { id: "report", state: "created" },
        ],
      },
    },
  ];
  const text = renderTaskIndex(buildTaskGraph(storage, [second]));
  expect(text).toContain('process(fn=score_rows, doc="Complete working scores")');
  // The definition names the function; its signature and body are read on demand.
  expect(text).not.toContain("signature:");
  expect(text).not.toContain("return df.assign(score=df.x * 2)");
  expect(text).toContain("inputs: `source`");
  expect(text).toContain("inputs: `scores`");
  expect(text.indexOf("**scores**")).toBeLessThan(text.indexOf("**report**"));
  expect(text).not.toContain("**source**");
  expect(text).not.toContain('scan("data.csv")');
});

test("command receipt order wins over topologically sorted edit blocks", async () => {
  const { storage, task, graph } = await fixture();
  const secondGraph = await planGraphEdit(
    graph.workflow,
    'create operator report: limit(5)\ncreate operator scores: project(keep=["x"])\n' +
      "create edge source.out -> scores.in\ncreate edge scores.out -> report.in",
    { metadataStore: WorkflowSystemMetadata.getInstance() }
  );
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.createSnapshot("s2", secondGraph.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      action: { type: "edit", changes: "recorded edit" },
      status: "ok",
      output: {
        changes: secondGraph.changes,
        operator_blocks: [
          { id: "scores", state: "created" },
          { id: "report", state: "created" },
        ],
      },
    },
  ];
  const text = renderTaskIndex(buildTaskGraph(storage, [second]));
  expect(text.indexOf("**report**")).toBeLessThan(text.indexOf("**scores**"));
});

test("repeated edits show one final saved definition without following the live graph", async () => {
  const { storage, task, graph, end } = await fixture();
  const metadataStore = WorkflowSystemMetadata.getInstance();
  const secondGraph = await planGraphEdit(graph.workflow, 'update operator source: scan("second.csv")', {
    metadataStore,
  });
  const thirdGraph = await planGraphEdit(secondGraph.workflow, 'update operator source: scan("live.csv")', {
    metadataStore,
  });
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.createSnapshot("s2", secondGraph.workflow);
  storage.createSnapshot("s3", thirdGraph.workflow);
  const first = task(1);
  first.steps = [first.steps[0], { ...end(2), messageId: "m1" }];
  first.stepId = "s2";
  for (const [index, step] of first.steps.entries()) {
    const receipt = step.toolResults![0].output as any;
    receipt.actions = [
      {
        index: 1,
        action: { type: "edit", changes: "recorded edit" },
        status: "ok",
        output: { operator_blocks: [{ id: "source", state: index ? "updated" : "created" }] },
      },
    ];
  }
  const text = renderTaskIndex(buildTaskGraph(storage, [first]));
  expect(text.match(/\*\*source\*\*/g)).toHaveLength(1);
  expect(text).toContain("(scan, created)");
  expect(text).toContain('scan("second.csv")');
  expect(text).not.toContain('scan("data.csv")');
  expect(text).not.toContain('scan("live.csv")');
});

test("failed and skipped edits do not publish operator blocks", async () => {
  const { storage, task } = await fixture();
  for (const status of ["error", "skipped"]) {
    const first = task(1);
    const receipt = first.steps[0].toolResults![0].output as any;
    receipt.actions = [
      {
        index: 1,
        action: { type: "edit", changes: "rejected edit" },
        status,
        output: { operator_blocks: [{ id: "source", state: "created" }] },
      },
    ];
    expect(renderTaskIndex(buildTaskGraph(storage, [first]))).not.toContain("**source**");
  }
});

test("deleted operators remain tombstones rather than live definitions", async () => {
  const { storage, task, graph } = await fixture();
  const deleted = await planGraphEdit(graph.workflow, "delete operator source", {
    metadataStore: WorkflowSystemMetadata.getInstance(),
  });
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.createSnapshot("s2", deleted.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      action: { type: "edit", changes: "delete operator source" },
      status: "ok",
      output: { operators: deleted.operators, changes: deleted.changes },
    },
  ];
  const text = renderTaskIndex(buildTaskGraph(storage, [second]));
  expect(text).toContain("**source** (scan, deleted)");
  expect(text).not.toContain("definition:");
});

test("catalog definitions remain complete and failed results expose no rows", async () => {
  const { storage, task, graph } = await fixture();
  const definition = `scan("${"long_path_".repeat(220)}data.csv")`;
  const workflow = {
    ...graph.workflow,
    operators: graph.workflow.operators.map(op => ({ ...op, nativeOp: { ...op.nativeOp!, source: definition } })),
  };
  storage.clear();
  storage.createSnapshot("s1", workflow);
  storage.setOperatorResult("s1", "source", {
    state: "Failed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
    error: "PRIVATE_FAILURE_DETAIL",
    result: [{ x: "PRIVATE_SAMPLE" }],
  });
  const first = task(1);
  (first.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      action: { type: "edit", changes: "recorded edit" },
      status: "ok",
      output: { operator_blocks: [{ id: "source", state: "created" }] },
    },
  ];
  const text = renderTaskIndex(buildTaskGraph(storage, [first], { catalogStatistics: true }));
  expect(text).toContain(definition);
  expect(text).toContain("- result: failed");
  expect(text).not.toContain("PRIVATE_SAMPLE");
  expect(text).not.toContain("PRIVATE_FAILURE_DETAIL");
});

test("fork receipts expose copied operators while edge-only edits show changed inputs", async () => {
  const { storage, task } = await fixture();
  const first = task(2);
  const receipt = first.steps[0].toolResults![0].output as any;
  receipt.actions = [
    {
      index: 1,
      action: { type: "fork", task_id: 1, operator_id: "prior", new_operator_id: "source" },
      status: "ok",
      output: { operators: [{ id: "source", op: "scan", status: "added" }] },
    },
  ];
  expect(renderTaskIndex(buildTaskGraph(storage, [first]))).toContain("**source**");
  receipt.actions[0] = {
    index: 1,
    action: { type: "edit", changes: "create edge parent.out -> source.in" },
    status: "ok",
    output: { operator_blocks: [{ id: "source", state: "reconnected" }] },
  };
  expect(renderTaskIndex(buildTaskGraph(storage, [first]))).toContain("(scan, reconnected)");
});

test("catalog statistics describe the saved task and never expose result rows", async () => {
  const { storage, task } = await fixture();
  const earlier = buildTaskGraph(storage, [task(1)], { catalogStatistics: true });
  expect(renderTaskIndex(earlier)).toContain("- **source** (scan, referenced)");
  expect(renderTaskIndex(earlier)).toContain("- result: 2 rows × 1 column");
  storage.setOperatorResult("s2", "source", {
    state: "Completed",
    inputTuples: 0,
    outputTuples: 9,
    totalRowCount: 9,
    resultMode: "table",
    result: [{ x: "PRIVATE_SAMPLE" }],
    resultSchema: [{ name: "x", type: "str", encoding: "" }],
  });
  const later = buildTaskGraph(storage, [task(1), task(2)], { catalogStatistics: true });
  expect(later[0].operators[0].result_summary).toBe(earlier[0].operators[0].result_summary);
  expect(renderTaskIndex(later)).toContain("- result: 9 rows × 1 column");
  expect(renderTaskIndex(later)).not.toContain("PRIVATE_SAMPLE");
  expect(renderTaskIndex(buildTaskGraph(storage, [task(1), task(2)]))).not.toContain("Referenced results:");
});

test("catalog omits repeated checkpoint headers and generic process scope", async () => {
  const { storage, task, graph } = await fixture();
  const plan = await planGraphEdit(
    graph.workflow,
    `create operator prepared: process(fn=prepare, doc="Normalize measurements")
    def prepare(source):
        return source
create operator selected: limit(2)
create edge source.out -> prepared.in[0]
create edge prepared.out -> selected.in`,
    { metadataStore: WorkflowSystemMetadata.getInstance() }
  );
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.createSnapshot("s2", plan.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    { index: 1, status: "ok", action: { type: "edit", changes: "recorded edit" }, output: plan },
  ];
  const record = buildTaskGraph(storage, [task(1), second], { catalogStatistics: true })[1];
  const text = renderTaskIndex([record]);
  expect(text).toContain("- **prepared** (process, created)");
  expect(text).toContain("- **selected** (limit, created)");
  expect(text).not.toContain("row selection inside Python is unknown");
  expect(text).not.toMatch(/^- \*\*.*version at end of task/m);
  // A limit's definition already says what it selects; entries carry no scope lines.
  expect(text).toContain("definition: `limit(2)`");
  expect(text).not.toContain("scope:");
  // General inspection still exposes Python's opaque selection boundary.
  const prepared = plan.workflow.operators.find(op => op.operatorID === "prepared")!;
  expect(
    resultScope(
      prepared,
      plan.workflow,
      () => undefined,
      id => id,
      false
    ).join("\n")
  ).toContain("row selection inside Python is unknown");
});

test("declared answer sources exclude exploratory reads and preserve read-time snapshots", async () => {
  const { storage, task, reference } = await fixture();
  const first = task(1);
  const receipt = first.steps[0].toolResults![0].output as any;
  receipt.actions = [
    { index: 1, status: "ok", action: { type: "retrieve", operator_id: "probe", view: "sample" } },
    { index: 2, status: "ok", action: { type: "answer", content: "2", operator_ids: ["source"] } },
  ];
  receipt.references = [
    reference("read", { operatorId: "probe", readStepId: "s1" }),
    reference("read", { actionIndex: 2, readStepId: "s1" }),
  ];
  const output = buildTaskGraph(storage, [first])[0].output_roots!;
  expect(output.basis).toBe("answer");
  expect(output.roots.map(r => r.operator_id)).toEqual(["source"]);
  expect(output.roots[0].step_id).toBe("s1");
});

test("observed reads are labelled candidates and superseded reads are excluded", async () => {
  const { storage, task, reference } = await fixture();
  const first = task(1);
  const receipt = first.steps[0].toolResults![0].output as any;
  receipt.actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "retrieve", operator_id: "source", view: "sample" },
      output: { superseded_in_call: true },
    },
  ];
  receipt.references = [reference("read", { readStepId: "s1" })];
  expect(buildTaskGraph(storage, [first])[0].output_roots!.basis).toBe("unknown");
  delete receipt.actions[0].output.superseded_in_call;
  expect(buildTaskGraph(storage, [first])[0].output_roots!.basis).toBe("observed_reads");
});

test("history numbering preserves requests without an agent action and excludes seed steps", async () => {
  const { storage, end } = await fixture();
  const user = (n: number): ReActStep => ({
    id: `u${n}`,
    messageId: `m${n}`,
    stepId: n,
    timestamp: n,
    role: "user",
    content: `question ${n}`,
    isBegin: true,
    isEnd: false,
  });
  const seed = { ...end(1), id: "seed", messageId: "seed", synthetic: "state" as const };
  const history = taskHistoryFromSteps(
    [seed, user(1), end(1), user(2), { ...end(2), isEnd: false }, user(3)],
    storage,
    new Map([
      ["m1", 7],
      ["m2", 8],
      ["m3", 9],
    ])
  );
  expect(history.map(t => t.taskId)).toEqual([7, 8, 9]);
  expect(history[1].status).toBe("incomplete");
  expect(history[1].answer).toBe("");
  expect(history[2].status).toBe("incomplete");
  expect(history[2].answer).toBe("");
  expect(history[2].steps).toHaveLength(1);
  const record = buildTaskGraph(storage, history)[2];
  expect(record.request).toBe("question 3");
  expect(record.operators).toEqual([]);
  expect(record.dependencies).toEqual([]);
});

test("clipped answers are explicitly labelled and the task remains addressable", async () => {
  const { storage, task } = await fixture();
  const first = { ...task(1), answer: "z".repeat(2000) };
  const text = renderTaskIndex(buildTaskGraph(storage, [first]), 100);
  expect(text).toContain("answer clipped");
  expect(text).toContain("inspect");
  expect(text.length).toBeLessThan(1200);
});

test("deleting an input records its disconnected consumers in command order", async () => {
  const { storage, task, graph } = await fixture();
  const context = { metadataStore: WorkflowSystemMetadata.getInstance() };
  const initial = await planGraphEdit(
    graph.workflow,
    "create operator consumer: limit(2)\ncreate edge source.out -> consumer.in",
    context
  );
  const plan = await planGraphEdit(
    initial.workflow,
    'delete operator source\ncreate operator later: scan("later.csv")',
    context
  );
  storage.clear();
  storage.createSnapshot("s1", initial.workflow);
  storage.createSnapshot("s2", plan.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "edit", changes: "recorded edit" },
      output: { ...plan, workflow: undefined },
    },
  ];
  const record = buildTaskGraph(storage, [second])[0];
  expect(record.operator_changes!.map(block => block.id)).toEqual(["source", "consumer", "later"]);
  const consumer = record.operator_changes!.find(block => block.id === "consumer")!;
  expect(consumer.inputs).toEqual([{ port: "in", id: "unconnected" }]);
  expect(consumer.state).toContain("reconnected");
  expect(renderTaskIndex([record])).toContain("Deleted operators:");
});

async function forkFixture() {
  const { storage, task, graph, end } = await fixture();
  const context = { metadataStore: WorkflowSystemMetadata.getInstance() };
  const initial = await planGraphEdit(
    graph.workflow,
    'create operator middle: project(keep=["x"])\ncreate operator report: limit(2)\n' +
      "create edge source.out -> middle.in\ncreate edge middle.out -> report.in",
    context
  );
  storage.clear();
  storage.createSnapshot("s1", initial.workflow);
  const first = task(1);
  const fork = forkState(initial.workflow, storage, [first], 1, "report", "old_report");
  storage.createSnapshot("s2", fork.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "fork", task_id: 1, operator_id: "report", new_operator_id: "old_report" },
      output: { ...fork, workflow: undefined },
    },
  ];
  return { storage, first, second, fork, context, end };
}

test("unchanged fork copies collapse under their root with an exact inspectable mapping", async () => {
  const { storage, first, second } = await forkFixture();
  const record = buildTaskGraph(storage, [first, second])[1];
  const text = renderTaskIndex([record]);
  expect(text).toContain("**old_report**");
  expect(text).not.toContain("**old_report__source**");
  expect(text).not.toContain("**old_report__middle**");
  expect(text).toContain("2 unchanged upstream operators from task 1");
  expect(record.forks![0]).toMatchObject({
    task_id: 1,
    operator_id: "report",
    new_operator_id: "old_report",
    mapping: { source: "old_report__source", middle: "old_report__middle", report: "old_report" },
    collapsed_operator_ids: ["old_report__source", "old_report__middle"],
  });
});

test("legacy fork edits recover a mapping only from a matching saved-origin proof", async () => {
  const { storage, first, second, fork, context } = await forkFixture();
  const receipt = second.steps[0].toolResults![0].output as any;
  receipt.actions = [
    {
      index: 1,
      status: "ok",
      action: {
        type: "edit",
        changes: "fork operator report from task 1 as old_report",
      },
      output: { operator_blocks: fork.operators.map(op => ({ id: op.id, state: "forked from task 1" })), changes: [] },
    },
  ];
  const saved = buildTaskGraph(storage, [first, second])[1];
  expect(saved.forks![0].mapping).toEqual(fork.mapping);
  expect(renderTaskIndex([saved])).not.toContain("**old_report__source**");
  const edited = await planGraphEdit(fork.workflow, 'update operator old_report__source: scan("new.csv")', context);
  storage.createSnapshot("s3", edited.workflow);
  second.stepId = "s3";
  const modified = buildTaskGraph(storage, [first, second])[1];
  expect(renderTaskIndex([modified])).toContain("**old_report__source**");
});

test("a changed copied ancestor and its affected consumers never collapse", async () => {
  const { storage, first, second, fork, context, end } = await forkFixture();
  const changed = await planGraphEdit(fork.workflow, 'update operator old_report__source: scan("new.csv")', context);
  storage.createSnapshot("s3", changed.workflow);
  second.stepId = "s3";
  second.steps.push({
    ...end(3),
    messageId: "m2",
    toolResults: [
      {
        toolCallId: "edit",
        output: {
          kind: "dataflow-actions",
          actions: [
            {
              index: 1,
              status: "ok",
              action: { type: "edit", changes: "recorded edit" },
              output: changed,
            },
          ],
        },
      },
    ],
  });
  const text = renderTaskIndex(buildTaskGraph(storage, [first, second]).slice(1));
  expect(text).toContain("**old_report__source**");
  expect(text).toContain("**old_report__middle**");
  expect(text).toContain("forked from task 1; updated");
  expect(text).not.toContain("unchanged upstream operators");
});

test("fork copies remain visible when their root is deleted or disconnects them", async () => {
  for (const changes of [
    "delete operator old_report",
    'delete operator old_report\ncreate operator old_report: scan("replacement.csv")',
    "delete edge old_report__middle.out -> old_report.in\ncreate edge source.out -> old_report.in",
  ]) {
    const { storage, first, second, fork, context, end } = await forkFixture();
    const changed = await planGraphEdit(fork.workflow, changes, context);
    storage.createSnapshot("s3", changed.workflow);
    second.stepId = "s3";
    second.steps.push({
      ...end(3),
      messageId: "m2",
      toolResults: [
        {
          toolCallId: "edit",
          output: {
            kind: "dataflow-actions",
            actions: [{ index: 1, status: "ok", action: { type: "edit", changes }, output: changed }],
          },
        },
      ],
    });
    const text = renderTaskIndex(buildTaskGraph(storage, [first, second]).slice(1));
    expect(text).toContain("**old_report__source**");
    expect(text).toContain("**old_report__middle**");
    if (changes.includes("replacement.csv")) expect(text).toContain("**old_report** (scan, created)");
  }
});

test("an unchanged materialized input links to its earlier saved checkpoint", async () => {
  const { storage, task, graph } = await fixture();
  const context = { metadataStore: WorkflowSystemMetadata.getInstance() };
  const initial = structuredClone(storage.getOperatorResult("s1", "source")!);
  const plan = await planGraphEdit(
    graph.workflow,
    "create operator report: limit(1)\ncreate edge source.out -> report.in",
    context
  );
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.setOperatorResult("s1", "source", initial);
  storage.createSnapshot("s2", plan.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "edit", changes: "recorded edit" },
      output: plan,
    },
  ];
  const text = renderTaskIndex(buildTaskGraph(storage, [task(1), second]).slice(1));
  expect(text).toContain("inputs: `source` (version at end of task 1)");
});

test("unchanged fork ancestors declared as answer sources keep their blocks", async () => {
  const { storage, first, second } = await forkFixture();
  storage.setOperatorResult("s2", "old_report__source", {
    state: "Completed",
    inputTuples: 0,
    outputTuples: 1,
    totalRowCount: 1,
    resultMode: "table",
    result: [{ x: 1 }],
    resultSchema: [{ name: "x", type: "int64", encoding: "" }],
  });
  const receipt = second.steps[0].toolResults![0].output as any;
  receipt.actions.push({
    index: 2,
    status: "ok",
    action: {
      type: "answer",
      content: "1",
      operator_ids: ["old_report__source"],
    },
  });
  receipt.references = [{ actionIndex: 2, kind: "read", operatorId: "old_report__source", readStepId: "s2" }];
  const text = renderTaskIndex(buildTaskGraph(storage, [first, second]).slice(1));
  expect(text).toContain("**old_report__source** (scan, forked from task 1) — answer source");
  expect(text).not.toContain("**old_report__middle**");
});

test("read-only answers name saved source versions even with no operator edits", async () => {
  const { storage, task, reference } = await fixture();
  const second = task(2, [reference("read", { savedTaskId: 1, readStepId: "s1" })]);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "answer", content: "2", operator_ids: ["source"] },
    },
  ];
  const record = buildTaskGraph(storage, [task(1), second])[1];
  expect(record.operator_changes).toEqual([]);
  expect(renderTaskIndex([record])).toContain("Answer sources: `source@1`");
});

async function catalogFixture() {
  const f = await fixture();
  const info = structuredClone(f.storage.getOperatorResult("s1", "source")!);
  info.resultVersion = { ...info.resultVersion!, complete: true };
  info.tableProfile = {
    version: 1,
    resultVersion: info.resultVersion!.id,
    status: "available",
    columnCount: 1,
    rowCount: 2,
    schema: [{ name: "x", type: "int64", dtype: "int64" }],
    schemaComplete: true,
    coverage: { scope: "full", complete: true, expectedWorkers: 1, receivedWorkers: 1, rowsProcessed: 2 },
    columns: {
      x: {
        type: "int64",
        rowsProcessed: 2,
        nullCount: 0,
        nonnullCount: 2,
        distinctCount: 2,
        nullRatio: 0,
        uniquenessRatio: 1,
        min: null,
        max: null,
        frequencies: null,
        omissions: [],
      },
    },
    structure: { duplicateRows: 0, allNullRows: 0, allNullColumns: [] },
    native: null,
    producerIds: ["catalog-fixture"],
    omissions: [],
    cost: { collectionMs: 0, cellsProcessed: 2, payloadBytes: 0 },
  };
  // Restore a pinned profile fixture; execution-time proof validation has
  // separate coverage. This suite tests catalog rendering from saved facts.
  f.storage.getAssociatedSnapshot("s1").results.get("source")!.info = info;
  f.storage.captureNativeObservations("s1", ["source"], { data: false, flow: false, maxChars: 2000, view: "full" });
  const first = f.task(1);
  (first.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "edit", changes: "recorded edit" },
      output: { operator_blocks: [{ id: "source", state: "created" }] },
    },
    { index: 2, status: "ok", action: { type: "retrieve", operator_id: "source", view: "full" } },
  ];
  return { ...f, first, info };
}

test("catalog statistics and already-observed records can be enabled independently", async () => {
  const { storage, first, info } = await catalogFixture();
  // The catalog must use the frozen observation, not resample retained data.
  info.result = [{ x: 999 }, { x: 888 }];
  for (const catalogStatistics of [false, true])
    for (const catalogRecords of [0, 1]) {
      const options: ObservationFormatOptions = { catalogStatistics, catalogRecords };
      const text = renderTaskIndex(buildTaskGraph(storage, [first], options));
      expect(text).toContain("**source** (scan, created)");
      expect(text).toContain("columns: x int64");
      expect(text.includes("stats full")).toBe(catalogStatistics);
      expect(text.includes("null=0/2")).toBe(catalogStatistics);
      expect(text.includes("records: full; 1 of 2 rows")).toBe(catalogRecords > 0);
      expect(text.includes("| 1 |")).toBe(catalogRecords > 0);
      expect(text).not.toContain("| 2 |");
      expect(text).not.toContain("999");
      expect(text).not.toContain("888");
    }
  const text = renderTaskIndex(buildTaskGraph(storage, [first]));
  expect(text).not.toContain("stats full");
  expect(text).not.toContain("records:");
});

test("catalog records require a matching saved result version", async () => {
  const { storage, first, info } = await catalogFixture();
  const version = structuredClone(info.resultVersion!);
  info.resultVersion!.id = "different-result";
  expect(renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }))).not.toContain("records:");
  info.resultVersion = { ...version, operatorRevision: "different-revision" };
  expect(renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }))).not.toContain("records:");
  info.resultVersion = { ...version, subgraphHash: "different-subgraph" };
  expect(renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }))).not.toContain("records:");
  info.resultVersion = version;
  info.state = "Running";
  expect(renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }))).not.toContain("records:");
  info.state = "Completed";
  delete info.resultVersion;
  expect(renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }))).not.toContain("records:");
});

test("catalog rows cannot be invented from retained data or inherited object properties", async () => {
  const { storage, first } = await catalogFixture();
  const record = buildTaskGraph(storage, [first], { catalogRecords: 1 })[0];
  record.operator_changes!.push({ id: "toString", kind: "scan", state: "created" });
  expect(renderTaskIndex([record])).toContain("**toString** (scan, created)");
  storage.getAssociatedSnapshot("s1").nativeObservations = undefined;
  expect(renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }))).not.toContain("records:");
});

test("read-only task catalogs can include rows without enabling statistics", async () => {
  const { storage, first } = await catalogFixture();
  (first.steps[0].toolResults![0].output as any).actions.shift();
  const text = renderTaskIndex(buildTaskGraph(storage, [first], { catalogRecords: 1 }));
  expect(text).toContain("Referenced results:");
  expect(text).toContain("**source** (scan, referenced)");
  expect(text).toContain("| 1 |");
  expect(text).not.toContain("stats full");
});

test("catalog record frames remain immutable after settings and retained data change", async () => {
  const { storage, first, info } = await catalogFixture();
  const record = buildTaskGraph(storage, [first], { catalogStatistics: true, catalogRecords: 1 })[0];
  storage.captureNativeTaskCatalog("s1", record);
  const text = renderTaskIndex([record]);
  info.result = [{ x: 999 }];
  const saved = buildTaskGraph(storage, [first], { catalogStatistics: false, catalogRecords: 0 })[0];
  expect(renderTaskIndex([saved])).toBe(text);
  expect(Object.isFrozen(saved.operator_records)).toBe(true);
  expect(text).toContain("| 1 |");
});

test("sealed catalog frames are immutable across settings, descendants and storage clear", async () => {
  const { storage, task } = await fixture();
  const first = task(1);
  const receipt = first.steps[0].toolResults![0].output as any;
  receipt.actions.unshift({
    index: 0,
    status: "ok",
    action: { type: "edit", changes: "recorded edit" },
    output: { operator_blocks: [{ id: "source", state: "created" }] },
  });
  const record = buildTaskGraph(storage, [first], { catalogStatistics: true })[0];
  storage.captureNativeTaskCatalog("s1", record);
  const text = renderTaskIndex([record]);
  record.answer = "MUTATED OUTSIDE STORAGE";
  first.answer = "MUTATED TRACE";
  const saved = buildTaskGraph(storage, [first, task(2)], { catalogStatistics: false })[0];
  expect(renderTaskIndex([saved])).toBe(text);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved.operator_changes![0])).toBe(true);
  storage.captureNativeTaskCatalog("s1", { ...record, answer: "SECOND CAPTURE" });
  expect(renderTaskIndex(buildTaskGraph(storage, [first]))).toBe(text);
  storage.clear();
  expect(storage.getRootSnapshot().nativeTaskCatalog).toBeUndefined();
});

test("saved changes distinguish invalidated results from never executed outputs", async () => {
  const { storage, task, graph } = await fixture();
  const context = { metadataStore: WorkflowSystemMetadata.getInstance() };
  const initial = structuredClone(storage.getOperatorResult("s1", "source")!);
  const plan = await planGraphEdit(
    graph.workflow,
    'update operator source: scan("changed.csv")\ncreate operator new_source: scan("new.csv")',
    context
  );
  storage.clear();
  storage.createSnapshot("s1", graph.workflow);
  storage.setOperatorResult("s1", "source", initial);
  storage.createSnapshot("s2", plan.workflow);
  const second = task(2);
  (second.steps[0].toolResults![0].output as any).actions = [
    {
      index: 1,
      status: "ok",
      action: { type: "edit", changes: "recorded edit" },
      output: plan,
    },
  ];
  const blocks = buildTaskGraph(storage, [task(1), second])[1].operator_changes!;
  expect(blocks.find(block => block.id === "source")!.result).toContain("stale");
  expect(blocks.find(block => block.id === "new_source")!.result).toBe("not run");
});

test("a sealed imported leaf cannot be rewritten as a pending workflow", async () => {
  const { storage, task, graph } = await fixture();
  storage.captureNativeTaskCatalog("s3", buildTaskGraph(storage, [task(3)])[0]);
  expect(() => storage.updatePendingWorkflow("s3", graph.workflow)).toThrow("completed snapshot");
});
