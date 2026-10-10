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

import { describe, expect, spyOn, test } from "bun:test";
import { compileWorkflowAsync } from "./compile-api";
import type { LogicalPlan } from "../types/workflow";

const plan = { operators: [], links: [] } as unknown as LogicalPlan;
const hangingFetch = (started?: () => void) =>
  spyOn(globalThis, "fetch").mockImplementation(
    (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        started?.();
        const signal = init?.signal;
        if (!signal) return reject(new Error("Missing bounded cancellation signal"));
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })) as typeof fetch
  );

describe("schema compilation deadlines and cancellation", () => {
  test("a hanging compiler falls back after the deadline", async () => {
    const fetch = hangingFetch();
    try {
      expect(await compileWorkflowAsync(plan, undefined, { timeoutMs: 5 })).toBeNull();
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  test("caller cancellation rejects instead of continuing without schemas", async () => {
    const controller = new AbortController();
    const fetch = hangingFetch(() => queueMicrotask(() => controller.abort()));
    try {
      await expect(
        compileWorkflowAsync(plan, undefined, { abortSignal: controller.signal, timeoutMs: 500 })
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      fetch.mockRestore();
    }
  });

  test("an already cancelled turn never contacts the compiler", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = hangingFetch();
    try {
      await expect(compileWorkflowAsync(plan, undefined, { abortSignal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test("compiler failures still allow schema-free preparation", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    try {
      expect(await compileWorkflowAsync(plan)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test("successful schemas and auth survive the new request limits", async () => {
    const schemas = { operatorOutputSchemas: { a: {} }, operatorErrors: {} };
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(schemas));
    try {
      expect(await compileWorkflowAsync(plan, "test-token")).toEqual(schemas);
      expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer test-token" });
      expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      fetch.mockRestore();
    }
  });
});
