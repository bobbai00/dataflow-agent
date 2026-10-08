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

import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type {
  TokenUsage,
  ModelRequestRecord,
  ModelRequestAccounting,
  ServiceRuntimeFingerprint,
} from "../../types/agent";
import { sumTokenUsage, TOKEN_USAGE_KEYS } from "./turn-usage-accounting";
import { providerResponseMetadata } from "./provider-response-metadata";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Equivalent gateway aliases must agree; conflicting counts remain unknown. */
function aliasCount(defaultValue: number | undefined, ...values: unknown[]): number | undefined {
  const present = values.filter(value => value !== undefined && value !== null);
  if (!present.length) return defaultValue;
  const first = count(present[0]);
  return first !== undefined && present.every(value => count(value) === first) ? first : undefined;
}

/** Raw OpenAI chat/Responses totals include cache reads and writes. Anthropic
 * input_tokens excludes both. Reasoning is a subset of output, never additive.
 * https://developers.openai.com/api/docs/guides/prompt-caching documents the
 * cache_write_tokens class and its separate rate; preserve it for pricing. */
export function normalizeProviderUsage(raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return;
  const chat = raw.prompt_tokens !== undefined;
  const responses = raw.input_tokens_details !== undefined;
  const includedCache = chat || responses;
  const details = chat ? raw.prompt_tokens_details : raw.input_tokens_details;
  const outputTokens = count(chat ? raw.completion_tokens : raw.output_tokens);
  let cachedInputTokens = aliasCount(
    includedCache ? undefined : 0,
    details?.cached_tokens,
    details?.cacheReadTokens,
    raw.cache_read_input_tokens,
    raw.cache_read_tokens,
    raw.cached_tokens
  );
  let cacheCreationInputTokens = aliasCount(
    0,
    details?.cache_write_tokens,
    details?.cache_creation_tokens,
    details?.cacheWriteTokens,
    raw.cache_creation_input_tokens,
    raw.cache_creation_tokens,
    raw.cache_write_tokens
  );
  const baseInput = count(chat ? raw.prompt_tokens : raw.input_tokens);
  const outputDetails = chat ? raw.completion_tokens_details : raw.output_tokens_details;
  let reasoningTokens = aliasCount(
    undefined,
    outputDetails?.reasoning_tokens,
    outputDetails?.reasoningTokens,
    raw.reasoning_tokens
  );
  if (baseInput === undefined || outputTokens === undefined) return;
  const inputTokens = includedCache
    ? baseInput
    : cachedInputTokens !== undefined && cacheCreationInputTokens !== undefined
      ? baseInput + cachedInputTokens + cacheCreationInputTokens
      : undefined;
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheCreationInputTokens !== undefined &&
    cachedInputTokens + cacheCreationInputTokens > inputTokens
  ) {
    cachedInputTokens = undefined;
    cacheCreationInputTokens = undefined;
  }
  if (reasoningTokens !== undefined && reasoningTokens > outputTokens) reasoningTokens = undefined;
  const totalTokens = inputTokens !== undefined ? inputTokens + outputTokens : undefined;
  if (raw.total_tokens !== undefined && count(raw.total_tokens) !== totalTokens) return;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens };
}

export function normalizeSdkUsage(usage: TokenUsage | undefined, raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return usage;
  const normalized = normalizeProviderUsage(raw);
  if (normalized) return normalized;
  // Some SDK adapters return only gateway extension fields in response.body.
  // Fill absent totals from the SDK while validating every present wire alias.
  if (usage && raw.prompt_tokens === undefined && raw.input_tokens === undefined) {
    const extended = normalizeProviderUsage({
      ...raw,
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedInputTokens, ...raw.prompt_tokens_details },
      completion_tokens_details: { reasoning_tokens: usage.reasoningTokens, ...raw.completion_tokens_details },
    });
    if (extended) return extended;
  }
  // SDK totals remain observed when wire fields are malformed or conflicting;
  // don't invent cache/reasoning classes from the first conflicting alias.
  return usage
    ? { ...usage, cachedInputTokens: undefined, cacheCreationInputTokens: undefined, reasoningTokens: undefined }
    : undefined;
}

