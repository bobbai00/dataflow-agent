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

import { expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { jsonSchema, tool } from "ai";
import { VercelToolUseDriver } from "./vercel-tool-use-driver";
import type { DriverStepFinish } from "./types";

for (const field of ["cache_write_tokens", "cache_creation_tokens"]) {
  test(`records raw ${field} in per-step and total usage`, async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 2000, noCache: 500, cacheRead: 1000, cacheWrite: 500 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        response: { body: { usage: { prompt_tokens_details: { [field]: 500 } } } },
        warnings: [],
      }),
    });
    const steps: DriverStepFinish[] = [];
    const result = await new VercelToolUseDriver({ model }).runTurn({
      initialMessages: [{ role: "user", content: "Hello" }],
      systemPrompt: undefined,
      tools: {},
      maxSteps: 1,
      parallelToolCalls: false,
      prepareStep: async ({ messages }) => ({ messages }),
      onStepFinish: async step => {
        steps.push(step);
      },
    });
    expect(steps[0].usage?.cacheCreationInputTokens).toBe(500);
    expect(result.usage.cacheCreationInputTokens).toBe(500);
    expect(result.usage.cachedInputTokens).toBe(1000);
    expect(result.usage.inputTokens).toBe(2000);
  });
}

for (const [modelId, forcedToolChoice, expected] of [
  ["custom-model", false, "auto"],
  ["custom-model", true, "required"],
  ["custom-model", undefined, "required"],
  ["claude-sonnet-5.5", undefined, "auto"],
  ["claude-sonnet-5-5", undefined, "auto"],
  ["claude-sonnet-5.5", true, "required"],
] as const) {
  test(`resolves ${modelId} forcedToolChoice=${forcedToolChoice} once and passes ${expected}`, async () => {
    const choices: unknown[] = [];
    const model = new MockLanguageModelV3({
      modelId,
      doGenerate: async options => {
        choices.push(options.toolChoice);
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const driver = new VercelToolUseDriver({
      model,
      modelCapabilities: forcedToolChoice === undefined ? undefined : { forcedToolChoice },
    });
    await driver.runTurn({
      initialMessages: [{ role: "user", content: "Original task" }],
      systemPrompt: "Original prompt",
      tools: { fixture: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) }) },
      maxSteps: 1,
      parallelToolCalls: false,
      requireToolCall: true,
      getFinalAnswer: () => "done",
      prepareStep: async ({ messages }) => ({ messages }),
      onStepFinish: async () => {},
    });
    expect(choices).toEqual([{ type: expected }]);
  });
}
