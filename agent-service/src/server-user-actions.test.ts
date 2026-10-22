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
import { MockLanguageModelV3 } from "ai/test";
import { VercelToolUseDriver } from "./agent/llm-drivers/vercel-tool-use-driver";
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
/** What the model replies to each request: a fixed text. */
let reply = "Done.";
const prompts: unknown[][] = [];

beforeEach(() => {
  _resetAgentStoreForTests();
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const initialize = TexeraAgent.prototype.initialize;
  initSpy = spyOn(TexeraAgent.prototype, "initialize").mockImplementation(async function (this: TexeraAgent, config) {
    await initialize.call(this, config);
    agent = this;
    (this as any).driver = new VercelToolUseDriver({
      maxRetries: 0,
      model: new MockLanguageModelV3({
        doGenerate: async options => {
          prompts.push(structuredClone(options.prompt) as unknown[]);
          return {
            content: [{ type: "text" as const, text: reply }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
    });
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
async function created(respondToCanvasRuns = false): Promise<string> {
  prompts.length = 0;
  const response = await call("POST", "", {
    modelType: "test",
    workflowId: 17,
    settings: { agentMode: "native", respondToCanvasRuns },
  });
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
  // v3 is the edit; the run and showing its result are v4 and v5.
  expect(run.userAction).toEqual({ kind: "run", operatorId: "kept", status: "ok", rows: 3, version: 5 });
  expect(run.responding).toBe(false);
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

test("the socket streams a canvas action version by version: an edit's change, the run, then the shown result", async () => {
  const id = await created();
  const server = buildApp().listen(0);
  try {
    const frames: Array<Record<string, any>> = [];
    const ws = new WebSocket(`ws://localhost:${server.server!.port}${env.API_PREFIX}/agents/${id}/react`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no complete frame")), 5000);
      ws.onmessage = event => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (frame.type === "init")
          void call("POST", `/${id}/operators/kept/edit`, {
            statement: "set kept: filter(records, lambda row: row['value'] > 1)",
            run: true,
          });
        if (frame.type === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    ws.close();
    const progress = frames.filter(frame => frame.type === "progress");
    expect(progress.map(frame => [frame.version.kind, frame.version.version, frame.running])).toEqual([
      ["update", 3, undefined],
      ["run", 4, ["records", "kept"]],
      ["run", 4, []],
      ["show", 5, undefined],
    ]);
    // An edit sends what it changed, in full, and the links and positions after it.
    const [edit, started, finished, shown] = progress;
    expect(edit.dataflow.operators.map((op: any) => op.operatorID)).toEqual(["kept"]);
    expect(edit.dataflow.operators[0].nativeOp.source).toBe("set kept: filter(records, lambda row: row['value'] > 1)");
    expect(edit.dataflow.removed).toEqual([]);
    expect(edit.dataflow.links).toHaveLength(1);
    expect(Object.keys(edit.dataflow.operatorPositions).sort()).toEqual(["kept", "records"]);
    // A run's start carries no results yet; its end and the show carry every operator's.
    expect(started.operatorResults).toBeUndefined();
    expect(finished.operatorResults.kept.outputTuples).toBe(3);
    expect(shown.operatorResults.kept.totalRowCount).toBe(3);
    expect(progress.every(frame => frame.version.author === "user")).toBe(true);
  } finally {
    server.stop(true);
  }
});

/** Wait until the agent's turn, started in the background, has finished. */
async function settled(): Promise<void> {
  for (let i = 0; i < 200 && agent.getState() !== AgentState.AVAILABLE; i++) await Bun.sleep(10);
  await Bun.sleep(10);
}

test("a canvas run is answered by the agent in a turn of its own", async () => {
  const id = await created(true);
  reply = "All three records pass the filter.";
  const run = (await (await call("POST", `/${id}/operators/kept/run`)).json()) as Record<string, any>;
  expect(run.responding).toBe(true);
  await settled();
  const steps = ((await (await call("GET", `/${id}/react-steps`)).json()) as { steps: any[] }).steps;
  const turn = steps.filter(
    step => step.messageId === steps.find(s => s.stepId === 0 && s.messageSource === "action")?.messageId
  );
  expect(turn.map(step => [step.role, step.content.split("\n")[0]])).toEqual([
    ["user", "I ran `kept` on the canvas."],
    ["agent", "All three records pass the filter."],
  ]);
  expect(JSON.stringify(prompts.at(-1))).toContain("What does this result mean for my request?");
});

test("the version tree lists each action; a version can be previewed and checked out", async () => {
  const id = await created();
  const tree = (await (await call("GET", `/${id}/snapshot-tree`)).json()) as Record<string, any>;
  const versions = tree.nodes
    .filter((node: any) => node.version !== undefined)
    .sort((a: any, b: any) => a.version - b.version);
  // v0 is where the agent started; the call's two edits are v1 and v2, the
  // step resolving to the last, with v1 between it and v0.
  expect(versions.map((node: any) => [node.version, node.action.kind, node.action.operatorId, node.owned])).toEqual([
    [0, "start", undefined, true],
    [1, "add", "records", false],
    [2, "add", "kept", true],
  ]);
  expect(versions[2].parentId).toBe(versions[1].id);
  expect(versions[1].parentId).toBe(versions[0].id);
  expect(tree.headSnapshotId).toBe(versions[2].id);
  // Each version is timed by when its action happened.
  expect(versions.every((node: any) => typeof node.timestamp === "number")).toBe(true);
  expect(versions[1].timestamp).toBeGreaterThanOrEqual(versions[0].timestamp);

  const preview = (await (await call("GET", `/${id}/versions/${versions[1].id}`)).json()) as Record<string, any>;
  expect(preview.version).toBe(1);
  expect(preview.action).toMatchObject({ kind: "add", operatorId: "records" });
  expect(preview.workflow.operators.map((op: any) => op.operatorID)).toEqual(["records"]);
  expect(preview.operatorResults).toEqual({});
  expect((await call("GET", `/${id}/versions/S999`)).status).toBe(404);

  const restored = await call("POST", `/${id}/checkout-version`, { snapshotId: versions[1].id });
  expect(restored.status).toBe(200);
  const head = ((await restored.json()) as { headId: string }).headId;
  expect(agent.getStepsById().get(head)?.userAction).toMatchObject({ kind: "restore", version: 1 });
  expect(
    agent
      .getWorkflowState()
      .getAllOperators()
      .map(op => op.operatorID)
  ).toEqual(["records"]);
  expect((await call("POST", `/${id}/checkout-version`, { snapshotId: "S999" })).status).toBe(404);
  (agent as any).state = AgentState.GENERATING;
  expect((await call("POST", `/${id}/checkout-version`, { snapshotId: versions[2].id })).status).toBe(409);
});
