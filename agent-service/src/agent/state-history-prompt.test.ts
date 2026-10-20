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
import { type HistoricalTask } from "./state-history";
import { restoreCommands, splitVersionCommands, upstreamDrift } from "./state-ledger";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { WorkflowState } from "./workflow-state";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { prepareDataflowActions, type DataflowAction } from "./tools/dataflow-actions";
import { planGraphEdit } from "./tools/graph-edits";

function examples(view: "full" | "sample" | "sample_stats" = "sample") {
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, retrievalViews: [view] });
  const section = prompt.split("### Example: compare with an earlier task and go back")[1] ?? "";
  const calls = Array.from(section.matchAll(/```json\n([\s\S]*?)\n```/g), m => JSON.parse(m[1]));
  return { prompt, section, calls };
}

test("multi-task history and catalog are separate extensions using the edit vocabulary", () => {
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const { prompt, section, calls } = examples(view);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(prepareDataflowActions(call, [view], true).status).toBe("pending");
      for (const action of call.actions as DataflowAction[])
        if (action.type === "retrieve") expect(action.view).toBe(view);
    }
    const restoreEdits = calls.flatMap(call =>
      (call.actions as DataflowAction[]).filter(a => a.type === "edit")
    ) as Array<{ changes: string }>;
    expect(restoreEdits).toHaveLength(2);
    for (const edit of restoreEdits) expect(splitVersionCommands(edit.changes).versions.length).toBe(1);
    expect(calls.flatMap(call => call.actions).find((a: any) => a.type === "inspect")).toMatchObject({
      type: "inspect",
      target: "state",
      task_id: null,
      view: null,
    });
    expect(prompt).not.toContain("{{");
    expect(section).not.toMatch(/LongDS|Kiva|Netflix|NFL|Kaggle/i);
    expect(prompt).toContain("update operator <id> from task <N>");
    expect(prompt).toContain("fork operator <id> from task <N> as <new_id>");
    expect(prompt).not.toMatch(/rollback/i);
  }
  const history = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true });
  expect(history).toContain("### Earlier tasks in the session");
  expect(history).toContain("Restore the definition task N saved");
  expect(history).toContain("When a task is answered, the dataflow as it stands is saved under that task's");
  expect(history).toContain("going back never removes a\nversion");
  expect(history).not.toMatch(/seal/i);
  expect(history).not.toContain("\"type\": \"fork\"");
  expect(history).not.toContain("Task catalog and provenance");
  expect(history).not.toContain("inputs from earlier tasks:\n- **");
  const ledger = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, stateLedger: true });
  expect(ledger).toContain("An answer's receipt is the task's catalog entry");
  expect(ledger).toContain("provenance");
  expect(ledger).toMatch(/top-k report represents\s+the selected rows/);
  expect(ledger).toContain("#### Task 2\n2 tables created.");
  const single = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
  expect(single).not.toContain("### Earlier tasks in the session");
  expect(single).not.toContain("### Example: build on an earlier task");
  const control = buildNativeModeSystemPrompt(ContextMode.DELTA, { multiTask: true, retrievalViews: ["sample"] });
  expect(control).toContain("### Earlier tasks in the session");
  expect(control).toContain("Earlier versions are not kept, so build a second operator only when the");
  expect(control).toContain("### Example: revise a rule for the rest of the session");
  expect(control).not.toContain("remains saved under tasks 1 and 2");
  expect(control).not.toContain("fork operator");
  expect(control).not.toContain('"target": "state"');
  expect(control).not.toContain("{{");
  const section = control.split("### Example: build on an earlier task")[1];
  for (const [, json] of section.matchAll(/```json\n([\s\S]*?)\n```/g))
    expect(prepareDataflowActions(JSON.parse(json), ["sample"]).status).toBe("pending");
});

