/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { asNativeBatchResult, batchObservedIds, nativeBatchResults, TOOL_NAME_DATAFLOW } from "./native-batch-tools";
import { prepareDataflowCall } from "./turn-tool";
import { TexeraAgent } from "../texera-agent";
import { AgentMode, type ReActStep } from "../../types/agent";

const step = (
  calls: Array<{ statements: string; observe: string[] }>
): Pick<ReActStep, "toolCalls" | "toolResults"> => ({
  toolCalls: calls.map((call, i) => ({
    toolName: TOOL_NAME_DATAFLOW,
    toolCallId: `c${i}`,
    input: { python: "", statements: call.statements },
  })),
  toolResults: calls.map((call, i) => {
    const output = prepareDataflowCall({ python: "", statements: call.statements });
    output.observe = call.observe;
    return { toolCallId: `c${i}`, output };
  }),
});

describe("native dataflow tool", () => {
  test("agent native mode exposes only dataflow and forces provider parallel calls off", () => {
    const agent = new TexeraAgent({
      agentId: "native-tools-test",
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    agent.updateSettings({ agentMode: AgentMode.NATIVE, parallelToolCalls: true });
    expect(agent.getSettings().parallelToolCalls).toBe(false);
    expect(Object.keys((agent as any).tools).sort()).toEqual(["dataflow"]);
    expect(agent.getSettings().systemPrompt).toContain('aggregate(t, by=[], outputs={"output": reducer(...)})');
    expect(agent.getSettings().systemPrompt).toContain("show result");
    const schema = asSchema((agent as any).tools.dataflow.inputSchema).jsonSchema as any;
    expect(Object.keys(schema.properties).sort()).toEqual(["python", "statements"]);
    expect([...schema.required].sort()).toEqual(["python", "statements"]);
    agent.updateSettings({ agentMode: AgentMode.CODE, parallelToolCalls: true });
    expect((agent as any).tools.createOrModifyOperator).toBeDefined();
    expect((agent as any).tools.dataflow).toBeUndefined();
    expect(agent.getSettings().parallelToolCalls).toBe(true);
  });
});

describe("receipt accounting", () => {
  test("results are read from dataflow calls only; definition lookups do not count as reads", () => {
    const read = step([
      { statements: "show result a full", observe: ["a"] },
      { statements: "show function f", observe: [] },
    ]);
    expect(nativeBatchResults(read)).toHaveLength(2);
    expect(batchObservedIds(read)).toEqual(new Set(["a"]));
    expect(batchObservedIds(step([{ statements: "show function f", observe: [] }]))).toBeUndefined();
    const other = {
      ...read,
      toolCalls: read.toolCalls!.map(call => ({ ...call, toolName: "createOrModifyOperator" })),
    };
    expect(nativeBatchResults(other)).toEqual([]);
    expect(asNativeBatchResult({ kind: "native-batch", operators: [], observe: [] })).toBeUndefined();
    expect(asNativeBatchResult("text")).toBeUndefined();
  });
});
