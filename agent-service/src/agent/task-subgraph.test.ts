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
import { inspectTaskSubgraph, type HistoricalTask } from "./state-history";
import { WorkflowState } from "./workflow-state";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { planGraphEdit } from "./tools/graph-edits";

async function fixture(results = true) {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const context = { metadataStore };
  const first = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    `create operator source: scan("old.csv")
create operator prepared: filter(lambda row: row["x"] > 0, doc="Keep positive values")
create operator prior_answer: aggregate(n=count())
create edge source.out -> prepared.in
create edge prepared.out -> prior_answer.in`,
    context
  );
  const path = ["s1", "s2", "s3"];
  const storage = new WorkflowSnapshotStorage(id => path.slice(0, path.indexOf(id) + 1));
  storage.createSnapshot("s1", first.workflow);
  if (results)
    for (const op of first.workflow.operators)
      storage.setOperatorResult("s1", op.operatorID, {
        state: "Completed",
        inputTuples: 1,
        outputTuples: 1,
        totalRowCount: 1,
        result: [{ x: 1 }],
        resultMode: "table",
        resultSchema: [{ name: "x", type: "int64", encoding: "" }],
      });
  const second = await planGraphEdit(
    first.workflow,
    `create operator left_values: map(lambda row: {"x": row["x"] + 1}, doc="Add one to each value")
create operator right_values: map(lambda row: {"x": row["x"] + 2}, doc="Add two to each value")
create operator combined: union(schema="strict")
create operator unique_values: distinct(columns=["x"])
create operator answer: aggregate(n=count())
create operator experiment: limit(1)
create edge prepared.out -> left_values.in
create edge prepared.out -> right_values.in
create edge left_values.out -> combined.in[0]
create edge right_values.out -> combined.in[1]
create edge combined.out -> unique_values.in
create edge unique_values.out -> answer.in
create edge source.out -> experiment.in`,
    context
  );
  storage.createSnapshot("s2", second.workflow);
  const tasks: HistoricalTask[] = [
    { taskId: 1, stepId: "s1", request: "Prepare records", answer: "1" },
    { taskId: 2, stepId: "s2", request: "Combine two calculations", answer: "2" },
  ];
  return { storage, tasks, context, first, second };
}

test("a task shows its five contributing operators and one shared saved input", async () => {
  const { storage, tasks } = await fixture();
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["answer"], true);
  expect(graph.operators.map(o => o.operator_id)).toEqual([
    "left_values",
    "right_values",
    "combined",
    "unique_values",
    "answer",
  ]);
  expect(graph.boundary_inputs).toHaveLength(1);
  expect(graph.boundary_inputs[0]).toMatchObject({
    task_id: 1,
    step_id: "s1",
    operator_id: "prepared",
    result: { available: true },
  });
  expect(graph.boundary_inputs[0].result.result_version).toBe(
    storage.getOperatorResult("s1", "prepared")!.resultVersion!.id
  );
  expect(graph.boundary_inputs[0]).not.toHaveProperty("implementation");
  expect(graph.boundary_inputs[0]).not.toHaveProperty("expression");
  expect(graph.operators.every(o => o.implementation !== undefined)).toBe(true);
  expect(graph.edges).toHaveLength(6);
  expect(graph.upstream_operator_count).toBe(7);
  expect(graph.operators.some(o => o.operator_id === "experiment")).toBe(false);
});

test("a changed ancestor keeps unchanged downstream definitions inside the local computation", async () => {
  const { storage, tasks, first, context } = await fixture();
  const changed = await planGraphEdit(first.workflow, 'update operator source: scan("new.csv")', context);
  storage.createSnapshot("s3", changed.workflow);
  tasks[1].stepId = "s3";
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["prior_answer"], false);
  expect(graph.operators.map(o => o.operator_id)).toEqual(["source", "prepared", "prior_answer"]);
  expect(graph.boundary_inputs).toEqual([]);
  expect(graph.operators[0].expression).toContain("new.csv");
});

test("missing saved tables remain explicit unavailable input references, never fabricated results", async () => {
  const { storage, tasks } = await fixture(false);
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["answer"], false);
  expect(graph.operators).toHaveLength(5);
  expect(graph.boundary_inputs[0]).toMatchObject({ operator_id: "prepared", result: { available: false } });
  expect(graph.operators.every(o => o.implementation === undefined)).toBe(true);
});

