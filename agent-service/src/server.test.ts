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

import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildApp,
  buildContextAssembler,
  _dropLiveAgentForTests,
  _resetAgentStoreForTests,
  _setSeedDefinitionForTests,
} from "./server";
import { env } from "./config/env";
import { TexeraAgent } from "./agent/texera-agent";
import { NATIVE_OPERATORS } from "./agent/native/catalog";

const API = env.API_PREFIX;
const app = buildApp();

function mintTestToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "tester",
      userId: 1,
      email: "tester@example.com",
      role: "REGULAR",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

const TOKEN = mintTestToken();

test("untuned production context preview is synchronous and current after debug", async () => {
  const agent = new TexeraAgent({
    agentId: "preview-regression",
    modelType: "test",
    driver: {
      runTurn: async () => {
        throw new Error("No LLM allowed in preview test");
      },
    },
    contextAssembler: buildContextAssembler("vercel-tool-use", {} as never),
  });
  await agent.handleDebugInput("PREVIEW_CURRENT_TASK");
  expect(agent.getNextStepContext()).toContain("PREVIEW_CURRENT_TASK");
});

test("context preview includes later native tool messages, not only the first user block", () => {
  const agent = new TexeraAgent({
    agentId: "preview-native-transcript",
    modelType: "test",
    driver: {
      runTurn: async () => {
        throw new Error("No LLM allowed in preview test");
      },
    },
    contextAssembler: () => [
      { role: "user", content: "# Agent Events" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "dataflow",
            output: { type: "text", value: "CALLBACK_RUNTIME" },
          },
        ],
      },
    ],
  });
  expect(agent.getNextStepContext()).toContain("# Agent Events");
  expect(agent.getNextStepContext()).toContain("CALLBACK_RUNTIME");
});