test("update from task restores a saved definition in place on today's inputs and reports upstream drift", async () => {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const context = { metadataStore };
  const first = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    `create operator items: scan("items.csv")
create operator eligible: filter(lambda row: row["active"], doc="Active items")
create operator score: map(lambda row: {**row, "score": 2*row["units"]+row["margin"]}, doc="Original priority score")
create edge items.out -> eligible.in
create edge eligible.out -> score.in`,
    context
  );
  const second = await planGraphEdit(
    first.workflow,
    `update operator eligible: filter(lambda row: row["active"] and row["premium"], doc="Premium active items")
update operator score: map(lambda row: {**row, "score": 3*row["units"]+row["margin"]}, doc="Current priority score")`,
    context
  );
  const storage = new WorkflowSnapshotStorage(id => (id === "s1" ? ["s1"] : ["s1", "s2"]));
  storage.createSnapshot("s1", first.workflow);
  storage.createSnapshot("s2", second.workflow);
  const tasks: HistoricalTask[] = [
    { taskId: 1, stepId: "s1", request: "Use active items", answer: "Original report" },
    { taskId: 2, stepId: "s2", request: "Change the population and score", answer: "Current report" },
  ];
  const restored = restoreCommands(storage, tasks[0], second.workflow, "score");
  expect(restored.existed).toBe(true);
  expect(restored.commands.startsWith("update operator score: map(")).toBe(true);
  expect(restored.commands).toContain('2*row["units"]');
  // The population changed in task 2; the rolled-back rule runs on today's version of it.
  expect(upstreamDrift(storage, tasks[0], second.workflow, "score")).toEqual(["eligible"]);
  const third = await planGraphEdit(second.workflow, restored.commands, context);
  const score = third.workflow.operators.find(o => o.operatorID === "score")!;
  expect(score.nativeOp!.source).toContain('2*row["units"]');
  expect(score.nativeOp!.inputs).toEqual(["eligible"]);
  expect(third.workflow.operators.find(o => o.operatorID === "eligible")).toEqual(
    second.workflow.operators.find(o => o.operatorID === "eligible")!
  );
  // A deleted operator is re-created with the sealed edges that still resolve.
  const without = await planGraphEdit(second.workflow, "delete operator score", context);
  const recreated = restoreCommands(storage, tasks[0], without.workflow, "score");
  expect(recreated.existed).toBe(false);
  expect(recreated.commands).toContain("create operator score: map(");
  expect(recreated.commands).toContain("create edge eligible.out -> score.in");
  expect(recreated.restoredInputs).toEqual(["eligible"]);
  expect(() => restoreCommands(storage, tasks[0], second.workflow, "missing")).toThrow(/did not exist at task 1/);
  expect(storage.getWorkflow("s1")).toEqual(first.workflow);
  expect(storage.getWorkflow("s2")).toEqual(second.workflow);
});

test("single-task prompts leave out multi-task guidance; the multi flag adds it back unchanged", () => {
  const existingGraph = "An existing graph may already contain useful work; inspect what is relevant";
  const views = ["full", "sample", "sample_stats"] as const;
  for (const options of [{}, { retrievalViews: [...views], dataEvidence: true, flowEvidence: true }]) {
    const single = buildNativeModeSystemPrompt(ContextMode.DELTA, options);
    expect(single).not.toContain(existingGraph);
    expect(single).not.toContain("existing work");
    expect(single).not.toContain("Reuse\n   tables that already express the required work.");
    expect(single).not.toContain("### Earlier tasks in the session");
    expect(single).toContain("1. **Understand the request.** Identify the required answer,");
    expect(single).not.toContain("{{");
  }
  for (const options of [{ multiTask: true }, { multiTask: true, stateHistory: true, stateLedger: true }, { session: true }]) {
    const multi = buildNativeModeSystemPrompt(ContextMode.DELTA, options);
    expect(multi).toContain(existingGraph);
    expect(multi).toContain("1. **Understand the request and existing work.** Identify the required answer,");
    expect(multi).toContain("Reuse\n   tables that already express the required work.");
    expect(multi).not.toContain("{{");
  }
});
