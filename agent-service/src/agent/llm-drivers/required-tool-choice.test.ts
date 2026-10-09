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
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool } from "ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRequiredToolChoice, requiredToolChoiceRecovery } from "./required-tool-choice";
import { withModelWireTrace } from "./wire-trace";

const textChoice = {
  index: 0,
  finish_reason: "stop",
  message: { role: "assistant", content: "I will inspect the graph." },
};
const toolChoice = {
  index: 1,
  finish_reason: "tool_calls",
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call-a", type: "function", function: { name: "dataflow", arguments: '{"action":"inspect"}' } }],
  },
};
const request = {
  model: "test",
  tool_choice: "required",
  tools: [{ type: "function", function: { name: "dataflow" } }],
};
const response = {
  id: "completion-a",
  object: "chat.completion",
  created: 1,
  model: "test",
  choices: [textChoice, toolChoice],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 50 },
  },
};

test("the real SDK executes the sole tool choice without another provider call and retains raw usage and wire response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "required-tool-choice-"));
  let requests = 0,
    executions = 0;
  const transport = (async (_input: any, init: any) => {
    requests++;
    expect(JSON.parse(init.body).tool_choice).toBe("required");
    return Response.json(response, { headers: { "x-request-id": "raw-request" } });
  }) as typeof fetch;
  try {
    const model = createOpenAI({
      apiKey: "unused",
      baseURL: "http://test/v1",
      fetch: withRequiredToolChoice(withModelWireTrace(directory, () => ({ agentId: "test" }), transport)),
    }).chat("test");
    const result = await generateText({
      model,
      messages: [{ role: "user", content: "Inspect the graph." }],
      toolChoice: "required",
      maxRetries: 0,
      tools: {
        dataflow: tool({
          inputSchema: jsonSchema<{ action: string }>({
            type: "object",
            properties: { action: { type: "string" } },
            required: ["action"],
          }),
          execute: async input => {
            executions++;
            return input.action;
          },
        }),
      },
    });
    expect(requests).toBe(1);
    expect(executions).toBe(1);
    expect(result.toolCalls[0].toolCallId).toBe("call-a");
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(100);
    expect(result.usage.cachedInputTokens).toBe(700);
    expect((result.response.body as any).usage).toEqual(response.usage);
    expect(result.response.headers?.["x-request-id"]).toBe("raw-request");
    expect(JSON.parse(await readFile(join(directory, "test/000001-response.json"), "utf8"))).toEqual(response);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery requires a single requested completion, required tools, and exactly one valid tool-bearing choice", () => {
  expect(requiredToolChoiceRecovery(request, response)).toBe(1);
  for (const changed of [
    { ...request, n: 2 },
    { ...request, tool_choice: "auto" },
    { ...request, stream: true },
  ])
    expect(requiredToolChoiceRecovery(changed, response)).toBeUndefined();
  for (const choices of [
    [toolChoice],
    [toolChoice, textChoice],
    [textChoice, textChoice],
    [textChoice, toolChoice, { ...toolChoice, index: 2 }],
    [
      textChoice,
      {
        ...toolChoice,
        message: {
          ...toolChoice.message,
          tool_calls: [{ ...toolChoice.message.tool_calls[0], function: { name: "unknown", arguments: "{}" } }],
        },
      },
    ],
    [textChoice, { ...toolChoice, finish_reason: "length" }],
  ])
    expect(requiredToolChoiceRecovery(request, { ...response, choices })).toBeUndefined();
});

test("ordinary responses and provider failures remain byte-identical", async () => {
  for (const status of [200, 500]) {
    const body = status === 200 ? '{ "choices": [] }' : '{"error":"provider down"}';
    const raw = new Response(body, { status });
    const wrapped = withRequiredToolChoice((async () => raw) as unknown as typeof fetch);
    const got = await wrapped("http://test", { method: "POST", body: JSON.stringify(request) });
    expect(got).toBe(raw);
    expect(await got.text()).toBe(body);
  }
});
