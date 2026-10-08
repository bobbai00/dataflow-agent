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

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { buildApp, _resetAgentStoreForTests } from "./server";
import { WorkflowSystemMetadata } from "./agent/util/workflow-system-metadata";
import { env } from "./config/env";
import { createNativeTools } from "./agent/tools/native-batch-tools";
import { TexeraAgent } from "./agent/texera-agent";
import { LLM_REQUEST_TIMEOUT_MS } from "./agent/llm-drivers/request-timeout";

const app = buildApp(),
  originalFetch = globalThis.fetch;
const token = (uid = 1, signature = "backend-approved") =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ userId: uid, sub: "test", role: "REGULAR", exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url"),
    signature,
  ].join(".");
let backendStatus = 200,
  requests: Array<{ url: string; init?: RequestInit }>;
let createdAgent: TexeraAgent;
let modelResponse: Record<string, unknown> | undefined;
let modelRequests: Array<Record<string, any>>;
let modelNeverAnswers = false;
let modelRequestSignals: AbortSignal[];
let initSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  _resetAgentStoreForTests();
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  backendStatus = 200;
  modelResponse = undefined;
  modelRequests = [];
  modelNeverAnswers = false;
  modelRequestSignals = [];
  requests = [];
  const initialize = TexeraAgent.prototype.initialize;
  initSpy = spyOn(TexeraAgent.prototype, "initialize").mockImplementation(async function (this: TexeraAgent, config) {
    await initialize.call(this, config);
    createdAgent = this;
  });
  globalThis.fetch = Object.assign(
    async (input: any, init?: RequestInit) => {
      if ((modelResponse || modelNeverAnswers) && String(input).endsWith("/chat/completions")) {
        modelRequests.push(JSON.parse(String(init?.body)));
        if (modelNeverAnswers) {
          modelRequestSignals.push(init!.signal!);
          return new Promise<Response>((_, reject) => {
            if (init?.signal?.aborted) reject(init.signal.reason);
            else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          });
        }
        return Response.json(modelResponse);
      }
      if (String(input).endsWith("/api/resources/operator-metadata"))
        return Response.json({ operators: [], groups: [] });
      requests.push({ url: String(input), init });
      expect(String(input)).toEndWith("/api/workflow/17");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const auth = new Headers(init?.headers).get("Authorization");
      if (backendStatus === 0) throw new Error("upstream unavailable; API_KEY=do-not-echo");
      const status = auth?.endsWith(".backend-approved") ? backendStatus : 401;
      return Response.json(
        status === 200
          ? {
              wid: 17,
              name: "fixture",
              content: {
                operators: [],
                links: [],
                operatorPositions: {},
                commentBoxes: [],
                settings: { dataTransferBatchSize: 400 },
              },
            }
          : { error: "PRIVATE_BACKEND_ERROR" },
        { status }
      );
    },
    { preconnect: originalFetch.preconnect }
  );
});

