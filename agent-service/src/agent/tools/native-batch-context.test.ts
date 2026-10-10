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

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode, type ReActStep, type ResultSelection } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { assembleContext, latestNativeActionReceipt } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import { planRegisteredGraphEdit } from "./graph-edits";
import { prepareDataflowCall } from "./turn-tool";

const predicate = "def positive(row, *, minimum=0):\n    return row['x'] > minimum";
const source = "set source: scan(files='data/test.csv')";
const selected = (minimum: number) =>
  `set selected: filter(source, predicate='positive', settings={'minimum': ${minimum}})`;
const total = "set total: aggregate(selected, outputs={'n': count()})";

/** Steps as the agent records them: the call, its completed receipt, and the
 * snapshot after its edit. Results are written separately, as the engine would. */
function fixture() {
  const state = new WorkflowState();
  const metadataStore = new WorkflowSystemMetadata();
  metadataStore.seedCodeModeDefaults();
  const steps: ReActStep[] = [];
  const storage = new WorkflowSnapshotStorage(id =>
    steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
  );
  const record = async (id: string, python: string, statements: string, observe: string[] = []) => {
    const input = { python, statements };
    const output = prepareDataflowCall(input);
    expect(output.status).toBe("pending");
    for (const item of output.actions) {
      if (item.action.type === "edit") {
        const plan = await planRegisteredGraphEdit(
          state.getWorkflowContent(),
          item.action.python,
          item.action.changes,
          { metadataStore }
        );
        state.setWorkflowContent(plan.workflow);
        output.operators.push(...plan.operators);
      }
      item.status = "ok";
    }
    output.status = "completed";
    output.observe = observe;
    steps.push({
      id,
      parentId: steps.at(-1)?.id,
      messageId: "m",
      stepId: steps.length + 1,
      timestamp: 1,
      role: "agent",
      content: "",
      isBegin: false,
      isEnd: false,
      toolCalls: [{ toolName: "dataflow", toolCallId: id, input }],
      toolResults: [{ toolCallId: id, output }],
    });
    storage.createSnapshot(id, state.getWorkflowContent());
    return output;
  };
  const result = (stepId: string, opId: string, value: string, error?: string) => {
    storage.setOperatorResult(stepId, opId, {
      state: error ? "Failed" : "Completed",
      inputTuples: 0,
      outputTuples: 1,
      totalRowCount: 1,
      resultMode: "table",
      result: [{ value }],
      error,
    } as OperatorInfo);
  };
  return { state, steps, storage, record, result };
}

