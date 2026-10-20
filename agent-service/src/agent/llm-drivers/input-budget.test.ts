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
import { generateText, jsonSchema, tool, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { DEFAULT_AGENT_SETTINGS, ContextMode } from "../../types/agent";
import type { ContextAssemblerInput } from "./types";
import {
  estimateFullInput,
  readInputBudget,
  projectChatInput,
  withInputBudget,
  budgetContextAssembler,
  InputBudgetError,
  withModelCallLimit,
} from "./input-budget";

test("shared estimator counts system, tools, frame structure, escapes and Unicode", () => {
  const input = {
    messages: [{ role: "system", content: "Rules 😊\n" }],
    tools: [{ function: { description: "long tools" } }],
  };
  expect(estimateFullInput(input, 1)).toBe(33);
  expect(estimateFullInput(input, 1)).toBe(Math.ceil(JSON.stringify(input).length / 3.3));
  expect(estimateFullInput(input, 1)).toBeGreaterThan(estimateFullInput({ messages: [] }, 1));
  expect(estimateFullInput(input, 2)).toBe(2 * Math.ceil(JSON.stringify(input).length / 3.3));
});

test("call limit counts corrections and resets only on a new request identity", async () => {
  let turn = "t1", calls = 0;
  const transport = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  const wrapped = withModelCallLimit(2, () => turn, transport);
  await wrapped("http://localhost/never");
  await wrapped("http://localhost/never");
  expect(wrapped("http://localhost/never")).rejects.toThrow("next call not sent");
  expect(calls).toBe(2);
  turn = "t2";
  await wrapped("http://localhost/never");
  expect(calls).toBe(3);
});

test("budget configuration rejects invalid values and defaults to disabled", () => {
  expect(readInputBudget({})).toEqual({ tokens: 0, scale: 1 });
  expect(readInputBudget({ MODEL_INPUT_TOKEN_BUDGET: "64000", MODEL_INPUT_TOKEN_SCALE: "0.92" })).toEqual({
    tokens: 64000,
    scale: 0.92,
  });
  for (const value of ["-1", "1.5", "NaN", ""])
    expect(() => readInputBudget({ MODEL_INPUT_TOKEN_BUDGET: value })).toThrow();
  for (const value of ["0", "-2", "Infinity", ""])
    expect(() => readInputBudget({ MODEL_INPUT_TOKEN_SCALE: value })).toThrow();
});

const fixed = () => ({
  systemPrompt: "Constant role and rules",
  tools: [{ name: "dataflow", description: "Actions", inputSchema: { type: "object" }, strict: false, enabled: true }],
});
const input = () =>
  ({ settings: { ...DEFAULT_AGENT_SETTINGS, contextMode: ContextMode.DELTA } }) as ContextAssemblerInput;

test("under-budget requests preserve the same message objects and fixed prefix", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "Short request" }];
  const result = await budgetContextAssembler(() => messages, fixed, { tokens: 1000, scale: 1 })(input());
  expect(result).toBe(messages);
});

test("disabled policy calls the existing assembler without projecting its input", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "Legacy" }];
  const wrapped = budgetContextAssembler(
    () => messages,
    () => {
      throw new Error("unused");
    },
    { tokens: 0, scale: 1 }
  );
  expect(await wrapped(input())).toBe(messages);
});

test("full overhead is subtracted before compaction and settings are not mutated", async () => {
  const original = input();
  const budgets: number[] = [];
  const assembler = (state: ContextAssemblerInput): ModelMessage[] => {
    budgets.push(state.settings.contextWindowTokens);
    return [
      {
        role: "user",
        content: "x".repeat(state.settings.contextWindowTokens > 0 ? state.settings.contextWindowTokens * 4 : 5000),
      },
    ];
  };
  const messages = await budgetContextAssembler(assembler, fixed, { tokens: 500, scale: 1 })(original);
  expect(estimateFullInput(projectChatInput(messages, fixed()), 1)).toBeLessThanOrEqual(500);
  expect(budgets.length).toBeGreaterThan(1);
  expect(original.settings.contextWindowTokens).toBe(0);
  expect(budgets[1]).toBeLessThan(500);
});

test("irreducible context fails before provider access rather than cutting a tool pair", async () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolName: "dataflow", toolCallId: "call-1", input: { code: "x".repeat(5000) } }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolName: "dataflow", toolCallId: "call-1", output: { type: "text", value: "ok" } },
      ],
    },
  ];
  expect(budgetContextAssembler(() => messages, fixed, { tokens: 500, scale: 1 })(input())).rejects.toThrow(
    InputBudgetError
  );
  expect(messages.length).toBe(2);
});

test("projection preserves tool IDs, JSON arguments, text and error results", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Think" },
        { type: "tool-call", toolName: "dataflow", toolCallId: "call-1", input: { text: 'a"b\nc' } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "dataflow",
          toolCallId: "call-1",
          output: { type: "error-json", value: { error: "missing" } },
        },
      ],
    },
  ];
  const projected = projectChatInput(messages, fixed());
  expect(projected.messages[1]).toEqual({
    role: "assistant",
    content: "Think",
    tool_calls: [
      { id: "call-1", type: "function", function: { name: "dataflow", arguments: JSON.stringify({ text: 'a"b\nc' }) } },
    ],
  });
  expect(projected.messages[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: '{"error":"missing"}' });
});

test("full projection matches the actual SDK-serialized native text and tool frames", async () => {
  let captured: any;
  const provider = createOpenAI({ apiKey: "test", fetch: (async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return Response.json({ id: "test", object: "chat.completion", created: 0, model: "test",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
    });
  }) as typeof fetch });
  const messages: ModelMessage[] = [
    { role: "user", content: "Question 😊" },
    { role: "assistant", content: [{ type: "text", text: "Think" }, { type: "tool-call", toolName: "dataflow", toolCallId: "call-1", input: { text: 'a"b\nc' } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "dataflow", toolCallId: "call-1", output: { type: "text", value: "Observation\n1\t2" } }] },
    { role: "user", content: [{ type: "text", text: "Next" }] },
  ];
  await generateText({ model: provider.chat("test"), system: fixed().systemPrompt, messages, maxRetries: 0,
    tools: { dataflow: tool({ description: "Actions", strict: false, inputSchema: jsonSchema({ type: "object" }) }) },
  });
  expect(projectChatInput(messages, fixed())).toEqual({ messages: captured.messages, tools: captured.tools });
  expect(estimateFullInput(projectChatInput(messages, fixed()), .92)).toBe(estimateFullInput(captured, .92));
});

test("wire guard includes tool overhead and rejects before any network call", async () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    return Response.json({ usage: { prompt_tokens: 5 } });
  }) as unknown as typeof fetch;
  const wrapped = withInputBudget({ tokens: 50, scale: 1 }, transport);
  const body = JSON.stringify({
    messages: [{ role: "user", content: "small" }],
    tools: [{ function: { description: "x".repeat(500) } }],
  });
  expect(wrapped("http://localhost/never", { body, method: "POST" })).rejects.toThrow(InputBudgetError);
  expect(calls).toBe(0);
  await wrapped("http://localhost/never", { body: JSON.stringify({ messages: [] }), method: "POST" });
  expect(calls).toBe(1);
});
