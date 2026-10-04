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

test("task index contains questions, answers and references, with no code or record dump", async () => {
  const { storage, task, reference } = await fixture();
  const text = renderTaskIndex(buildTaskGraph(storage, [task(1), task(2, [reference()])]));
  expect(text).toContain("question 1");
  expect(text).toContain("answer 2");
  expect(text).toContain("task 1");
  expect(text).not.toContain('scan("data.csv")');
  expect(text).not.toContain("x: 1");
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
