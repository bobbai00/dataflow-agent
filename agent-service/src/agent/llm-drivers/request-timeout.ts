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
 * Model requests that never answer.
 *
 * A model request without a deadline can wait forever: the provider accepted
 * the request and never answered, so the turn sat in GENERATING until an
 * outside watchdog killed the task. Every model request now carries a
 * deadline (`LLM_REQUEST_TIMEOUT_MS`, default 180 s; the slowest legitimate
 * step measured on feat/state-registry was 83 s), and the agent retries a
 * turn whose driver run failed this way (`TexeraAgent.sendMessage`).
 * Ported from feat/state-registry 4fbff96b5, which applied it to its
 * Responses transport.
 */

export const LLM_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000);

/** `fetch` with a deadline per request; the caller's own abort signal still wins. */
export function withRequestTimeout(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = LLM_REQUEST_TIMEOUT_MS
): typeof fetch {
  const timed = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signals = [init?.signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => !!s);
    return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
  };
  return timed as typeof fetch;
}

/** A failure worth retrying the turn for: the request timed out or the connection dropped.
 * A user stop is not transient; the caller checks its own abort signal first. */
export function isTransientModelError(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  const text = `${name}: ${error instanceof Error || error instanceof DOMException ? error.message : String(error)}`;
  const cause = (error as { cause?: unknown }).cause;
  return (
    name === "TimeoutError" ||
    /timed out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|terminated|Cannot connect to API|network/i.test(
      text
    ) ||
    (cause !== undefined && cause !== error && isTransientModelError(cause))
  );
}
