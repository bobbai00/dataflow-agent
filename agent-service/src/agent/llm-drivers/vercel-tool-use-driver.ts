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
import { normalizeSdkUsage } from "./model-request-accounting";
import type { ModelCapabilities, ResolvedModelCapabilities, TokenUsage } from "../../types/agent";
import { resolveModelCapabilities } from "./model-capabilities";

export interface VercelToolUseDriverOptions {
  model: LanguageModel;
  /** Sampling temperature. Defaults to 0.2, matching the pre-refactor
   *  hardcoded value in TexeraAgent.sendMessage. */
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  modelCapabilities?: ModelCapabilities;
}

export class VercelToolUseDriver implements LLMDriver {
  private readonly model: LanguageModel;
  private readonly temperature: number;
  readonly modelCapabilities: ResolvedModelCapabilities;
  private readonly requestLimits: Pick<VercelToolUseDriverOptions, "maxOutputTokens" | "maxRetries">;

  constructor(opts: VercelToolUseDriverOptions) {
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.2;
    const modelId = typeof opts.model === "string" ? opts.model : opts.model.modelId;
    this.modelCapabilities = resolveModelCapabilities(modelId, opts.modelCapabilities);
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
      stopWhen: [stepCountIs(input.maxSteps), () => input.getFinalAnswer?.() !== undefined],
      toolChoice: input.requireToolCall && this.modelCapabilities.forcedToolChoice ? "required" : "auto",
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
      onStepFinish: async ({ text, reasoningText, toolCalls, toolResults, content, usage, response }) => {
        const stepUsage = normalizeSdkUsage(usage, (response as any)?.body?.usage);
        const stepCacheCreation = stepUsage?.cacheCreationInputTokens ?? 0;
        cacheCreationTotal += stepCacheCreation;
        // SDK validation failures live in content as tool-error, rather than
        // toolResults. Keep them beside successful receipts in provider order.
        const receipts = new Map(
          content.flatMap(part => {
            if (part.type === "tool-result") {
              const output = part.output;
              return [
                [
                  part.toolCallId,
                  {
                    toolCallId: part.toolCallId,
                    output,
                    isError: !!(output as any)?.error || (typeof output === "string" && output.startsWith("[ERROR]")),
                  },
                ] as const,
              ];
            }
            if (part.type === "tool-error") {
              const error = part.error;
              const message =
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : typeof error === "string"
                    ? error
                    : (JSON.stringify(error) ?? String(error));
              return [
                [
                  part.toolCallId,
                  { toolCallId: part.toolCallId, output: `[ERROR] ${message}`, isError: true },
                ] as const,
              ];
            }
            return [];
          })
        );
        const orderedResults = toolCalls.flatMap(call => {
          const receipt = receipts.get(call.toolCallId);
          return receipt ? [receipt] : [];
        });
        const before = new Map(orderedResults.map(tr => [tr.toolCallId, JSON.stringify(tr.output)]));
        await input.onStepFinish({
          text: text || "",
          reasoningText: reasoningText || undefined,
          toolCalls: toolCalls?.map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          })),
          toolResults: orderedResults,
          usage: stepUsage,
        });
        // The SDK cloned response.messages before calling this hook. Preserve
        // outputs completed by the agent here so the returned archive reflects
        // the same completed actions used by the next prepareStep.
        for (const tr of orderedResults) {
          if (JSON.stringify(tr.output) !== before.get(tr.toolCallId)) {
            updatedToolOutputs.set(tr.toolCallId, structuredClone(tr.output));
            const original = toolResults.find(result => result.toolCallId === tr.toolCallId);
            if (original) original.output = tr.output;
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
      text: input.getFinalAnswer?.() ?? result.text,
      messages: result.response.messages.map(message =>
        message.role !== "tool"
          ? message
          : {
              ...message,
              content: message.content.map(part =>
                part.type === "tool-result" && updatedToolOutputs.has(part.toolCallId)
                  ? {
                      ...part,
                      output: {
                        type:
                          part.output.type === "error-text" || part.output.type === "error-json"
                            ? ("error-json" as const)
                            : ("json" as const),
                        value: JSON.parse(JSON.stringify(updatedToolOutputs.get(part.toolCallId))),
                      },
                    }
                  : part
              ),
            }
      ),
      usage,
    };
    if (input.requireToolCall && input.getFinalAnswer?.() === undefined) {
      throw new MissingAnswerActionError(
        completed,
        result.finishReason === "stop" && !result.toolCalls.length && result.steps.length < input.maxSteps
      );
    }
    return completed;
  }
}
