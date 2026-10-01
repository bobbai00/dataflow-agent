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
import { AgentMode, ContextMode, DEFAULT_AGENT_SETTINGS, type ReActStep } from "../../types/agent";
import { buildContextAssembler } from "../../server";
import type { OperatorInfo } from "../../types/execution";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import { TexeraAgent } from "../texera-agent";
import { createNativeTools } from "../tools/native-batch-tools";
import { dataflowInput, type LegacySpec } from "./test-support";
import { formatOperatorResult } from "../tools/result-formatting";
import { prepareStructuredExecutionResult } from "./execution-transport";
import { workflowExecutionPlan } from "./result-versions";

function fixture() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const tools = createNativeTools(state, {
    metadataStore: metadata,
    settings: { nativeProfileCollection: true },
  } as any);
  const steps: ReActStep[] = [];
  const storage = new WorkflowSnapshotStorage(
    id => steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id),
    () => 17
  );
  const record = async (id: string, operators: Record<string, unknown>[], observe: string[] = []) => {
    const input = dataflowInput({ operators: operators as LegacySpec[], observe });
    const output = await tools.dataflow.execute(input);
    expect(output.observe).toEqual(observe);
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
          operations:
            v.type === "Filter"
              ? { keptRows: nums.length, rejectedRows: inputs[0] - nums.length, nullPredicates: 0 }
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

const source = { op: "scan", id: "source", files: "data/test.csv" };
const filter = {
  op: "filter",
  id: "selected",
  input: "source",
  columns: ["x"],
  func: "def apply(row):\n    return row['x'] > 0",
};

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  test(`shared flow ${mode}: dedup only visible outputs in this frame`, async () => {
    const f = fixture();
    const render = () =>
      assembleContext(f.steps, f.state, f.storage, mode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        dataEvidence: true,
        flowEvidence: true,
        maxOperatorResultCharLimit: 2000,
      });
    await f.record(
      "A",
      [
        source,
        filter,
        { op: "project", id: "first", input: "selected", keep: ["x"] },
        { op: "project", id: "second", input: "selected", keep: ["x"] },
      ],
      ["first", "second"]
    );
    f.persist("A", {
      source: [-100, 0, 10, 20, 30],
      selected: [10, 20, 30],
      first: [10, 20, 30],
      second: [10, 20, 30],
    });
    f.capture("A", ["first", "second"]);
    const before = render();
    const text = JSON.stringify(before);
    expect(text.match(/Flow upstream selected:/g)?.length).toBe(1);
    expect(text).toContain("Flow upstream: see");
    expect(text).not.toContain("Sample record: -100");
    expect(text.match(/Output Table: 3 rows/g)?.length).toBe(2);
    const frozen = structuredClone(f.storage.getAssociatedSnapshot("A").nativeObservations);
    await f.record("B", [], ["second"]);
    f.capture("B", ["second"]);
    const after = render();
    const later = JSON.stringify(after);
    if (mode === ContextMode.LATEST) {
      expect(later.match(/Flow upstream selected:/g)?.length).toBe(1);
      expect(later).not.toContain("Flow upstream: see");
    } else {
      expect(later.match(/Flow upstream selected:/g)?.length).toBe(2);
      expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    }
    expect(f.storage.getAssociatedSnapshot("A").nativeObservations).toEqual(frozen);
  });
}

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  for (const dataEvidence of [false, true])
    for (const flowEvidence of [false, true]) {
      test(`production ${mode}: legacy controls cannot alter data=${dataEvidence}/flow=${flowEvidence} input`, async () => {
        const f = fixture();
        await f.record("A", [filter, source], ["selected"]);
        f.persist("A", { source: [-1, 0, 10, 20, 30], selected: [10, 20, 30] });
        const info = f.storage.getOperatorResult("A", "selected")!;
        f.storage.setOperatorResult("A", "selected", {
          ...info,
          columnStats: { x: "LEGACY_STATS_SENTINEL", __table_hints__: "LEGACY_HINT_SENTINEL" },
        });
        f.capture("A", ["selected"], dataEvidence, flowEvidence);
        const assembler = buildContextAssembler("vercel-tool-use", {} as never);
        const input = {
          visibleSteps: f.steps,
          workflowState: f.state,
          snapshotStorage: f.storage,
          compilationResult: null,
          settings: {
            ...DEFAULT_AGENT_SETTINGS,
            agentMode: AgentMode.NATIVE,
            contextMode: mode,
            dataEvidence,
            flowEvidence,
          },
        };
        const expected = await assembler(input as any);
        const text = JSON.stringify(expected);
        expect(text.includes("Data measurement")).toBe(dataEvidence);
        expect(text.includes("Flow measurement")).toBe(flowEvidence);
        expect(text).not.toContain("LEGACY_");
        for (const level of [0, 1, 2, 3]) {
          expect(
            await assembler({
              ...input,
              settings: {
                ...input.settings,
                flowLevel: level,
                dataLevel: level,
                columnStats: true,
                valueFormat: true,
                dataHints: true,
                coercionTelemetry: true,
                rowLineage: true,
              },
            } as any)
          ).toEqual(expected);
        }
      });
    }
}

