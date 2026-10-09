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

// State across tasks in the assignment form: an in-place change to a shared
// function's setting, the effect it reports against the saved version,
// `name@N` inputs, and restoring a definition in place.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { prepareDataflowActions, renderDataflowActionsResult, type DataflowAction, type DataflowActionsResult } from "./dataflow-actions";
import { TexeraAgent } from "../texera-agent";
import { AgentMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

const ORDERS = [
  { unit: "a", amount: 3 },
  { unit: "b", amount: 2 },
  { unit: "c", amount: 1 },
];

/** A stand-in engine: scores = amount × weight, top = the two highest scores. */
function results(agent: any) {
  const state = agent.workflowState;
  const scoresOp = state.getOperator("scores")?.nativeOp;
  const weight = Number((scoresOp?.properties.params as any)?.weight ?? 1);
  const scores = ORDERS.map(row => ({ unit: row.unit, score: row.amount * weight }));
  const top = [...scores].sort((x, y) => y.score - x.score || x.unit.localeCompare(y.unit)).slice(0, 2);
  return { orders: ORDERS, scores, top, shift: scores } as Record<string, Record<string, unknown>[]>;
}

function session(batches: DataflowAction[][]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const outcomes: DataflowActionsResult[] = [];
  let executions = 0;
  const agent = new TexeraAgent({
    agentId: "state-assignments-test",
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
  (agent as any).executePostStepChanges = async () => {
    executions++;
    const tables = results(agent);
    for (const op of (agent as any).workflowState.getAllOperators()) {
      if (op.savedResult) {
        // The engine serves a saved handle from its retained materialization.
        const saved = (agent as any).snapshotStorage.getOperatorResult(op.savedResult.stepId, op.savedResult.operatorId);
        (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, { ...saved, state: "CompletedFromCache" });
        continue;
      }
      const rows = tables[op.operatorID] ?? [{ value: 1 }];
      const columns = Object.keys(rows[0]);
      (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: rows.length,
        totalRowCount: rows.length,
        resultMode: "table",
        result: rows,
        resultSchema: columns.map(name => ({ name, type: typeof rows[0][name] === "number" ? "double" : "string" })),
        resultVersion: { id: createHash("sha256").update(op.operatorID + JSON.stringify(rows)).digest("hex") },
        materialization: { executionId: String(executions), outputPort: 0, cached: false },
      } as any);
    }
  };
  const replace = (next: DataflowAction[][]) => batches.splice(0, batches.length, ...next);
  return { agent, outcomes, replace };
}

const TASK_1 = `orders = scan("data/orders.csv")
def score(orders, weight=1):
    """Unit scores: amount times {weight}."""
    out = orders.copy()
    out["score"] = out["amount"] * weight
    return out[["unit", "score"]]
scores = score(orders)
top = limit(scores, 2, by=[("score", "desc"), "unit"])`;

describe("state across tasks in assignment edits", () => {
  test("an in-place setting change reports its effect against the saved version", async () => {
    const s = session([
      [{ type: "edit", changes: TASK_1 }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: '{"top": ["a", "b"]}', operator_ids: ["top"] }],
    ]);
    await s.agent.sendMessage("Score the units and report the top two.");
    expect(s.outcomes[0].status).toBe("completed");
    s.replace([
      [{ type: "edit", changes: "scores = score(orders, weight=-1)" }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: '{"top": ["c", "b"]}', operator_ids: ["top"] }],
    ]);
    await s.agent.sendMessage("From now on, weight the scores by -1. Which units are on top now?");
    const receipt = renderDataflowActionsResult(s.outcomes[2]);
    expect(receipt).not.toContain("is the same table as the current");
    expect(receipt).toContain("results invalidated: scores, top");
    expect(receipt).toContain("changed since top@1: 2 → 2 rows; entered (1): c; left (1): a; 1 kept with new values (rows matched on unit).");
    expect(receipt).not.toContain("changed since orders@1");
    expect(receipt).toContain("changed since scores@1: 3 → 3 rows; 3 kept with new values (rows matched on unit).");
  });

  test("saved versions are inputs and in-place restores", async () => {
    const s = session([
      [{ type: "edit", changes: TASK_1 }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: "done", operator_ids: ["top"] }],
    ]);
    await s.agent.sendMessage("Task 1.");
    s.replace([
      [{ type: "edit", changes: "scores = score(orders, weight=-1)" }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: "done", operator_ids: ["top"] }],
    ]);
    await s.agent.sendMessage("Task 2.");
    s.replace([
      [
        { type: "edit", changes: 'shift = diff(scores@1, scores, key=["unit"], columns=["score"])' },
        { type: "execute", operator_ids: ["shift"] },
      ],
      [{ type: "edit", changes: "scores = scores@1" }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: "done", operator_ids: ["shift"] }],
    ]);
    await s.agent.sendMessage("Compare with task 1, then go back to the first rule.");
    expect(s.outcomes[4].status).toBe("completed");
    const workflow = s.agent.getWorkflowState().getWorkflowContent();
    const handles = workflow.operators.filter(op => op.savedResult);
    expect(handles.map(op => op.savedResult!.operatorId)).toContain("scores");
    // The restore brings back task 1's setting; the shared function itself is unchanged.
    expect(s.outcomes[5].status).toBe("completed");
    expect(s.agent.getWorkflowState().getOperator("scores")!.nativeOp!.properties.params).toEqual({});
    expect(s.agent.getWorkflowState().getOperator("scores")!.nativeOp!.properties.entry).toBe("score");
  });

  test("restoring a call whose function changed keeps the old code under its own name", async () => {
    const s = session([
      [{ type: "edit", changes: TASK_1 }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: "done", operator_ids: ["top"] }],
    ]);
    await s.agent.sendMessage("Task 1.");
    s.replace([
      [{ type: "edit", changes: TASK_1.split("\n").slice(1, 6).join("\n").replace('* weight', '* weight + 1') }, { type: "execute", operator_ids: ["top"] }],
      [{ type: "answer", content: "done", operator_ids: ["top"] }],
    ]);
    await s.agent.sendMessage("Task 2: add one to every score from now on.");
    expect(renderDataflowActionsResult(s.outcomes[2])).toContain("score redefined; its callers scores recompute");
    s.replace([
      [{ type: "edit", changes: "scores = scores@1" }],
      [{ type: "answer", content: "done", operator_ids: [] }],
    ]);
    await s.agent.sendMessage("Task 3: go back to the first scores.");
    const restored = s.agent.getWorkflowState().getOperator("scores")!.nativeOp!;
    expect(restored.properties.entry).toBe("score_t1");
    expect(String(restored.properties.code)).toContain("def score_t1(");
    expect(String(restored.properties.code)).not.toContain("+ 1");
    expect(renderDataflowActionsResult(s.outcomes[4])).toContain("now named score_t1; score keeps its current definition");
  });
});
