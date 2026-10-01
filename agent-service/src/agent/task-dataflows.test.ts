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
import { TaskDataflows, type RetainedResult } from "./task-dataflows";
import { WorkflowState } from "./workflow-state";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { planGraphEdit } from "./tools/graph-edits";
import type { OperatorInfo } from "../types/execution";

const metadata = WorkflowSystemMetadata.getInstance();
metadata.seedCodeModeDefaults();
const graph = async () =>
  (
    await planGraphEdit(
      new WorkflowState().getWorkflowContent(),
      `
create operator raw: scan("data/a.csv")
create operator eligible: filter(fn=lambda df: df["value"] > 0, doc="Keep positive values")
create operator report: limit(2)
create operator unrelated: scan("data/unrelated.csv")
create edge raw.out -> eligible.in
create edge eligible.out -> report.in`,
      { metadataStore: metadata }
    )
  ).workflow;
function info(id: string, rows: number, inputs: string[] = []): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: rows,
    outputTuples: rows,
    resultMode: "structured",
    result: [{ value: 1 }],
    totalRowCount: rows,
    displayedRows: 1,
    truncated: rows > 1,
    materialization: { outputPort: 0, executionId: "7", cached: false },
    resultVersion: {
      version: 1,
      id: `v-${id}`,
      workflowId: 1,
      operatorId: id,
      operatorRevision: null,
      definitionHash: null,
      subgraphHash: null,
      outputPort: 0,
      executionId: "7",
      inputs: inputs.map((up, i) => ({ inputIndex: i, operatorId: up, outputPort: 0, resultVersion: `v-${up}` })),
      sourceFingerprints: null,
      complete: true,
      omissions: [],
    },
  };
}
const results = () =>
  new Map([
    ["raw", info("raw", 100)],
    ["eligible", info("eligible", 80, ["raw"])],
    ["report", info("report", 2, ["eligible"])],
    ["unrelated", info("unrelated", 200)],
  ]);
const answer = {
  content: "Two rows are shown.",
  exports: [{ name: "eligible_population", operator_id: "eligible" }],
  answer_sources: ["report"],
  defaults: [{ name: "population", export_name: "eligible_population" }],
};
const artifact = (rows: number): RetainedResult => ({
  path: "/tmp/retained.arrow",
  sha256: "a".repeat(64),
  rowCount: rows,
});
const store = () => new TaskDataflows(async (_id, result) => artifact(result.totalRowCount!));

test("capture retains complete working outputs and extracts only producing ancestors", async () => {
  const retained: string[] = [];
  const tasks = new TaskDataflows(async (id, result) => {
    retained.push(id);
    return artifact(result.totalRowCount!);
  });
  tasks.begin("Keep eligible rows, show two.");
  await tasks.seal(answer, await graph(), results());
  expect(retained.sort()).toEqual(["eligible", "report"]);
  const saved = tasks.resolve(1, "eligible_population");
  expect(saved.artifact.rowCount).toBe(80);
  expect(saved.info.result!.length).toBe(1);
  expect(tasks.resolve(1, "answer/report").artifact.rowCount).toBe(2);
  expect(
    tasks
      .record(1)
      .graph.operators.map(op => op.operatorID)
      .sort()
  ).toEqual(["eligible", "raw", "report"]);
  expect(tasks.defaults()).toEqual([{ name: "population", task_id: 1, export_name: "eligible_population" }]);
  saved.info.result![0].value = 999;
  expect(tasks.resolve(1, "eligible_population").info.result![0].value).toBe(1);
});

test("failed retention and stale exports never finalize a task or change defaults", async () => {
  let fail = true;
  const tasks = new TaskDataflows(async (id, result) => {
    if (id === "report" && fail) throw new Error("retention unavailable");
    return artifact(result.totalRowCount!);
  });
  tasks.begin("Keep population");
  await expect(tasks.seal(answer, await graph(), results())).rejects.toThrow("retention unavailable");
  expect(tasks.defaults()).toEqual([]);
  expect(() => tasks.resolve(1, "eligible_population")).toThrow();
  fail = false;
  const stale = results();
  stale.delete("eligible");
  await expect(tasks.seal(answer, await graph(), stale)).rejects.toThrow("eligible");
  await tasks.seal(answer, await graph(), results());
  expect(tasks.record(1).status).toBe("completed");
});

test("missing, duplicate, and unsaved export bindings fail before retaining anything", async () => {
  let calls = 0;
  const tasks = new TaskDataflows(async (_id, result) => {
    calls++;
    return artifact(result.totalRowCount!);
  });
  tasks.begin("Task");
  for (const bad of [
    { ...answer, exports: [{ name: "missing", operator_id: "absent" }] },
    { ...answer, exports: [...answer.exports, ...answer.exports] },
    { ...answer, defaults: [{ name: "population", export_name: "absent" }] },
    { ...answer, answer_sources: ["absent"] },
  ])
    await expect(tasks.seal(bad, await graph(), results())).rejects.toThrow();
  expect(calls).toBe(0);
});