test("create API uses explicit per-agent model deadlines and reports effective provenance", async () => {
  const sdkRetries = process.env.MODEL_SDK_RETRIES;
  const backoff = process.env.MODEL_RETRY_BACKOFF_MS;
  process.env.MODEL_SDK_RETRIES = "0";
  process.env.MODEL_RETRY_BACKOFF_MS = "1";
  modelNeverAnswers = true;
  try {
    const response = await post("", { modelType: "custom-model", workflowId: 17,
      settings: { agentMode: "native" }, modelRequestTimeoutMs: 30 }, token());
    expect(response.status).toBe(200);
    const info: any = await response.json();
    expect(info.modelRequestTimeoutMs).toBe(30);
    expect(info.modelRequestTimeoutSource).toBe("explicit");
    expect(info.modelRequestTimeoutMethod).toBe("abort_signal_fetch_deadline");
    const started = performance.now();
    const sent = await post(`/${info.id}/message`, { content: "Task" });
    expect(sent.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(modelRequestSignals.length).toBeGreaterThan(0);
    expect(modelRequestSignals.every(signal => signal.aborted && signal.reason?.name === "TimeoutError")).toBe(true);
    const read: any = await (await app.handle(new Request(`http://localhost${env.API_PREFIX}/agents/${info.id}`))).json();
    expect(read.modelRequestTimeoutMs).toBe(30);
    expect(read.modelRequestTimeoutSource).toBe("explicit");
  } finally {
    if (sdkRetries === undefined) delete process.env.MODEL_SDK_RETRIES;
    else process.env.MODEL_SDK_RETRIES = sdkRetries;
    if (backoff === undefined) delete process.env.MODEL_RETRY_BACKOFF_MS;
    else process.env.MODEL_RETRY_BACKOFF_MS = backoff;
  }
});

test("omitted model deadline preserves service defaults independently of earlier overrides", async () => {
  const custom = await post("", { modelType: "custom-model", workflowId: 17, modelRequestTimeoutMs: 240_000 }, token());
  expect(custom.status).toBe(200);
  const response = await post("", { modelType: "custom-model", workflowId: 17 }, token());
  const info: any = await response.json();
  expect(response.status).toBe(200);
  expect(info.modelRequestTimeoutMs).toBe(LLM_REQUEST_TIMEOUT_MS);
  expect(["environment", "default"]).toContain(info.modelRequestTimeoutSource);
});

test("invalid model deadlines are rejected before initialization or inference", async () => {
  for (const modelRequestTimeoutMs of [0, -1, 1.5, "240000", null, true, 2_147_483_648]) {
    const response = await post("", { modelType: "test", workflowId: 17, modelRequestTimeoutMs }, token());
    expect([400, 422]).toContain(response.status);
  }
  expect(requests).toHaveLength(0);
  expect(modelRequests).toHaveLength(0);
});

test("create API validates explicit generic capabilities and preserves them through the driver and info", async () => {
  modelResponse = {
    id: "capability-response",
    model: "custom-model",
    created: 1,
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "answer", type: "function", function: {
        name: "dataflow", arguments: JSON.stringify({ reasoning: "Submit answer", actions: [{ type: "answer", content: "Final Answer: 3" }] }),
      } }],
    } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
  };
  const response = await post("", {
    modelType: "custom-model", workflowId: 17, settings: { agentMode: "native" },
    modelCapabilities: { forcedToolChoice: false },
  }, token());
  expect(response.status).toBe(200);
  const info: any = await response.json();
  expect(info.modelCapabilities).toEqual({ forcedToolChoice: false, forcedToolChoiceSource: "explicit" });
  const sent = await post(`/${info.id}/message`, { content: "Task" });
  expect(sent.status).toBe(200);
  expect(modelRequests).toHaveLength(1);
  expect(modelRequests[0].tool_choice).toBe("auto");
  const read: any = await (await app.handle(new Request(`http://localhost${env.API_PREFIX}/agents/${info.id}`))).json();
  expect(read.modelCapabilities).toEqual(info.modelCapabilities);
});

test("invalid forced-tool capabilities fail before agent initialization or provider dispatch", async () => {
  requests = [];
  for (const forcedToolChoice of ["false", 0, null]) {
    const response = await post("", { modelType: "custom-model", workflowId: 17, modelCapabilities: { forcedToolChoice } }, token());
    expect([400, 422]).toContain(response.status);
  }
  expect(requests).toHaveLength(0);
  expect(modelRequests).toHaveLength(0);
});
afterEach(() => {
  initSpy.mockRestore();
  globalThis.fetch = originalFetch;
  _resetAgentStoreForTests();
});

