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

// Saved-versions sessions (stateHistory on, the public `dataflow` tool): the
// retired commands are refused with the `@N` form, result handles cannot be
// deleted and do not linger, the boundary receipt says what was saved and
// whether retention worked, and a batched read keeps the columns each table has.
import { describe, expect, test } from "bun:test";
import { prepareDataflowActions, renderDataflowActionsResult, type DataflowAction, type DataflowActionsResult } from "./dataflow-actions";
import { TexeraAgent } from "../texera-agent";
import { AgentMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { selectAnswerRows } from "../native/answer";
import type { OperatorInfo } from "../../types/execution";

function session(batches: DataflowAction[][], schemaOf: (id: string) => string[] = () => ["value"]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const outcomes: DataflowActionsResult[] = [];
  let executions = 0;
  const agent = new TexeraAgent({
    agentId: "saved-fixes-test",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      async runTurn(input) {
        for (const [i, actions] of batches.entries()) {
          const args = { reasoning: "Next step.", actions };
          const output = prepareDataflowActions(args, ["full", "sample", "sample_stats"], true, true);
          await input.onStepFinish({
            text: "",
            toolCalls: [{ toolName: "dataflow", toolCallId: `t${i}`, input: args }],
            toolResults: [{ toolCallId: `t${i}`, output }],
          });
          outcomes.push(output);
          if (input.getFinalAnswer?.() !== undefined) break;
        }
        return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
      },
    },
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, retrievalViews: ["full", "sample", "sample_stats"], stateHistory: true });
  (agent as any).executePostStepChanges = async (_calls: unknown, _results: unknown, _explicit: boolean, operatorIds?: readonly string[]) => {
    executions++;
    for (const op of (agent as any).workflowState.getAllOperators()) {
      if (op.savedResult || (operatorIds && !operatorIds.includes(op.operatorID))) continue;
      const columns = schemaOf(op.operatorID);
      (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 2,
        totalRowCount: 2,
        resultMode: "table",
        result: [1, 2].map(n => Object.fromEntries(columns.map(c => [c, `${c}-${n}`]))),
        resultSchema: columns.map(name => ({ name, type: "str" })),
        // The exact engine identity a saved edge binds to.
        materialization: { executionId: String(executions), outputPort: 0, cached: false },
      });
    }
  };
  const replace = (next: DataflowAction[][]) => batches.splice(0, batches.length, ...next);
  return { agent, outcomes, replace, executions: () => executions };
}

