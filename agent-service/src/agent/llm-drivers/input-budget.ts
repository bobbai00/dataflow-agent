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
import type { ModelMessage } from "ai";
import type { ContextAssembler } from "./types";
import { ContextMode } from "../../types/agent";

/** An experimental service policy, disabled by default. This is a calibrated
 * estimate of the full input, not a provider tokenizer or total input+output cap. */
export interface InputBudget {
  tokens: number;
  scale: number;
}
export class InputBudgetError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly budgetTokens: number
  ) {
    super(
      `Full model input estimates ${estimatedTokens} tokens, above the ${budgetTokens} token budget; request not sent.`
    );
    this.name = "InputBudgetError";
  }
}

export function readInputBudget(environment: Record<string, string | undefined>): InputBudget {
  const tokens = environment.MODEL_INPUT_TOKEN_BUDGET === undefined ? 0 : Number(environment.MODEL_INPUT_TOKEN_BUDGET);
  const scale = environment.MODEL_INPUT_TOKEN_SCALE === undefined ? 1 : Number(environment.MODEL_INPUT_TOKEN_SCALE);
  if (environment.MODEL_INPUT_TOKEN_BUDGET === "" || !Number.isSafeInteger(tokens) || tokens < 0)
    throw new Error("MODEL_INPUT_TOKEN_BUDGET must be a nonnegative integer");
  if (environment.MODEL_INPUT_TOKEN_SCALE === "" || !Number.isFinite(scale) || scale <= 0)
    throw new Error("MODEL_INPUT_TOKEN_SCALE must be positive and finite");
  return { tokens, scale };
}

/** Shared with comparison_budget.py. Count the complete compact JSON input
 * including role/frame metadata, escaped arguments and the tool definitions.
 * JS string length counts UTF-16 units. Sampling/output settings are excluded. */
export function estimateFullInput(request: { messages?: unknown; tools?: unknown }, scale = 1): number {
  const text = JSON.stringify({ messages: request.messages ?? [], tools: request.tools ?? [] });
  return Math.ceil(Math.ceil(text.length / 3.3) * scale);
}

interface FixedInput {
  systemPrompt: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown; strict?: boolean; enabled: boolean }>;
}

/** Projection for the text and function-call frames produced by the native
 * assembler. The transport guard independently checks the actual SDK body.
 * Unsupported image/audio/approval frames fail explicitly in this experiment. */
export function projectChatInput(messages: ModelMessage[], fixed: FixedInput) {
  const projected: Array<Record<string, unknown>> = [{ role: "system", content: fixed.systemPrompt }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      projected.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      const calls: unknown[] = [];
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "tool-call")
          calls.push({
            id: part.toolCallId,
            type: "function",
            function: { name: part.toolName, arguments: JSON.stringify(part.input) },
          });
        else throw new Error(`Unsupported budgeted assistant part: ${part.type}`);
      }
      projected.push({
        role: "assistant",
        content: calls.length ? text || null : text,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") throw new Error(`Unsupported budgeted tool part: ${part.type}`);
        const output = part.output;
        const content =
          output.type === "text" || output.type === "error-text"
            ? output.value
            : output.type === "json" || output.type === "error-json"
              ? JSON.stringify(output.value)
              : undefined;
        if (content === undefined) throw new Error(`Unsupported budgeted tool output: ${output.type}`);
        projected.push({ role: "tool", tool_call_id: part.toolCallId, content });
      }
    } else if (message.role === "user" && message.content.every(part => part.type === "text")) {
      projected.push({
        role: "user",
        content:
          message.content.length === 1
            ? (message.content[0] as { text: string }).text
            : message.content.map(part => ({ type: "text", text: (part as { text: string }).text })),
      });
    } else throw new Error(`Unsupported budgeted message role: ${message.role}`);
  }
  return {
    messages: projected,
    tools: fixed.tools
      .filter(tool => tool.enabled)
      .map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: tool.strict ?? false,
        },
      })),
  };
}

/** Preserve lossless/cacheable frames while they fit. On overflow, ask the
 * existing assembler to compact whole events and remeasure the complete input.
 * Never slice a message/tool pair or change the caller's persistent settings. */
export function budgetContextAssembler(
  assemble: ContextAssembler,
  fixedInput: () => FixedInput,
  policy: InputBudget,
  observe?: (value: { before: number; after: number; trajectoryBudget: number; attempts: number }) => void
): ContextAssembler {
  if (!policy.tokens) return assemble;
  return async input => {
    if (input.settings.contextMode !== ContextMode.DELTA)
      throw new Error("Full input budget experiment requires delta context");
    const fixed = fixedInput();
    const overhead = estimateFullInput(projectChatInput([], fixed), policy.scale);
    if (overhead >= policy.tokens) throw new InputBudgetError(overhead, policy.tokens);
    let messages = await assemble(input);
    const before = estimateFullInput(projectChatInput(messages, fixed), policy.scale);
    let after = before,
      trajectoryBudget = input.settings.contextWindowTokens;
    for (let attempt = 0; attempt <= 8; attempt++) {
      if (after <= policy.tokens) {
        observe?.({ before, after, trajectoryBudget, attempts: attempt });
        return messages;
      }
      if (attempt === 8) break;
      const chars = messages.reduce(
        (sum, message) =>
          sum + (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length),
        0
      );
      const suggested = Math.max(
        1,
        Math.floor((((chars / 4) * (policy.tokens - overhead)) / Math.max(1, after - overhead)) * 0.95)
      );
      trajectoryBudget =
        trajectoryBudget > 0 ? Math.min(suggested, Math.max(1, Math.floor(trajectoryBudget * 0.8))) : suggested;
      messages = await assemble({ ...input, settings: { ...input.settings, contextWindowTokens: trajectoryBudget } });
      after = estimateFullInput(projectChatInput(messages, fixed), policy.scale);
    }
    throw new InputBudgetError(after, policy.tokens);
  };
}

/** Final independent guard at the transport boundary. Includes system/tools
 * exactly as serialized by the SDK; rejected requests incur no model call. */
export function withInputBudget(policy: InputBudget, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  if (!policy.tokens) return fetchImpl;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body =
      typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined;
    if (body === undefined) throw new Error("Cannot measure full model request body");
    const estimated = estimateFullInput(JSON.parse(body), policy.scale);
    if (estimated > policy.tokens) throw new InputBudgetError(estimated, policy.tokens);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

/** Includes protocol corrections and summary calls, which may sit outside a
 * driver's action-step counter. Failed provider attempts remain counted. */
export function withModelCallLimit(
  limit: number, turn: () => string | undefined, fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Model call limit must be a nonnegative integer");
  if (!limit) return fetchImpl;
  let key: string | undefined, calls = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const current = turn();
    if (!current) throw new Error("Model call has no current request identity");
    if (current !== key) { key = current; calls = 0; }
    if (calls >= limit) throw new Error(`Request reached ${limit} model calls; next call not sent.`);
    calls++;
    return fetchImpl(input, init);
  }) as typeof fetch;
}