const post = (path: string, body: unknown, credential?: string) =>
  app.handle(
    new Request(`http://localhost${env.API_PREFIX}/agents${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(body),
    })
  );
async function create() {
  const response = await post(
    "",
    {
      modelType: "test",
      workflowId: 17,
      settings: { agentMode: "native" },
    },
    token()
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

test("diagnostic endpoint fails closed on missing credentials, forged signatures, wrong owners and backend denial", async () => {
  const id = await create();
  requests = [];
  const query = { operatorId: "answer" };
  expect((await post(`/${id}/inspect-error`, query)).status).toBe(401);
  expect((await post(`/${id}/inspect-error`, query, "not-a-jwt")).status).toBe(401);
  expect(requests.length).toBe(0);
  expect((await post(`/${id}/inspect-error`, query, token(2))).status).toBe(403);
  expect((await post(`/${id}/inspect-error`, query, token(1, "forged"))).status).toBe(401);
  for (const status of [403, 404, 500, 0]) {
    backendStatus = status;
    const response = await post(`/${id}/inspect-error`, query, token());
    expect(response.status).toBe(status === 403 || status === 404 ? 403 : 503);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_BACKEND_ERROR");
    expect(text).not.toContain("do-not-echo");
  }
});

test("authorized diagnostic inspection is pinned, bounded and read-only; ordinary snapshots omit private records", async () => {
  const id = await create();
  // Archived assignment-based traces retain revision-pinned attempt diagnostics.
  const legacy = createdAgent as any;
  legacy.tools = createNativeTools(legacy.workflowState, {
    metadataStore: legacy.metadataStore,
    settings: legacy.settings,
  });
  const args = {
    edits: 'def load_answer(*ORIGINAL_FAILURE):\n    return None\nanswer = process(fn=load_answer, doc="probe")',
  };
  await createdAgent.handleDebugInput(`Function(name='dataflow', arguments=${JSON.stringify(JSON.stringify(args))})`);
  const step = createdAgent.getAllSteps().find(item => item.id === createdAgent.getHead())!;
  expect((step.toolResults![0].output as any).operators[0].message).toContain("CALLBACK_SIGNATURE");
  requests = [];
  const response = await post(`/${id}/inspect-error`, { operatorId: "answer" }, token());
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, any>;
  expect(body.found).toBe(true);
  expect(body.text).toContain("ORIGINAL_FAILURE");
  expect(body.text.length).toBeLessThan(4500);
  expect(body.summary.phase).toBe("attempt");
  expect(body.traceback).toBeUndefined();
  expect(body.submittedSource).toBeUndefined();
  expect(requests.length).toBe(1); // Permission check only; no engine, LLM or persistence call.
  expect(requests[0].init?.redirect).toBe("error");
  expect(requests[0].init?.signal).toBeDefined();
  const snapshot = await app.handle(new Request(`http://localhost${env.API_PREFIX}/agents/${id}/snapshots/head`));
  const value = (await snapshot.json()) as Record<string, any>;
  expect(value.nativeDiagnostics).toBeUndefined();
  expect(value.results.answer.nativeError.diagnosticId).toBe(body.summary.diagnosticId);
  expect(JSON.stringify(value)).not.toContain('"submittedSource"');
  expect((await post(`/${id}/inspect-error`, { operatorId: "answer", revision: "missing" }, token())).status).toBe(404);
  expect((await post(`/${id}/inspect-error`, { operatorId: "answer", maxChars: 99999 }, token())).status).toBe(400);
});

test("REST messages expose authoritative request accounting and retain it for metrics reads", async () => {
  modelResponse = {
    id: "response-fixture",
    model: "test",
    created: 1,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "answer-fixture",
              type: "function",
              function: {
                name: "dataflow",
                arguments: JSON.stringify({
                  reasoning: "Submit answer",
                  actions: [{ type: "answer", content: "Final Answer: 3" }],
                }),
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  };
  const id = await create();
  const response = await post(`/${id}/message`, { content: "Task" });
  expect(response.status).toBe(200);
  const value: any = await response.json();
  expect(value.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 60 });
  expect(value.modelAccounting).toMatchObject({ attemptedRequests: 1, succeededRequests: 1, usageStatus: "complete" });
  const metrics = await app.handle(new Request(`http://localhost${env.API_PREFIX}/agents/${id}/model-metrics`));
  const recorded: any = await metrics.json();
  expect(recorded.usage).toEqual(value.usage);
  expect(recorded.serviceRuntime.pid).toBe(process.pid);
  expect(recorded.serviceRuntime.sourceHashes["src/server.ts"]).toMatch(/^[a-f0-9]{64}$/);
  expect(recorded.serviceRuntime.sourceHashes["src/agent/native/catalog.ts"]).toMatch(/^[a-f0-9]{64}$/);
  expect(recorded.serviceRuntime.sourceHashes["src/agent/native/python/runtime.py"]).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(recorded.serviceRuntime.sourceHashes).some(path => path.startsWith("src/agent/context/"))).toBe(
    true
  );
  expect(recorded.requests[0].requestId).toBe(value.modelAccounting.requests[0].requestId);
  expect(JSON.stringify(recorded)).not.toContain(token());
});
