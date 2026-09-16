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
import { expect, test, spyOn } from "bun:test";
import { assertFullDataReturn, previewDependencies } from "./input-coverage";
import { TaskHistory } from "./task-history";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { TexeraAgent } from "../texera-agent";
import { AgentMode } from "../../types/agent";

const op = (id: string, type: string, inputs: string[] = [], properties: any = {}) => ({
  operatorID: id,
  operatorType: "DataProcessing",
  operatorVersion: "1",
  operatorProperties: {},
  inputPorts: [],
  outputPorts: [],
  showAdvanced: false,
  nativeOp: { type, version: "v2" as const, inputs, properties },
});

test("an aggregate's complete output does not erase a discovery preview in its dependencies", () => {
  const operators = [
    op("probe", "Scan", [], { files: "data/a.csv", preview: 5 }),
    op("parsed", "UDF", ["probe"]),
    op("total", "Aggregate", ["parsed"]),
    op("full", "Scan", [], { files: "data/a.csv" }),
    op("intentional_subset", "Limit", ["full"], { n: 5 }),
  ];
  expect(previewDependencies("total", operators)).toEqual([{ operator: "probe" }]);
  expect(() => assertFullDataReturn("total", operators)).toThrow("probe");
  expect(() => assertFullDataReturn("intentional_subset", operators)).not.toThrow();
  expect(() => assertFullDataReturn("full", operators)).not.toThrow();
});

test("coverage follows actual graph links through an opaque operator", () => {
  const source = op("probe", "Scan", [], { preview: 2 });
  const opaque: any = op("opaque", "UDF");
  delete opaque.nativeOp;
  const links: any[] = [{ source: { operatorID: "probe" }, target: { operatorID: "opaque" } }];
  expect(() => assertFullDataReturn("opaque", [source, opaque], undefined, links)).toThrow("probe");
});

test("retained outputs keep their preview origin after the current source becomes full", async () => {
  const probe = op("source", "Scan", [], { preview: 5 });
  const total = op("total", "Aggregate", ["source"]);
  const history = new TaskHistory(async () => ({ path: "/tmp/table.arrow", rowCount: 1, sha256: "a".repeat(64) }));
  const info: any = {
    state: "Completed",
    resultVersion: { id: "old" },
    materialization: { executionId: "1" },
    totalRowCount: 1,
  };
  await history.seal(1, [probe, total], new Map([["total", info]]));
  const state = new WorkflowState();
  state.addOperator(op("source", "Scan", [], { files: "data/full.csv" }));
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const saved = history.source({ operator: "total", atTask: 1 }, state, metadata);
  state.addOperator(op("comparison", "Join", ["source", saved]));
  expect(previewDependencies("comparison", state.getAllOperators(), history)).toEqual([
    { operator: "source", atTask: 1 },
  ]);
  expect(() => assertFullDataReturn("comparison", state.getAllOperators(), history)).toThrow("task 1");
  expect(() => assertFullDataReturn("source", state.getAllOperators(), history)).not.toThrow();
});

test("the production model loop refuses direct completion from a preview-derived aggregate", async () => {
  let directAnswer: string | undefined;
  let observedErrors: string[] = [];
  let agent: any;
  agent = new TexeraAgent({
    agentId: "coverage-test",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      runTurn: async input => {
        const args = {
          operators: [
            { op: "scan", id: "probe", files: "data/a.csv", preview: 5 },
            { op: "aggregate", id: "total", input: "probe", aggregations: [{ fn: "count", as: "count" }] },
          ],
          return: { operator: "total", format: "row" },
        };
        const output = await agent.tools.dataflow.execute(args);
        await input.onStepFinish({
          text: "",
          toolCalls: [{ toolName: "dataflow", toolCallId: "call", input: args }],
          toolResults: [{ toolCallId: "call", output }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        directAnswer = input.getFinalAnswer?.();
        observedErrors = output.observationErrors;
        return {
          text: "Full input must be read before answering.",
          messages: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    },
  });
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  agent.metadataStore = metadata;
  Object.assign(agent.settings, {
    agentMode: AgentMode.NATIVE,
    nativeCatalogVersion: "v2",
    nativeToolMode: "batch",
    nativeDirectReturn: true,
  });
  agent.tools = agent.createTools();
  const execution = spyOn(agent, "runPostStepExecution").mockImplementation(async () => {
    agent.snapshotStorage.setOperatorResult(agent.head, "total", {
      state: "Completed",
      resultMode: "table",
      inputTuples: 5,
      outputTuples: 1,
      result: [{ count: 5 }],
      resultSchema: [{ name: "count", type: "int64", encoding: "number-or-decimal-string" }],
      totalRowCount: 1,
      displayedRows: 1,
      truncated: false,
    });
  });
  try {
    const result = await agent.sendMessage("Count all rows in the file.");
    expect(result.error).toBeUndefined();
    expect(directAnswer).toBeUndefined();
    expect(observedErrors.join()).toContain("raw discovery previews: probe");
  } finally {
    execution.mockRestore();
  }
});
