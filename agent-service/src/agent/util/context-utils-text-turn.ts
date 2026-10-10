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
 * Context for the text transport: an append-only chat transcript.
 *
 *   user:      the request (and any feedback the agent inserted)
 *   assistant: the model's turn, with fabricated receipts removed
 *   user:      the receipt of that turn (native/turn-receipt.ts)
 *
 * Each frozen replay preserves the provider prefix across later steps. Raw
 * model text remains in the recorded call input for auditing.
 */
import type { ModelMessage } from "ai";
import type { ReActStep } from "../../types/agent";
import { asDataflowActionsResult } from "../tools/dataflow-actions";
import { renderTurnReceipt } from "../native/turn-receipt";
import { sanitizeTurnReplay, type TurnReceiptInfo, type TurnStatement } from "../native/turn-syntax";

/** The receipt text of one recorded step, or undefined for a step without a call. */
export function textTurnReceipt(step: ReActStep): string | undefined {
  const call = step.toolCalls?.[0];
  if (!call) return undefined;
  const result = asDataflowActionsResult(step.toolResults?.find(r => r.toolCallId === call.toolCallId)?.output);
  if (!result) return undefined;
  const input = call.input as {
    statements?: TurnStatement[];
    missingSummary?: boolean;
    ignoredProse?: number[];
    wroteReceipt?: boolean;
  };
  const turn: TurnReceiptInfo | undefined = Array.isArray(input?.statements)
    ? {
        statements: input.statements,
        missingSummary: !!input.missingSummary,
        ignoredProse: Array.isArray(input.ignoredProse) ? input.ignoredProse : [],
        wroteReceipt: !!input.wroteReceipt,
      }
    : undefined;
  return renderTurnReceipt(result, turn);
}

export function assembleTextTurnContext(visibleSteps: ReActStep[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Adjacent same-role messages stay separate (a receipt followed by
  // feedback): merging would rewrite an earlier message and break the
  // append-only prefix that caching and the audit rely on. Providers that
  // need alternation combine them on the wire.
  const push = (role: "user" | "assistant", content: string) => messages.push({ role, content });
  for (const step of visibleSteps) {
    if (step.role === "user") {
      if (step.content) push("user", step.content);
      continue;
    }
    const call = step.toolCalls?.[0];
    if (call?.toolName === "initialize") continue;
    const input = call?.input as { turn?: string; replayText?: string } | undefined;
    const raw = typeof input?.turn === "string" ? input.turn : undefined;
    // Older saved traces lack replayText; sanitize those with the same rules.
    const turn =
      typeof input?.replayText === "string"
        ? input.replayText
        : raw !== undefined
          ? sanitizeTurnReplay(raw).replayText
          : undefined;
    // An empty reply is replayed as a marker: providers reject empty content.
    if (turn !== undefined) push("assistant", turn.trim() ? turn : "(empty reply)");
    else if (step.content && !step.isEnd) push("assistant", step.content);
    const receipt = textTurnReceipt(step);
    if (receipt !== undefined && !step.isEnd) push("user", receipt);
  }
  // The transcript ends with a user message so the next completion is the
  // model's turn; a trailing assistant message is left as the model's own.
  return messages;
}
