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

/**
 * Default LLM driver: hands the loop over to the Vercel AI SDK's
 * `generateText({ tools, stopWhen, prepareStep, onStepFinish })`. The
 * provider sees the tool catalog as native tool-calling frames; the SDK
 * parses `tool_calls` blocks back into typed arguments and drives the loop
 * until either no tool calls are emitted or `stopWhen` fires.
 *
 * This driver is a *thin* extraction of the inline `generateText` block
 * that used to live in `TexeraAgent.sendMessage`. The agent's per-step
 * bookkeeping is unchanged — it is passed in as `prepareStep` /
 * `onStepFinish` closures that the SDK invokes at the same boundaries it
 * always has.
 */

import { generateText, stepCountIs, type LanguageModel } from "ai";
import type { LLMDriver, DriverRunTurnInput, DriverRunTurnResult } from "./types";
import type { TokenUsage } from "../../types/agent";

export interface VercelToolUseDriverOptions {
  model: LanguageModel;
  /** Used for turns with task entries; carries explicit cache boundaries. */
  taskModel?: LanguageModel;
  /** Sampling temperature. Defaults to 0.2, matching the pre-refactor
   *  hardcoded value in TexeraAgent.sendMessage. */
  temperature?: number;
}

export class VercelToolUseDriver implements LLMDriver {
  private readonly model: LanguageModel;
  private readonly taskModel?: LanguageModel;
  private readonly temperature: number;

  constructor(opts: VercelToolUseDriverOptions) {
    this.model = opts.model;
    this.taskModel = opts.taskModel;
    this.temperature = opts.temperature ?? 0.2;
  }

  async runTurn(input: DriverRunTurnInput): Promise<DriverRunTurnResult> {
    // Summed across steps in onStepFinish; the SDK's aggregated totalUsage
    // cannot carry it because its usage schema has no such field.
    let cacheCreationTotal = 0;
    const result = await generateText({
      model: input.taskContext && this.taskModel ? this.taskModel : this.model,
      system: input.systemPrompt,
      messages: input.initialMessages,
      tools: input.tools,
      temperature: this.temperature,
      stopWhen: [stepCountIs(input.maxSteps), () => input.shouldStop?.() === true],
      prepareStep: async ({ stepNumber, messages }) => {
        return input.prepareStep({ stepNumber, messages });
      },
      abortSignal: input.abortSignal,
      // reasoning_effort is configured per-model in litellm-config.yaml via
      // extra_body to bypass LiteLLM's param validation — do not pass it here.
      providerOptions: {
        // Provider-side parallel tool-call gating. The agent serializes
        // execution into a topological order via ToolCallScheduler so it's
        // safe to let the model emit multiple tool calls in one turn.
        openai: {
          parallelToolCalls: input.parallelToolCalls,
          promptCacheKey: input.promptCacheKey,
          ...(input.taskContext && this.taskModel ? { store: false, strictJsonSchema: false } : {}),
        },
        texera: { taskCache: input.taskCache !== false },
        anthropic: { disableParallelToolUse: !input.parallelToolCalls },
        mistral: { parallelToolCalls: input.parallelToolCalls },
      },
      onStepFinish: async ({ text, reasoningText, toolCalls, toolResults, content, usage, response }) => {
        // Preserve provider cache-write accounting from the raw response;
        // the SDK's typed usage can omit these fields. This does not alter
        // requests, cache policy, model selection or stopping behavior.
        const stepCacheCreation = Number(
          (response as any)?.body?.usage?.input_tokens_details?.cache_write_tokens ??
            (response as any)?.body?.usage?.prompt_tokens_details?.cache_write_tokens ??
            (response as any)?.body?.usage?.prompt_tokens_details?.cache_creation_tokens ??
            (response as any)?.body?.usage?.cache_creation_input_tokens ??
            0
        );
        cacheCreationTotal += stepCacheCreation;
        await input.onStepFinish({
          text: text || "",
          reasoningText: reasoningText || undefined,
          toolCalls: toolCalls?.map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          })),
          toolResults: [
            ...toolResults.map(tr => {
              const outputStr = typeof tr.output === "string" ? tr.output : "";
              const isError = !!(tr.output as any)?.error || outputStr.startsWith("[ERROR]");
              return {
                toolCallId: tr.toolCallId,
                output: tr.output,
                isError,
              };
            }),
            // The SDK excludes thrown exceptions from toolResults. Preserve
            // them from content so rebuilt context cannot report a false "ok".
            ...content
              .filter(part => part.type === "tool-error")
              .map(part => ({
                toolCallId: part.toolCallId,
                output: `[ERROR] ${part.error instanceof Error ? part.error.message : String(part.error)}`,
                isError: true,
              })),
          ],
          usage: usage
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
                // Per-class breakdown — the python client re-aggregates usage per
                // step, so reasoning/cache must ride on each step's usage.
                reasoningTokens: (usage as any).reasoningTokens,
                cachedInputTokens: (usage as any).cachedInputTokens,
                cacheCreationInputTokens: stepCacheCreation,
              }
            : undefined,
        });
      },
    });

    const finalUsage = (result as any).totalUsage || result.usage;
    const usage: TokenUsage = {
      inputTokens: finalUsage?.inputTokens ?? finalUsage?.promptTokens ?? 0,
      outputTokens: finalUsage?.outputTokens ?? finalUsage?.completionTokens ?? 0,
      totalTokens: finalUsage?.totalTokens ?? 0,
      reasoningTokens: finalUsage?.reasoningTokens ?? 0,
      cachedInputTokens: finalUsage?.cachedInputTokens ?? 0,
      cacheCreationInputTokens: cacheCreationTotal,
    };
    return {
      text: result.text,
      messages: result.response.messages,
      usage,
    };
  }
}
