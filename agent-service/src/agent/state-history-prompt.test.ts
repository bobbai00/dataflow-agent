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
import { restoreAssignment, splitVersionCommands, upstreamDrift } from "./state-ledger";
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

test("task retrieval examples check reusable branches and declare answer roots without benchmark hints", () => {
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, retrievalViews: [view] });
    const section =
      prompt.split("### Example: retrieve a relevant task before reusing its work")[1]?.split("### Example:")[0] ?? "";
    const calls = Array.from(section.matchAll(/```json\n([\s\S]*?)\n```/g), m => JSON.parse(m[1]));
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(prepareDataflowActions(call, [view], true).status).toBe("pending");
    expect(calls[0].actions[0]).toMatchObject({ target: "task", operator_id: null, view });
    expect(calls[0].reasoning).toContain("task 2");
    expect(calls[2].actions[0]).toEqual({ type: "answer", from: "by_region[region,count]" });
    expect(section).not.toMatch(/LongDS|Kiva|Netflix|NFL|Kaggle/i);
    expect(prompt).toContain("local answer computation");
    expect(prompt).toContain("saved input\nreferences");
    expect(prompt).toContain("without expanding their graphs");
    expect(prompt).toContain("Graph inspection requires named `operator_ids`");
    expect(prompt).toContain("Dependency links help locate useful");
    expect(prompt).not.toContain("{{");
  }
});

test("computed answers prefer runtime composition and narrow the first retrieval", () => {
  for (const stateHistory of [false, true]) {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory });
    expect(prompt).toContain("Prefer `answer` with `from` for tabular answers");
    expect(prompt).toContain("Use `columns` when a wide result hides the fields you need");
  }
});

test("scope and repair guidance is general and works in ordinary ReAct without a ledger or check interface", () => {
  const single = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
  expect(single).toContain("Completeness describes the stored result");
  expect(single).toContain("scope");
  expect(single).toContain("A smaller table is right when the request asks for that selection");
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { multiTask: true, retrievalViews: [view] });
    const section =
      prompt.split("### Example: repair an aggregate that reads a limited report")[1]?.split("\n### Example:")[0] ?? "";
    expect(section).toContain("covered_scores");
    expect(section).toContain("scope: limit");
    expect(section).not.toMatch(/LongDS|Kiva|Netflix|NFL|Kaggle|check=/i);
    expect(prompt).not.toContain("Task catalog and provenance");
    for (const [, json] of section.matchAll(/```json\n([\s\S]*?)\n```/g))
      expect(prepareDataflowActions(JSON.parse(json), [view]).status).toBe("pending");
  }
});

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
    expect(prompt).toContain("`name = at(name, task=N)`");
    expect(prompt).toContain("`new_name = at(name, task=N)`");
    expect(prompt).not.toMatch(/rollback/i);
  }
  const history = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true });
  expect(history).toContain("### Earlier tasks in the session");
  expect(history).toContain("Restore the definition task N saved");
  expect(history).toContain("When a task is answered, the dataflow as it stands is saved under that task's");
  expect(history).toContain("going back never removes a\nversion");
  expect(history).not.toMatch(/seal/i);
  expect(history).not.toContain('"type": "fork"');
  expect(history).not.toContain("Task catalog and provenance");
  expect(history).not.toContain("inputs from earlier tasks:\n- **");
  const ledger = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, stateLedger: true });
  expect(ledger).toContain("An answer's receipt is the task's catalog entry");
  expect(ledger).toContain("provenance");
  expect(ledger).toMatch(/top-k report represents\s+the selected rows/);
  expect(ledger).toContain("covered_scores");
  const single = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
  expect(single).not.toContain("### Earlier tasks in the session");
  expect(single).not.toContain("### Example: build on an earlier task");
  const control = buildNativeModeSystemPrompt(ContextMode.DELTA, { multiTask: true, retrievalViews: ["sample"] });
  expect(control).toContain("### Earlier tasks in the session");
  expect(control).toContain("Earlier versions are not kept, so build a second operator only when the");
  expect(control).toContain("### Example: revise a rule for the rest of the session");
  expect(control).not.toContain("remains saved under tasks 1 and 2");
  expect(control).not.toContain("= at(");
  expect(control).not.toContain('"target": "state"');
  expect(control).not.toContain("{{");
  const section = control.split("### Example: build on an earlier task")[1];
  for (const [, json] of section.matchAll(/```json\n([\s\S]*?)\n```/g))
    expect(prepareDataflowActions(JSON.parse(json), ["sample"]).status).toBe("pending");
});