test("a temporary comparison leaves defaults and historical results unchanged", async () => {
  const tasks = store();
  tasks.begin("Keep the eligible population");
  await tasks.seal(answer, await graph(), results());
  tasks.begin("Temporarily compare to the broad population");
  await tasks.seal(
    { content: "Comparison", exports: [{ name: "broad", operator_id: "raw" }], answer_sources: ["raw"], defaults: [] },
    await graph(),
    results()
  );
  expect(tasks.defaults()[0].task_id).toBe(1);
  expect(tasks.resolve(1, "eligible_population").artifact.rowCount).toBe(80);
  expect(() => tasks.resolve(2, "eligible_population")).toThrow();
});

test("imports are pinned, can feed edits, and are the only task dependency when consumed", async () => {
  const tasks = store();
  tasks.begin("Original");
  await tasks.seal(answer, await graph(), results());
  tasks.begin("Use the saved eligible population");
  tasks.inspect(1, "graph");
  const state = new WorkflowState();
  tasks.importResult(1, "eligible_population", "previous", state, metadata);
  const imported = state.getOperator("previous")!;
  expect(imported.taskImport).toEqual({ task_id: 1, export_name: "eligible_population", result_version: "v-eligible" });
  await expect(
    planGraphEdit(state.getWorkflowContent(), 'update operator previous: scan("new.csv")', { metadataStore: metadata })
  ).rejects.toThrow("immutable");
  await expect(
    planGraphEdit(state.getWorkflowContent(), 'delete operator previous\ncreate operator previous: scan("new.csv")', {
      metadataStore: metadata,
    })
  ).rejects.toThrow("immutable");
  const edited = await planGraphEdit(
    state.getWorkflowContent(),
    "create operator report: limit(1)\ncreate edge previous.out -> report.in",
    { metadataStore: metadata }
  );
  expect(edited.workflow.operators.find(op => op.operatorID === "previous")).toEqual(imported);
  const current = new Map([
    ["previous", info("previous", 80)],
    ["report", info("report", 1, ["previous"])],
  ]);
  await tasks.seal(
    { content: "One row", exports: [], answer_sources: ["report"], defaults: [] },
    edited.workflow,
    current
  );
  expect(tasks.record(2).dependencies).toEqual([
    { task_id: 1, export_name: "eligible_population", result_version: "v-eligible" },
  ]);
  tasks.begin("Read only, no reuse");
  tasks.inspect(1, "implementations");
  await tasks.seal(
    { content: "No calculation", exports: [], answer_sources: [], defaults: [] },
    new WorkflowState().getWorkflowContent(),
    new Map()
  );
  expect(tasks.record(3).dependencies).toEqual([]);
});

test("output discovery stays small for wide saved tables and keyword search finds the task", async () => {
  const tasks = store();
  tasks.begin("Compare adoption rates among people shown the AutoML question");
  const data = results();
  const result = data.get("eligible")!;
  result.resultSchema = Array.from({ length: 400 }, (_, i) => ({
    name: `question_${i}`,
    type: "str",
    encoding: "string",
  }));
  result.result = Array.from({ length: 20 }, () =>
    Object.fromEntries(result.resultSchema!.map(c => [c.name, "x".repeat(100)]))
  );
  await tasks.seal(answer, await graph(), data);
  const view = JSON.stringify(tasks.inspect(1, "outputs"));
  expect(view.length).toBeLessThan(3000);
  expect(view).toContain('"columns":400');
  expect(view).toContain('"omitted_columns":388');
  expect(tasks.list("AutoML rates shown").map(t => t.task_id)).toEqual([1]);
});

test("a cancellation during retention cannot commit a task", async () => {
  let current = true;
  const tasks = new TaskDataflows(async (_id, result) => {
    current = false;
    return artifact(result.totalRowCount!);
  });
  tasks.begin("Task");
  await expect(
    tasks.seal(answer, await graph(), results(), () => {
      if (!current) throw new Error("cancelled");
    })
  ).rejects.toThrow("cancelled");
  expect(tasks.defaults()).toEqual([]);
  expect(tasks.record(1).status).toBe("running");
});

test("initial task context includes requests and answers but no graph, exports or internal observations", async () => {
  const tasks = store();
  tasks.begin("Keep eligible rows");
  await tasks.seal(answer, await graph(), results());
  tasks.begin("Next task");
  const context = tasks.historyMessages();
  expect(JSON.stringify(context)).toContain("Keep eligible rows");
  expect(JSON.stringify(context)).toContain(answer.content);
  for (const hidden of ["eligible_population", "data/a.csv", "v-eligible", "retained.arrow"])
    expect(JSON.stringify(context)).not.toContain(hidden);
  const frozen = JSON.stringify(context);
  tasks.inspect(1, "outputs");
  expect(JSON.stringify(tasks.historyMessages())).toBe(frozen);
});
