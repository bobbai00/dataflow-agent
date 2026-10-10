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
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { VercelToolUseDriver } from "../llm-drivers/vercel-tool-use-driver";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { renderDataflowActionsResult } from "../tools/dataflow-actions";

type Call = { python: string; statements: string };

/** One response carrying the same dataflow call several times (a provider decoding
 * repeat, seen 62 times in one Qwen response) counts as one call: it runs once and
 * the replayed context shows one call with one result. Distinct calls in one
 * response run as one call: the first call's result holds the receipt, and each
 * later call's result points to it. */
function fixture(replyAt: (call: number) => Call[] | string) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      const reply = replyAt(++calls);
      const text = typeof reply === "string";
      return {
        content: text
          ? [{ type: "text" as const, text: reply }]
          : reply.map((input, i) => ({
              type: "tool-call" as const,
              toolCallId: `dup-${calls}-${i}`,
              toolName: "dataflow",
              input: JSON.stringify(input),
            })),
        finishReason: text
          ? { unified: "stop" as const, raw: "stop" }
          : { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "duplicate-tool-calls",
    modelType: "test",
    driver: new VercelToolUseDriver({ model }),
    contextAssembler: ({ visibleSteps, workflowState, snapshotStorage, settings }) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        thoughtReplay: false,
      }),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false });
  // No engine in a unit test: every operator "executes" to one row.
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators())
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        totalRowCount: 1,
        resultMode: "table",
        result: [{ value: 42 }],
        resultSchema: [{ name: "value", type: "int64", encoding: "" }],
      });
  };
  return { agent, prompts };
}

const scan: Call = { python: "", statements: "set raw: scan(files='data/x/input/a.csv')\nshow result raw" };
const lookup: Call = { python: "", statements: "show builtin scan" };
const replayedCalls = (prompt: unknown[]) =>
  prompt
    .filter((m: any) => m.role === "assistant")
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === "tool-call");

test("identical repeated tool calls in one response collapse to one recorded call that runs", async () => {
  const f = fixture(call => (call === 1 ? [scan, scan, scan] : "The value is 42."));
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The value is 42.");
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(steps[0].toolCalls).toHaveLength(1);
  expect(steps[0].toolResults).toHaveLength(1);
  const receipt = steps[0].toolResults![0].output as any;
  expect(receipt.status).toBe("completed");
  expect(receipt.actions.map((a: any) => [a.action.type, a.status])).toEqual([
    ["edit", "ok"],
    ["execute", "ok"],
    ["retrieve", "ok"],
  ]);
  expect(f.agent.getWorkflowState().getAllOperators()).toHaveLength(1);
  // The second request replays one call with one result, not three.
  expect(replayedCalls(f.prompts[1])).toHaveLength(1);
});

test("distinct calls in one response run as one call; the later call points to the receipt", async () => {
  const f = fixture(call => (call === 1 ? [scan, lookup] : "The value is 42."));
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The value is 42.");
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(steps[0].toolCalls).toHaveLength(2);
  expect(steps[0].toolResults).toHaveLength(2);
  const [first, second] = steps[0].toolResults!.map(tr => tr.output as any);
  expect(first.status).toBe("completed");
  expect(first.actions.map((a: any) => [a.action.type, a.status])).toEqual([
    ["edit", "ok"],
    ["execute", "ok"],
    ["retrieve", "ok"],
    ["inspect", "ok"],
  ]);
  expect(second).toMatchObject({ status: "completed", actions: [], mergedInto: "dup-1-0" });
  expect(renderDataflowActionsResult(second)).toContain("ran together with the first dataflow call");
  // Both calls and both results are replayed, in order.
  expect(replayedCalls(f.prompts[1]).map((p: any) => p.toolCallId)).toEqual(["dup-1-0", "dup-1-1"]);
});

test("a statements call and a definitions call in one response run as one call", async () => {
  // DeepSeek sends the statements that use a predicate and the definition in two calls.
  const uses: Call = {
    python: "",
    statements: "set raw: scan(files='data/x/input/a.csv')\nset kept: filter(raw, predicate='keep')\nshow result kept",
  };
  const defines: Call = { python: 'def keep(row):\n    """Keep every row."""\n    return True', statements: "" };
  const f = fixture(call => (call === 1 ? [uses, defines] : "The value is 42."));
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  const [first, second] = steps[0].toolResults!.map(tr => tr.output as any);
  expect(first.status).toBe("completed");
  expect(first.actions.map((a: any) => [a.action.type, a.status])).toEqual([
    ["edit", "ok"],
    ["execute", "ok"],
    ["retrieve", "ok"],
  ]);
  expect(second).toMatchObject({ status: "completed", mergedInto: "dup-1-0" });
  expect(steps[0].toolResults!.map(tr => tr.isError)).toEqual([false, false]);
  expect(
    f.agent
      .getWorkflowState()
      .getAllOperators()
      .map(op => op.operatorID)
      .sort()
  ).toEqual(["kept", "raw"]);
});
