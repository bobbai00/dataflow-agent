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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRequestLedger, withModelRequestAccounting, normalizeProviderUsage } from "./model-request-accounting";

test("normalizes OpenAI and Anthropic cache writes as separate input subclasses", () => {
  expect(
    normalizeProviderUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 10 },
    })
  ).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 40,
    cacheCreationInputTokens: 60,
    reasoningTokens: 10,
  });
  expect(
    normalizeProviderUsage({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
      output_tokens_details: { reasoning_tokens: 10 },
    })
  ).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    cacheCreationInputTokens: 60,
    reasoningTokens: 10,
  });
  expect(
    normalizeProviderUsage({
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    })
  ).toMatchObject({ inputTokens: 100, cachedInputTokens: 40, cacheCreationInputTokens: 10 });
  expect(
    normalizeProviderUsage({ prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } })
  ).toMatchObject({ inputTokens: 20, outputTokens: 10 });
});

test("durably records unique failed and successful requests, retaining raw usage and unknown billing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-accounting-test-"));
  try {
    const ledger = new ModelRequestLedger("agent-test", directory);
    let calls = 0;
    const transport = withModelRequestAccounting(ledger, () => "turn-1", (async () => {
      if (++calls === 1) throw new Error("secret-token must not be journaled");
      return Response.json({
        model: "resolved-model",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
        },
      });
    }) as unknown as typeof fetch);
    await transport("https://provider.example", {
      body: JSON.stringify({ model: "requested-model" }),
      headers: { Authorization: "secret-token" },
    }).catch(() => {});
    await transport("https://provider.example", { body: JSON.stringify({ model: "requested-model" }) });
    const summary = ledger.summary("turn-1");
    expect(summary.attemptedRequests).toBe(2);
    expect(summary.succeededRequests).toBe(1);
    expect(summary.usageStatus).toBe("partial");
    expect(summary.unknownUsageRequestIds).toHaveLength(1);
    expect(summary.usage.inputTokens).toBe(100);
    expect(summary.requests[0].requestId).not.toBe(summary.requests[1].requestId);
    expect(summary.requests[1].rawUsage?.prompt_tokens_details).toEqual({ cached_tokens: 40, cache_write_tokens: 60 });
    const text = await readFile(join(directory, "agent-test", "model-requests.jsonl"), "utf8");
    expect(text).not.toContain("secret-token");
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
    expect(ledger.summary("another-turn").attemptedRequests).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a response with missing usage remains unknown rather than a zero-cost request", async () => {
  const ledger = new ModelRequestLedger("agent-test");
  const transport = withModelRequestAccounting(ledger, () => "turn", (async () =>
    Response.json({ model: "model" })) as unknown as typeof fetch);
  await transport("https://provider.example");
  expect(ledger.summary("turn")).toMatchObject({ succeededRequests: 1, usageStatus: "unknown" });
});

test("durable provider response metadata preserves filtering and sanitized errors without text or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-metadata-test-"));
  try {
    const ledger = new ModelRequestLedger("metadata-agent", directory);
    const body = {
      id: "public-response", model: "public-model",
      choices: [
        { index: 0, finish_reason: "content_filter", message: { content: null, refusal: null, tool_calls: null } },
        { index: 1, finish_reason: "tool_calls", message: {
          content: "PRIVATE_PROVIDER_CONTENT", refusal: "PRIVATE_REFUSAL_Bearer_secret",
          tool_calls: [{ type: "function", function: { name: "dataflow", arguments: "PRIVATE_TOOL_ARGUMENTS" } }],
        } },
      ],
      error: { type: "invalid_request_error", code: "insufficient_quota", message: "PRIVATE_ERROR_BODY_API_KEY" },
      usage: { prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 10 } },
    };
  const transport = withModelRequestAccounting(ledger, () => "turn", (async () => Response.json(body, { status: 429 })) as unknown as typeof fetch);
    const response = await transport("https://offline.invalid", { body: JSON.stringify({ model: "public-model", messages: "PRIVATE_PROMPT" }), headers: { Authorization: "PRIVATE_HEADER" } });
    expect(await response.json()).toEqual(body);
    const record: any = ledger.summary("turn").requests[0];
    expect(record.providerResponseMetadata).toEqual({
      choiceCount: 2,
      choices: [
        { index: 0, finishReason: "content_filter", refusal: null, contentCharacterCount: 0, toolCallCount: 0 },
        { index: 1, finishReason: "tool_calls", refusal: { present: true, type: "string", characterCount: 29 }, contentCharacterCount: 24, toolCallCount: 1 },
      ],
      providerError: { type: "invalid_request_error", code: "insufficient_quota", messageCharacterCount: 26 },
    });
    expect(record.usage.cacheCreationInputTokens).toBe(10);
    expect(record.status).toBe("http_error");
    const text = await readFile(join(directory, "metadata-agent/model-requests.jsonl"), "utf8");
    for (const secret of ["PRIVATE_PROVIDER_CONTENT", "PRIVATE_REFUSAL", "PRIVATE_TOOL_ARGUMENTS", "PRIVATE_ERROR_BODY", "PRIVATE_PROMPT", "PRIVATE_HEADER"])
      expect(text).not.toContain(secret);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider metadata distinguishes missing choices and withholds unknown error labels", async () => {
  const ledger = new ModelRequestLedger("metadata-agent");
  const transport = withModelRequestAccounting(ledger, () => "turn", (async () => Response.json({
    error: { type: "PRIVATE_CREDENTIAL_TYPE", code: "sk-PRIVATE-CREDENTIAL", message: "private" },
  }, { status: 403 })) as unknown as typeof fetch);
  await transport("https://offline.invalid");
  const metadata: any = (ledger.summary("turn").requests[0] as any).providerResponseMetadata;
  expect(metadata.choiceCount).toBeNull();
  expect(metadata.choices).toEqual([]);
  expect(metadata.providerError).toEqual({ type: null, code: null, messageCharacterCount: 7 });
  expect(JSON.stringify(ledger.summary())).not.toContain("PRIVATE_CREDENTIAL");
});

