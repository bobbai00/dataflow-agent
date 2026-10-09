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

import { beforeAll, expect, test } from "bun:test";
import { AgentMode, ContextMode, DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { WorkflowState } from "../workflow-state";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planGraphEdit } from "../tools/graph-edits";
import { executeDataflowActionBatch } from "../tools/dataflow-action-runtime";
import { prepareDataflowActions, renderDataflowActionsResult, dataflowActionsSchema } from "../tools/dataflow-actions";
import { buildNativeModeSystemPrompt } from "../prompts";
import { TexeraAgent } from "../texera-agent";
import { columnEntries, describeOperator, operatorBlock } from "./observation-format";
import { taskLedger } from "../state-ledger";
import { splitOperators, buildNativeFrames } from "../context/summarize/native-frames";
import { prepareStructuredExecutionResult } from "./execution-transport";
import { workflowExecutionPlan } from "./result-versions";

const metadata = new WorkflowSystemMetadata();
metadata.seedCodeModeDefaults();
let workflow: ReturnType<WorkflowState["getWorkflowContent"]>;
beforeAll(async () => {
  workflow = (
    await planGraphEdit(
      new WorkflowState().getWorkflowContent(),
      'source = scan("data/test.csv")\noutput = project(source, keep=["id"])',
      { metadataStore: metadata, settings: { nativeProfileCollection: true } }
    )
  ).workflow;
});
function info(wide = false): OperatorInfo {
  const schema = [
    { name: "id", type: "int64", encoding: "number-or-decimal-string" },
    { name: "label", type: "str", encoding: "string" },
    ...(wide
      ? Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, type: "int64", encoding: "number-or-decimal-string" }))
      : []),
  ];
  const op = workflow.operators[0];
  const resultVersion = {
    version: 1 as const,
    id: "v1",
    workflowId: 1,
    operatorId: "source",
    operatorRevision: op.nativeOp!.revision!,
    definitionHash: "d",
    subgraphHash: "s",
    outputPort: 0,
    executionId: "1",
    inputs: [],
    sourceFingerprints: null,
    complete: true,
    omissions: [],
  };
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: 20,
    totalRowCount: 20,
    truncated: true,
    resultMode: "table",
    resultVersion,
    resultSchema: schema,
    result: Array.from({ length: 2 }, (_, i) =>
      Object.fromEntries(
        schema.map(field => [
          field.name,
          field.name === "id" ? "9007199254740993" : field.name === "label" ? (i ? "null" : "A|B") : i,
        ])
      )
    ),
    tableProfile: {
      version: 1,
      resultVersion: "v1",
      status: "available",
      rowCount: 20,
      columnCount: schema.length,
      schema: schema.map(field => ({ ...field, dtype: field.type })),
      schemaComplete: true,
      coverage: { scope: "full", complete: true, expectedWorkers: 1, receivedWorkers: 1, rowsProcessed: 20 },
      columns: Object.fromEntries(
        schema.map(field => [
          field.name,
          {
            type: field.type,
            rowsProcessed: 20,
            nullCount: 0,
            nonnullCount: 20,
            nullRatio: 0,
            distinctCount: 2,
            uniquenessRatio: 0.1,
            min: null,
            max: null,
            frequencies: null,
            mergeValues: null,
            omissions: [],
          },
        ])
      ),
      structure: { duplicateRows: 0, allNullRows: 0, allNullColumns: [] },
      native: {
        operatorType: "Scan",
        inputOperators: [],
        inputRows: [],
        outputRows: 20,
        operations: { scan: { preview: false, resolvedFiles: 1, selectedFiles: 1, omittedFiles: 0, sources: [] } },
      },
      algorithm: {
        name: "bounded-exact-v1",
        rowSelection: "prefix",
        distinctLimit: 256,
        rowDistinctLimit: 4096,
        topK: 8,
      },
      cost: { collectionMs: 0, cellsProcessed: 20, payloadBytes: 0 },
      omissions: [],
    },
  } as unknown as OperatorInfo;
}
function persist(storage: WorkflowSnapshotStorage, step: string, value: OperatorInfo, execution = "1") {
  const profile = {
    ...value.tableProfile,
    protocol: "texera.table-profile",
    workerId: "w",
    producerId: "a".repeat(32),
    operatorId: "source",
    operatorRevision: workflow.operators[0].nativeOp!.revision,
    coverage: { scope: "worker", complete: true, rowsProcessed: 20, yields: 1 },
  };
  const response = prepareStructuredExecutionResult(
    {
      success: true,
      state: "Completed",
      executionId: execution,
      capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
      operators: {
        source: {
          ...value,
          numWorkers: 1,
          materialization: { outputPort: 0, executionId: execution, cached: false },
          resultMetadata: { w: JSON.stringify(profile) },
        },
      },
    },
    1,
    workflowExecutionPlan(workflow)
  );
  storage.setOperatorResult(step, "source", response.operators.source);
}
function fixture() {
  const state = new WorkflowState();
  state.setWorkflowContent(workflow);
  const steps = ["base", "read"];
  const storage = new WorkflowSnapshotStorage(id => steps.slice(0, steps.indexOf(id) + 1));
  storage.createSnapshot("base", workflow);
  storage.createSnapshot("read", workflow);
  return {
    state,
    storage,
    stepId: "read",
    context: { metadataStore: metadata },
    edited: () => {},
    isCurrent: () => true,
    execute: async () => {
      throw new Error("A read must never execute");
    },
  };
}