test("DELTA error observations stay append-only without a moving legacy error suffix", async () => {
  const f = fixture();
  await f.record("A", [filter, source], []);
  f.persist("A", { source: [-1, 1], selected: [1] });
  f.storage.setOperatorResult("A", "selected", {
    state: "Failed",
    inputTuples: 2,
    outputTuples: 0,
    resultMode: "table",
    error: "a unique callback failure",
  });
  f.capture("A", [], false, false);
  const render = () =>
    assembleContext(f.steps, f.state, f.storage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      messageLayout: "native",
      dataEvidence: false,
      flowEvidence: false,
    });
  const before = render();
  expect(JSON.stringify(before)).toContain("a unique callback failure");
  expect(JSON.stringify(before)).not.toContain("Operators needing attention");
  await f.record("B", [], ["source"]);
  f.capture("B", ["source"], false, false);
  const after = render();
  // The final continuation directive is not a saved event.
  expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  expect(JSON.stringify(after).match(/a unique callback failure/g)?.length).toBe(1);
});

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  test(`upstream summaries ${mode}: observe pins hidden calculation, revisions do not leak`, async () => {
    const f = fixture();
    const render = () =>
      JSON.stringify(
        assembleContext(f.steps, f.state, f.storage, mode, {
          agentMode: AgentMode.NATIVE,
          dataEvidence: false,
          flowEvidence: true,
          maxOperatorResultCharLimit: 2000,
        })
      );
    await f.record("A", [{ op: "project", id: "final", input: "selected", keep: ["x"] }, filter, source], ["final"]);
    f.persist("A", { source: [-100, 0, 10, 20, 30], selected: [10, 20, 30], final: [10, 20, 30] });
    f.capture("A", ["final"], false, true);
    const frozen = structuredClone(f.storage.getAssociatedSnapshot("A").nativeObservations!.final);
    expect(frozen.text).toContain("Flow upstream selected:");
    expect(frozen.text).toContain("kept=3/5");
    expect(frozen.text).not.toContain("-100");
    expect(render()).toContain("kept=3/5");
    await f.record("B", [{ ...filter, func: "def apply(row):\n    return row['x'] > 10" }]);
    f.persist("B", { selected: [20, 30], final: [20, 30] }, "101");
    f.capture("B", [], false, true);
    expect(render()).not.toContain("kept=2/5");
    expect(render().includes("kept=3/5")).toBe(mode === ContextMode.DELTA);
    await f.record("C", [], ["final"]);
    f.capture("C", ["final"], false, true);
    expect(render()).toContain("kept=2/5");
    expect(f.storage.getAssociatedSnapshot("A").nativeObservations!.final).toEqual(frozen);
  });
}

