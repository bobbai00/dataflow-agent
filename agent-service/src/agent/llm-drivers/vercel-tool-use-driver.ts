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
import { MissingAnswerActionError } from "./types";
import type { TokenUsage } from "../../types/agent";

export interface VercelToolUseDriverOptions {
  model: LanguageModel;
  /** Sampling temperature. Defaults to 0.2, matching the pre-refactor
   *  hardcoded value in TexeraAgent.sendMessage. */
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
}

export class VercelToolUseDriver implements LLMDriver {
  private readonly model: LanguageModel;
  private readonly temperature: number;
  private readonly requestLimits: Pick<VercelToolUseDriverOptions, "maxOutputTokens" | "maxRetries">;

  constructor(opts: VercelToolUseDriverOptions) {
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.2;
    this.requestLimits = { maxOutputTokens: opts.maxOutputTokens, maxRetries: opts.maxRetries };
  }

  async runTurn(input: DriverRunTurnInput): Promise<DriverRunTurnResult> {
    // Summed across steps in onStepFinish; the SDK's aggregated totalUsage
    // cannot carry it because its usage schema has no such field.
    let cacheCreationTotal = 0;
    const updatedToolOutputs = new Map<string, unknown>();
    const result = await generateText({
      model: this.model,
      ...this.requestLimits,
      system: input.systemPrompt,
      messages: input.initialMessages,
      tools: input.tools,
      temperature: this.temperature,
      // An answer statement ends the request after its step.
      stopWhen: [stepCountIs(input.maxSteps), () => input.answered?.() !== undefined],
      // Never forced: a native answer is a reply without a tool call, and a
      // forced call would also rule out the model's extended reasoning.
      toolChoice: "auto",
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
        openai: { parallelToolCalls: input.parallelToolCalls },
        anthropic: { disableParallelToolUse: !input.parallelToolCalls },
        mistral: { parallelToolCalls: input.parallelToolCalls },
      },
      onStepFinish: async ({ text, reasoningText, toolCalls, toolResults, usage, response }) => {
        // Preserve cache writes from raw provider usage. Gateways expose both
        // OpenAI's cache_write_tokens and Anthropic's cache_creation_tokens;
        // the SDK's flattened usage does not retain either field reliably.
        const stepCacheCreation = Number(
          (response as any)?.body?.usage?.prompt_tokens_details?.cache_write_tokens ??
            (response as any)?.body?.usage?.prompt_tokens_details?.cache_creation_tokens ??
            (response as any)?.body?.usage?.cache_creation_input_tokens ??
            0
        );
        cacheCreationTotal += stepCacheCreation;
        const before = new Map(toolResults?.map(tr => [tr.toolCallId, JSON.stringify(tr.output)]));
        await input.onStepFinish({
          text: text || "",
          reasoningText: reasoningText || undefined,
          toolCalls: toolCalls?.map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          })),
          toolResults: toolResults?.map(tr => {
            const outputStr = typeof tr.output === "string" ? tr.output : "";
            const isError = !!(tr.output as any)?.error || outputStr.startsWith("[ERROR]");
            return {
              toolCallId: tr.toolCallId,
              output: tr.output,
              isError,
            };
          }),
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
        // The SDK cloned response.messages before calling this hook. Preserve
        // outputs completed by the agent here so the returned archive reflects
        // the same completed actions used by the next prepareStep.
        for (const tr of toolResults ?? []) {
          if (JSON.stringify(tr.output) !== before.get(tr.toolCallId)) {
            updatedToolOutputs.set(tr.toolCallId, structuredClone(tr.output));
          }
        }
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
    const completed: DriverRunTurnResult = {
      text: result.text,
      messages: result.response.messages.map(message =>
        message.role !== "tool"
          ? message
          : {
              ...message,
              content: message.content.map(part =>
                part.type === "tool-result" && part.output.type === "json" && updatedToolOutputs.has(part.toolCallId)
                  ? {
                      ...part,
                      output: {
                        type: "json" as const,
                        value: JSON.parse(JSON.stringify(updatedToolOutputs.get(part.toolCallId))),
                      },
                    }
                  : part
              ),
            }
      ),
      usage,
    };
    const answer = input.answered?.();
    if (answer !== undefined) return { ...completed, text: answer };
    if (input.requireShownResult) {
      const textOnly = result.finishReason === "stop" && !result.toolCalls.length;
      // The answer is a reply without a tool call once a result was shown;
      // before that the reply computed nothing, and the agent corrects it.
      if (textOnly && result.text.trim() && input.resultShown?.()) return completed;
      // A reply cut at the output limit is not an answer either; the model gets another call.
      const cut = result.finishReason === "length" && !result.toolCalls.length;
      throw new MissingAnswerActionError(completed, (textOnly || cut) && result.steps.length < input.maxSteps, cut);
    }
    return completed;
  }
}
