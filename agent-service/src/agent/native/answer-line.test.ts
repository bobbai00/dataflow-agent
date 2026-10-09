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

/** An answer without the marker line the request asks for is not accepted: the
 * receipt names the line, the turn continues, and the next answer ends the task. */
test("an answer without the requested marker line is returned and the corrected answer ends the task", async () => {
  const answers = ["27 states had ", "27 states.\n**Final Answer: 27**"];
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `answer-${++calls}`,
          toolName: "dataflow",
          input: JSON.stringify({ reasoning: "Done.", actions: [{ type: "answer", content: answers[calls - 1] }] }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const agent = new TexeraAgent({
    agentId: "answer-line",
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
  const result = await agent.sendMessage("How many states?\n\nYour last line MUST BE: **Final Answer: <value>**");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("27 states.\n**Final Answer: 27**");
  expect(calls).toBe(2);
  const steps = agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  const first = steps[0].toolResults![0].output as any;
  expect(first.status).toBe("error");
  expect(first.actions[0].output).toContain("answer not accepted");
});