test("a restore assignment brings back a saved definition in place on today's inputs and reports upstream drift", async () => {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const context = { metadataStore };
  const first = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    `items = scan("items.csv")
eligible = filter(items, lambda row: row["active"], doc="Active items")
score = map(eligible, lambda row: {**row, "score": 2*row["units"]+row["margin"]}, doc="Original priority score")`,
    context
  );
  const second = await planGraphEdit(
    first.workflow,
    `eligible = filter(items, lambda row: row["active"] and row["premium"], doc="Premium active items")
score = map(eligible, lambda row: {**row, "score": 3*row["units"]+row["margin"]}, doc="Current priority score")`,
    context
  );
  const storage = new WorkflowSnapshotStorage(id => (id === "s1" ? ["s1"] : ["s1", "s2"]));
  storage.createSnapshot("s1", first.workflow);
  storage.createSnapshot("s2", second.workflow);
  const tasks: HistoricalTask[] = [
    { taskId: 1, stepId: "s1", request: "Use active items", answer: "Original report" },
    { taskId: 2, stepId: "s2", request: "Change the population and score", answer: "Current report" },
  ];
  const restored = restoreAssignment(storage, tasks[0], second.workflow, "score");
  expect(restored.existed).toBe(true);
  expect(restored.assignment.startsWith("score = map(eligible, lambda row:")).toBe(true);
  expect(restored.assignment).toContain('2*row["units"]');
  // The population changed in task 2; the rolled-back rule runs on today's version of it.
  expect(upstreamDrift(storage, tasks[0], second.workflow, "score")).toEqual(["eligible"]);
  const third = await planGraphEdit(second.workflow, restored.assignment, context);
  const score = third.workflow.operators.find(o => o.operatorID === "score")!;
  expect(score.nativeOp!.source).toContain('2*row["units"]');
  expect(score.nativeOp!.inputs).toEqual(["eligible"]);
  expect(third.workflow.operators.find(o => o.operatorID === "eligible")).toEqual(
    second.workflow.operators.find(o => o.operatorID === "eligible")!
  );
  // A deleted operator is re-created on its sealed inputs when they still exist.
  const without = await planGraphEdit(second.workflow, "del score", context);
  const recreated = restoreAssignment(storage, tasks[0], without.workflow, "score");
  expect(recreated.existed).toBe(false);
  expect(recreated.assignment.startsWith("score = map(eligible, lambda row:")).toBe(true);
  expect(recreated.restoredInputs).toEqual(["eligible"]);
  const orphaned = await planGraphEdit(without.workflow, "del eligible", context);
  expect(() => restoreAssignment(storage, tasks[0], orphaned.workflow, "score")).toThrow(
    "score's task-1 inputs eligible do not exist now; copy it with its saved inputs instead: `score_1 = at(score, task=1)`."
  );
  expect(() => restoreAssignment(storage, tasks[0], second.workflow, "missing")).toThrow(/did not exist at task 1/);
  expect(storage.getWorkflow("s1")).toEqual(first.workflow);
  expect(storage.getWorkflow("s2")).toEqual(second.workflow);
});

test("single-task prompts leave out multi-task guidance; the multi flag adds it back unchanged", () => {
  const existingGraph = "An existing graph may already contain useful work; inspect what is relevant";
  const views = ["full", "sample", "sample_stats"] as const;
  for (const options of [
    {},
    { nativePromptDetail: "on_demand" as const },
    { retrievalViews: [...views], dataEvidence: true, flowEvidence: true, fullResultCharLimit: 100_000, maxResultRows: 5 },
  ]) {
    const single = buildNativeModeSystemPrompt(ContextMode.DELTA, options);
    expect(single).not.toContain(existingGraph);
    expect(single).not.toContain("existing work");
    expect(single).not.toContain("Reuse\n   tables that already express the required work.");
    expect(single).not.toContain("### Earlier tasks in the session");
    expect(single).toContain("1. **Understand the request.** Identify the answer,");
    expect(single).not.toContain("{{");
  }
  for (const options of [{ multiTask: true }, { multiTask: true, stateHistory: true, stateLedger: true }, { session: true }]) {
    const multi = buildNativeModeSystemPrompt(ContextMode.DELTA, options);
    expect(multi).toContain(existingGraph);
    expect(multi).toContain("1. **Understand the request and existing work.** Identify the answer,");
    expect(multi).toContain("Reuse\n   tables that already express the required work.");
    expect(multi).not.toContain("{{");
  }
});
