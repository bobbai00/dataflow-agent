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

import type { ProviderResponseMetadata } from "../../types/agent";

const FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "function_call",
  "content_filter",
  "error",
  "other",
  "unknown",
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "pause_turn",
]);
const ERROR_LABELS = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "permission_denied",
  "rate_limit_error",
  "rate_limit_exceeded",
  "overloaded_error",
  "server_error",
  "api_error",
  "invalid_api_key",
  "insufficient_quota",
  "billing_not_active",
  "model_not_found",
  "context_length_exceeded",
  "content_filter",
  "not_found_error",
]);
const record = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
const label = (value: unknown, allowed: Set<string>): string | null =>
  typeof value === "string" && allowed.has(value) ? value : null;
const length = (value: unknown): number | null => (typeof value === "string" ? value.length : null);

/** Store only terminal labels/counts; provider text may echo prompts or keys.
 * Text lengths count JavaScript UTF-16 code units. Unknown labels stay null. */
export function providerResponseMetadata(value: unknown): ProviderResponseMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = record(value);
  const choices = Array.isArray(body.choices) ? body.choices : undefined;
  const result: ProviderResponseMetadata = {
    choiceCount: choices?.length ?? null,
    choices: (choices ?? []).map(raw => {
      const choice = record(raw),
        message = record(choice.message);
      const refusal = message.refusal;
      return {
        index: Number.isSafeInteger(choice.index) && choice.index >= 0 ? choice.index : null,
        finishReason: label(choice.finish_reason, FINISH_REASONS),
        refusal:
          refusal === undefined || refusal === null
            ? null
            : {
                present: true as const,
                type: Array.isArray(refusal) ? "array" : typeof refusal,
                characterCount: length(refusal),
              },
        contentCharacterCount: message.content === null ? 0 : length(message.content),
        toolCallCount: Array.isArray(message.tool_calls)
          ? message.tool_calls.length
          : message.tool_calls === null || message.tool_calls === undefined
            ? 0
            : null,
      };
    }),
  };
  if (body.error !== undefined && body.error !== null) {
    const error = record(body.error);
    result.providerError = {
      type: label(error.type, ERROR_LABELS),
      code: label(error.code, ERROR_LABELS),
      messageCharacterCount: length(typeof body.error === "string" ? body.error : error.message),
    };
  }
  return result;
}
