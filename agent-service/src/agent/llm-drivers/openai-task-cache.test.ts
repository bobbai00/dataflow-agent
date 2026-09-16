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
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createTaskResponsesModel, supportsTaskCache } from "./openai-task-cache";
import { VercelToolUseDriver } from "./vercel-tool-use-driver";
function reply(call = false) {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      created_at: 1,
      model: "gpt-5.6-luna",
      status: "completed",
      output: call
        ? [
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "total",
              arguments: '{"value":7}',
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "7", annotations: [] }],
            },
          ],
      usage: {
        input_tokens: 2000,
        output_tokens: 8,
        total_tokens: 2008,
        input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 800 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
const completed = (text: string) => ({
  role: "user" as const,
  content: text,
  providerOptions: { texera: { taskHistory: true } },
});
test("wire keeps roles/text and marks only the last two completed user messages", async () => {
  let body: any;
  const model = createTaskResponsesModel("gpt-5.6-luna", {
    baseURL: "https://gateway.test/api",
    apiKey: "delegated-jwt",
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://gateway.test/api/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer delegated-jwt");
      body = JSON.parse(String(init?.body));
      return reply();
    },
  });
  await generateText({
    model,
    system: "fixed instructions",
    messages: [
      completed("task one"),
      { role: "assistant", content: "answer one" },
      completed("task two"),
      { role: "assistant", content: "answer two" },
      completed("task three"),
      { role: "assistant", content: "answer three" },
      { role: "user", content: "mutable graph" },
      { role: "user", content: "current task" },
    ],
  });
  expect(body.input.map((m: any) => m.role)).toEqual([
    "developer",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "user",
  ]);
  expect(
    body.input.flatMap((m: any) => m.content.filter((c: any) => c.prompt_cache_breakpoint).map((c: any) => c.text))
  ).toEqual(["fixed instructions", "task two", "task three"]);
  expect(body.extra_body.prompt_cache_options.mode).toBe("implicit");
  expect(JSON.stringify(body)).not.toContain("taskHistory");
});
test("same Responses transport disables boundaries for a control", async () => {
  let body: any;
  const model = createTaskResponsesModel("gpt-5.6-luna", {
    apiKey: "test",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return reply();
    },
  });
  await generateText({
    model,
    system: "fixed",
    messages: [completed("old"), { role: "user", content: "new" }],
    providerOptions: { texera: { taskCache: false } },
  });
  expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
  expect(body.extra_body.prompt_cache_options.mode).toBe("implicit");
});
test("tool calls and results survive Responses round trip", async () => {
  const requests: any[] = [];
  const model = createTaskResponsesModel("gpt-5.6-luna", {
    apiKey: "test",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return reply(requests.length === 1);
    },
  });
  const result = await generateText({
    model,
    messages: [{ role: "user", content: "total" }],
    stopWhen: stepCountIs(3),
    providerOptions: { openai: { store: false, strictJsonSchema: false } },
    tools: { total: tool({ inputSchema: z.object({ value: z.number() }), execute: async ({ value }) => value }) },
  });
  expect(result.text).toBe("7");
  expect(requests).toHaveLength(2);
  expect(requests[0].tools[0].strict).toBe(false);
  expect(requests[1].input).toContainEqual(
    expect.objectContaining({ type: "function_call_output", call_id: "call_1" })
  );
});
test("driver records Responses cache writes per step and in totals", async () => {
  const model = createTaskResponsesModel("gpt-5.6-luna", { apiKey: "test", fetch: async () => reply() });
  const driver = new VercelToolUseDriver({ model, taskModel: model });
  const steps: any[] = [];
  const result = await driver.runTurn({
    initialMessages: [{ role: "user", content: "sum" }],
    systemPrompt: "fixed",
    tools: {},
    maxSteps: 2,
    parallelToolCalls: false,
    taskContext: true,
    prepareStep: async ({ messages }) => ({ messages }),
    onStepFinish: async s => {
      steps.push(s);
    },
  });
  expect(steps[0].usage.cacheCreationInputTokens).toBe(800);
  expect(result.usage.cacheCreationInputTokens).toBe(800);
  expect(result.usage.cachedInputTokens).toBe(1000);
  expect(result.usage.outputTokens).toBe(8);
});

test("explicit cache route is limited to supported OpenAI models", () => {
  for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6", "gpt-6-astra"])
    expect(supportsTaskCache(model)).toBe(true);
  for (const model of ["gpt-5.2", "claude-sonnet-5", "local-llm"]) expect(supportsTaskCache(model)).toBe(false);
});
