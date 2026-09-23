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
import { createNativeTools, type NativeBatchResult } from "./native-batch-tools";
import { dataflowInput, type LegacySpec } from "../native/test-support";

const source = { op: "scan", id: "source", files: "data/test.csv" };
const selected = { op: "filter", id: "selected", input: "source", predicate: "x > 0" };
const total = { op: "aggregate", id: "total", input: "selected", aggregations: [{ fn: "count" }] };

function fixture() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const tools = createNativeTools(state, { metadataStore: metadata });
  const steps: ReActStep[] = [];
  const storage = new WorkflowSnapshotStorage(id =>
    steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
  );
  const record = async (id: string, legacy: Record<string, unknown>): Promise<NativeBatchResult> => {
    const args = dataflowInput(legacy as { operators: LegacySpec[]; observe?: string[] });
    const output = await tools.dataflow.execute(args);
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
      toolCalls: [{ toolName: "dataflow", toolCallId: id, input: args }],
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

describe("explicit batch observations across context modes", () => {
  test("LATEST retains only the current task's last completed receipt", async () => {
    const f = fixture();
    await f.record("write", { operators: [source], observe: [] });
    f.result("write", "source", "visible_after_pull");
    await f.record("read", { operators: [], observe: ["source"] });
    const render = (mode: ContextMode) =>
      JSON.stringify(
        assembleContext(f.steps, f.state, f.storage, mode, {
          agentMode: AgentMode.NATIVE,
        })
      );
    expect(render(ContextMode.LATEST)).toContain("Last completed action in this task:");
    expect(render(ContextMode.LATEST)).toContain("cached read");
    expect(render(ContextMode.LATEST)).toContain("visible_after_pull");
    expect(render(ContextMode.DELTA)).not.toContain("Last completed action in this task:");
    const receipt = latestNativeActionReceipt(f.steps)!;
    expect(receipt).toContain('observe=["source"]');
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

  for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
    for (const messageLayout of [undefined, "native", "block"] as const) {
      for (const resultSelection of ["all", "rule", "scoped"] as ResultSelection[]) {
        test(`${mode}/${messageLayout ?? "default"}/${resultSelection}: upstream edits hide fresh descendants until observe`, async () => {
          const { state, steps, storage, record, result } = fixture();
          const render = () =>
            assembleContext(steps, state, storage, mode, {
              agentMode: AgentMode.NATIVE,
              resultSelection,
              messageLayout,
              flowEvidence: true,
              dataEvidence: true,
            });
          const text = () => JSON.stringify(render());

          await record("s1", { operators: [total, selected, source], observe: ["total"] });
          result("s1", "source", "source_private_marker");
          result("s1", "selected", "selected_old_private_marker");
          result("s1", "total", "total_old_public_marker");
          const before = render();
          expect(text()).toContain("total_old_public_marker");
          expect(text()).not.toContain("source_private_marker");
          expect(text()).not.toContain("selected_old_private_marker");

          const revised = await record("s2", { operators: [{ ...selected, predicate: "x > 10" }] });
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
          expect(hidden).not.toContain("terminal outputs (default)");
          expect(hidden).toContain("result not requested");
          if (mode === ContextMode.DELTA) {
            expect(hidden).toContain("total_old_public_marker");
            expect(hidden).toContain("re-executed");
            if (messageLayout === "native") expect(render().slice(0, before.length)).toEqual(before);
            else
              expect(
                render()
                  .map(m => m.content)
                  .join("\n")
                  .startsWith(before.map(m => m.content).join("\n"))
              ).toBe(true);
          } else {
            expect(hidden).not.toContain("total_old_public_marker");
            for (const id of ["source", "selected", "total"]) expect(hidden).toContain(id);
            expect(hidden).toContain("> 10");
          }

          const hiddenMessages = render();
          const read = await record("s3", { operators: [], observe: ["total"] });
          expect(read.operators).toEqual([]);
          expect(storage.getOperatorResult("s3", "total")).toEqual(storage.getOperatorResult("s2", "total"));
          expect(text()).toContain("total_new_private_marker");
          expect(text()).not.toContain("selected_new_private_marker");
          if (mode === ContextMode.DELTA) {
            expect(text()).toContain("observed (cached)");
            if (messageLayout === "native") expect(render().slice(0, hiddenMessages.length)).toEqual(hiddenMessages);
            else
              expect(
                render()
                  .map(m => m.content)
                  .join("\n")
                  .startsWith(hiddenMessages.map(m => m.content).join("\n"))
              ).toBe(true);
          } else {
            expect(text()).not.toContain("total_old_public_marker");
          }

          // A new visibility request replaces the LATEST set, but never rewrites DELTA history.
          await record("s4", { operators: [], observe: ["source"] });
          expect(text()).toContain("source_private_marker");
          expect(text().includes("total_new_private_marker")).toBe(mode === ContextMode.DELTA);
          expect(storage.getOperatorResult("s1", "total")?.result).toEqual([{ value: "total_old_public_marker" }]);

          // Unrequested errors always remain actionable in both modes.
          await record("s5", { operators: [{ ...selected, predicate: "missing > 0" }], observe: [] });
          result("s5", "selected", "", "unrequested_execution_failure_marker");
          expect(text()).toContain("unrequested_execution_failure_marker");
        });
      }
    }
  }
});