/** A journal contains accounting metadata only, never headers, credentials,
 * prompts or provider exception text. Start is flushed before dispatch. */
export class ModelRequestLedger {
  private sequence = 0;
  private readonly records = new Map<string, ModelRequestRecord>();
  constructor(
    readonly agentId: string,
    private readonly directory?: string,
    private readonly serviceRuntime?: ServiceRuntimeFingerprint
  ) {
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Invalid agent ID for request accounting");
  }
  async record(record: ModelRequestRecord): Promise<void> {
    if (this.directory) {
      const base = join(this.directory, this.agentId);
      await mkdir(base, { recursive: true, mode: 0o700 });
      const file = await open(join(base, "model-requests.jsonl"), "a", 0o600);
      try {
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    }
    this.records.set(record.requestId, structuredClone(record));
  }
  nextId(): string {
    return `${this.agentId}-request-${++this.sequence}`;
  }
  summary(messageId?: string): ModelRequestAccounting {
    const requests = [...this.records.values()].filter(
      record => messageId === undefined || record.messageId === messageId
    );
    const unknownUsageRequestIds = requests
      .filter(
        record =>
          !record.usage ||
          ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheCreationInputTokens"].some(
            key => record.usage?.[key as keyof TokenUsage] === undefined
          )
      )
      .map(record => record.requestId);
    return {
      version: 1,
      source: "transport",
      ...(this.serviceRuntime ? { serviceRuntime: structuredClone(this.serviceRuntime) } : {}),
      messageId,
      requests: structuredClone(requests),
      attemptedRequests: requests.length,
      succeededRequests: requests.filter(record => record.status === "succeeded").length,
      failedRequests: requests.filter(record => !["pending", "succeeded"].includes(record.status)).length,
      pendingRequests: requests.filter(record => record.status === "pending").length,
      usage: sumTokenUsage(requests.flatMap(record => (record.usage ? [record.usage] : []))),
      usageCoverage: Object.fromEntries(
        TOKEN_USAGE_KEYS.map(key => [
          key,
          {
            knownRequests: requests.filter(record => record.usage?.[key] !== undefined).length,
            attemptedRequests: requests.length,
          },
        ])
      ),
      usageStatus: !unknownUsageRequestIds.length
        ? "complete"
        : requests.some(record => record.usage)
          ? "partial"
          : "unknown",
      unknownUsageRequestIds,
    };
  }
}

/** Place inside input-budget/call-limit guards to record only dispatched
 * requests, and inside response adapters to retain exact provider usage. */
export function withModelRequestAccounting(
  ledger: ModelRequestLedger,
  messageId: () => string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body =
      typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined;
    let requestedModel: string | undefined;
    try {
      const model = body ? JSON.parse(body).model : undefined;
      if (typeof model === "string") requestedModel = model;
    } catch {}
    const record: ModelRequestRecord = {
      version: 1,
      requestId: ledger.nextId(),
      agentId: ledger.agentId,
      messageId: messageId(),
      requestedModel,
      startedAt: new Date().toISOString(),
      status: "pending",
      usage: null,
      rawUsage: null,
    };
    await ledger.record(record);
    const started = performance.now();
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      record.status =
        error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "aborted" : "transport_error";
      record.finishedAt = new Date().toISOString();
      record.durationMs = performance.now() - started;
      await ledger.record(record);
      throw error;
    }
    record.status = response.ok ? "succeeded" : "http_error";
    record.httpStatus = response.status;
    try {
      const value: any = await response.clone().json();
      if (typeof value.model === "string") record.returnedModel = value.model;
      if (typeof value.id === "string") record.providerResponseId = value.id;
      record.providerResponseMetadata = providerResponseMetadata(value);
      record.rawUsage = value.usage && typeof value.usage === "object" ? value.usage : null;
      record.usage = normalizeProviderUsage(record.rawUsage) ?? null;
    } catch {
      /* Invalid/missing usage is explicitly unknown. Keep the response unchanged. */
    }
    record.finishedAt = new Date().toISOString();
    record.durationMs = performance.now() - started;
    await ledger.record(record);
    return response;
  }) as typeof fetch;
}
