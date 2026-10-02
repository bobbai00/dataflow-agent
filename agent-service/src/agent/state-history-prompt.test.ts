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
import { ContextMode } from "../types/agent";
import { buildNativeModeSystemPrompt } from "./prompts";
import { forkState, type HistoricalTask } from "./state-history";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { WorkflowState } from "./workflow-state";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { prepareDataflowActions, type DataflowAction } from "./tools/dataflow-actions";
import { planGraphEdit } from "./tools/graph-edits";

function examples(view: "full" | "sample" | "sample_stats" = "sample") {
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, retrievalViews: [view] });
  const section = prompt.split("### Generic multitask examples")[1]?.split("\n## Examples")[0] ?? "";
  const calls = Array.from(section.matchAll(/```json\n([\s\S]*?)\n```/g), m => JSON.parse(m[1]));
  return { prompt, section, calls };
}

test("historical examples validate for every retrieval configuration and separate observation-dependent calls", () => {
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const { prompt, section, calls } = examples(view);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(prepareDataflowActions(call, [view], true).status).toBe("pending");
      const actions: DataflowAction[] = call.actions;
      if (actions.some(a => a.type === "inspect" && a.target === "state"))
        expect(actions.every(a => a.type === "inspect")).toBe(true);
      if (actions.some(a => a.type === "answer")) expect(actions).toHaveLength(1);
      for (const action of actions) if (action.type === "retrieve") expect(action.view).toBe(view);
    }
    expect(prompt).not.toContain("{{");
    expect(section).not.toMatch(/LongDS|Kiva|Netflix|NFL|Kaggle/i);
  }
  const control = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: false });
  expect(control).not.toContain("Generic multitask examples");
  expect(control).not.toContain("Historical state across tasks");
});

test("worked edits preserve baseline branches and connect old formulas to current populations", async () => {
  const { calls } = examples();
  expect(calls).toHaveLength(5);
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const context = { metadataStore };
  const first = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    `create operator items: scan("items.csv")
create operator eligible: filter(lambda row: row["active"], doc="Active items")
create operator score: map(lambda row: {**row, "score": 2*row["units"]+row["margin"]}, doc="Original priority score")
create operator qualified: filter(lambda row: row["units"] >= 10, doc="At least ten units")
create edge items.out -> eligible.in
create edge eligible.out -> score.in
create edge eligible.out -> qualified.in`,
    context
  );
  const second = await planGraphEdit(
    first.workflow,
    `update operator eligible: filter(lambda row: row["active"] and row["premium"], doc="Premium active items")
update operator score: map(lambda row: {**row, "score": 3*row["units"]+row["margin"]}, doc="Current priority score")
create operator current_items: scan("current_items.csv")`,
    context
  );
  const storage = new WorkflowSnapshotStorage(id => (id === "s1" ? ["s1"] : ["s1", "s2"]));
  storage.createSnapshot("s1", first.workflow);
  storage.createSnapshot("s2", second.workflow);
  const tasks: HistoricalTask[] = [
    { taskId: 1, stepId: "s1", request: "Use active items", answer: "Original report" },
    { taskId: 2, stepId: "s2", request: "Change the population and score", answer: "Current report" },
  ];
  let workflow = second.workflow;
  for (const call of calls) {
    for (const action of call.actions as DataflowAction[]) {
      if (action.type === "fork")
        workflow = forkState(
          workflow,
          storage,
          tasks,
          action.task_id,
          action.operator_id,
          action.new_operator_id
        ).workflow;
      if (action.type === "edit") workflow = (await planGraphEdit(workflow, action.changes, context)).workflow;
    }
  }
  const operator = (id: string) => workflow.operators.find(o => o.operatorID === id)!;
  expect(operator("old_rule_current").nativeOp!.inputs).toEqual(["current_items"]);
  expect(operator("old_rule_current").nativeOp!.source).toContain('2*row["units"]');
  expect(operator("earlier_summary").nativeOp!.inputs).toEqual(["earlier_items"]);
  expect(operator("earlier_items").nativeOp!.source).toBe(
    first.workflow.operators.find(o => o.operatorID === "eligible")!.nativeOp!.source
  );
  for (const id of ["eligible", "score", "qualified", "current_items"])
    expect(operator(id)).toEqual(second.workflow.operators.find(o => o.operatorID === id)!);
  expect(storage.getWorkflow("s1")).toEqual(first.workflow);
  expect(storage.getWorkflow("s2")).toEqual(second.workflow);
});
