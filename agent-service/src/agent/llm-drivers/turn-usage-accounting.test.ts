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
import { TexeraAgent } from "../texera-agent";
import type { DriverRunTurnInput } from "./types";

const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3, reasoningTokens: 1 };
function agentWith(runTurn: (input: DriverRunTurnInput) => Promise<any>) {
  return new TexeraAgent({
    agentId: `accounting-${Math.random()}`,
    modelType: "test",
    contextAssembler: () => [],
    driver: { runTurn },
  });
}

for (const kind of ["failure", "abort"] as const) {
  test(`retains completed usage when a later request ends in ${kind}`, async () => {
    const agent = agentWith(async input => {
      await input.onStepFinish({ text: "working", usage });
      throw kind === "abort" ? new DOMException("Stopped", "AbortError") : new Error("400 Bad Request");
    });
    const result = await agent.sendMessage("Task");
    expect(result.usage).toMatchObject(usage);
    expect(result.stopped).toBe(kind === "abort");
  });
}

test("adds completed work before a transient retry without charging steps twice", async () => {
  const old = process.env.MODEL_RETRY_BACKOFF_MS;
  process.env.MODEL_RETRY_BACKOFF_MS = "1";
  let calls = 0;
  try {
    const agent = agentWith(async input => {
      calls++;
      await input.onStepFinish({ text: "working", usage });
      if (calls === 1) throw new DOMException("Timed out", "TimeoutError");
      return { text: "done", messages: [], usage };
    });
    const result = await agent.sendMessage("Task");
    expect(calls).toBe(2);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24, cachedInputTokens: 6 });
  } finally {
    if (old === undefined) delete process.env.MODEL_RETRY_BACKOFF_MS;
    else process.env.MODEL_RETRY_BACKOFF_MS = old;
  }
});

test("includes the first answer and its grounding correction in returned usage", async () => {
  let calls = 0;
  const agent = agentWith(async input => {
    calls++;
    await input.onStepFinish({ text: "working", usage });
    return { text: calls === 1 ? "Final Answer: 12345, 67890" : "Final Answer: corrected", messages: [], usage };
  });
  agent.updateSettings({ enableAnswerGrounding: true });
  const result = await agent.sendMessage("Task");
  expect(calls).toBe(2);
  expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24 });
});

test("transport usage takes precedence over incomplete SDK step usage after a parsing failure", async () => {
  const { ModelRequestLedger, withModelRequestAccounting } = await import("./model-request-accounting");
  const ledger = new ModelRequestLedger("ledger-test");
  let agent: TexeraAgent;
  const transport = withModelRequestAccounting(ledger, () => agent.getCurrentMessageId(), (async () =>
    Response.json({
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
    })) as unknown as typeof fetch);
  agent = new TexeraAgent({
    agentId: "ledger-test",
    modelType: "test",
    modelRequestLedger: ledger,
    contextAssembler: () => [],
    driver: {
      runTurn: async () => {
        await transport("https://mock.example");
        throw new Error("invalid provider response");
      },
    },
  });
  const result = await agent.sendMessage("Task");
  expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  expect(result.modelAccounting).toMatchObject({ attemptedRequests: 1, usageStatus: "complete" });
});
