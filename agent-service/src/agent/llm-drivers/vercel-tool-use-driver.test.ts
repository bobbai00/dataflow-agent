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
import type { DriverRunTurnInput, DriverStepFinish } from "./types";

const response = (call: number): Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>> => ({
  content:
    call === 1
      ? [{ type: "tool-call", toolCallId: "call-1", toolName: "read", input: "{}" }]
      : [{ type: "text", text: "The result is 42." }],
  finishReason: { unified: call === 1 ? "tool-calls" : "stop", raw: undefined },
  usage: {
    inputTokens: { total: 100, noCache: 30, cacheRead: 60, cacheWrite: 10 },
    outputTokens: { total: 8, text: 3, reasoning: 5 },
  },
  response: {
    body: {
      usage: call === 1 ? { prompt_tokens_details: { cache_write_tokens: 10 } } : { cache_creation_input_tokens: 7 },
    },
  },
  warnings: [],
});

function fixture(maxSteps = 3) {
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => response(++calls) });
  const driver = new VercelToolUseDriver({ model });
  const steps: DriverStepFinish[] = [];
  const events: string[] = [];
  const input: DriverRunTurnInput = {
    systemPrompt: "Shared ReAct instructions",
    initialMessages: [{ role: "user", content: "Read the result" }],
    tools: {
      read: tool({
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => {
          events.push("execute");
          return { value: 42 };
        },
      }),
    },
    maxSteps,
    parallelToolCalls: false,
    prepareStep: async ({ stepNumber, messages }) => {
      events.push(`prepare:${stepNumber}`);
      return { messages };
    },
    onStepFinish: async step => {
      events.push(`finish:${steps.length}`);
      steps.push(step);
    },
  };
  return { model, driver, input, steps, events };
}

test("the shared SDK loop executes tools, prepares the next step, and lets the model finish", async () => {
  const { model, driver, input, steps, events } = fixture();
  const result = await driver.runTurn(input);
  expect(result.text).toBe("The result is 42.");
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(events).toEqual(["prepare:0", "execute", "finish:0", "prepare:1", "finish:1"]);
  expect(steps[0]!.toolResults).toEqual([{ toolCallId: "call-1", output: { value: 42 }, isError: false }]);
  expect(steps[0]!.usage?.cacheCreationInputTokens).toBe(10);
  expect(steps[1]!.usage?.cacheCreationInputTokens).toBe(7);
  expect(result.usage).toMatchObject({
    inputTokens: 200,
    outputTokens: 16,
    cachedInputTokens: 120,
    cacheCreationInputTokens: 17,
  });
  for (const call of model.doGenerateCalls) {
    expect(call.providerOptions).toEqual({
      openai: { parallelToolCalls: false, promptCacheKey: undefined },
      texera: { taskCache: true },
      anthropic: { disableParallelToolUse: true },
      mistral: { parallelToolCalls: false },
    });
  }
});

test("the shared maxSteps cap applies even when the model asks for another tool", async () => {
  const { model, driver, input, steps } = fixture(1);
  await driver.runTurn(input);
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(steps).toHaveLength(1);
  expect(steps[0]!.toolResults?.[0]?.output).toEqual({ value: 42 });
});

test("the shared SDK loop passes cancellation to the provider without recording a completed step", async () => {
  const { model, driver, input, steps } = fixture();
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  model.doGenerate = async options => {
    invoked = true;
    expect(options.abortSignal?.aborted).toBe(true);
    options.abortSignal?.throwIfAborted();
    throw new Error("Provider should have received the aborted signal");
  };
  await expect(driver.runTurn({ ...input, abortSignal: controller.signal })).rejects.toThrow();
  expect(invoked).toBe(true);
  expect(steps).toHaveLength(0);
});