for (const tableFormat of ["markdown", "tsv"] as const)
  for (const wide of [false, true])
    for (const flow of [false, true])
      for (const view of ["full", "sample", "sample_stats"] as const) {
        test(`${tableFormat}, wide=${wide}, flow=${flow}, ${view}: readable frozen receipt and no hidden execution`, async () => {
          const f = fixture();
          persist(f.storage, "read", info(wide));
          const result = prepareDataflowActions({
            reasoning: "Read the executed result.",
            actions: [{ type: "retrieve", operator_id: "source", view }],
          });
          await executeDataflowActionBatch(result, {
            ...f,
            settings: {
              ...DEFAULT_AGENT_SETTINGS,
              systemPrompt: "",
              tableFormat,
              flowEvidence: flow,
              retrievalViews: ["full", "sample", "sample_stats"],
            },
          });
          expect(result.status).toBe("completed");
          const text = renderDataflowActionsResult(result);
          expect(text).toContain(`### 1. retrieve source: ok`);
          expect(text).toContain(`records: ${view}; 2 of 20 rows`);
          expect(text).toContain("9007199254740993");
          expect(text).toContain('"null"');
          expect(text.includes("statistics:")).toBe(view === "sample_stats");
          // One complete single-file scan measures nothing worth a flow line.
          expect(text.includes("- flow:")).toBe(false);
          expect(text.includes("- id:")).toBe(wide);
          if (!wide) expect(text.includes("| id | label |")).toBe(tableFormat === "markdown");
          const saved = structuredClone(result);
          f.state.setWorkflowContent(new WorkflowState().getWorkflowContent());
          expect(renderDataflowActionsResult(saved)).toBe(text);
          expect(JSON.stringify(saved)).not.toContain("NATIVE_ERROR_V2");
        });
      }