describe("dataflow receipts and observations in LATEST context", () => {
  test("LATEST retains only the current task's last completed receipt", async () => {
    const f = fixture();
    await f.record("write", "", source);
    f.result("write", "source", "visible_after_pull");
    await f.record("read", "", "show result source", ["source"]);
    const render = (mode: ContextMode) =>
      JSON.stringify(
        assembleContext(f.steps, f.state, f.storage, mode, {
          agentMode: AgentMode.NATIVE,
        })
      );
    expect(render(ContextMode.LATEST)).toContain("Last completed action in this task:");
    expect(render(ContextMode.LATEST)).toContain("visible_after_pull");
    expect(render(ContextMode.DELTA)).not.toContain("Last completed action in this task:");
    const receipt = latestNativeActionReceipt(f.steps)!;
    expect(receipt).toContain("dataflow completed: 1. execute ok; 2. retrieve ok.");
    expect(receipt).not.toContain("data/test.csv");
    expect(receipt).not.toContain("visible_after_pull");
    const next: ReActStep = { ...f.steps[1]!, id: "new-task", role: "user", toolCalls: [], toolResults: [] };
    expect(latestNativeActionReceipt([...f.steps, next])).toBeUndefined();
    expect(latestNativeActionReceipt([{ ...f.steps[1]!, toolResults: [] }])).toBeUndefined();
  });

  test("LATEST inspection receipt is bounded and does not echo diagnostic content", () => {
    const step: ReActStep = {
      id: "inspect",
      messageId: "m",
      stepId: 1,
      timestamp: 1,
      role: "agent",
      content: "",
      isBegin: false,
      isEnd: false,
      toolCalls: [{ toolName: "inspectError", toolCallId: "i", input: { operatorId: "filtered" } }],
      toolResults: [{ toolCallId: "i", output: "PRIVATE_DIAGNOSTIC" }],
    };
    const receipt = latestNativeActionReceipt([step])!;
    expect(receipt).toContain('inspectError for "filtered"');
    expect(receipt).toContain("saved inspection");
    expect(receipt).not.toContain("PRIVATE_DIAGNOSTIC");
    step.toolCalls![0]!.input = { operatorId: "x".repeat(2000) };
    expect(latestNativeActionReceipt([step])!.length).toBeLessThanOrEqual(1200);
  });

  for (const messageLayout of [undefined, "native", "block"] as const) {
    for (const resultSelection of ["all", "rule", "scoped"] as ResultSelection[]) {
      test(`LATEST/${messageLayout ?? "default"}/${resultSelection}: upstream edits hide fresh descendants until shown`, async () => {
        const { state, steps, storage, record, result } = fixture();
        const text = () =>
          JSON.stringify(
            assembleContext(steps, state, storage, ContextMode.LATEST, {
              agentMode: AgentMode.NATIVE,
              resultSelection,
              messageLayout,
              flowEvidence: true,
              dataEvidence: true,
            })
          );

        await record("s1", predicate, [total, selected(0), source, "show result total"].join("\n"), ["total"]);
        result("s1", "source", "source_private_marker");
        result("s1", "selected", "selected_old_private_marker");
        result("s1", "total", "total_old_public_marker");
        expect(text()).toContain("total_old_public_marker");
        expect(text()).not.toContain("source_private_marker");
        expect(text()).not.toContain("selected_old_private_marker");

        const revised = await record("s2", "", selected(10));
        expect(revised.observe).toEqual([]);
        // Snapshot invalidation follows the actual DAG, including unedited descendants.
        expect(storage.getOperatorResult("s2", "selected")).toBeUndefined();
        expect(storage.getOperatorResult("s2", "total")).toBeUndefined();
        expect(storage.getOperatorResult("s2", "source")?.result).toEqual([{ value: "source_private_marker" }]);
        // Even equal row counts are a new execution, not proof of unchanged contents.
        result("s2", "selected", "selected_new_private_marker");
        result("s2", "total", "total_new_private_marker");
        const hidden = text();
        expect(hidden).not.toContain("selected_new_private_marker");
        expect(hidden).not.toContain("total_new_private_marker");
        expect(hidden).not.toContain("total_old_public_marker");
        expect(hidden).toContain("result not requested");
        for (const id of ["source", "selected", "total"]) expect(hidden).toContain(id);
        expect(hidden).toContain("'minimum': 10");

        await record("s3", "", "show result total", ["total"]);
        expect(storage.getOperatorResult("s3", "total")).toEqual(storage.getOperatorResult("s2", "total"));
        expect(text()).toContain("total_new_private_marker");
        expect(text()).not.toContain("selected_new_private_marker");
        expect(text()).not.toContain("total_old_public_marker");

        // A new request replaces the LATEST set.
        await record("s4", "", "show result source", ["source"]);
        expect(text()).toContain("source_private_marker");
        expect(text()).not.toContain("total_new_private_marker");
        expect(storage.getOperatorResult("s1", "total")?.result).toEqual([{ value: "total_old_public_marker" }]);

        // Unrequested errors always remain actionable.
        await record("s5", "", selected(20));
        result("s5", "selected", "", "unrequested_execution_failure_marker");
        expect(text()).toContain("unrequested_execution_failure_marker");
      });
    }
  }
});