for (const mode of [ContextMode.DELTA, ContextMode.LATEST])
  for (const messageLayout of [undefined, "native", "block", "blockSplit", "opSplit", "turnSplit"] as const) {
    test(`V2 evidence ${mode}/${messageLayout ?? "default"}: explicit observe, revision, error, cached read`, async () => {
      const f = fixture();
      let dataEvidence: boolean = true,
        flowEvidence: boolean = true;
      const render = () =>
        JSON.stringify(
          assembleContext(f.steps, f.state, f.storage, mode, {
            agentMode: AgentMode.NATIVE,
            messageLayout,
            dataEvidence,
            flowEvidence,
            maxOperatorResultCharLimit: 2000,
          })
        );
      await f.record("A", [filter, source], ["selected"]);
      f.persist("A", { source: [-100, 0, 10, 20, 30], selected: [10, 20, 30] });
      f.capture("A", ["selected"]);
      expect(f.storage.getOperatorResult("A", "selected")?.tableProfile?.status).toBe("available");
      const frame = f.storage.getAssociatedSnapshot("A").nativeObservations?.selected;
      expect(frame?.text).toContain("kept=3/5");
      expect(frame?.text).not.toContain("-100"); // downstream facts do not dump upstream samples
      expect(render()).toContain("kept=3/5");
      expect(render()).toContain("Data measurement");
      const first = render();

      await f.record("B", [{ ...filter, func: "def apply(row):\n    return row['x'] > 10" }]);
      f.persist("B", { selected: [20, 30] }, "101");
      f.capture("B", []);
      expect(render()).not.toContain("kept=2/5");
      expect(render()).toContain("result not requested");
      expect(f.storage.getAssociatedSnapshot("B").nativeObservations).toEqual({});
      expect(render().includes("kept=3/5")).toBe(mode === ContextMode.DELTA);

      await f.record("C", [], ["selected"]);
      f.capture("C", ["selected"]);
      expect(render()).toContain("kept=2/5");
      expect(f.storage.getAssociatedSnapshot("A").nativeObservations?.selected).toEqual(frame);
      expect(f.storage.getOperatorResult("C", "selected")).toEqual(f.storage.getOperatorResult("B", "selected"));
      dataEvidence = flowEvidence = false;
      if (mode === ContextMode.DELTA) {
        expect(render()).toContain("kept=3/5");
        expect(render()).toContain("kept=2/5");
        expect(render()).toContain("Data measurement");
      } else {
        expect(render()).not.toContain("Flow measurement");
        expect(render()).not.toContain("Data measurement");
      }
      expect(first).toContain("kept=3/5");

      await f.record("D", [{ ...filter, func: "def apply(row):\n    return 'bad'" }]);
      f.storage.setOperatorResult("D", "selected", {
        state: "Failed",
        inputTuples: 0,
        outputTuples: 0,
        resultMode: "error",
        error: "CALLBACK_RETURN_TYPE: expected bool",
      });
      f.capture("D", []);
      expect(render()).toContain("CALLBACK_RETURN_TYPE");
      expect(f.storage.getOperatorResult("D", "selected")?.tableProfile).toBeUndefined();
    });
  }

test("DELTA never retroactively adds evidence when it was off at observation time", async () => {
  const f = fixture();
  await f.record("A", [filter, source], ["selected"]);
  f.persist("A", { source: [-1, 0, 10], selected: [10] });
  f.capture("A", ["selected"], false, false);
  const render = () =>
    JSON.stringify(
      assembleContext(f.steps, f.state, f.storage, ContextMode.DELTA, {
        agentMode: AgentMode.NATIVE,
        dataEvidence: true,
        flowEvidence: true,
      })
    );
  expect(render()).not.toContain("Flow measurement");
  // Re-capture cannot rewrite a finalized event with new settings.
  f.capture("A", ["selected"], true, true);
  expect(render()).not.toContain("Flow measurement");
  expect(Object.isFrozen(f.storage.getAssociatedSnapshot("A").nativeObservations?.selected)).toBe(true);
});

test("V2 formatting shares one budget and does not call legacy reserved-column/viz rendering", async () => {
  const f = fixture();
  await f.record("A", [source], ["source"]);
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
    expect(rendered.length).toBeLessThanOrEqual(maxChars);
    expect(rendered).not.toContain("Column Schema and stats");
    if (maxChars >= 120) expect(rendered).toContain("Columns:");
  }
});

