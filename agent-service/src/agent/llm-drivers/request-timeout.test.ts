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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { AgentMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { isTransientModelError, LLM_DEADLINE_HEADER, withRequestTimeout } from "./request-timeout";

/** A provider that accepted the request and never answers; it only honours abort. */
const neverAnswers = ((_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;

let backoff: string | undefined;
beforeAll(() => {
  backoff = process.env.MODEL_RETRY_BACKOFF_MS;
  process.env.MODEL_RETRY_BACKOFF_MS = "1";
});
afterAll(() => {
  if (backoff === undefined) delete process.env.MODEL_RETRY_BACKOFF_MS;
  else process.env.MODEL_RETRY_BACKOFF_MS = backoff;
});

test("a model request that never answers is abandoned at its deadline", async () => {
  const started = Date.now();
  const error = await withRequestTimeout(neverAnswers, 50)("http://model/v1/chat").catch(e => e);
  expect(Date.now() - started).toBeLessThan(2000);
  expect((error as DOMException).name).toBe("TimeoutError");
  expect(isTransientModelError(error)).toBe(true);
});

test("the gateway receives the same absolute deadline without modifying prompt bodies", async () => {
  const started = Date.now();
  let observed: RequestInit | undefined;
  const transport = (async (_input: unknown, init?: RequestInit) => {
    observed = init;
    return Response.json({ choices: [] });
  }) as typeof fetch;
  const headers = new Headers({ Authorization: "Bearer test", [LLM_DEADLINE_HEADER]: "1" });
  await withRequestTimeout(transport, 2000)("http://model/api/chat/completions", {
    method: "POST",
    headers,
    body: '{"messages":[]}',
  });
  const sent = new Headers(observed?.headers);
  expect(Number(sent.get(LLM_DEADLINE_HEADER))).toBeGreaterThanOrEqual(started + 2000);
  expect(Number(sent.get(LLM_DEADLINE_HEADER))).toBeLessThanOrEqual(Date.now() + 2000);
  expect(sent.get("Authorization")).toBe("Bearer test");
  expect(observed?.body).toBe('{"messages":[]}');
  expect(headers.get(LLM_DEADLINE_HEADER)).toBe("1");
  // Bun's own request sweep is off, so the deadline is the only limit.
  expect((observed as { timeout?: unknown }).timeout).toBe(false);
});

test("a Request's own headers and cancellation remain effective", async () => {
  const controller = new AbortController();
  const request = new Request("http://model/api/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { "X-Example": "kept" },
    signal: controller.signal,
  });
  let sentHeaders: Headers | undefined;
  const transport = ((input: unknown, init?: RequestInit) => {
    sentHeaders = new Headers(init?.headers);
    return neverAnswers(input as Request, init);
  }) as typeof fetch;
  const pending = withRequestTimeout(transport, 60_000)(request);
  controller.abort();
  expect((await pending.catch(e => e)).name).toBe("AbortError");
  expect(sentHeaders?.get("X-Example")).toBe("kept");
});

test("the caller's own abort still ends the request, and it is not a transient failure", async () => {
  const controller = new AbortController();
  const pending = withRequestTimeout(neverAnswers, 60_000)("http://model/v1/chat", { signal: controller.signal });
  controller.abort();
  const error = await pending.catch(e => e);
  expect((error as DOMException).name).toBe("AbortError");
  expect(isTransientModelError(error)).toBe(false);
});

test("timeouts and dropped connections are transient; request errors are not", () => {
  for (const error of [
    new DOMException("The operation timed out.", "TimeoutError"),
    new Error("fetch failed"),
    Object.assign(new Error("Cannot connect to API: socket hang up"), { name: "APICallError" }),
    Object.assign(new Error("request failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }),
  ])
    expect(isTransientModelError(error), String(error)).toBe(true);
  for (const error of [new Error("400 Bad Request: invalid tool schema"), new Error("401 Unauthorized"), undefined])
    expect(isTransientModelError(error), String(error)).toBe(false);
});

function agentWith(runTurn: (input: any) => Promise<any>) {
  const agent = new TexeraAgent({
    agentId: `retry-${Math.random()}`,
    modelType: "test",
    contextAssembler: () => [],
    driver: { runTurn },
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25 });
  return agent;
}

test("a turn whose model request timed out is retried, and the retry only gets the steps left", async () => {
  const budgets: number[] = [];
  const agent = agentWith(async input => {
    budgets.push(input.maxSteps);
    if (budgets.length === 1) {
      // Two steps were recorded before the hung request.
      for (let i = 0; i < 2; i++) await input.onStepFinish({ text: "", toolCalls: [], toolResults: [], usage: {} });
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    return { text: "Final Answer: 3", messages: [], usage: {} };
  });
  const result = await agent.sendMessage("Task.");
  expect(result.response).toBe("Final Answer: 3");
  expect(result.stopped).toBe(false);
  expect(budgets).toEqual([25, 23]);
});

test("a turn gives up after two retries, and a non-transient failure is not retried", async () => {
  let calls = 0;
  const hung = agentWith(async () => {
    calls++;
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  const failed = await hung.sendMessage("Task.");
  expect(calls).toBe(3);
  expect(failed.stopped).toBe(false);
  expect((failed as { error?: string }).error).toContain("timed out");

  calls = 0;
  const rejected = agentWith(async () => {
    calls++;
    throw new Error("400 Bad Request: invalid tool schema");
  });
  await rejected.sendMessage("Task.");
  expect(calls).toBe(1);
});