describe("saved-versions sessions after the 2026-10-06 audit", () => {
  test("retired fork and restore commands are refused with the @N form, and replay still accepts them", async () => {
    const s = session([
      [{ type: "edit", changes: 'create operator source: scan("old.csv")' }, { type: "execute", operator_ids: ["source"] }],
      [{ type: "answer", content: "Saved.", operator_ids: ["source"] }],
    ]);
    await s.agent.sendMessage("Build the baseline.");
    s.replace([
      [{ type: "edit", changes: "fork operator source from task 1 as earlier" }],
      [{ type: "edit", changes: "update operator source from task 1" }],
      [{ type: "edit", changes: "create operator earlier from source@1" }, { type: "execute", operator_ids: ["earlier"] }],
      [{ type: "answer", content: "Done.", operator_ids: ["earlier"] }],
    ]);
    await s.agent.sendMessage("Return to the first version.");
    const fork = s.outcomes[2].actions[0];
    expect(fork.status).toBe("error");
    expect(String(fork.output)).toContain("Forks are not available");
    expect(String(fork.output)).toContain("create operator earlier from source@1");
    const restore = s.outcomes[3].actions[0];
    expect(restore.status).toBe("error");
    expect(String(restore.output)).toContain("update operator source from source@1");
    expect(s.outcomes[4].status).toBe("completed");
    expect(s.agent.getWorkflowState().getOperator("earlier")?.nativeOp?.source).toContain("old.csv");
    expect(s.agent.getWorkflowState().getOperator("source")).toBeDefined();
  });

  test("the boundary receipt records what the task saved and says whether retention worked", async () => {
    const s = session([
      [{ type: "edit", changes: 'create operator source: scan("a.csv")\ncreate operator pending: scan("b.csv")' }, { type: "execute", operator_ids: ["source"] }],
      [{ type: "answer", content: "Saved the source.", operator_ids: ["source"] }],
    ]);
    await s.agent.sendMessage("Build the baseline.");
    const receipt = renderDataflowActionsResult(s.outcomes[1]);
    // Every table is readable as name@1 later; the receipt names the answer's
    // source and no longer lists a saved handle per operator.
    expect(receipt).toContain("Answer sources: `source`");
    expect(receipt).not.toContain("saved as");
    // The mock session has no engine: the receipt must say so rather than
    // promising a materialization that was never retained.
    expect(receipt).toContain("Retention: RETENTION_UNAVAILABLE");
    expect(s.agent.getTaskHistory()[0].saved_versions).toEqual(["source"]);
  });

  test("a saved-result handle cannot be deleted and disappears with its consumer", async () => {
    const s = session([
      [{ type: "edit", changes: 'create operator source: scan("a.csv")' }, { type: "execute", operator_ids: ["source"] }],
      [{ type: "answer", content: "Saved.", operator_ids: ["source"] }],
    ]);
    await s.agent.sendMessage("Build the baseline.");
    s.replace([
      [{ type: "edit", changes: "create operator copy: project(keep=[\"value\"])\ncreate edge source@1.out -> copy.in" }],
      [{ type: "answer", content: "Connected.", operator_ids: [] }],
    ]);
    await s.agent.sendMessage("Connect the saved table.");
    const handles = () => s.agent.getWorkflowState().getAllOperators().filter(op => op.savedResult).map(op => op.operatorID);
    expect(handles()).toHaveLength(1);
    const handle = handles()[0];
    s.replace([
      [{ type: "edit", changes: `delete operator ${handle}` }],
      [{ type: "edit", changes: "delete operator copy" }],
      [{ type: "answer", content: "Removed.", operator_ids: [] }],
    ]);
    await s.agent.sendMessage("Remove the copy.");
    expect(s.outcomes[4].actions[0].status).toBe("error");
    expect(String(s.outcomes[4].actions[0].output)).toContain("read-only");
    expect(s.outcomes[5].status).toBe("completed");
    expect(handles()).toEqual([]);
    expect(s.agent.getWorkflowState().getOperator("copy")).toBeUndefined();
  });

  test("a batched read applies the columns each table has and refuses a table with none of them", async () => {
    const s = session(
      [
        [{ type: "edit", changes: 'create operator alpha: scan("a.csv")\ncreate operator beta: scan("b.csv")' }, { type: "execute", operator_ids: ["alpha", "beta"] }],
        [{ type: "read", operator_ids: ["alpha", "beta"], view: "full", include_implementation: false, columns: ["shared", "only_alpha"] }],
        [{ type: "read", operator_ids: ["beta"], view: "full", include_implementation: false, columns: ["only_alpha"] }],
        [{ type: "answer", content: "Read.", operator_ids: [] }],
      ],
      id => (id === "alpha" ? ["shared", "only_alpha"] : ["shared", "only_beta"])
    );
    await s.agent.sendMessage("Read both tables.");
    const read = s.outcomes[1];
    expect(read.status).toBe("completed");
    const text = renderDataflowActionsResult(read);
    expect(text).toContain("beta has no columns only_alpha; its other requested columns are shown");
    expect(text).not.toContain("alpha has no columns");
    const refused = s.outcomes[2];
    expect(refused.status).toBe("error");
    expect(String(refused.actions[0].output)).toContain("UNKNOWN_COLUMN: beta has no columns only_alpha");
  });
});

test("a boundary tie names a column that identifies the rows when one exists", () => {
  const info = {
    state: "Completed", inputTuples: 0, outputTuples: 3, totalRowCount: 3, resultMode: "table",
    result: [{ unit: "a", amount: 5 }, { unit: "b", amount: 5 }, { unit: "c", amount: 1 }],
    resultSchema: [{ name: "unit", type: "str" }, { name: "amount", type: "int" }],
  } as unknown as OperatorInfo;
  const tie = selectAnswerRows("scores", info, { n: 1, by: [{ column: "amount", desc: true }] });
  expect(tie).toMatchObject({ reason: expect.stringContaining("such as unit asc") });
  const numeric = { ...info, result: [{ amount: 5, other: 1 }, { amount: 5, other: 2 }, { amount: 1, other: 3 }],
    resultSchema: [{ name: "amount", type: "int" }, { name: "other", type: "int" }] } as unknown as OperatorInfo;
  const plain = selectAnswerRows("scores", numeric, { n: 1, by: [{ column: "amount", desc: true }] });
  expect(plain).toMatchObject({ reason: expect.stringContaining("add a tie-breaking sort column to choose") });
  expect(JSON.stringify(plain)).not.toContain("such as");
});
