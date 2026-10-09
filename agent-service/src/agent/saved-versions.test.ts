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
import { parseOperatorReference, resolveSavedOperator, savedResultSource } from "./saved-versions";
import type { HistoricalTask } from "./state-history";
import { planVersionedGraphEdit } from "./tools/versioned-graph-edits";

async function fixture() {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const first = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    `create operator source: scan("old.csv")
create operator scores: aggregate(n=count())
create edge source.out -> scores.in`,
    { metadataStore }
  );
  const storage = new WorkflowSnapshotStorage(id => (id === "s1" ? ["s1"] : ["s1", "s2"]));
  storage.createSnapshot("s1", first.workflow);
  storage.setOperatorResult("s1", "scores", {
    state: "Completed", inputTuples: 2, outputTuples: 1, totalRowCount: 1,
    result: [{ n: 2 }], resultSchema: [{ name: "n", type: "int64", encoding: "" }],
    resultMode: "table", materialization: { executionId: "41", outputPort: 0, cached: false },
  });
  const second = await planGraphEdit(first.workflow, 'update operator source: scan("new.csv")', { metadataStore });
  storage.createSnapshot("s2", second.workflow);
  const tasks: HistoricalTask[] = [
    { taskId: 1, stepId: "s1", request: "Count rows", answer: "2" },
    { taskId: 2, stepId: "s2", request: "Replace the source", answer: "Changed" },
  ];
  return { storage, tasks, first, second };
}

test("references have one unambiguous, bounded task address", () => {
  expect(parseOperatorReference("scores")).toEqual({ operatorId: "scores" });
  expect(parseOperatorReference("scores@12")).toEqual({ operatorId: "scores", taskId: 12 });
  for (const text of ["scores@0", "scores@-1", "scores@1.5", "scores@01", "scores@", "scores@9007199254740992", "a@1@2", " a@2"])
    expect(() => parseOperatorReference(text)).toThrow();
});

test("historical reads retain the exact old result after a current input changes", async () => {
  const { storage, tasks } = await fixture();
  const before = JSON.stringify(storage.getWorkflow("s1"));
  const saved = resolveSavedOperator(storage, tasks, "scores@1", true);
  expect(saved.info?.result).toEqual([{ n: 2 }]);
  expect(saved.info?.materialization?.executionId).toBe("41");
  expect(saved.op.nativeOp?.inputs).toEqual(["source"]);
  expect(saved.workflow.operators[0].nativeOp?.source).toContain("old.csv");
  expect(JSON.stringify(storage.getWorkflow("s1"))).toBe(before);
});

test("a missing result can be inspected as a definition but cannot become a data input", async () => {
  const { storage, tasks } = await fixture();
  expect(resolveSavedOperator(storage, tasks, "source@1", false).op.nativeOp?.source).toContain("old.csv");
  expect(() => resolveSavedOperator(storage, tasks, "source@1", true)).toThrow("completed result");
  expect(() => resolveSavedOperator(storage, tasks, "scores@2", true)).toThrow("completed result");
  expect(() => resolveSavedOperator(storage, tasks, "missing@1", false)).toThrow("did not exist");
  expect(() => resolveSavedOperator(storage, tasks, "scores@3", false)).toThrow();
});

test("a historical input is a single read-only materialization handle, without copied ancestors", async () => {
  const { storage, tasks } = await fixture();
  const saved = resolveSavedOperator(storage, tasks, "scores@1", true);
  const source = savedResultSource(saved);
  expect(source.nativeOp?.inputs).toEqual([]);
  expect(source.savedResult).toMatchObject({ taskId: 1, operatorId: "scores", executionId: "41", outputPort: 0 });
  expect(source.operatorProperties.code).toContain("HISTORICAL_RESULT_UNAVAILABLE");
  expect(savedResultSource(saved)).toEqual(source);
  expect(source.operatorID.length).toBeLessThan(60);
});

test("an edge reference adds one handle and never copies or changes the historical graph", async () => {
  const { storage, tasks, second } = await fixture();
  const metadataStore = WorkflowSystemMetadata.getInstance();
  const before = JSON.stringify(second.workflow);
  const plan = await planVersionedGraphEdit(second.workflow, `create operator comparison: join(on="n", how="full")
create edge scores@1.out -> comparison.left
create edge scores.out -> comparison.right`, { metadataStore, settings: { stateHistory: true } as any }, storage, tasks);
  expect(plan.workflow.operators).toHaveLength(second.workflow.operators.length + 2);
  const handles = plan.workflow.operators.filter(op => op.savedResult);
  expect(handles).toHaveLength(1);
  expect(handles[0].savedResult?.executionId).toBe("41");
  expect(plan.changes.map(change => change.edge).filter(Boolean)).toContain("scores@1.out -> comparison.left");
  expect(JSON.stringify(second.workflow)).toBe(before);
  await expect(planVersionedGraphEdit(plan.workflow, `update operator ${handles[0].operatorID}: process(fn=load, doc="Overwrite history")
    def load():
        return pd.DataFrame()`, { metadataStore, settings: { stateHistory: true } as any }, storage, tasks)).rejects.toThrow("read-only");
});

test("restoring a definition preserves current input bindings", async () => {
  const { storage, tasks, first } = await fixture();
  const metadataStore = WorkflowSystemMetadata.getInstance();
  const changed = await planGraphEdit(first.workflow, `create operator replacement: scan("current.csv")
delete edge source.out -> scores.in
create edge replacement.out -> scores.in
update operator scores: aggregate(n=sum("amount"))`, { metadataStore });
  const restored = await planVersionedGraphEdit(changed.workflow, "update operator scores from scores@1",
    { metadataStore, settings: { stateHistory: true } as any }, storage, tasks);
  const op = restored.workflow.operators.find(op => op.operatorID === "scores")!;
  expect(op.nativeOp?.inputs).toEqual(["replacement"]);
  expect(op.nativeOp?.source).toContain("count()");
  expect(restored.invalidated_results).toContain("scores");
});
