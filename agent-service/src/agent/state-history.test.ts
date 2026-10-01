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
import { forkState, inspectState, readForkResult, type HistoricalTask } from "./state-history";

async function fixture() {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const context = { metadataStore };
  const state = new WorkflowState();
  const first = await planGraphEdit(
    state.getWorkflowContent(),
    `create operator source: scan("old.csv")
create operator eligible: filter(lambda row: row["net"] > 0 and row["quality"], doc="Positive net and quality gate")
create operator total: aggregate(n=count())
create edge source.out -> eligible.in
create edge eligible.out -> total.in`,
    context
  );
  const path = ["s1", "s2", "s3"];
  const storage = new WorkflowSnapshotStorage(id => path.slice(0, path.indexOf(id) + 1));
  storage.createSnapshot("s1", first.workflow);
  storage.setOperatorResult("s1", "total", {
    state: "Completed",
    inputTuples: 2,
    outputTuples: 1,
    totalRowCount: 1,
    result: [{ n: 2 }],
    resultSchema: [{ name: "n", type: "int64", encoding: "" }],
    resultMode: "table",
  });
  const second = await planGraphEdit(first.workflow, 'update operator source: scan("new.csv")', context);
  storage.createSnapshot("s2", second.workflow);
  state.setWorkflowContent(second.workflow);
  const tasks: HistoricalTask[] = [
    { taskId: 1, stepId: "s1", request: "Apply the quality gate", answer: "2" },
    { taskId: 2, stepId: "s2", request: "Change the input", answer: "Changed" },
  ];
  return { state, storage, context, tasks, first, second };
}

test("history exposes upstream changes even when an operator expression is unchanged", async () => {
  const { storage, tasks } = await fixture();
  const output = inspectState(storage, tasks, { task_id: null, operator_id: "total", include_implementation: false });
  expect(output.versions).toHaveLength(2);
  expect(output.versions![1].expression).toBe(output.versions![0].expression);
  expect(output.versions![1].subgraph_hash).not.toBe(output.versions![0].subgraph_hash);
  expect(output.versions![0].result!.available).toBe(true);
  expect(output.versions![1].result!.available).toBe(false);
});

test("operator inspection exposes immediate input definitions from the same historical task", async () => {
  const { storage, tasks } = await fixture();
  const before = JSON.stringify(storage.getWorkflow("s1"));
  const output = inspectState(storage, tasks, { task_id: 1, operator_id: "total", include_implementation: true });
  const input = output.versions![0].input_definitions![0];
  expect(input.operator_id).toBe("eligible");
  expect(input.expression).toContain('row["quality"]');
  expect(input.inputs).toEqual(["source"]);
  expect(input.implementation).toBeDefined();
  expect(input.input_definitions).toBeUndefined();
  const source = inspectState(storage, tasks, { task_id: 1, operator_id: "eligible", include_implementation: false });
  expect(source.versions![0].input_definitions![0].expression).toContain("old.csv");
  expect(source.versions![0].input_definitions![0].implementation).toBeUndefined();
  expect(JSON.stringify(storage.getWorkflow("s1"))).toBe(before);
});

test("task overview uses successful receipts and distinguishes historical reads from task-end state", async () => {
  const { storage, tasks } = await fixture();
  const action = (type: string, output: unknown, status = "ok") => ({
    index: 1,
    action: { type, operator_id: "total" },
    status,
    output,
  });
  tasks[1].steps = [
    {
      id: "s2",
      toolResults: [
        {
          toolCallId: "call",
          output: {
            kind: "dataflow-actions",
            status: "error",
            operators: [],
            observe: [],
            observationErrors: [],
            actions: [
              action("edit", { operators: [{ id: "source", status: "modified" }] }),
              action("retrieve", {
                operator_id: "total",
                historical_state: { task_id: 1, operator_id: "total" },
                revision: "r1",
              }),
              action("retrieve", { operator_id: "eligible", superseded_in_call: true }),
              action("edit", { operators: [{ id: "phantom", status: "added" }] }, "error"),
              action("retrieve", { operator_id: "not_read" }, "skipped"),
            ],
          },
        },
      ],
    },
  ];
  const output = inspectState(storage, tasks, { task_id: 2, operator_id: null, include_implementation: false });
  expect(output.scope).toBe("task_activity");
  expect(output.total_operator_count).toBe(3);
  expect(output.operators!.map(op => op.id)).toEqual(["source", "eligible"]);
  expect(output.operators![0].inputs).toEqual([]);
  expect(output.retrieved).toEqual([
    {
      operator_id: "total",
      read_at_step: "s2",
      historical_state: { task_id: 1, operator_id: "total" },
      revision: "r1",
    },
    { operator_id: "eligible", read_at_step: "s2", superseded_in_call: true },
  ]);
  expect(JSON.stringify(output)).not.toContain("phantom");
  expect(JSON.stringify(output)).not.toContain("not_read");
});

test("old traces without receipts keep a discoverable graph and honor implementation requests", async () => {
  const { storage, tasks } = await fixture();
  const output = inspectState(storage, tasks, { task_id: 1, operator_id: null, include_implementation: true });
  expect(output.scope).toBe("whole_graph_no_action_receipts");
  expect(output.operators).toHaveLength(3);
  expect(output.operators!.find(op => op.id === "eligible")!.expression).toContain('row["quality"]');
  expect(output.operators!.find(op => op.id === "total")!.result).toMatchObject({ available: true, rows: 1 });
});

