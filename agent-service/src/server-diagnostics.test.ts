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
let initSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  _resetAgentStoreForTests();
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  backendStatus = 200;
  requests = [];
  const initialize = TexeraAgent.prototype.initialize;
  initSpy = spyOn(TexeraAgent.prototype, "initialize").mockImplementation(async function (this: TexeraAgent, config) {
    await initialize.call(this, config);
    createdAgent = this;
  });
  globalThis.fetch = Object.assign(
    async (input: any, init?: RequestInit) => {
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
