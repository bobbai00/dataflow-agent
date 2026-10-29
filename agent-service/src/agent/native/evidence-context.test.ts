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
import type { ReActStep } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import { TexeraAgent } from "../texera-agent";
import { planRegisteredGraphEdit } from "../tools/graph-edits";
import { prepareDataflowCall } from "../tools/turn-tool";
import { formatOperatorResult } from "../tools/result-formatting";
import { prepareStructuredExecutionResult } from "./execution-transport";
import { workflowExecutionPlan } from "./result-versions";

/**
 * Evidence captured for the operators a call showed: what capture freezes, and
 * who owns a capture. (DELTA renders each call's receipt; turn-receipt tests
 * cover it.)
 */
function fixture() {
  const state = new WorkflowState();
  const metadataStore = new WorkflowSystemMetadata();
  metadataStore.seedNativeOperatorDefaults();
  const steps: ReActStep[] = [];
  const storage = new WorkflowSnapshotStorage(
    id => steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id),
    () => 17
  );
  /** A completed `dataflow` call: its edit lands, its `show result` targets are observed. */
  const record = async (id: string, python: string, statements: string, observe: string[] = []) => {
    const input = { python, statements };
    const output = prepareDataflowCall(input);
    for (const item of output.actions) {
      if (item.action.type === "edit") {
        const plan = await planRegisteredGraphEdit(
          state.getWorkflowContent(),
          item.action.python,
          item.action.changes,
          {
            metadataStore,
            settings: { nativeProfileCollection: true },
          }
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
  };
  const persist = (step: string, values: Record<string, number[]>, execution = "100") => {
    const workflow = state.getWorkflowContent();
    const raw: Record<string, OperatorInfo> = {};
    for (const [id, nums] of Object.entries(values)) {
      const op = workflow.operators.find(o => o.operatorID === id)!;
      const v = op.nativeOp!;
      const distinct = [...new Set(nums)].sort((a, b) => a - b);
      const scalar = (n: number) => ({ type: "int64", value: String(n) });
      const counts = distinct.map(n => ({ value: scalar(n), count: nums.filter(x => x === n).length }));
      const inputs = v.inputs.map(up => values[up]?.length ?? storage.getOperatorResult(step, up)?.totalRowCount!);
      const profile = {
        protocol: "texera.table-profile",
        version: 1,
        workerId: "w",
        producerId: "a".repeat(32),
        operatorId: id,
        operatorRevision: v.revision,
        status: "available",
        coverage: { scope: "worker", complete: true, rowsProcessed: nums.length, yields: 1 },
        rowCount: nums.length,
        columnCount: 1,
        schema: [{ name: "x", type: "int64", dtype: "Int64" }],
        schemaComplete: true,
        columns: {
          x: {
            type: "int64",
            rowsProcessed: nums.length,
            nullCount: 0,
            nonnullCount: nums.length,
            nullRatio: nums.length ? 0 : null,
            distinctCount: distinct.length,
            uniquenessRatio: nums.length ? distinct.length / nums.length : null,
            min: nums.length ? scalar(Math.min(...nums)) : null,
            max: nums.length ? scalar(Math.max(...nums)) : null,
            frequencies: { values: counts, otherCount: 0, truncated: false },
            mergeValues: counts,
            omissions: [],
          },
        },
        structure: { duplicateRows: nums.length - distinct.length, allNullRows: 0, allNullColumns: [] },
        native: {
          operatorType: v.type,
          inputOperators: v.inputs,
          inputRows: inputs,
          outputRows: nums.length,
          // One None verdict among the rejected rows keeps the filter's counters
          // a flow line; without one they only restate the row counts.
          operations:
            v.type === "Filter"
              ? {
                  keptRows: nums.length,
                  rejectedRows: inputs[0] - nums.length,
                  nullPredicates: inputs[0] > nums.length ? 1 : 0,
                }
              : {},
        },
        algorithm: {
          name: "bounded-exact-v1",
          rowSelection: "prefix",
          distinctLimit: 256,
          rowDistinctLimit: 4096,
          topK: 8,
        },
        omissions: [],
        cost: { collectionMs: 0, cellsProcessed: nums.length, payloadBytes: 0 },
      };
      raw[id] = {
        state: "Completed",
        inputTuples: inputs.reduce((a, b) => a + b, 0),
        outputTuples: nums.length,
        resultMode: "table",
        result: nums.slice(0, 1).map(x => ({ x })),
        totalRowCount: nums.length,
        truncated: nums.length > 1,
        numWorkers: 1,
        resultSchema: [{ name: "x", type: "int64", encoding: "number-or-decimal-string" }],
        materialization: { outputPort: 0, executionId: execution, cached: false },
        resultMetadata: { w: JSON.stringify(profile) },
      };
    }
    const response = prepareStructuredExecutionResult(
      {
        success: true,
        state: "Completed",
        operators: raw,
        executionId: execution,
        capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
        inputMaterializations: Object.fromEntries(
          workflow.operators.map(op => [
            op.operatorID,
            raw[op.operatorID]?.materialization ?? storage.getOperatorResult(step, op.operatorID)?.materialization!,
          ])
        ),
      },
      17,
      workflowExecutionPlan(workflow)
    );
    for (const [id, info] of Object.entries(response.operators)) storage.setOperatorResult(step, id, info);
  };
  const capture = (step: string, ids: string[], data = true, flow = true, maxChars = 2000) =>
    storage.captureNativeObservations(step, ids, { data, flow, maxChars });
  return { state, steps, storage, record, persist, capture };
}

const predicate = "def positive(row, *, minimum=0):\n    return row['x'] > minimum";
const source = "set source: scan(files='data/test.csv')";
const selected = (minimum = 0) =>
  `set selected: filter(source, predicate='positive', settings={'minimum': ${minimum}})`;
const graph = (...lines: string[]) => [source, selected(), ...lines].join("\n");

test("upstream summaries: a shown result pins its hidden calculation, revisions do not leak", async () => {
  const f = fixture();
  await f.record("A", predicate, graph("set final: project(selected, keep=['x'])", "show result final"), ["final"]);
  f.persist("A", { source: [-100, 0, 10, 20, 30], selected: [10, 20, 30], final: [10, 20, 30] });
  f.capture("A", ["final"], false, true);
  const frozen = structuredClone(f.storage.getAssociatedSnapshot("A").nativeObservations!.final);
  expect(frozen.text).toContain("- runtime stats (selected):");
  expect(frozen.text).toContain("kept=3/5");
  expect(frozen.text).not.toContain("-100");
  await f.record("B", "", selected(10));
  f.persist("B", { selected: [20, 30], final: [20, 30] }, "101");
  f.capture("B", [], false, true);
  expect(f.storage.getAssociatedSnapshot("B").nativeObservations).toEqual({});
  await f.record("C", "", "show result final", ["final"]);
  f.capture("C", ["final"], false, true);
  expect(f.storage.getAssociatedSnapshot("C").nativeObservations!.final.text).toContain("kept=2/5");
  expect(f.storage.getAssociatedSnapshot("A").nativeObservations!.final).toEqual(frozen);
});

test("V2 evidence capture: shown result, revision, error, cached read", async () => {
  const f = fixture();
  await f.record("A", predicate, graph("show result selected"), ["selected"]);
  f.persist("A", { source: [-100, 0, 10, 20, 30], selected: [10, 20, 30] });
  f.capture("A", ["selected"]);
  expect(f.storage.getOperatorResult("A", "selected")?.tableProfile?.status).toBe("available");
  const frame = f.storage.getAssociatedSnapshot("A").nativeObservations?.selected;
  expect(frame?.text).toContain("kept=3/5");
  expect(frame?.text).toContain("statistics:");
  expect(frame?.text).not.toContain("-100"); // downstream facts do not dump upstream samples

  await f.record("B", "", selected(10));
  f.persist("B", { selected: [20, 30] }, "101");
  f.capture("B", []);
  expect(f.storage.getAssociatedSnapshot("B").nativeObservations).toEqual({});

  await f.record("C", "", "show result selected", ["selected"]);
  f.capture("C", ["selected"]);
  expect(f.storage.getAssociatedSnapshot("C").nativeObservations?.selected.text).toContain("kept=2/5");
  expect(f.storage.getAssociatedSnapshot("A").nativeObservations?.selected).toEqual(frame);
  expect(f.storage.getOperatorResult("C", "selected")).toEqual(f.storage.getOperatorResult("B", "selected"));

  await f.record("D", "", selected(20));
  f.storage.setOperatorResult("D", "selected", {
    state: "Failed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "error",
    error: "CALLBACK_RETURN_TYPE: expected bool",
  });
  f.capture("D", []);
  expect(f.storage.getOperatorResult("D", "selected")?.tableProfile).toBeUndefined();
});

test("a captured observation is frozen; capturing again cannot rewrite it with new settings", async () => {
  const f = fixture();
  await f.record("A", predicate, graph("show result selected"), ["selected"]);
  f.persist("A", { source: [-1, 0, 10], selected: [10] });
  f.capture("A", ["selected"], false, false);
  const first = f.storage.getAssociatedSnapshot("A").nativeObservations?.selected;
  expect(first?.text).not.toContain("- runtime stats:");
  f.capture("A", ["selected"], true, true);
  const again = f.storage.getAssociatedSnapshot("A").nativeObservations?.selected;
  expect(again).toEqual(first);
  expect(again?.text).not.toContain("- runtime stats:");
  expect(Object.isFrozen(again)).toBe(true);
});

test("V2 formatting shares one budget and does not call legacy reserved-column/viz rendering", async () => {
  const f = fixture();
  await f.record("A", "", `${source}\nshow result source`, ["source"]);
  f.persist("A", { source: [1, 2, 3] });
  const snap = f.storage.getAssociatedSnapshot("A");
  const info = snap.results.get("source")!.info;
  for (const maxChars of [40, 120, 500, 2000]) {
    const rendered = formatOperatorResult("source", info, f.state, {
      operatorAtEvent: snap.workflow.operators[0],
      nativeEvidence: {
        workflow: snap.workflow,
        resolveInput: id => snap.results.get(id)?.info,
        data: true,
        flow: true,
        maxChars,
      },
    });
    expect(rendered.length).toBeLessThanOrEqual(3 * maxChars + 2);
    expect(rendered).not.toContain("Column Schema and stats");
    if (maxChars >= 500) expect(rendered).toContain("columns:");
  }
});

for (const data of [false, true]) {
  for (const flow of [false, true]) {
    test(`a cached read captures data=${data} flow=${flow} within the shared budget`, async () => {
      const f = fixture();
      await f.record("A", predicate, graph());
      f.persist("A", { source: [-1, 0, 10, 20, 30], selected: [10, 20, 30] });
      f.capture("A", [], data, flow, 2000);
      await f.record("B", "", "show result selected", ["selected"]);
      f.capture("B", ["selected"], data, flow, 2000);
      const output = f.storage.getAssociatedSnapshot("B").nativeObservations!.selected.text;
      expect(output.includes("statistics:")).toBe(data);
      expect(output.includes("- runtime stats:")).toBe(flow);
      expect(output.length).toBeLessThanOrEqual(2000);
      expect(output).not.toContain("Column Schema and stats");
      expect(f.storage.getOperatorResult("B", "selected")).toEqual(f.storage.getOperatorResult("A", "selected"));
      expect(f.storage.getAssociatedSnapshot("A").nativeObservations).toEqual({});
    });
  }
}

for (const scenario of ["settings", "checkout", "abort"] as const) {
  test(`a dataflow call's evidence capture keeps its owner across ${scenario}`, async () => {
    const f = fixture();
    await f.record("A", predicate, graph());
    f.persist("A", { source: [-1, 0, 10], selected: [10] });
    const agent = new TexeraAgent({
      agentId: `evidence-${scenario}`,
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    }) as any;
    agent.snapshotStorage = f.storage;
    agent.workflowState = f.state;
    agent.head = "A";
    agent.settings.flowEvidence = true;
    agent.settings.dataEvidence = true;
    agent.abortController = new AbortController();
    let finish!: () => void;
    agent.executePostStepChanges = () =>
      new Promise<void>(resolve => {
        finish = resolve;
      });
    const input = { python: "", statements: "show result selected" };
    const output = prepareDataflowCall(input);
    const pending = agent.runPostStepExecution(
      [{ toolName: "dataflow", toolCallId: "show", input }],
      [{ toolCallId: "show", output }]
    );
    await Promise.resolve();
    if (scenario === "settings") {
      agent.settings.flowEvidence = false;
      agent.settings.dataEvidence = false;
      agent.settings.maxOperatorResultCharLimit = 50;
    } else if (scenario === "checkout") {
      await f.record("B", "", "show function positive");
      agent.head = "B";
    } else agent.abortController.abort();
    finish();
    const outcome = await pending.then(
      () => "completed",
      (error: Error) => error.name
    );
    const captured = f.storage.getAssociatedSnapshot("A").nativeObservations;
    if (scenario === "settings") {
      expect(outcome).toBe("completed");
      expect(captured?.selected.text).toContain("kept=1/3");
    } else {
      expect(outcome).toBe("AbortError");
      expect(captured).toBeUndefined();
    }
    if (scenario === "checkout") expect(f.storage.getAssociatedSnapshot("B").nativeObservations).toBeUndefined();
  });
}
