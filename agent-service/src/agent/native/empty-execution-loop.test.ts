/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
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

const execute = { type: "execute" };
const answer = { type: "answer", content: "No result is available." };

function fixture(actionsAt: (call: number) => unknown[], layout: "native" | "markdown" = "markdown") {
  let calls = 0;
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `empty-${++calls}`,
            toolName: "dataflow",
            input: JSON.stringify({ reasoning: "Check the graph.", actions: actionsAt(calls) }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
          outputTokens: { total: 5, text: 4, reasoning: 1 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: `empty-loop-${layout}`,
    modelType: "test",
    driver: new VercelToolUseDriver({ model }),
    contextAssembler: ({ visibleSteps, workflowState, snapshotStorage, settings }) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: layout,
        thoughtReplay: false,
      }),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false, messageLayout: layout });
  return { agent, prompts, calls: () => calls };
}

test.each(["native", "markdown"] as const)(
  "%s: repeated empty execution stops at four model calls and retains usage",
  async layout => {
    const f = fixture(() => [execute, execute, execute], layout);
    const result = await f.agent.sendMessage("Analyze the supplied file.");
    expect(
      f.calls(),
      JSON.stringify(f.agent.getVisibleReActSteps().find(s => s.toolResults?.length)?.toolResults)
    ).toBe(4);
    expect(result.error).toContain("EMPTY_EXECUTION_LOOP");
    expect(result.response).toBe("");
    expect(result.stopped).toBe(false);
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 20, cachedInputTokens: 8, reasoningTokens: 4 });
    const feedback = f.agent.getVisibleReActSteps().filter(s => s.messageSource === "feedback");
    expect(feedback).toHaveLength(1);
    expect(feedback[0].content).toContain("edit");
    expect(feedback[0].content).toContain("Answer");
    expect(JSON.stringify(f.prompts[2])).toContain(feedback[0].content);
    for (let i = 1; i < f.prompts.length; i++)
      expect(f.prompts[i].slice(0, f.prompts[i - 1].length)).toEqual(f.prompts[i - 1]);
    const receipts = f.agent.getVisibleReActSteps().flatMap(s => s.toolResults ?? []);
    expect(receipts).toHaveLength(4);
    expect(receipts.flatMap(r => (r.output as any).actions)).toHaveLength(12);
    expect(f.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    expect(f.agent.getVisibleReActSteps().at(-1)?.isEnd).toBe(true);
  }
);

test("the model can answer after the correction instead of being stopped", async () => {
  const f = fixture(call => (call <= 2 ? [execute] : [answer]));
  const result = await f.agent.sendMessage("Analyze the file.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe(answer.content);
  expect(f.calls()).toBe(3);
});

test("inspection resets the streak and unknown targets are not classified as empty execution", async () => {
  const f = fixture(call => (call === 3 ? [{ type: "inspect", target: "graph" }] : call === 6 ? [answer] : [execute]));
  expect((await f.agent.sendMessage("Inspect before correcting.")).error).toBeUndefined();
  expect(f.calls()).toBe(6);
  const unknown = fixture(call => (call === 6 ? [answer] : [{ type: "execute", operator_ids: ["missing"] }]));
  expect((await unknown.agent.sendMessage("Check the requested target.")).error).toBeUndefined();
  expect(unknown.calls()).toBe(6);
});

test("empty execution protection resets at the next user turn", async () => {
  const f = fixture(() => [execute]);
  for (let turn = 0; turn < 2; turn++) {
    expect((await f.agent.sendMessage("Try a new task.")).error).toContain("EMPTY_EXECUTION_LOOP");
    expect(f.calls()).toBe((turn + 1) * 4);
  }
});
