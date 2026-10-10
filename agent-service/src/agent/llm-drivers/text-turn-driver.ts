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

/**
 * The text transport of the registered protocol: no tools on the wire. Each
 * model step is one chat completion whose text is a turn (native/turn-syntax.ts).
 * The driver parses it into the dataflow tool's action list, runs it through
 * the same tool `execute` the JSON transport uses, and records the step with
 * one synthesized `dataflow` tool call, so execution, receipts, traces and the
 * audit are shared. The next step's context (util/context-utils-text-turn.ts)
 * replays the turn text as the assistant message and the receipt as a user
 * message.
 *
 * A reply that is not a turn (prose, or nothing), or one cut off by the
 * output limit, is recorded as a rejected turn whose receipt names the cause,
 * so the task continues and the repeated-failure guard bounds the retries.
 * `MissingAnswerActionError` is thrown only when the step budget ends without
 * an answer.
 */
import { asSchema, generateText, type LanguageModel, type ModelMessage } from "ai";
import { MissingAnswerActionError, type DriverRunTurnInput, type DriverRunTurnResult, type LLMDriver } from "./types";
import type { RetrievalView, TokenUsage } from "../../types/agent";
import { TOOL_NAME_DATAFLOW } from "../tools/native-batch-tools";
import { parseTurn, type ParsedTurn } from "../native/turn-syntax";

export interface TextTurnDriverOptions {
  model: LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  /** Retrieval views the session allows; read per step from the tool when omitted. */
  views?: () => readonly RetrievalView[];
}

/** The recorded tool-call input: the JSON tool's shape plus the turn text. */
export interface TextTurnCallInput {
  reasoning: string;
  actions: ParsedTurn["actions"];
  /** The model's message, verbatim; replayed as its assistant message. */
  turn: string;
  statements: ParsedTurn["statements"];
  missingSummary: boolean;
  ignoredProse: number[];
}

export class TextTurnDriver implements LLMDriver {
  private readonly model: LanguageModel;
  private readonly temperature: number;
  private readonly requestLimits: { maxOutputTokens?: number; maxRetries?: number };
  private readonly views?: () => readonly RetrievalView[];
  private callSeq = 0;

  constructor(opts: TextTurnDriverOptions) {
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.2;
    this.requestLimits = { maxOutputTokens: opts.maxOutputTokens, maxRetries: opts.maxRetries };
    this.views = opts.views;
  }

  async runTurn(input: DriverRunTurnInput): Promise<DriverRunTurnResult> {
    let messages: ModelMessage[] = input.initialMessages;
    const aggregated: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let lastText = "";
    const tool = input.tools[TOOL_NAME_DATAFLOW];
    if (!tool || typeof tool.execute !== "function") throw new Error("The text transport needs the dataflow tool.");
    const views = this.views?.() ?? viewsFromTool(tool);

    for (let stepNumber = 1; stepNumber <= input.maxSteps; stepNumber++) {
      const prepared = await input.prepareStep({ stepNumber, messages });
      messages = prepared.messages;
      const result = await generateText({
        model: this.model,
        ...this.requestLimits,
        system: input.systemPrompt,
        messages,
        temperature: this.temperature,
        abortSignal: input.abortSignal,
      });
      const rawText = result.text ?? "";
      lastText = rawText;
      const body = (result.response as any)?.body?.usage;
      const cacheCreation = Number(
        body?.prompt_tokens_details?.cache_write_tokens ??
          body?.prompt_tokens_details?.cache_creation_tokens ??
          body?.cache_creation_input_tokens ??
          0
      );
      const usage: TokenUsage | undefined = result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            reasoningTokens: (result.usage as any).reasoningTokens,
            cachedInputTokens: (result.usage as any).cachedInputTokens,
            cacheCreationInputTokens: cacheCreation,
          }
        : undefined;
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens", "cacheCreationInputTokens"] as const)
        if (usage?.[key] !== undefined) aggregated[key] = (aggregated[key] ?? 0) + (usage[key] ?? 0);

      const parsed = parseTurn(rawText, { views });
      const cut = result.finishReason === "length";
      const toolCallId = `text-turn-${++this.callSeq}-${Date.now()}`;
      const summary = parsed.ok ? parsed.turn.summary : "";
      const callInput: TextTurnCallInput = {
        reasoning: summary,
        actions: parsed.ok ? parsed.turn.actions : [],
        turn: rawText,
        statements: parsed.ok ? parsed.turn.statements : [],
        missingSummary: parsed.ok ? parsed.turn.missingSummary : false,
        ignoredProse: parsed.ok ? parsed.turn.ignoredProse : [],
      };
      let output: unknown;
      let isError = false;
      if (cut) {
        output = rejected(
          "the reply was cut off at the output limit before its statements ended. Keep the summary to one line and the turn short; put long work in a function."
        );
        isError = true;
      } else if (!rawText.trim()) {
        // GPT reasoning models sometimes return no visible text; a rejected
        // turn keeps the task going without spending the one correction.
        output = rejected("the reply was empty. Write a turn: a summary: line, then statements (set, execute, show).");
        isError = true;
      } else if (!parsed.ok) {
        output = rejected(
          parsed.line === undefined
            ? "this message is not a turn, so nothing was computed. The task's files are on the engine: `set <id>: scan(files='<path>')` reads one, and `show result <id>` displays it. Write a summary: line and statements; give the final answer with answer: alone in a turn, after show result has displayed what it rests on."
            : parsed.error
        );
        isError = true;
      } else {
        try {
          output = await tool.execute({ reasoning: summary, actions: parsed.turn.actions });
        } catch (error) {
          output = rejected(error instanceof Error ? error.message : String(error));
        }
        isError = !!(output as any)?.error;
      }
      await input.onStepFinish({
        text: "",
        toolCalls: [{ toolName: TOOL_NAME_DATAFLOW, toolCallId, input: callInput }],
        toolResults: [{ toolCallId, output, isError }],
        usage,
      });
      if (input.getFinalAnswer?.() !== undefined) break;
    }
    const completed: DriverRunTurnResult = { text: input.getFinalAnswer?.() ?? lastText, messages, usage: aggregated };
    if (input.requireToolCall && input.getFinalAnswer?.() === undefined) throw new MissingAnswerActionError(completed, false);
    return completed;
  }
}

/** The retrieval views the session allows, read from the tool's own schema
 * (the agent rebuilds the tool when the views change). */
function viewsFromTool(tool: any): readonly RetrievalView[] {
  try {
    const schema = asSchema(tool.inputSchema).jsonSchema as any;
    const retrieve = schema.properties.actions.items.anyOf.find((a: any) => a.properties?.type?.const === "retrieve");
    const views = retrieve?.properties?.view?.enum;
    if (Array.isArray(views) && views.length) return views as RetrievalView[];
  } catch {
    // Fall through to the default views.
  }
  return ["sample_stats", "full"];
}

/** A rejected turn in the dataflow tool's receipt shape: nothing ran. */
function rejected(message: string) {
  return {
    kind: "dataflow-actions" as const,
    protocol: "registered-python-v1" as const,
    status: "error" as const,
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
    error: `${message} No actions ran.`,
  };
}