test("every prompt capability combination matches its schema and keeps the common core first", () => {
  for (const mode of [ContextMode.DELTA, ContextMode.LATEST])
    for (const data of [false, true])
      for (const flow of [false, true])
        for (const history of [false, true])
          for (const tableFormat of ["markdown", "tsv"] as const) {
            const views = data ? (["sample_stats", "full"] as const) : (["sample", "full"] as const);
            const prompt = buildNativeModeSystemPrompt(mode, {
              retrievalViews: [...views],
              flowEvidence: flow,
              stateHistory: history,
              tableFormat,
            });
            // Role and actions, then solving a task, then examples.
            const order = [
              "## Role and objective",
              "## Actions and their effects",
              "### Understanding observations",
              "## Solving a task",
              "## Examples",
            ];
            expect(prompt.startsWith(order[0])).toBe(true);
            for (let i = 1; i < order.length; i++)
              expect(prompt.indexOf(order[i - 1])).toBeLessThan(prompt.indexOf(order[i]));
            expect(prompt.includes("#### Data statistics")).toBe(data);
            expect(prompt.includes("#### Flow statistics")).toBe(flow);
            expect(prompt.includes("### Earlier tasks in the session")).toBe(history);
            expect(prompt.includes("### Example: compare with an earlier task and go back")).toBe(history);
            expect(prompt).not.toMatch(/texera|\{\{|\}\}/i);
            // Every fence closes, and example receipts carry only enabled statistics and this table syntax.
            expect((prompt.match(/^```/gm) ?? []).length % 2).toBe(0);
            const receipts = [...prompt.matchAll(/```text\n([\s\S]*?)\n```/g)].map(m => m[1]).join("\n");
            expect(/^\s*- flow\b/m.test(receipts)).toBe(flow);
            expect(/^statistics: full table/m.test(receipts)).toBe(data);
            expect(/^\|---/m.test(receipts)).toBe(tableFormat === "markdown");
            // As in the renderer, an execute receipt's blocks all have something to report.
            for (const section of receipts.split(/^(?=### )/m).filter(text => /^### \d+\. execute\b/.test(text)))
              for (const block of section.split(/^(?=- \*\*)/m).slice(1))
                expect(block).toMatch(/^ {2}- (error|note|check|flow|scope)\b/m);
            for (const [, json] of prompt.matchAll(/```json\n([\s\S]*?)\n```/g))
              expect(prepareDataflowActions(JSON.parse(json), views, history).status).toBe("pending");
            expect(JSON.stringify(dataflowActionsSchema(history))).not.toContain('"const":"fork"');
          }
});

test("format settings validate atomically, rebuild the prompt and preserve zero limits", () => {
  const agent = new TexeraAgent({
    agentId: "format-settings",
    modelType: "test",
    contextAssembler: () => [],
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
  });
  for (const patch of [
    { tableFormat: "csv" },
    { cellChars: -1 },
    { columnsShown: 1.5 },
    { answerEcho: "true" },
    { multiTask: 1 },
  ]) {
    const before = structuredClone(agent.getSettings());
    expect(() => agent.updateSettings({ maxSteps: 3, ...patch } as any)).toThrow();
    expect(agent.getSettings()).toEqual(before);
  }
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    multiTask: true,
    tableFormat: "tsv",
    keyValueColumns: 0,
    columnsShown: 0,
    definitionChars: 0,
    cellChars: 0,
    topValues: 0,
    catalogRecords: 0,
    answerEcho: false,
  });
  const settings = agent.getSettings();
  expect(settings.tableFormat).toBe("tsv");
  expect(settings.keyValueColumns).toBe(0);
  expect(settings.systemPrompt).toContain(
    "Requests in this session are tasks, numbered from 1, that share one graph and one set of registered definitions."
  );
});

test("column runs retain type boundaries, leading zeros and physical omitted counts", () => {
  expect(
    columnEntries(
      [
        { name: "Q6_1", type: "int64" },
        { name: "Q6_2", type: "int64" },
        { name: "Q6_3", type: "int64" },
        { name: "Q6_4", type: "str" },
        { name: "other", type: "str" },
      ],
      1
    )
  ).toEqual(["Q6_1..Q6_3 int64", "… +2 more"]);
  expect(columnEntries([{ name: "id01" }, { name: "id02" }, { name: "id03" }], 0, false)).toEqual([
    "id01",
    "id02",
    "id03",
  ]);
});

test("catalog includes unchanged definitions whose output version changed and keeps frozen displayed records", () => {
  const f = fixture();
  const original = info();
  persist(f.storage, "base", original);
  persist(f.storage, "read", original, "2");
  const before = taskLedger(
    { storage: f.storage, baseStepId: "base", currentStepId: "read", historicalTasks: [] },
    workflow,
    id => f.storage.getOperatorResult("read", id),
    2
  );
  expect(before).toContain("**source** (scan, recomputed)");
  expect(before).not.toContain("9007199254740993");
  f.storage.captureNativeObservations("read", ["source"], { data: false, flow: false, maxChars: 2000, view: "sample" });
  const ctx = {
    storage: f.storage,
    baseStepId: "base",
    currentStepId: "read",
    historicalTasks: [],
    settings: { catalogRecords: 1 },
  };
  const withRecords = taskLedger(ctx, workflow, id => f.storage.getOperatorResult("read", id), 2);
  expect(withRecords).toContain("records: sample; 1 of 20 rows");
  expect(withRecords).toContain("9007199254740993");
  persist(f.storage, "read", original, "3");
  const replaced = taskLedger(ctx, workflow, id => f.storage.getOperatorResult("read", id), 2);
  expect(replaced).not.toContain("records:");
  const source = workflow.operators[0];
  const block = operatorBlock(describeOperator(source, original, { definitionChars: 5, definitionLimit: true }));
  expect(block).toContain("definition clipped; inspect for full text");
  expect(block).not.toContain("revision");
});

test("new operator blocks split into independent messages and new receipts stay in tool results", () => {
  const text =
    "# Current Dataflow\n## Operators\n\n- **a** (scan, executed)\n  - result: 1 rows × 1 columns\nrecords: full\n| x |\n|---|\n| 1 |\n\n- **b** (project, not run)\n  - inputs: `a`\n  - result: not run";
  const parts = splitOperators(text);
  expect(parts).toHaveLength(3);
  expect(parts[1]).toContain("**a**");
  expect(parts[1]).not.toContain("**b**");
  const step = {
    id: "s",
    role: "agent",
    toolCalls: [
      {
        toolCallId: "c",
        toolName: "dataflow",
        input: { reasoning: "Read.", actions: [{ type: "inspect", target: "graph" }] },
      },
    ],
    toolResults: [],
  } as any;
  const frames = buildNativeFrames(
    "## Agent Event 1\nThought: Read.\nObservation:\n### 1. inspect graph: ok\nThe dataflow is empty.",
    new Map([[1, step]])
  );
  const result = JSON.stringify(frames);
  expect(result).toContain("### 1. inspect graph: ok");
  expect(result).not.toContain("Observation:");
});