test("counts each actual SDK retry and preserves usage if parsing fails after transport success", async () => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const { generateText } = await import("ai");
  const ledger = new ModelRequestLedger("sdk-test");
  let calls = 0;
  const transport = withModelRequestAccounting(ledger, () => "turn", (async () => {
    calls++;
    if (calls === 1) return Response.json({ error: { message: "temporary", type: "server_error" } }, { status: 503 });
    return Response.json({
      id: "response",
      model: "resolved-model",
      created: 1,
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
  }) as unknown as typeof fetch);
  const provider = createOpenAI({ apiKey: "never-sent-outside-mock", fetch: transport });
  const result = await generateText({ model: provider.chat("test"), prompt: "Task", maxRetries: 1 });
  expect(result.text).toBe("done");
  expect(ledger.summary("turn")).toMatchObject({
    attemptedRequests: 2,
    succeededRequests: 1,
    failedRequests: 1,
    usageStatus: "partial",
    usage: { inputTokens: 100, outputTokens: 20 },
  });
});

test("missing OpenAI cache and opaque reasoning remain unknown while totals survive", async () => {
  const raw = { prompt_tokens: 100, completion_tokens: 20 };
  expect(normalizeProviderUsage(raw)).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  expect(normalizeProviderUsage(raw)?.cachedInputTokens).toBeUndefined();
  expect(normalizeProviderUsage(raw)?.reasoningTokens).toBeUndefined();
  const ledger = new ModelRequestLedger("cache-unknown");
  const transport = withModelRequestAccounting(ledger, () => "turn", (async () =>
    Response.json({ usage: raw })) as unknown as typeof fetch);
  await transport("https://mock.example");
  expect(ledger.summary()).toMatchObject({ usageStatus: "partial", usage: { inputTokens: 100, outputTokens: 20 } });
  expect(ledger.summary().usage.cachedInputTokens).toBeUndefined();
  expect(ledger.summary().usage.reasoningTokens).toBeUndefined();
  expect(ledger.summary().unknownUsageRequestIds).toHaveLength(1);
});

test("top-level gateway cache aliases agree and conflicting aliases stay unknown", async () => {
  const raw = {
    prompt_tokens: 100,
    completion_tokens: 20,
    cache_read_tokens: 40,
    cache_creation_tokens: 20,
    cache_write_tokens: 20,
  };
  expect(normalizeProviderUsage(raw)).toMatchObject({ cachedInputTokens: 40, cacheCreationInputTokens: 20 });
  const conflicting = normalizeProviderUsage({ ...raw, cache_write_tokens: 21 });
  expect(conflicting).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
  expect(conflicting?.cacheCreationInputTokens).toBeUndefined();
  const { normalizeSdkUsage } = await import("./model-request-accounting");
  expect(
    normalizeSdkUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }, { ...raw, cache_write_tokens: 21 })
      ?.cacheCreationInputTokens
  ).toBeUndefined();
});

test("conflicting and oversized cache classes preserve known totals with partial billing", async () => {
  for (const details of [
    { cached_tokens: 40, cache_write_tokens: 20, cache_creation_tokens: 21 },
    { cached_tokens: 101, cache_write_tokens: 0 },
  ]) {
    const ledger = new ModelRequestLedger("invalid-cache");
    const raw = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: details };
    const transport = withModelRequestAccounting(ledger, () => "turn", (async () =>
      Response.json({ usage: raw })) as unknown as typeof fetch);
    await transport("https://mock.example");
    const summary = ledger.summary();
    expect(summary.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(summary.usage.reasoningTokens).toBeUndefined();
    expect(summary.usageStatus).toBe("partial");
    expect(summary.unknownUsageRequestIds).toHaveLength(1);
    expect(summary.usageCoverage?.cacheCreationInputTokens.knownRequests).toBe(0);
    expect(summary.requests[0].rawUsage?.prompt_tokens_details).toEqual(details);
  }
});
