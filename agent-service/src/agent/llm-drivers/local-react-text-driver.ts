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
 * Text-mode driver for the in-house local LLM. The model's tool catalog +
 * output-format instructions are baked into its training prompt (sent as
 * `system`), so the agent sends one user message per turn, no `tools` param
 * (the gateway returns the raw completion text, which this driver parses
 * itself), and no SDK-managed stop condition.
 *
 * The wire syntax depends on the configured `toolDialect` (a per-agent
 * setting; the system prompt is matched to it by the agent factory):
 *   - "qwen-xml"   — `<tool_call><function=NAME><parameter=KEY>…</parameter>
 *     …</function></tool_call>` (parser `parseQwenToolCall`). Default.
 *   - "react-text" — `Thought:` / `Action:` / `Action Input:` (parser
 *     `parseReActText`).
 *
 * Per turn:
 *   1. `prepareStep` re-renders context (events + current dataflow) into a
 *      single user message via `assembleLocalReactContext`.
 *   2. The driver calls `generateText({ model, system, messages })` — the
 *      SDK is used as a thin OpenAI-compatible chat client; routing,
 *      authentication, and the feature-flag chain (agent-service →
 *      AccessControlService → LiteLLM gateway) are inherited from the
 *      injected `model` instance, and the gateway's ChatML template wraps
 *      the system/user content as `<|im_start|>…<|im_end|>`.
 *   3. The dialect's parser pulls the thought (pre-call reasoning) + ordered
 *      list of tool calls out of the raw completion.
 *   4. The driver executes each action sequentially against the agent's
 *      tool registry, collects results, then calls `onStepFinish` so the
 *      agent's bookkeeping runs identically to the SDK path.
 *   5. The loop ends when the model emits zero tool calls in a turn (its
 *      final text-only answer) or when `maxSteps` is reached.
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { LLMDriver, DriverRunTurnInput, DriverRunTurnResult, DriverStepFinish } from "./types";
import type { TokenUsage } from "../../types/agent";
import { parseReActText, type ParsedReActOutput } from "./react-text-parser";
import { parseQwenToolCall } from "./qwen-tool-call-parser";

export interface LocalReactTextDriverOptions {
  model: LanguageModel;
  /** Sampling temperature for the wire call. Defaults to 0 — the local LLM
   *  is fine-tuned for a deterministic ReAct trajectory shape; greedy
   *  decoding stays closest to the training distribution and avoids
   *  divergence into off-format `<Analyze>` / hallucinated `(result: …)`
   *  blocks the parser then has to discard. */
  temperature?: number;
}

export class LocalReactTextDriver implements LLMDriver {
  private readonly model: LanguageModel;
  private readonly temperature: number;
  /** Increments every parsed action; used to mint stable per-call IDs the
   *  agent can correlate with the recorded ReActStep.toolCalls entries. */
  private toolCallSeq = 0;

  constructor(opts: LocalReactTextDriverOptions) {
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0;
  }

  async runTurn(input: DriverRunTurnInput): Promise<DriverRunTurnResult> {
    let messages: ModelMessage[] = input.initialMessages;
    let lastThought = "";
    const aggregated: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Pick the parser for the configured tool-call dialect once per turn (the
    // dialect is fixed for the duration of a turn). The system prompt the
    // agent sends is already matched to the same dialect, so the model's
    // emission shape and this parser agree. Default → the Qwen XML format.
    const parse: (raw: string) => ParsedReActOutput =
      input.toolDialect === "react-text" ? parseReActText : parseQwenToolCall;

    for (let stepNumber = 1; stepNumber <= input.maxSteps; stepNumber++) {
      const prepared = await input.prepareStep({ stepNumber, messages });
      messages = prepared.messages;

      // Thin HTTP completion — tools intentionally omitted (the model's
      // training prompt carries the tool catalog), but the system prompt
      // is sent so the gateway's chat template wraps it as the system
      // turn the model was trained against. The text is set by the agent
      // factory via `systemPromptBuilder` (typically the verbatim training
      // prompt from `prompts/local-react.txt`).
      const result = await generateText({
        model: this.model,
        system: input.systemPrompt,
        messages,
        temperature: this.temperature,
        abortSignal: input.abortSignal,
      });

      const rawText = result.text ?? "";
      const usage: TokenUsage | undefined = result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined;
      aggregated.inputTokens = (aggregated.inputTokens ?? 0) + (usage?.inputTokens ?? 0);
      aggregated.outputTokens = (aggregated.outputTokens ?? 0) + (usage?.outputTokens ?? 0);
      aggregated.totalTokens = (aggregated.totalTokens ?? 0) + (usage?.totalTokens ?? 0);

      const parsed = parse(rawText);
      lastThought = parsed.thought;

      const toolCalls = parsed.actions.map(a => ({
        toolName: a.name,
        toolCallId: this.nextToolCallId(),
        input: a.input,
      }));

      const toolResults: NonNullable<DriverStepFinish["toolResults"]> = [];
      for (const tc of toolCalls) {
        const tool = input.tools[tc.toolName];
        let output: any;
        let isError = false;
        if (!tool || typeof tool.execute !== "function") {
          output = `[ERROR] Tool '${tc.toolName}' not found`;
          isError = true;
        } else {
          try {
            output = await tool.execute(tc.input);
          } catch (e: any) {
            output = `[ERROR] ${e?.message ?? String(e)}`;
            isError = true;
          }
        }
        if (!isError) {
          if (typeof output === "string" && output.startsWith("[ERROR]")) isError = true;
          else if (output && typeof output === "object" && (output as any).error) isError = true;
        }
        toolResults.push({ toolCallId: tc.toolCallId, output, isError });
      }

      await input.onStepFinish({
        text: parsed.thought,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        usage,
      });

      // Native mode ends with the explicit Answer action. Code-mode models
      // retain their existing convention of ending with a text-only reply.
      if (input.getFinalAnswer?.() !== undefined || toolCalls.length === 0) break;
    }

    if (input.requireToolCall && input.getFinalAnswer?.() === undefined) {
      throw new Error(
        "The turn ended without an answer action. The model stopped or reached the step limit; no final answer was produced."
      );
    }
    return {
      text: input.getFinalAnswer?.() ?? lastThought,
      messages,
      usage: aggregated,
    };
  }

  private nextToolCallId(): string {
    return `local-react-tc-${++this.toolCallSeq}-${Date.now()}`;
  }
}
