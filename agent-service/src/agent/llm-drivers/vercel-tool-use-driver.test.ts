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
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { VercelToolUseDriver } from "./vercel-tool-use-driver";
import { ProviderRefusalError, type DriverStepFinish } from "./types";
import { isTransientModelError } from "./request-timeout";

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

test("an empty reply ended by the provider's content filter is a provider refusal, retried with the turn", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [],
      finishReason: { unified: "content-filter", raw: "content_filter" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const error = await new VercelToolUseDriver({ model })
    .runTurn({
      initialMessages: [{ role: "user", content: "Hello" }],
      systemPrompt: undefined,
      tools: {},
      maxSteps: 1,
      requireShownResult: true,
      resultShown: () => true,
      prepareStep: async ({ messages }) => ({ messages }),
      onStepFinish: async () => {},
    })
    .catch(e => e);
  expect(error).toBeInstanceOf(ProviderRefusalError);
  expect(isTransientModelError(error)).toBe(true);
});

test("every model request asks the provider for one tool call per turn", async () => {
  const bodies: any[] = [];
  const provider = createOpenAI({
    apiKey: "test",
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "test",
        object: "chat.completion",
        created: 0,
        model: "test",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
      });
    }) as typeof fetch,
  });
  await new VercelToolUseDriver({ model: provider.chat("test") }).runTurn({
    initialMessages: [{ role: "user", content: "Hello" }],
    systemPrompt: "System",
    tools: { dataflow: tool({ description: "Actions", inputSchema: jsonSchema({ type: "object" }) }) },
    maxSteps: 1,
    prepareStep: async ({ messages }) => ({ messages }),
    onStepFinish: async () => {},
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0].parallel_tool_calls).toBe(false);
});
