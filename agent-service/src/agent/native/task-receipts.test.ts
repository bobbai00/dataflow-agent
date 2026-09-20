/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import {
  TaskHistory,
  emptyTaskEffects,
  formatTaskReceipt,
  historicalReferences,
  receiptFromEffects,
} from "./task-history";
import { assembleTaskContext, operatorSignature } from "./task-context";
import { WorkflowState } from "../workflow-state";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";

test("historical references are read from every input slot, never from prose", () => {
  expect(historicalReferences({ op: "join", left: "a", right: { operator: "total", atTask: 1 } })).toEqual([
    "total@task1",
  ]);
  expect(
    historicalReferences({ op: "udf", inputs: ["x", { operator: "y", atTask: 3 }, { operator: "z", atTask: 2 }] })
  ).toEqual(["y@task3", "z@task2"]);
  expect(historicalReferences({ op: "filter", input: "current" })).toEqual([]);
  expect(historicalReferences("not a spec")).toEqual([]);
});

test("a receipt states what the runtime did; invalidated descendants count only while they stay invalid", () => {
  const effects = emptyTaskEffects();
  effects.edited.add("default_tariff");
  effects.executed.add("default_tariff").add("portfolio_result");
  effects.notExecuted.add("portfolio_result").add("stress_result").add("unchanged_report");
  effects.rejected.set("broken", "CALLBACK_SIGNATURE");
  effects.historical.add("portfolio_result@task1");
  effects.returned = "portfolio_result (json)";
  const results = new Map<string, any>([
    ["default_tariff", { state: "Completed" }],
    ["portfolio_result", { state: "Completed" }],
    // Identical version after the edit: never invalidated, so not stale.
    ["unchanged_report", { state: "Completed" }],
  ]);
  const receipt = receiptFromEffects(effects, results, 4);
  expect(receipt).toEqual({
    edited: ["default_tariff"],
    executed: ["default_tariff", "portfolio_result"],
    notExecuted: ["stress_result"],
    rejected: ["broken"],
    historical: ["portfolio_result@task1"],
    returned: "portfolio_result (json)",
    retained: 4,
  });
  expect(formatTaskReceipt(6, receipt)).toBe(
    [
      "# Task 6 receipt",
      "Edited: default_tariff",
      "Executed: default_tariff, portfolio_result",
      "Not re-executed (inputs changed): stress_result",
      "Rejected at end of task: broken",
      "Historical inputs: portfolio_result@task1",
      "Returned: portfolio_result (json)",
      "Retained outputs: 4",
    ].join("\n")
  );
  // A task that changed nothing says so, and a prose answer is named as such.
  expect(formatTaskReceipt(2, receiptFromEffects(undefined, new Map(), 0))).toBe(
    "# Task 2 receipt\nEdited: none\nExecuted: none\nReturned: answered in prose\nRetained outputs: 0"
  );
});

test("receipts are sealed once per task and rendered after the task's answer, as cacheable history", () => {
  const history = new TaskHistory(async () => ({ path: "", sha256: "0".repeat(64), rowCount: 0 }));
  history.record(1, receiptFromEffects(undefined, new Map(), 0));
  expect(() => history.record(1, receiptFromEffects(undefined, new Map(), 0))).toThrow(/already has a receipt/);
  const state = new WorkflowState();
  const steps: any[] = [
    { id: "u1", role: "user", messageId: "one", content: "Establish the default", isBegin: true },
    { id: "a1", role: "agent", messageId: "one", content: '{"bill": 288}', isEnd: true },
    { id: "u2", role: "user", messageId: "two", content: "Adopt tariff 0.30", isBegin: true },
  ];
  const render = (nativeTaskReceipts: boolean) =>
    assembleTaskContext(
      {
        visibleSteps: steps,
        workflowState: state,
        snapshotStorage: new WorkflowSnapshotStorage(() => []),
        settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "", nativeTaskReceipts },
        compilationResult: null,
      },
      history
    );
  const withReceipts = render(true);
  expect(withReceipts.slice(0, 3).map(m => [m.role, String(m.content).split("\n")[0]])).toEqual([
    ["user", "# Task 1"],
    ["assistant", '{"bill": 288}'],
    ["user", "# Task 1 receipt"],
  ]);
  expect((withReceipts[2] as any).providerOptions).toEqual({ texera: { taskHistory: true } });
  // Off: byte-identical to the existing layout, so the control arms do not move.
  expect(render(false).map(m => String(m.content))).not.toContain(expect.stringContaining("receipt"));
});

test("the compact index states the declared operation over its inputs and keeps definitions at the boundary", () => {
  const state = new WorkflowState();
  const add = (id: string, type: string, properties: any, inputs: string[] = [], taskInputs?: any[]) =>
    state.addOperator({
      operatorID: id,
      operatorType: "DataProcessing",
      operatorVersion: "1",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      nativeOp: { type, properties, inputs, ...(taskInputs ? { taskInputs } : {}), version: "v2" },
    } as any);
  add("patients", "Scan", { files: "data/x/old.csv", format: "csv" });
  add("eligible", "Filter", { columns: ["risk"], func: "def apply(row):\n    return row['risk'] >= 7" }, ["patients"]);
  add(
    "totals",
    "Aggregate",
    {
      groupBy: [],
      aggregations: [
        { fn: "sum", col: "value", as: "total" },
        { fn: "count", as: "n" },
      ],
    },
    ["eligible"]
  );
  add(
    "report",
    "UDF",
    { code: "def process(a, b): return a" },
    ["totals", "task_archive_1"],
    ["totals", { operator: "totals", atTask: 1 }]
  );
  expect(operatorSignature(state.getOperator("patients")!)).toBe("scan(old.csv)");
  expect(operatorSignature(state.getOperator("eligible")!)).toBe("filter(risk) <- patients");
  expect(operatorSignature(state.getOperator("totals")!)).toBe(
    "aggregate(group[] sum(value)→total count(*)→n) <- eligible"
  );
  expect(operatorSignature(state.getOperator("report")!)).toBe("udf(def process(a, b)) <- totals, totals@task1");
  const render = (nativeCompactIndex: boolean) =>
    String(
      assembleTaskContext({
        visibleSteps: [{ id: "u1", role: "user", messageId: "one", content: "Next", isBegin: true } as any],
        workflowState: state,
        snapshotStorage: new WorkflowSnapshotStorage(() => []),
        settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "", nativeCompactIndex },
        compilationResult: null,
      }).find(m => String(m.content).startsWith("# Current operator catalog"))!.content
    );
  const compact = render(true);
  expect(compact).toContain("eligible = filter(risk) <- patients; schema=unknown; not executed");
  expect(compact).not.toContain("def apply");
  expect(compact.length).toBeLessThan(render(false).length);
  // The full card still carries the clipped definition, Python included.
  expect(render(false)).toContain("def apply");
});