test("a fresh materialization is not collapsed into an earlier result with the same definition", async () => {
  const { storage, tasks } = await fixture();
  const previous = storage.getOperatorResult("s1", "source")!;
  storage.setOperatorResult("s2", "source", {
    ...previous,
    result: [{ x: 9 }],
    materialization: { outputPort: 0, executionId: "200", cached: false },
  });
  expect(storage.getOperatorResult("s2", "source")!.resultVersion!.id).not.toBe(previous.resultVersion!.id);
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["prior_answer"], false);
  expect(graph.operators.map(op => op.operator_id)).toEqual(["source", "prepared", "prior_answer"]);
  expect(graph.boundary_inputs).toEqual([]);
});

test("input metadata is pinned to its owning snapshot, including after a later cache observation", async () => {
  const { storage, tasks } = await fixture();
  const saved = storage.getOperatorResult("s1", "prepared")!;
  storage.setOperatorResult("s2", "prepared", { ...saved, state: "CompletedFromCache" });
  expect(storage.getOperatorResult("s2", "prepared")!.resultVersion!.id).toBe(saved.resultVersion!.id);
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["answer"], false);
  expect(graph.boundary_inputs[0].result).toMatchObject({ state: "Completed", producing_step: "s1" });
});

test("restoring an older computation is local when it changes the immediately preceding task", async () => {
  const { first, context } = await fixture();
  const changed = await planGraphEdit(first.workflow, 'update operator source: scan("changed.csv")', context);
  const path = ["before", "changed", "restored"];
  const storage = new WorkflowSnapshotStorage(id => path.slice(0, path.indexOf(id) + 1));
  storage.createSnapshot("before", first.workflow);
  for (const op of first.workflow.operators)
    storage.setOperatorResult("before", op.operatorID, {
      state: "Completed",
      inputTuples: 1,
      outputTuples: 1,
      totalRowCount: 1,
      result: [{ x: 1 }],
      resultMode: "table",
    });
  storage.createSnapshot("changed", changed.workflow);
  storage.createSnapshot("restored", first.workflow);
  for (const op of first.workflow.operators)
    storage.setOperatorResult("restored", op.operatorID, storage.getOperatorResult("before", op.operatorID)!);
  const tasks: HistoricalTask[] = path.map((stepId, index) => ({
    taskId: index + 1,
    stepId,
    request: stepId,
    answer: "1",
  }));
  const graph = inspectTaskSubgraph(storage, tasks[2], tasks, ["prior_answer"], false);
  expect(graph.operators.map(op => op.operator_id)).toEqual(["source", "prepared", "prior_answer"]);
  expect(graph.boundary_inputs).toEqual([]);
});

test("a task that reuses an earlier answer can contain only a saved input reference", async () => {
  const { storage, tasks } = await fixture();
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["prior_answer"], false);
  expect(graph.operators).toEqual([]);
  expect(graph.boundary_inputs.map(o => o.operator_id)).toEqual(["prior_answer"]);
  expect(graph.roots).toEqual(["prior_answer"]);
});

test("an answer read directly from an older saved version is a boundary, including after a fork", async () => {
  const { storage, tasks } = await fixture();
  const graph = inspectTaskSubgraph(storage, tasks[0], tasks, ["prior_answer"], true, tasks[1].taskId);
  expect(graph.operators).toEqual([]);
  expect(graph.boundary_inputs).toHaveLength(1);
  expect(graph.boundary_inputs[0]).toMatchObject({ task_id: 1, step_id: "s1", operator_id: "prior_answer" });
  expect(graph.task_id).toBe(2);
});

test("expanding an input's owning task exposes its branch without changing either snapshot", async () => {
  const { storage, tasks } = await fixture();
  const before = JSON.stringify(tasks.map(t => storage.getWorkflow(t.stepId)));
  const graph = inspectTaskSubgraph(storage, tasks[0], tasks, ["prepared"], true);
  expect(graph.operators.map(o => o.operator_id)).toEqual(["source", "prepared"]);
  expect(graph.boundary_inputs).toEqual([]);
  expect(JSON.stringify(tasks.map(t => storage.getWorkflow(t.stepId)))).toBe(before);
});

test("shared ancestors are deduplicated across selected answer branches", async () => {
  const { storage, tasks } = await fixture();
  const graph = inspectTaskSubgraph(storage, tasks[1], tasks, ["left_values", "right_values"], false);
  expect(graph.operators.map(o => o.operator_id)).toEqual(["left_values", "right_values"]);
  expect(graph.boundary_inputs.map(o => o.operator_id)).toEqual(["prepared"]);
});
