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

/** One response carrying the same dataflow call several times (a provider decoding
 * repeat, seen 62 times in one Qwen response) counts as one call: it runs once and
 * the replayed context shows one call with one result. Distinct calls in one
 * response still follow the one-call-per-turn rule. */
function fixture(callsAt: (call: number) => Array<{ reasoning: string; actions: unknown[] }>) {
  let calls = 0;
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      const batch = callsAt(++calls);
      return {
        content: batch.map((input, i) => ({
          type: "tool-call" as const,
          toolCallId: `dup-${calls}-${i}`,
          toolName: "dataflow",
          input: JSON.stringify(input),
        })),
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
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
  return { agent, prompts };
}

const inspect = { reasoning: "Look at the graph.", actions: [{ type: "inspect", target: "graph" }] };
const answer = { reasoning: "Done.", actions: [{ type: "answer", content: "The graph is empty." }] };

test("identical repeated tool calls in one response collapse to one recorded call that runs", async () => {
  const f = fixture(call => (call === 1 ? [inspect, inspect, inspect] : [answer]));
  const result = await f.agent.sendMessage("Check the graph.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The graph is empty.");
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(steps[0].toolCalls).toHaveLength(1);
  expect(steps[0].toolResults).toHaveLength(1);
  const receipt = steps[0].toolResults![0].output as any;
  expect(receipt.status).toBe("completed");
  expect(receipt.actions.map((a: any) => a.status)).toEqual(["ok"]);
  // The second request replays one call with one result, not three.
  const assistant = f.prompts[1].filter((m: any) => m.role === "assistant");
  const toolParts = assistant.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === "tool-call");
  expect(toolParts).toHaveLength(1);
});

test("distinct calls in one response still follow the one-call rule", async () => {
  const other = { reasoning: "Look again.", actions: [{ type: "inspect", target: "namespace" }] };
  const f = fixture(call => (call === 1 ? [inspect, other] : [answer]));
  const result = await f.agent.sendMessage("Check the graph.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(steps[0].toolCalls).toHaveLength(2);
  for (const tr of steps[0].toolResults!) expect((tr.output as any).error).toContain("Use one dataflow call per turn");
});
