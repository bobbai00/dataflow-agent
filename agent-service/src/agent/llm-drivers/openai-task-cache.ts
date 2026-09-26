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

import { createOpenAI, type OpenAIProviderSettings } from "@ai-sdk/openai";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

/** The gateway exposes other vendors through Chat Completions. Only models
 * supporting OpenAI's explicit cache boundaries use this Responses adapter. */
export function supportsTaskCache(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
  return !!match && (Number(match[1]) > 5 || (Number(match[1]) === 5 && Number(match[2]) >= 6));
}

/** Bridge two fields absent from the installed AI SDK without changing its
 * tool/result conversion. Metadata comes from the assembler, never text matching.
 * Each invocation owns its fetch closure, including concurrent agents/retries. */
type TaskProviderSettings = Omit<OpenAIProviderSettings, "fetch"> & {
  fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
};

/** A request that has not answered by then is abandoned (the turn retries it):
 * the slowest legitimate step measured on 2026-09-26 was 83 s, and nine turns
 * that day sat 255 s on requests that never answered. */
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000);

export function createTaskResponsesModel(modelId: string, config: TaskProviderSettings) {
  // The SDK types fetch as Bun's global (including preconnect); it only calls it.
  const base = createOpenAI(config as OpenAIProviderSettings).responses(modelId);
  const requestModel = (params: LanguageModelV3CallOptions) => {
    const enabled = params.providerOptions?.texera?.taskCache !== false;
    const history = params.prompt
      .filter(m => m.role === "user")
      .flatMap((m, index) => (m.providerOptions?.texera?.taskHistory === true ? [index] : []))
      .slice(-2);
    const selected = new Set(enabled ? history : []);
    return createOpenAI({
      ...config,
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        // Responses defaults to strict function schemas; the existing Chat
        // tool contract intentionally has optional fields and runtime checks.
        for (const tool of body.tools ?? [])
          if (tool.type === "function" && tool.strict === undefined) tool.strict = false;
        let userIndex = 0;
        let markedDeveloper = false;
        let inDeveloperPrefix = true;
        for (const item of body.input) {
          const developer = item.role === "developer" || item.role === "system";
          const mark =
            (enabled && inDeveloperPrefix && developer && !markedDeveloper) ||
            (item.role === "user" && selected.has(userIndex));
          if (item.role === "user") userIndex++;
          if (!developer) inDeveloperPrefix = false;
          if (!mark) continue;
          if (typeof item.content === "string") item.content = [{ type: "input_text", text: item.content }];
          const part = item.content?.findLast((p: any) => p.type === "input_text");
          if (part) {
            part.prompt_cache_breakpoint = { mode: "explicit" };
            if (developer) markedDeveloper = true;
          }
        }
        // LiteLLM drops this newer top-level field; extra_body preserves it.
        body.extra_body = { ...body.extra_body, prompt_cache_options: { mode: "implicit", ttl: "30m" } };
        const signals = [init?.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter((s): s is AbortSignal => !!s);
        return (config.fetch ?? globalThis.fetch)(url, { ...init, body: JSON.stringify(body), signal: AbortSignal.any(signals) });
      }) as typeof fetch,
    }).responses(modelId);
  };
  return wrapLanguageModel({
    model: base,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: ({ params }) => requestModel(params).doGenerate(params),
      wrapStream: ({ params }) => requestModel(params).doStream(params),
    },
  });
}
