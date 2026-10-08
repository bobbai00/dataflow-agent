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
import {
  isTransientModelError,
  LLM_REQUEST_TIMEOUT_MS,
  resolveModelRequestTimeout,
  withRequestTimeout,
} from "./request-timeout";

test("explicit model deadlines resolve independently without changing the captured default", () => {
  const baseline = resolveModelRequestTimeout();
  expect(baseline.milliseconds).toBe(LLM_REQUEST_TIMEOUT_MS);
  expect(["environment", "default"]).toContain(baseline.source);
  expect(resolveModelRequestTimeout(240_000)).toEqual({ milliseconds: 240_000, source: "explicit" });
  expect(resolveModelRequestTimeout(50)).toEqual({ milliseconds: 50, source: "explicit" });
  expect(resolveModelRequestTimeout()).toEqual(baseline);
});

test("explicit model deadlines reject invalid or nonportable millisecond values", () => {
  for (const value of [0, -1, 1.5, "240000", null, true, NaN, Infinity, 2_147_483_648]) {
    expect(() => resolveModelRequestTimeout(value as any)).toThrow("Invalid model request timeout");
  }
});

test("omitted model deadline provenance is captured once instead of following environment mutations", () => {
  const baseline = resolveModelRequestTimeout();
  const original = process.env.LLM_REQUEST_TIMEOUT_MS;
  try {
    process.env.LLM_REQUEST_TIMEOUT_MS = "9";
    expect(resolveModelRequestTimeout()).toEqual(baseline);
  } finally {
    if (original === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS;
    else process.env.LLM_REQUEST_TIMEOUT_MS = original;
  }
});

test("a configured startup environment is retained as the omitted deadline's provenance", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    const { resolveModelRequestTimeout } = await import("./src/agent/llm-drivers/request-timeout.ts");
    const initial = resolveModelRequestTimeout();
    process.env.LLM_REQUEST_TIMEOUT_MS = "9";
    console.log(JSON.stringify({ initial, after: resolveModelRequestTimeout(), explicit: resolveModelRequestTimeout(50) }));
  `,
    ],
    { env: { ...process.env, LLM_REQUEST_TIMEOUT_MS: "12345" }, stdout: "pipe", stderr: "pipe" }
  );
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  const observed = JSON.parse(await new Response(child.stdout).text());
  expect(observed.initial).toEqual({ milliseconds: 12345, source: "environment" });
  expect(observed.after).toEqual(observed.initial);
  expect(observed.explicit).toEqual({ milliseconds: 50, source: "explicit" });
});

test("the fetch deadline still expires while a response body continuously makes progress", async () => {
  let chunks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue("[");
            timer = setInterval(() => {
              chunks++;
              controller.enqueue("0,");
            }, 10);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        })
      ),
  });
  try {
    const started = performance.now();
    const error = await withRequestTimeout(
      globalThis.fetch,
      100
    )(`http://localhost:${server.port}`)
      .then(response => response.text())
      .catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(["TimeoutError", "AbortError"]).toContain(error.name);
    expect(chunks).toBeGreaterThan(1);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    if (timer) clearInterval(timer);
    server.stop(true);
  }
});

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
