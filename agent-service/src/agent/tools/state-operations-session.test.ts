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

// State operations in a running session: how held statements are reported,
// what each task's entry says it changed, and how entries list columns.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { prepareDataflowActions, renderDataflowActionsResult, type DataflowAction, type DataflowActionsResult } from "./dataflow-actions";
import { TexeraAgent } from "../texera-agent";
import { AgentMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

const ORDERS = [
  { unit: "a", amount: 3, refund: 0 },
  { unit: "b", amount: 2, refund: 2 },
  { unit: "c", amount: 1, refund: 0 },
];

/** A stand-in engine for score calls and limits, from each operator's own settings. */
function rowsOf(agent: any, id: string): Record<string, unknown>[] {
  const view = agent.workflowState.getOperator(id)?.nativeOp;
  if (!view) return [];
  if (view.type === "Process") {
    const weight = Number(view.settings?.refund_weight ?? 0);
    return ORDERS.map(row => ({ unit: row.unit, score: row.amount - weight * row.refund }));
  }
  if (view.type === "Limit")
    return [...rowsOf(agent, view.inputs[0])]
      .sort((x: any, y: any) => y.score - x.score || x.unit.localeCompare(y.unit))
      .slice(0, Number(view.properties.n));
  return ORDERS;
}

function session(batches: DataflowAction[][]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const outcomes: DataflowActionsResult[] = [];
  let executions = 0;
  const agent = new TexeraAgent({
    agentId: "state-operations-session-test",
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
    for (const op of (agent as any).workflowState.getAllOperators()) {
      if (op.savedResult) {
        const saved = (agent as any).snapshotStorage.getOperatorResult(op.savedResult.stepId, op.savedResult.operatorId);
        (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, { ...saved, state: "CompletedFromCache" });
        continue;
      }
      const rows = rowsOf(agent, op.operatorID);
      (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: rows.length,
        totalRowCount: rows.length,
        resultMode: "table",
        result: rows,
        resultSchema: Object.keys(rows[0] ?? { value: 1 }).map(name => ({ name, type: name === "unit" ? "string" : "double" })),
        resultVersion: { id: createHash("sha256").update(op.operatorID + JSON.stringify(rows)).digest("hex") },
        materialization: { executionId: String(executions), outputPort: 0, cached: false },
      } as any);
    }
  };
  const replace = (next: DataflowAction[][]) => batches.splice(0, batches.length, ...next);
  return { agent, outcomes, replace };
}

const TASK_1 = `orders = scan("data/orders.csv")
def score(orders, refund_weight=0.0):
    """One row per unit: amount minus {refund_weight} times refunds."""
    out = orders.copy()
    out["score"] = out["amount"] - refund_weight * out["refund"]
    return out[["unit", "score"]]
scores = score(orders)
top2 = limit(scores, 2, by=[("score", "desc"), "unit"])`;

test("a held statement is reported, stops the call, and leaves the applied ones", async () => {
  const s = session([
    [
      { type: "edit", changes: `${TASK_1}\nbroken = limit(scores, 0)` },
      { type: "execute", operator_ids: ["top2"] },
    ],
  ]);
  await s.agent.sendMessage("Task 1.");
  const receipt = renderDataflowActionsResult(s.outcomes[0]);
  expect(s.outcomes[0].actions[0].status).toBe("error");
  expect(receipt).toContain("- held back, line 9 `broken = limit(scores, 0)`: Invalid limit arguments");
  expect(receipt).toContain("The other statements applied. Resend only the held statements, corrected.");
  expect(s.outcomes[0].actions[1].status).toBe("skipped");
  expect(s.agent.getWorkflowState().getOperator("top2")).toBeDefined();
});

test("each task's entry says what it did to the tables it changed", async () => {
  const s = session([
    [{ type: "edit", changes: TASK_1 }, { type: "execute", operator_ids: ["top2"] }],
    [{ type: "answer", content: "done", operator_ids: ["top2"] }],
  ]);
  await s.agent.sendMessage("Task 1.");
  s.replace([
    [{ type: "edit", changes: "scores = score(orders, refund_weight=1.0)" }, { type: "execute", operator_ids: ["top2"] }],
    [{ type: "answer", content: "done", operator_ids: ["top2"] }],
  ]);
  await s.agent.sendMessage("Task 2: refunds count in full from now on.");
  expect(renderDataflowActionsResult(s.outcomes[3])).toContain("> - **scores** (process, updated: set refund_weight 0 to 1)");
  s.replace([
    [{ type: "edit", changes: "scores = scores@1" }, { type: "execute", operator_ids: ["top2"] }],
    [{ type: "answer", content: "done", operator_ids: ["top2"] }],
  ]);
  await s.agent.sendMessage("Task 3: go back to the first rule.");
  const receipt = renderDataflowActionsResult(s.outcomes[5]);
  expect(receipt).toContain("> - **scores** (process, updated: restored task 1's version)");
  expect(receipt).toContain("  - doc: One row per unit: amount minus 0 times refunds.");
});

test("an entry lists columns where a chain starts and only the change after that", async () => {
  const s = session([
    [{ type: "edit", changes: TASK_1 }, { type: "execute", operator_ids: ["top2"] }],
    [{ type: "answer", content: "done", operator_ids: ["top2"] }],
  ]);
  await s.agent.sendMessage("Task 1.");
  const entry = renderDataflowActionsResult(s.outcomes[1]);
  expect(entry).toContain("> - **orders** (scan, created)");
  expect(entry).toContain(">   - columns: unit str, amount float64, refund float64");
  // A different set of columns is listed; the cut keeps its input's.
  expect(entry).toContain(">   - columns: unit str, score float64");
  expect(entry).toContain(">   - columns: same as `scores`");
  // The definition shows every setting, so the entry needs no signature, and
  // a limit's definition already says what it selects.
  expect(entry).toContain(">   - definition: `score(refund_weight=0)`");
  expect(entry).not.toContain("signature:");
  expect(entry).not.toContain("scope:");
});

test("an entry keeps what an edit with a held statement applied", async () => {
  const s = session([
    [{ type: "edit", changes: `${TASK_1}\nview = scores` }, { type: "execute", operator_ids: ["top2"] }],
    [{ type: "edit", changes: 'view = limit(scores, 3, by=[("score", "desc"), "unit"])' }, { type: "execute", operator_ids: ["top2", "view"] }],
    [{ type: "answer", content: "done", operator_ids: ["top2"] }],
  ]);
  await s.agent.sendMessage("Task 1.");
  expect(s.outcomes[0].actions[0].status).toBe("error");
  const entry = renderDataflowActionsResult(s.outcomes[2]);
  const order = ["orders", "scores", "top2", "view"].map(id => entry.indexOf(`> - **${id}** (`));
  expect(order.every(i => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(entry).toContain("> - **scores** (process, created)");
  expect(entry).not.toContain("(process, updated)");
});