test("production post-step hook records cached observations without running the engine", async () => {
  const f = fixture();
  await f.record("A", [filter, source], ["selected"]);
  f.persist("A", { source: [-1, 0, 10], selected: [10] });
  const agent = new TexeraAgent({
    agentId: "evidence-capture",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  }) as any;
  agent.snapshotStorage = f.storage;
  agent.workflowState = f.state;
  agent.head = "A";
  agent.delegateConfig = { userToken: "test", workflowId: 17 };
  agent.settings.agentMode = AgentMode.NATIVE;
  agent.settings.dataEvidence = true;
  agent.settings.flowEvidence = true;
  agent.settings.maxOperatorResultCharLimit = 700;
  const result = await createNativeTools(f.state, {
    settings: { nativeProfileCollection: true },
  } as any).dataflow.execute({
    edits: "",
    observe: ["selected"],
  });
  let executions = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      executions++;
      throw new Error("cached observe must not fetch");
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    await agent.runPostStepExecution(
      [{ toolName: "dataflow", toolCallId: "observe", input: { edits: "", observe: ["selected"] } }],
      [{ toolCallId: "observe", output: result }]
    );
    const observed = f.storage.getAssociatedSnapshot("A").nativeObservations?.selected;
    expect(observed?.text).toContain("kept=1/3");
    expect(observed?.text.length).toBeLessThanOrEqual(700);
    expect(executions).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  for (const data of [false, true]) {
    for (const flow of [false, true]) {
      test(`cached observe respects ${mode} data=${data} flow=${flow} and the shared budget`, async () => {
        const f = fixture();
        await f.record("A", [filter, source], []);
        f.persist("A", { source: [-1, 0, 10, 20, 30], selected: [10, 20, 30] });
        f.capture("A", [], data, flow, 2000);
        await f.record("B", [], ["selected"]);
        f.capture("B", ["selected"], data, flow, 2000);
        const output = f.storage.getAssociatedSnapshot("B").nativeObservations!.selected.text;
        expect(output.includes("Data measurement")).toBe(data);
        expect(output.includes("Flow measurement")).toBe(flow);
        expect(output.length).toBeLessThanOrEqual(2000);
        const rendered = JSON.stringify(
          assembleContext(f.steps, f.state, f.storage, mode, {
            agentMode: AgentMode.NATIVE,
            dataEvidence: data,
            flowEvidence: flow,
            maxOperatorResultCharLimit: 2000,
          })
        );
        expect(rendered.includes("Data measurement")).toBe(data);
        expect(rendered.includes("Flow measurement")).toBe(flow);
        expect(rendered).not.toContain("Column Schema and stats");
        expect(f.storage.getOperatorResult("B", "selected")).toEqual(f.storage.getOperatorResult("A", "selected"));
        expect(f.storage.getAssociatedSnapshot("A").nativeObservations).toEqual({});
      });
    }
  }
}

for (const scenario of ["settings", "checkout", "abort"] as const) {
  test(`post-step evidence capture preserves ownership across ${scenario}`, async () => {
    const f = fixture();
    await f.record("A", [filter, source], ["selected"]);
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
    agent.settings.agentMode = AgentMode.NATIVE;
    agent.settings.flowEvidence = true;
    agent.settings.dataEvidence = true;
    agent.abortController = new AbortController();
    let finish!: () => void;
    agent.executePostStepChanges = () =>
      new Promise<void>(resolve => {
        finish = resolve;
      });
    const pending = agent.runPostStepExecution(f.steps[0].toolCalls, f.steps[0].toolResults);
    if (scenario === "settings") {
      agent.settings.flowEvidence = false;
      agent.settings.dataEvidence = false;
      agent.settings.columnStats = false;
      agent.settings.maxOperatorResultCharLimit = 50;
    } else if (scenario === "checkout") {
      await f.record("B", [], []);
      agent.head = "B";
    } else agent.abortController.abort();
    finish();
    await pending;
    const captured = f.storage.getAssociatedSnapshot("A").nativeObservations;
    if (scenario === "settings") expect(captured?.selected.text).toContain("kept=1/3");
    else expect(captured).toBeUndefined();
    if (scenario === "checkout") expect(f.storage.getAssociatedSnapshot("B").nativeObservations).toBeUndefined();
  });
}

test("DELTA compaction cannot reveal a previously unobserved successful table", async () => {
  const f = fixture();
  f.steps.push({
    id: "user",
    messageId: "m",
    stepId: 1,
    timestamp: 1,
    role: "user",
    content: "Inspect the selected table.",
    isBegin: true,
    isEnd: false,
  });
  await f.record("A", [filter, source], ["selected"]);
  f.persist("A", { source: [-918273, 0, 10], selected: [10] });
  f.capture("A", ["selected"]);
  for (const id of ["B", "C", "D"]) {
    await f.record(id, [], ["selected"]);
    f.capture(id, ["selected"]);
  }
  const text = JSON.stringify(
    assembleContext(f.steps, f.state, f.storage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      dataEvidence: true,
      flowEvidence: true,
      contextWindowTokens: 40,
      compactionStrategy: "compress",
    })
  );
  expect(text).toContain("compacted");
  expect(text).not.toContain("-918273");
});

for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
  for (const layout of [{ sessionTurns: true }, { versionedCatalog: true }, { turnHistoryIndex: true }]) {
    test(`V2 ${mode}/${Object.keys(layout)[0]} keeps evidence behind observe`, async () => {
      const f = fixture();
      f.steps.push({
        id: "user",
        messageId: "m",
        stepId: 1,
        timestamp: 1,
        role: "user",
        content: "Inspect the selected table.",
        isBegin: true,
        isEnd: false,
      });
      await f.record("A", [filter, source], ["selected"]);
      f.persist("A", { source: [-918273, 0, 10], selected: [10] });
      f.capture("A", ["selected"]);
      const render = () =>
        JSON.stringify(
          assembleContext(f.steps, f.state, f.storage, mode, {
            agentMode: AgentMode.NATIVE,
            dataEvidence: true,
            flowEvidence: true,
            ...layout,
          })
        );
      expect(render()).toContain("kept=1/3");
      expect(render()).not.toContain("-918273");
      await f.record("B", [], []);
      f.capture("B", []);
      expect(render()).not.toContain("-918273");
      if (mode === ContextMode.LATEST) expect(render()).not.toContain("Flow measurement:");
    });
  }
}