function url(path: string): string {
  return `http://localhost${path}`;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request(url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

async function createAgent(body: Record<string, unknown> = {}, token: string | null = TOKEN): Promise<Response> {
  return postJson(`${API}/agents`, { modelType: "m", ...body }, token ? { Authorization: `Bearer ${token}` } : {});
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(url(path), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function getJson(path: string): Promise<Response> {
  return app.handle(new Request(url(path)));
}

async function del(path: string): Promise<Response> {
  return app.handle(new Request(url(path), { method: "DELETE" }));
}

async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  _resetAgentStoreForTests();
});

describe(`GET ${API}/healthcheck`, () => {
  test("returns 200 with status ok", async () => {
    const res = await getJson(`${API}/healthcheck`);
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; timestamp: string }>(res);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
  });
});

describe(`POST ${API}/agents`, () => {
  test("the removed text and turn-tool drivers are refused before an agent is created", async () => {
    for (const body of [{ driver: "text-turn" }, { driver: "turn-tool" }]) {
      expect((await createAgent(body)).status).toBe(400);
      expect((await readJson<any>(await getJson(`${API}/agents`))).agents).toHaveLength(0);
    }
    const created = await readJson<any>(await createAgent({ driver: "vercel-tool-use" }));
    expect(created.driver).toBe("vercel-tool-use");
  });

  test("removed protocol and multi-task settings are refused on create and patch, leaving settings unchanged", async () => {
    const created = await readJson<any>(await createAgent({ settings: { agentMode: "native" } }));
    const before = await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`));
    for (const settings of [
      { nativeTransport: "turn" },
      { taskContext: "dependencies" },
      { multiTask: true },
      { stateHistory: true },
      { stateLedger: true },
      { enableRecallTool: true },
      { enableResumeTool: true },
      { enableCompactTool: true },
      { turnHistory: "index" },
      { sessionTurns: true },
      { versionedMode: true },
    ]) {
      const response = await createAgent({ settings: { agentMode: "native", ...settings } });
      expect(response.status).toBe(400);
      expect((await patchJson(`${API}/agents/${created.id}/settings`, { ...settings, maxSteps: 7 })).status).toBe(400);
      expect(await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`))).toEqual(before);
    }
    expect((await readJson<any>(await getJson(`${API}/agents`))).agents).toHaveLength(1);
  });

  test("explicit message layout is echoed in create, info and settings", async () => {
    const response = await createAgent({ settings: { messageLayout: "native" } });
    const created = await readJson<any>(response);
    expect(created.settings.messageLayout).toBe("native");
    const info = await readJson<any>(await getJson(`${API}/agents/${created.id}`));
    expect(info.settings.messageLayout).toBe("native");
    const settings = await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`));
    expect(settings.messageLayout).toBe("native");
  });

  test("native mode survives create and forces provider parallel calls off; code mode keeps them", async () => {
    const created = await createAgent({ settings: { agentMode: "native", parallelToolCalls: true } });
    expect(created.status).toBe(200);
    const body = await readJson<{ id: string; settings: { agentMode: string; parallelToolCalls: boolean } }>(created);
    expect(body.settings.agentMode).toBe("native");
    expect(body.settings.parallelToolCalls).toBe(false);
    const patched = await patchJson(`${API}/agents/${body.id}/settings`, {
      agentMode: "code",
      parallelToolCalls: true,
      resultSelection: "all",
    });
    expect(patched.status).toBe(200);
    const settings = await readJson<{ agentMode: string; parallelToolCalls: boolean }>(patched);
    expect(settings.agentMode).toBe("code");
    expect(settings.parallelToolCalls).toBe(true);
  });

  test("rejects retired native settings and unknown modes", async () => {
    expect((await createAgent({ settings: { agentMode: "native", nativeToolMode: "batch" } })).status).toBe(400);
    expect((await createAgent({ settings: { agentMode: "native", nativeCatalogVersion: "v2" } })).status).toBe(400);
    expect((await createAgent({ settings: { agentMode: "general" } })).status).toBe(400);
  });

  test("creates an agent for the delegating user", async () => {
    const res = await createAgent({ modelType: "test-model", name: "Tester" });
    expect(res.status).toBe(200);

    const agent = await readJson<{
      id: string;
      name: string;
      modelType: string;
      state: string;
      delegate: unknown;
    }>(res);
    expect(agent.id).toMatch(/^agent-[a-z0-9]+-\d+$/);
    expect(agent.name).toBe("Tester");
    expect(agent.modelType).toBe("test-model");
    expect(agent.state).toBe("AVAILABLE");
  });

  test("auto-numbers agent ids monotonically", async () => {
    const a = await readJson<{ id: string }>(await createAgent());
    const b = await readJson<{ id: string }>(await createAgent());

    const aNum = Number(a.id.split("-")[1]);
    const bNum = Number(b.id.split("-")[1]);
    expect(bNum).toBe(aNum + 1);
  });

  test("rejects invalid token", async () => {
    const res = await createAgent({}, "obviously-not-a-jwt");
    expect(res.status).toBe(401);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe("Invalid or expired token");
  });

  test("rejects missing Authorization header", async () => {
    const res = await createAgent({}, null);
    expect(res.status).toBe(401);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe("Authorization header with a Bearer token is required");
  });

  test("rejects non-Bearer Authorization header", async () => {
    const res = await postJson(`${API}/agents`, { modelType: "m" }, { Authorization: `Basic ${TOKEN}` });
    expect(res.status).toBe(401);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe("Authorization header with a Bearer token is required");
  });

  test("rejects missing modelType", async () => {
    const res = await createAgent({ modelType: undefined, name: "no-model" });
    expect(res.status).toBe(400);
  });

  test("validates and preserves the frontier decay experiment config", async () => {
    const res = await createAgent({
      settings: {
        frontierDecayConfig: {
          sampleRows: 3,
          minStepsSinceEdit: 2,
          minConsumerStepsSinceEdit: 1,
        },
      },
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ settings: { frontierDecayConfig: Record<string, number> } }>(res);
    expect(body.settings.frontierDecayConfig).toEqual({
      sampleRows: 3,
      minStepsSinceEdit: 2,
      minConsumerStepsSinceEdit: 1,
      minConsumerStepsSinceHealthy: 1,
    });
  });

  test("rejects an unsafe frontier decay config", async () => {
    const res = await createAgent({ settings: { frontierDecayConfig: { sampleRows: 0 } } });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toContain("Invalid frontierDecayConfig");
  });

  test("validates and preserves the fold-resolved-revisions config (rank 3)", async () => {
    const res = await createAgent({ settings: { foldResolvedRevisionsConfig: {} } });
    expect(res.status).toBe(200);
    const body = await readJson<{ settings: { foldResolvedRevisionsConfig: Record<string, number> } }>(res);
    expect(body.settings.foldResolvedRevisionsConfig).toEqual({ graceEvents: 1 });
  });

  test("rejects an invalid fold-resolved-revisions config", async () => {
    const res = await createAgent({ settings: { foldResolvedRevisionsConfig: { graceEvents: -1 } } });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toContain("Invalid foldResolvedRevisionsConfig");
  });

  test("validates and preserves the probe-retirement config (rank 4)", async () => {
    const res = await createAgent({ settings: { probeRetirementConfig: { minStepsSinceEdit: 3 } } });
    expect(res.status).toBe(200);
    const body = await readJson<{ settings: { probeRetirementConfig: Record<string, number> } }>(res);
    expect(body.settings.probeRetirementConfig).toEqual({ minStepsSinceEdit: 3, minValueLength: 4 });
  });

  test("rejects an invalid probe-retirement config", async () => {
    const res = await createAgent({ settings: { probeRetirementConfig: { minValueLength: 0 } } });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toContain("Invalid probeRetirementConfig");
  });
});

describe(`GET ${API}/agents`, () => {
  test("empty store returns no agents", async () => {
    const res = await getJson(`${API}/agents`);
    expect(res.status).toBe(200);
    const body = await readJson<{ agents: unknown[] }>(res);
    expect(body.agents).toEqual([]);
  });

  test("lists every created agent", async () => {
    await createAgent({ name: "one" });
    await createAgent({ name: "two" });

    const res = await getJson(`${API}/agents`);
    const body = await readJson<{ agents: { name: string }[] }>(res);
    expect(body.agents).toHaveLength(2);
    expect(body.agents.map(a => a.name).sort()).toEqual(["one", "two"]);
  });
});

describe(`GET ${API}/agents/native-catalog`, () => {
  test("lists every built-in native operator with its contract and properties schema, not as an agent id", async () => {
    const res = await getJson(`${API}/agents/native-catalog`);
    expect(res.status).toBe(200);
    const { operators } = await readJson<{ operators: Array<Record<string, any>> }>(res);
    expect(operators.map(op => op.type)).toEqual(NATIVE_OPERATORS.map(op => op.type));
    for (const op of operators) {
      expect(op.schema.type).toBe("object");
      expect(op.signature).toBeString();
      expect(op.doc).toBeString();
    }
    expect(operators.find(op => op.type === "Aggregate")?.schema.properties).toHaveProperty("groupBy");
  });
});

describe(`GET ${API}/agents/:id`, () => {
  test("returns the agent plus its workflow snapshot", async () => {
    const created = await readJson<{ id: string }>(await createAgent());

    const res = await getJson(`${API}/agents/${created.id}`);
    expect(res.status).toBe(200);
    const body = await readJson<{ id: string; workflow: unknown; stepCount: number }>(res);
    expect(body.id).toBe(created.id);
    expect(body.workflow).toBeDefined();
    expect(typeof body.stepCount).toBe("number");
  });

  test("returns 404 for an unknown id", async () => {
    const res = await getJson(`${API}/agents/agent-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe("Agent not found");
  });
});

