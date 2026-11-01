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
let createdAgent: TexeraAgent;
let initSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  _resetAgentStoreForTests();
  WorkflowSystemMetadata.getInstance().seedNativeOperatorDefaults();
  const initialize = TexeraAgent.prototype.initialize;
  initSpy = spyOn(TexeraAgent.prototype, "initialize").mockImplementation(async function (this: TexeraAgent, config) {
    await initialize.call(this, config);
    createdAgent = this;
  });
  globalThis.fetch = Object.assign(
    async (input: any, init?: RequestInit) => {
      if (String(input).endsWith("/api/resources/operator-metadata"))
        return Response.json({ operators: [], groups: [] });
      expect(String(input)).toEndWith("/api/workflow/17");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const auth = new Headers(init?.headers).get("Authorization");
      const status = auth?.endsWith(".backend-approved") ? 200 : 401;
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
    },
    token()
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

test("ordinary snapshots omit the private diagnostic records of a failed operator", async () => {
  const id = await create();
  const args = { python: "", statements: "set answer: scan(files='data/answer.csv')" };
  await createdAgent.handleDebugInput(`Function(name='dataflow', arguments=${JSON.stringify(JSON.stringify(args))})`);
  const head = createdAgent.getHead()!;
  const step = createdAgent.getAllSteps().find(item => item.id === head)!;
  expect((step.toolResults![0].output as any).actions.map((item: any) => item.status)).toEqual(["ok"]);
  // An execution failure of the operator is recorded as a pinned diagnostic.
  createdAgent.getSnapshotStorage().setOperatorResult(head, "answer", {
    state: "Failed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
    error: "ORIGINAL_FAILURE: the source could not be parsed",
  });
  const diagnostics = createdAgent.getSnapshotStorage().getAssociatedSnapshot(head).nativeDiagnostics!;
  const [record] = Object.values(diagnostics);
  expect(record.operatorId).toBe("answer");
  expect(record.traceback).toContain("ORIGINAL_FAILURE");
  const snapshot = await app.handle(new Request(`http://localhost${env.API_PREFIX}/agents/${id}/snapshots/head`));
  const value = (await snapshot.json()) as Record<string, any>;
  expect(value.nativeDiagnostics).toBeUndefined();
  expect(value.results.answer.nativeError.diagnosticId).toBe(record.diagnosticId);
  expect(JSON.stringify(value)).not.toContain('"submittedSource"');
  expect(JSON.stringify(value)).not.toContain('"traceback"');
});
