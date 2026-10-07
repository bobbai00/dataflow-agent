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
  const section = prompt.split("### Example: one session whose rules change")[1] ?? "";
  const calls = Array.from(section.matchAll(/```json\n([\s\S]*?)\n```/g), m => JSON.parse(m[1]));
  return { prompt, section, calls };
}

test("saved-version examples inspect reusable rules and declare sources without benchmark hints", () => {
  for (const view of ["full", "sample", "sample_stats"] as const) {
    const { prompt, section, calls } = examples(view);
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(prepareDataflowActions(call, [view], true, true).status).toBe("pending");
    expect(calls.some(call => call.actions.some((a: any) => a.type === "read" && a.view === null))).toBe(true);
    expect(calls.some(call => call.actions.some((a: any) => a.type === "read" && a.operator_ids.some((id: string) => /@\d+$/.test(id))))).toBe(true);
    expect(calls.some(call => call.actions.some((a: any) => a.type === "answer" && a.from))).toBe(true);
    expect(section).not.toMatch(/LongDS|Kiva|Netflix|NFL|Kaggle/i);
    expect(prompt).toContain("Saved states may contain");
    expect(prompt).toContain("view: null");
    expect(prompt).toContain("without data");
    expect(prompt).not.toContain("{{");
  }
});

test("computed answers prefer runtime composition and narrow the first retrieval", () => {
  for (const stateHistory of [false, true]) {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory });
    expect(prompt).toContain("Prefer `answer` with `from` for tabular answers");
    expect(prompt).toContain("Select needed `columns` on the first retrieval");
  }
});

test("history guidance explains complete delta blocks and exact references without correctness or cache guarantees", () => {
  for (const nativePromptDetail of ["full", "on_demand"] as const) {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, nativePromptDetail });
    for (const text of ["first-edit order", "Function bodies", "Statistics and catalog records are off by default",
      "not a correctness guarantee", "All working tables", "HISTORICAL_RESULT_UNAVAILABLE",
      "never substitutes a newer table", "saved direct inputs", "exploratory reads do not become answer roots"])
      expect(prompt).toContain(text);
    expect(prompt).not.toMatch(/LongDS|Kiva|Netflix|Kaggle|cache hits guaranteed/i);
  }
});

test("scope and repair guidance is general and works in ordinary ReAct without a ledger or check interface", () => {
  const single = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
  expect(single).toContain("Completeness describes the stored result");
  expect(single).toContain("scope");
  expect(single).toContain("A smaller table is appropriate when the request asks for that selection");
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

test("multi-task saved versions use references while ordinary sessions keep their public vocabulary", () => {
  const history = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true });
  for (const text of ["scores@2", "scores = scores@2", "copy = scores@2", "diff(scores@2, scores",
    "matching completed", "today's inputs", "historical", "top 5 by score", "changed since"])
    expect(history.toLowerCase()).toContain(text.toLowerCase());
  expect(history).not.toContain('"type": "fork"');
  expect(history).not.toContain('"target": "state"');
  expect(history).not.toContain('"target": "task"');
  const single = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
  expect(single).not.toContain("### Earlier tasks in the session");
  expect(single).not.toContain("#### Saved versions");
  const control = buildNativeModeSystemPrompt(ContextMode.DELTA, { multiTask: true, retrievalViews: ["sample"] });
  expect(control).toContain("### Earlier tasks in the session");
  expect(control).toContain("### Example: revise a rule for the rest of the session");
  expect(control).not.toContain("#### Saved versions");
  expect(control).not.toContain('"target": "state"');
  expect(control).not.toContain("{{");
  for (const [, json] of control.matchAll(/```json\n([\s\S]*?)\n```/g))
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
