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
import { WorkflowState } from "../workflow-state";
import type { ReActStep } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { buildTaskEntry, renderTaskEntry, type TaskEntry } from "./task-entries";
import type { TaskHistory } from "./task-history";

const FN = "def clean(df):\n    return df.dropna()";

function operator(id: string, source: string, inputs: string[] = [], functions?: Record<string, string>) {
  return {
    operatorID: id,
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: { type: "Process", properties: { doc: "d" }, inputs, source, ...(functions ? { functions } : {}) },
  } as any;
}

function result(rows: Array<Record<string, unknown>>, total = rows.length): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: total,
    resultMode: "table",
    result: rows,
    totalRowCount: total,
    truncated: total === rows.length ? false : true,
    resultSchema: Object.keys(rows[0] ?? {}).map(name => ({ name, type: "int64", encoding: "plain" })),
  };
}

function receipt(messageId: string, operators: Array<Record<string, unknown>>, observe: string[]) {
  return {
    id: `s${Math.random()}`,
    role: "agent",
    messageId,
    content: "",
    toolCalls: [{ toolName: "dataflow", toolCallId: "c", input: { edits: "", observe } }],
    toolResults: [{ toolCallId: "c", output: { kind: "native-batch", operators, observe, observationErrors: [] } }],
  } as unknown as ReActStep;
}

test("lean entries: probes keep one line, only answer sources keep rows, a function body is shown once per session", () => {
  const state = new WorkflowState();
  state.addOperator(operator("raw", 'raw = scan("data/raw.csv")'));
  state.addOperator(operator("cleaned", "cleaned = process(raw, fn=clean, doc=\"d\")", ["raw"], { clean: FN }));
  state.addOperator(operator("probe", "probe = limit(cleaned, 5)", ["cleaned"]));
  state.addOperator(operator("total", "total = aggregate(cleaned, n=count())", ["cleaned"]));
  const results = new Map<string, OperatorInfo>([
    ["raw", result([{ a: 1, b: 2 }], 500)],
    ["cleaned", result([{ a: 1, b: 2 }], 480)],
    ["probe", result([{ a: 1, b: 2 }, { a: 3, b: 4 }])],
    ["total", result([{ n: 480 }])],
  ]);
  const steps = (messageId: string, request: string, answer: string): ReActStep[] => [
    { id: `u-${messageId}`, role: "user", messageId, content: request, isBegin: true } as any,
    receipt(messageId, [
      { id: "raw", op: "scan", status: "added", message: "" },
      { id: "cleaned", op: "process", status: "added", message: "" },
      { id: "probe", op: "limit", status: "added", message: "" },
      { id: "total", op: "aggregate", status: "added", message: "" },
    ], ["probe", "total"]),
    { id: `a-${messageId}`, role: "agent", messageId, content: answer, isEnd: true } as any,
  ];
  const lean = buildTaskEntry({ task: 1, steps: steps("m1", "Count", "There are 480 rows."), results, state, lean: true });
  const probe = lean.changes.find(c => c.id === "probe")!;
  expect(probe.rows).toBe(2);
  expect(probe.columns).toBeUndefined();
  const cleaned = lean.changes.find(c => c.id === "cleaned")!;
  expect(cleaned.columns).toEqual(["a", "b"]);
  expect(cleaned.functions).toEqual([FN]);
  expect(lean.from).toEqual(["total"]);
  expect(lean.tables.map(t => [t.id, t.text !== ""])).toEqual([["total", true], ["probe", false]]);
  const text = renderTaskEntry(lean, true);
  expect(text).toContain("probe: 2 rows, not shown here");
  expect(text).toContain("total (1 row, complete):");
  // The same session, one task later: the body is referenced, not repeated.
  const history = { entries: () => [lean], provenance: () => new Map() } as unknown as TaskHistory;
  const second = buildTaskEntry({
    task: 2,
    steps: [
      { id: "u2", role: "user", messageId: "m2", content: "Again", isBegin: true } as any,
      receipt("m2", [{ id: "cleaned", op: "process", status: "modified", message: "" }], []),
      { id: "a2", role: "agent", messageId: "m2", content: "ok", isEnd: true } as any,
    ],
    results,
    state,
    history,
    lean: true,
  });
  expect(second.changes[0]!.functions).toEqual(["# def clean: code as in task 1 (cleaned)"]);
  expect(renderTaskEntry(second, true)).toContain("# def clean: code as in task 1 (cleaned)");
  // The full entry keeps everything.
  const full: TaskEntry = buildTaskEntry({ task: 1, steps: steps("m1", "Count", "There are 480 rows."), results, state });
  expect(full.changes.find(c => c.id === "probe")!.columns).toEqual(["a", "b"]);
  expect(full.tables.map(t => [t.id, t.text !== ""])).toEqual([["total", true], ["probe", true]]);
});