describe(`DELETE ${API}/agents/:id`, () => {
  test("destroys the agent and a follow-up GET returns 404", async () => {
    const created = await readJson<{ id: string }>(await createAgent());

    const delRes = await del(`${API}/agents/${created.id}`);
    expect(delRes.status).toBe(200);
    expect(await readJson<unknown>(delRes)).toEqual({ deleted: true });

    const getRes = await getJson(`${API}/agents/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  test("returns 404 when deleting an unknown agent", async () => {
    const res = await del(`${API}/agents/missing`);
    expect(res.status).toBe(404);
  });
});

describe("Agent control routes", () => {
  test("POST /:id/stop returns stopping", async () => {
    const created = await readJson<{ id: string }>(await createAgent());
    const res = await postJson(`${API}/agents/${created.id}/stop`, {});
    expect(res.status).toBe(200);
    expect(await readJson<unknown>(res)).toEqual({ status: "stopping" });
  });

  test("POST /:id/clear resets history", async () => {
    const created = await readJson<{ id: string }>(await createAgent());
    const res = await postJson(`${API}/agents/${created.id}/clear`, {});
    expect(res.status).toBe(200);
    expect(await readJson<unknown>(res)).toEqual({ status: "cleared" });
  });

  test("GET /:id/operator-results returns an empty map on the framework build", async () => {
    const created = await readJson<{ id: string }>(await createAgent());
    const res = await getJson(`${API}/agents/${created.id}/operator-results`);
    expect(res.status).toBe(200);
    expect(await readJson<unknown>(res)).toEqual({ results: {} });
  });
});

describe(`PATCH ${API}/agents/:id/settings`, () => {
  test("updates settings and returns the new values", async () => {
    const created = await readJson<{ id: string }>(await createAgent());

    const res = await patchJson(`${API}/agents/${created.id}/settings`, {
      maxSteps: 7,
      toolTimeoutSeconds: 30,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ maxSteps: number; toolTimeoutSeconds: number }>(res);
    expect(body.maxSteps).toBe(7);
    expect(body.toolTimeoutSeconds).toBe(30);

    // A follow-up GET reflects the same values.
    const reread = await readJson<{ maxSteps: number; toolTimeoutSeconds: number }>(
      await getJson(`${API}/agents/${created.id}/settings`)
    );
    expect(reread.maxSteps).toBe(7);
    expect(reread.toolTimeoutSeconds).toBe(30);
  });

  test("updates and clears frontier decay independently of other settings", async () => {
    const created = await readJson<{ id: string }>(await createAgent());

    const enabled = await patchJson(`${API}/agents/${created.id}/settings`, {
      frontierDecayConfig: { sampleRows: 2 },
    });
    expect(enabled.status).toBe(200);
    const enabledBody = await readJson<{ frontierDecayConfig: Record<string, number> }>(enabled);
    expect(enabledBody.frontierDecayConfig).toEqual({
      sampleRows: 2,
      minStepsSinceEdit: 1,
      minConsumerStepsSinceEdit: 1,
      minConsumerStepsSinceHealthy: 1,
    });

    const cleared = await patchJson(`${API}/agents/${created.id}/settings`, { frontierDecayConfig: null });
    expect(cleared.status).toBe(200);
    const clearedBody = await readJson<{ frontierDecayConfig?: unknown }>(cleared);
    expect(clearedBody.frontierDecayConfig).toBeUndefined();
  });

  test("retrieval capabilities and budgets survive create, GET, and PATCH", async () => {
    const settings = {
      retrievalViews: ["full", "sample", "sample_stats"],
      fullResultCharLimit: 100000,
      maxOperatorResultCharLimit: 1500,
      maxResultRows: 5,
      dataEvidenceCharLimit: 1000,
      flowEvidenceCharLimit: 1200,
      flowEvidence: true,
    };
    const created = await readJson<any>(await createAgent({ settings }));
    expect(created.settings).toMatchObject(settings);
    const patch = { retrievalViews: ["sample_stats"], fullResultCharLimit: 80000 };
    expect((await patchJson(`${API}/agents/${created.id}/settings`, patch)).status).toBe(200);
    expect(await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`))).toMatchObject({
      ...settings,
      ...patch,
    });
    for (const bad of [
      { retrievalViews: [] },
      { retrievalViews: ["sample", "sample"] },
      { fullResultCharLimit: 100001 },
    ]) {
      expect((await patchJson(`${API}/agents/${created.id}/settings`, bad)).status).toBeGreaterThanOrEqual(400);
      expect(await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`))).toMatchObject({
        ...settings,
        ...patch,
      });
    }
  });

  test("the two evidence controls survive create, GET, and PATCH", async () => {
    const created = await readJson<any>(
      await createAgent({
        settings: {
          agentMode: "native",
          nativeProfileCollection: true,
          dataEvidence: true,
          flowEvidence: false,
        },
      })
    );
    expect(created.settings).toMatchObject({ dataEvidence: true, flowEvidence: false });
    for (const dataEvidence of [false, true])
      for (const flowEvidence of [false, true]) {
        const response = await patchJson(`${API}/agents/${created.id}/settings`, { dataEvidence, flowEvidence });
        expect(response.status).toBe(200);
        expect(await readJson(response)).toMatchObject({ dataEvidence, flowEvidence });
        const reread = await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`));
        expect(reread).toMatchObject({ dataEvidence, flowEvidence });
        for (const key of ["columnStats", "flowLevel", "dataLevel"]) expect(reread).not.toHaveProperty(key);
      }
  });

  test("operator docs survive create, GET, and PATCH, and rebuild the native prompt", async () => {
    expect((await readJson<any>(await createAgent())).settings.operatorDoc).toBe(false);
    const created = await readJson<any>(await createAgent({ settings: { agentMode: "native", operatorDoc: true } }));
    expect(created.settings.operatorDoc).toBe(true);
    const prompt = async () =>
      (await readJson<any>(await getJson(`${API}/agents/${created.id}/system-info`))).systemPrompt as string;
    expect(await prompt()).toContain("Give every operator, built-in or Python, a one-line `doc='...'`");

    const off = await patchJson(`${API}/agents/${created.id}/settings`, { operatorDoc: false });
    expect(off.status).toBe(200);
    expect(await readJson(off)).toMatchObject({ operatorDoc: false });
    expect(await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`))).toMatchObject({
      operatorDoc: false,
    });
    expect(await prompt()).toContain("Routine operators need no boilerplate.");
    expect((await patchJson(`${API}/agents/${created.id}/settings`, { operatorDoc: "yes" })).status).toBe(400);
  });

  test("the session's instructions survive create, GET and PATCH, and end the system prompt", async () => {
    const rules = "Answer questions about the analysis; change it only when told what to change.";
    const created = await readJson<any>(await createAgent({ settings: { agentMode: "native", instructions: rules } }));
    expect(created.settings.instructions).toBe(rules);
    const prompt = async () =>
      (await readJson<any>(await getJson(`${API}/agents/${created.id}/system-info`))).systemPrompt as string;
    expect(await prompt()).toEndWith(`## Instructions for this session\n\n${rules}\n`);

    const changed = await patchJson(`${API}/agents/${created.id}/settings`, { instructions: "Be brief." });
    expect(changed.status).toBe(200);
    expect(await readJson(changed)).toMatchObject({ instructions: "Be brief." });
    expect(await prompt()).toEndWith("## Instructions for this session\n\nBe brief.\n");
    // Code mode carries them too.
    await patchJson(`${API}/agents/${created.id}/settings`, { agentMode: "code" });
    expect(await prompt()).toContain("## Instructions for this session\n\nBe brief.");

    // An empty string clears them, and an agent without any has no such section.
    await patchJson(`${API}/agents/${created.id}/settings`, { instructions: "" });
    expect(await prompt()).not.toContain("Instructions for this session");
    const plain = await readJson<any>(await createAgent());
    expect(plain.settings.instructions).toBe("");
    expect((await patchJson(`${API}/agents/${created.id}/settings`, { instructions: 7 })).status).toBe(400);
  });

  for (const key of ["flowLevel", "dataLevel", "columnStats", "valueFormat", "dataHints", "statScopes"]) {
    test(`removed ${key} is rejected by create and PATCH`, async () => {
      expect((await createAgent({ settings: { [key]: true } })).status).toBe(400);
      const created = await readJson<any>(await createAgent());
      const before = await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`));
      expect((await patchJson(`${API}/agents/${created.id}/settings`, { maxSteps: 7, [key]: true })).status).toBe(400);
      expect(await readJson<any>(await getJson(`${API}/agents/${created.id}/settings`))).toEqual(before);
    });
  }

  test("rejects contextMode values outside delta|latest with 400", async () => {
    const created = await readJson<{ id: string }>(await createAgent());
    const res = await patchJson(`${API}/agents/${created.id}/settings`, { contextMode: "full" });
    expect(res.status).toBe(400);
  });
});

describe(`GET ${API}/traces`, () => {
  test("lists the agents the trace store holds and exports one agent's trace", async () => {
    const created = (await (await createAgent({ modelType: "test-model", name: "Traced" })).json()) as { id: string };
    const listed = (await (await app.handle(new Request(url(`${API}/traces`)))).json()) as {
      database: string;
      agents: Array<{ id: string; steps: number }>;
    };
    expect(listed.database).toBe(":memory:");
    expect(listed.agents.map(agent => agent.id)).toContain(created.id);

    const trace = (await (await app.handle(new Request(url(`${API}/traces/${created.id}`)))).json()) as any;
    expect(trace.agent).toMatchObject({ id: created.id, name: "Traced", model: "test-model" });
    expect(trace.steps.length).toBeGreaterThanOrEqual(1); // the initialize step
    expect(trace.snapshots.length).toBeGreaterThanOrEqual(1); // its snapshot
    expect((await app.handle(new Request(url(`${API}/traces/nobody`)))).status).toBe(404);
  });
});

describe(`POST ${API}/agents/:id/restore`, () => {
  test("rebuilds an agent the store holds once memory lost it, with its steps, and traces it again", async () => {
    const created = (await (await createAgent({ modelType: "test-model", name: "Restored" })).json()) as { id: string };
    const stepsOf = async () =>
      (
        (await (await app.handle(new Request(url(`${API}/agents/${created.id}/react-steps`)))).json()) as {
          steps: any[];
        }
      ).steps;
    // A conversation to lose: the initialize step is not shown, so import two steps.
    await postJson(`${API}/agents/${created.id}/import-react-steps`, {
      steps: [
        {
          id: "u1",
          messageId: "m1",
          stepId: 0,
          timestamp: 1000,
          role: "user",
          content: "hello",
          isBegin: true,
          isEnd: true,
        },
        {
          id: "a1",
          parentId: "u1",
          messageId: "m1",
          stepId: 1,
          timestamp: 1001,
          role: "agent",
          content: "hi there",
          isBegin: true,
          isEnd: true,
        },
      ],
    });
    const before = await stepsOf();
    expect(before.map(step => step.id)).toEqual(["u1", "a1"]);
    const restore = (id: string) =>
      app.handle(
        new Request(url(`${API}/agents/${id}/restore`), {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      );
    expect((await restore(created.id)).status).toBe(409); // still live

    _dropLiveAgentForTests(created.id); // the service restarted: memory is gone, the store is not
    expect((await app.handle(new Request(url(`${API}/agents/${created.id}/react-steps`)))).status).toBe(404);
    const restored = await restore(created.id);
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { name: string }).name).toBe("Restored");
    const after = await stepsOf();
    expect(after.map(step => step.id)).toEqual(before.map(step => step.id));

    const listed = (await (await app.handle(new Request(url(`${API}/traces`)))).json()) as {
      agents: Array<{ id: string; live: boolean }>;
    };
    expect(listed.agents.find(agent => agent.id === created.id)?.live).toBe(true);
    const trace = (await (await app.handle(new Request(url(`${API}/traces/${created.id}`)))).json()) as any;
    expect(trace.events.map((event: any) => event.kind)).toContain("restore");
    // The traced initialize step is newer than the imported steps, yet the head is the conversation's last step.
    expect(trace.events.find((event: any) => event.kind === "restore").detail.headId).toBe("a1");
    expect((await restore("nobody")).status).toBe(404);
  });
});

describe(`GET ${API}/agents (per user, restoring a workflow's agents)`, () => {
  const tokenFor = (userId: number, name: string): string => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: name,
        userId,
        email: `${name}@example.com`,
        role: "REGULAR",
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");
    return `${header}.${payload}.test-signature`;
  };
  const list = async (token?: string, workflowId?: number) =>
    (
      (await (
        await app.handle(
          new Request(url(`${API}/agents${workflowId ? `?workflowId=${workflowId}` : ""}`), {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
        )
      ).json()) as { agents: Array<{ id: string }> }
    ).agents.map(agent => agent.id);

  test("lists the caller's agents and ownerless ones, every agent without a token", async () => {
    const mine = (await (await createAgent({ modelType: "test-model", workflowId: 11 })).json()) as { id: string };
    const theirs = (await (
      await createAgent({ modelType: "test-model", workflowId: 12 }, tokenFor(2, "other"))
    ).json()) as { id: string };
    // Without a workflow an agent has no delegating user, so no owner: it shows to everyone.
    const shared = (await (await createAgent({ modelType: "test-model" })).json()) as { id: string };
    expect((await list()).sort()).toEqual([mine.id, theirs.id, shared.id].sort());
    expect((await list(TOKEN)).sort()).toEqual([mine.id, shared.id].sort());
    expect((await list(tokenFor(2, "other"))).sort()).toEqual([theirs.id, shared.id].sort());
  });

  test("brings back the caller's traced agents on the workflow asked for, as a seeded agent after a restart", async () => {
    const created = (await (await createAgent({ modelType: "test-model", name: "Seeded", workflowId: 77 })).json()) as {
      id: string;
    };
    _dropLiveAgentForTests(created.id); // the service restarted: memory is gone, the store is not
    expect(await list(TOKEN)).toEqual([]);
    expect(await list(TOKEN, 78)).toEqual([]); // another workflow: nothing to bring back
    expect(await list(tokenFor(2, "other"), 77)).toEqual([]); // another user: not theirs
    expect(await list(TOKEN, 77)).toEqual([created.id]);
    const info = (await (
      await app.handle(
        new Request(url(`${API}/agents/${created.id}`), { headers: { Authorization: `Bearer ${TOKEN}` } })
      )
    ).json()) as { name: string };
    expect(info.name).toBe("Seeded");
    // A deleted agent stays deleted.
    await app.handle(new Request(url(`${API}/agents/${created.id}`), { method: "DELETE" }));
    expect(await list(TOKEN, 77)).toEqual([]);
  });
});

describe(`${API}/agents/seed`, () => {
  test("says seeding is off without a definition, and records a user's seed once it is asked for", async () => {
    const seed = (method: "GET" | "POST", token = TOKEN) =>
      app
        .handle(new Request(url(`${API}/agents/seed`), { method, headers: { Authorization: `Bearer ${token}` } }))
        .then(response => response.json() as Promise<Record<string, unknown>>);
    expect((await seed("GET")).status).toBe("disabled");
    expect((await seed("POST")).status).toBe("disabled");
    _setSeedDefinitionForTests({
      name: "test-seed",
      bobflow: { workflowName: "Seeded", archive: "/nonexistent/archive.json", model: "test-model" },
    });
    try {
      expect(await seed("GET")).toEqual({ status: "none", seed: "test-seed" });
      const started = await seed("POST");
      expect(started.seed).toBe("test-seed");
      expect(["running", "failed"]).toContain(String(started.status));
      // The platform is not here, so the seed fails and says why; a later request may retry it.
      for (let i = 0; i < 50 && (await seed("GET")).status === "running"; i++) await Bun.sleep(100);
      const after = await seed("GET");
      expect(after.status).toBe("failed");
      expect(typeof after.error).toBe("string");
      expect(after.userUid).toBe(1);
      expect((await seed("GET", (await Promise.resolve(TOKEN)) && TOKEN)).seed).toBe("test-seed");
    } finally {
      _setSeedDefinitionForTests(undefined);
    }
    expect((await seed("GET")).status).toBe("disabled");
  });
});

describe(`GET ${API}/agents/:id/archive`, () => {
  test("an archive carries the steps, each step's results and the instructions, and an import takes them back", async () => {
    const created = (await (await createAgent({ modelType: "test-model", name: "Archived" })).json()) as { id: string };
    const workflow = {
      operators: [
        {
          operatorID: "x",
          operatorType: "TestOp",
          operatorVersion: "1",
          operatorProperties: {},
          inputPorts: [],
          outputPorts: [],
          showAdvanced: false,
        },
      ],
      operatorPositions: { x: { x: 0, y: 0 } },
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    // A result another workflow produced: the import must keep it all the same.
    const info = {
      operatorID: "x",
      state: "Completed",
      inputTuples: 0,
      outputTuples: 3,
      totalRowCount: 3,
      result: [{ a: 1 }],
      executionContext: { workflowId: 999999, executionId: "1" },
    };
    const imported = await postJson(`${API}/agents/${created.id}/import-react-steps`, {
      steps: [
        {
          id: "u1",
          messageId: "m1",
          stepId: 0,
          timestamp: 1000,
          role: "user",
          content: "hello",
          isBegin: true,
          isEnd: true,
        },
        {
          id: "a1",
          parentId: "u1",
          messageId: "m1",
          stepId: 1,
          timestamp: 1001,
          role: "agent",
          content: "built x",
          isBegin: true,
          isEnd: true,
          toolCalls: [{ toolName: "unknownTool", toolCallId: "c1", input: {} }],
          toolResults: [{ toolCallId: "c1", output: "ok" }],
        },
      ],
      snapshots: { a1: workflow },
      results: { a1: { x: info } },
      instructions: "Answer what is asked.",
    });
    expect(imported.status).toBe(200);
    const results = (await (
      await app.handle(new Request(url(`${API}/agents/${created.id}/operator-results`)))
    ).json()) as any;
    expect(results.results.x).toMatchObject({ totalRowCount: 3 });
    const settings = (await (await app.handle(new Request(url(`${API}/agents/${created.id}/settings`)))).json()) as any;
    expect(settings.instructions).toBe("Answer what is asked.");

    const archive = (await (await app.handle(new Request(url(`${API}/agents/${created.id}/archive`)))).json()) as any;
    expect(archive.steps.map((step: any) => step.id)).toEqual(["u1", "a1"]);
    expect(archive.results.a1.x).toMatchObject({ totalRowCount: 3 });
    expect(archive.instructions).toBe("Answer what is asked.");
    expect(archive.stepCount).toBe(2);
  });
});
