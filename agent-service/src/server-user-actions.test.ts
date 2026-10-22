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

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { buildApp, _resetAgentStoreForTests } from "./server";
import { WorkflowSystemMetadata } from "./agent/util/workflow-system-metadata";
import { env } from "./config/env";
import { TexeraAgent } from "./agent/texera-agent";
import { AgentState } from "./types/agent";

const app = buildApp(),
  originalFetch = globalThis.fetch;
const token = () =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ userId: 1, sub: "test", role: "REGULAR", exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url"),
    "signature",
  ].join(".");
let agent: TexeraAgent;
let initSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  _resetAgentStoreForTests();
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const initialize = TexeraAgent.prototype.initialize;
  initSpy = spyOn(TexeraAgent.prototype, "initialize").mockImplementation(async function (this: TexeraAgent, config) {
    await initialize.call(this, config);
    agent = this;
    // The engine: every operator completes with three rows.
    (this as any).executePostStepChanges = async () => {
      for (const op of this.getWorkflowState().getAllOperators())
        this.getSnapshotStorage().setOperatorResult(this.getHead()!, op.operatorID, {
          state: "Completed",
          inputTuples: 3,
          outputTuples: 3,
          totalRowCount: 3,
          resultMode: "table",
          result: [{ value: 1 }, { value: 2 }, { value: 3 }],
          resultSchema: [{ name: "value", type: "int64", encoding: "" }],
        });
    };
  });
  globalThis.fetch = Object.assign(
    async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/resources/operator-metadata")) return Response.json({ operators: [], groups: [] });
      if (url.endsWith("/api/workflow/17"))
        return Response.json({
          wid: 17,
          name: "fixture",
          content: { operators: [], links: [], operatorPositions: {}, commentBoxes: [], settings: {} },
        });
      // Compilation and persistence are not under test.
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect }
  );
});
afterEach(() => {
  initSpy.mockRestore();
  globalThis.fetch = originalFetch;
  _resetAgentStoreForTests();
});

const call = (method: string, path: string, body?: unknown) =>
  app.handle(
    new Request(`http://localhost${env.API_PREFIX}/agents${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );

/** A native agent whose dataflow has a registered loader and a filter. */
async function created(): Promise<string> {
  const response = await call("POST", "", { modelType: "test", workflowId: 17, settings: { agentMode: "native" } });
  expect(response.status).toBe(200);
  const id = ((await response.json()) as { id: string }).id;
  const args = {
    python: "import pandas as pd\ndef make_table(*, n=3):\n    return pd.DataFrame({'value': list(range(n))})",
    statements: "set records: make_table(n=3)\nset kept: filter(records, lambda row: row['value'] > 0)",
  };
  await agent.handleDebugInput(`Function(name='dataflow', arguments=${JSON.stringify(JSON.stringify(args))})`);
  return id;
}

test("the form splits an operator's statement into its fields", async () => {
  const id = await created();
  const filter = await call("GET", `/${id}/operators/kept/form`);
  expect(filter.status).toBe(200);
  expect(await filter.json()).toEqual({
    id: "kept",
    op: "filter",
    inputs: ["records"],
    positional: [{ source: "lambda row: row['value'] > 0", kind: "lambda" }],
    keywords: [],
    statement: "set kept: filter(records, lambda row: row['value'] > 0)",
  });
  const loader = (await (await call("GET", `/${id}/operators/records/form`)).json()) as Record<string, any>;
  expect(loader.keywords).toEqual([{ name: "n", source: "3", kind: "number", value: 3 }]);
  expect(loader.definition.name).toBe("make_table");
  expect(loader.definition.source).toContain("def make_table(*, n=3):");
  expect((await call("GET", `/${id}/operators/nope/form`)).status).toBe(404);
});

test("edit and run record user steps; a rejected edit is a 400 and records nothing", async () => {
  const id = await created();
  const edited = await call("POST", `/${id}/operators/kept/edit`, {
    statement: "set kept: filter(records, lambda row: row['value'] > 1)",
  });
  expect(edited.status).toBe(200);
  const body = (await edited.json()) as Record<string, any>;
  expect(body.status).toBe("ok");
  expect(body.userAction).toMatchObject({ kind: "edit", operatorId: "kept", status: "ok" });
  expect(body.content).toStartWith("I edited `kept` on the canvas.");

  const run = (await (await call("POST", `/${id}/operators/kept/run`)).json()) as Record<string, any>;
  expect(run.userAction).toEqual({ kind: "run", operatorId: "kept", status: "ok", rows: 3 });
  expect(run.operatorResults.kept.outputTuples).toBe(3);

  const steps = ((await (await call("GET", `/${id}/react-steps`)).json()) as { steps: any[] }).steps;
  expect(steps.filter(step => step.messageSource === "action").map(step => step.userAction.kind)).toEqual([
    "edit",
    "run",
  ]);

  const rejected = await call("POST", `/${id}/operators/kept/edit`, { statement: "set kept: filter(records," });
  expect(rejected.status).toBe(400);
  expect(((await rejected.json()) as { error: string }).error).toBeTruthy();
  const unchanged = await call("POST", `/${id}/operators/kept/edit`, {
    statement: "set kept: filter(records, lambda row: row['value'] > 1)",
  });
  expect(await unchanged.json()).toMatchObject({ status: "unchanged" });
  const after = ((await (await call("GET", `/${id}/react-steps`)).json()) as { steps: any[] }).steps;
  expect(after.length).toBe(steps.length);
});

test("a busy agent refuses canvas actions without touching the running turn", async () => {
  const id = await created();
  const callback = () => {};
  agent.setStepCallback(callback);
  (agent as any).state = AgentState.GENERATING;
  const busy = await call("POST", `/${id}/operators/kept/run`);
  expect(busy.status).toBe(409);
  expect((agent as any).stepCallback).toBe(callback);
});

test("the socket refuses a message while a canvas action or a turn runs", async () => {
  const id = await created();
  const server = buildApp().listen(0);
  try {
    (agent as any).state = AgentState.GENERATING;
    const frames: Array<{ type: string; error?: string }> = [];
    const ws = new WebSocket(`ws://localhost:${server.server!.port}${env.API_PREFIX}/agents/${id}/react`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error frame")), 5000);
      ws.onmessage = event => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (frame.type === "init") ws.send(JSON.stringify({ type: "message", content: "hello" }));
        if (frame.type === "error") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    ws.close();
    expect(frames.find(frame => frame.type === "error")?.error).toBe("The agent is busy; wait until it finishes.");
    expect(agent.getAllSteps().some(step => step.content === "hello")).toBe(false);
  } finally {
    server.stop(true);
  }
});