test("fork preserves the complete historical dependency closure and original graph", async () => {
  const { state, storage, tasks, first, second } = await fixture();
  const before = structuredClone(state.getWorkflowContent());
  const plan = forkState(before, storage, tasks, 1, "total", "old_total");
  expect(state.getWorkflowContent()).toEqual(before);
  expect(storage.getWorkflow("s1")).toEqual(first.workflow);
  expect(storage.getWorkflow("s2")).toEqual(second.workflow);
  expect(plan.workflow.operators.find(op => op.operatorID === "source")?.nativeOp?.source).toContain("new.csv");
  expect(plan.workflow.operators.find(op => op.operatorID === "old_total__source")?.nativeOp?.source).toContain(
    "old.csv"
  );
  expect(plan.workflow.operators.find(op => op.operatorID === "old_total")?.nativeOp?.inputs).toEqual([
    "old_total__eligible",
  ]);
  expect(
    plan.workflow.links
      .filter(link => link.target.operatorID.startsWith("old_total"))
      .every(link => link.source.operatorID.startsWith("old_total"))
  ).toBe(true);
  const saved = readForkResult(plan.workflow, storage, "old_total");
  expect(saved?.info.result).toEqual([{ n: 2 }]);
  expect(saved?.operatorId).toBe("total");
  expect(saved?.taskId).toBe(1);
  // Saved observations are read under their original identity, never fabricated
  // as an engine materialization for the new operator ID.
  expect(storage.getOperatorResult("s2", "old_total")).toBeUndefined();
});

test("changing a fork's ancestor makes its saved result unavailable", async () => {
  const { state, storage, tasks, context } = await fixture();
  const plan = forkState(state.getWorkflowContent(), storage, tasks, 1, "total", "old_total");
  const edited = await planGraphEdit(plan.workflow, 'update operator old_total__source: scan("other.csv")', context);
  expect(readForkResult(edited.workflow, storage, "old_total")).toBeUndefined();
  expect(readForkResult(plan.workflow, storage, "old_total")?.info.result).toEqual([{ n: 2 }]);
});

test("newly executed inputs cannot fall back to an older descendant observation", async () => {
  const { state, storage, tasks } = await fixture();
  const plan = forkState(state.getWorkflowContent(), storage, tasks, 1, "total", "old_total");
  storage.createSnapshot("s3", plan.workflow);
  expect(readForkResult(plan.workflow, storage, "old_total", "s3")?.info.result).toEqual([{ n: 2 }]);
  storage.setOperatorResult("s3", "old_total__source", {
    state: "Completed",
    inputTuples: 0,
    outputTuples: 1,
    totalRowCount: 1,
    result: [{ net: 10, quality: false }],
    resultMode: "table",
  });
  expect(readForkResult(plan.workflow, storage, "old_total", "s3")).toBeUndefined();
  expect(storage.getOperatorResult("s1", "total")?.result).toEqual([{ n: 2 }]);
});

test("an older expression can be rewired to the current population without changing either baseline", async () => {
  const { state, storage, tasks, context } = await fixture();
  const plan = forkState(state.getWorkflowContent(), storage, tasks, 1, "eligible", "old_gate");
  const edited = await planGraphEdit(
    plan.workflow,
    `delete edge old_gate__source.out -> old_gate.in
create edge source.out -> old_gate.in`,
    context
  );
  expect(edited.workflow.operators.find(op => op.operatorID === "old_gate")?.nativeOp?.inputs).toEqual(["source"]);
  expect(edited.workflow.operators.find(op => op.operatorID === "old_gate")?.nativeOp?.source).toContain(
    'row["quality"]'
  );
  expect(edited.workflow.operators.find(op => op.operatorID === "eligible")?.nativeOp?.inputs).toEqual(["source"]);
  expect(storage.getWorkflow("s1").operators.find(op => op.operatorID === "source")?.nativeOp?.source).toContain(
    "old.csv"
  );
});

test("fork rejects unknown tasks, collisions, and invalid IDs before changing anything", async () => {
  const { state, storage, tasks } = await fixture();
  const before = structuredClone(state.getWorkflowContent());
  for (const args of [
    [3, "total", "old"],
    [1, "absent", "old"],
    [1, "total", "source"],
    [1, "total", "a-b"],
  ] as const)
    expect(() => forkState(before, storage, tasks, args[0], args[1], args[2])).toThrow();
  expect(state.getWorkflowContent()).toEqual(before);
  expect(() =>
    inspectState(storage, tasks, { task_id: 3, operator_id: "total", include_implementation: false })
  ).toThrow("completed");
});

test("history can inspect and fork an operator deleted from the live graph", async () => {
  const { state, storage, tasks, context } = await fixture();
  const deleted = await planGraphEdit(state.getWorkflowContent(), "delete operator total", context);
  storage.createSnapshot("s3", deleted.workflow);
  tasks.push({ taskId: 3, stepId: "s3", request: "Delete total", answer: "Deleted" });
  const history = inspectState(storage, tasks, { task_id: null, operator_id: "total", include_implementation: false });
  expect(history.versions![2]).toMatchObject({ task_id: 3, operator_id: "total", deleted: true });
  expect(
    forkState(deleted.workflow, storage, tasks, 1, "total", "restored").workflow.operators.some(
      op => op.operatorID === "restored"
    )
  ).toBe(true);
});
