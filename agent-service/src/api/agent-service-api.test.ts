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

import { expect, test } from "bun:test";
import { createAgent, runAgentTurn } from "./agent-service-api";

const user = { id: "new-user", messageId: "new-message", role: "user", content: "current question", isEnd: true };
const terminal = { id: "new-answer", messageId: "new-message", role: "agent", content: "saved answer", isEnd: true };
const old = { id: "old-answer", messageId: "old-message", role: "agent", content: "old answer", isEnd: true };

test("create client forwards an explicit model deadline and omits the absent option", async () => {
  const bodies: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    bodies.push(await request.json());
    return Response.json({ id: "fixture", modelType: "test" });
  } });
  try {
    const baseUrl = `http://localhost:${server.port}`;
    await createAgent({ modelType: "test", baseUrl, modelRequestTimeoutMs: 240_000 } as any);
    await createAgent({ modelType: "test", baseUrl });
    expect(bodies[0].modelRequestTimeoutMs).toBe(240_000);
    expect(bodies[1]).not.toHaveProperty("modelRequestTimeoutMs");
  } finally {
    server.stop(true);
  }
});

test("create client preserves explicit false capabilities and omits absent capabilities", async () => {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return Response.json({ id: "fixture", modelType: "custom-model" });
    },
  });
  try {
    const baseUrl = `http://localhost:${server.port}`;
    await createAgent({ modelType: "custom-model", baseUrl, modelCapabilities: { forcedToolChoice: false } } as any);
    await createAgent({ modelType: "custom-model", baseUrl });
    expect(bodies[0].modelCapabilities).toEqual({ forcedToolChoice: false });
    expect(bodies[1]).not.toHaveProperty("modelCapabilities");
  } finally {
    server.stop(true);
  }
});

function endpoint(options: {
  complete?: boolean;
  omitNewSteps?: boolean;
  omitTerminal?: boolean;
  response?: () => unknown;
}) {
  let sends = 0;
  let reads = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname.endsWith("/react")) {
        if (server.upgrade(request)) return;
      }
      reads++;
      return Response.json(options.response?.() ?? { state: "AVAILABLE", steps: [old, user, terminal] });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "init", state: "AVAILABLE", steps: [old] }));
      },
      message(ws) {
        sends++;
        if (!options.omitNewSteps) {
          ws.send(JSON.stringify({ type: "step", step: user }));
          if (!options.omitTerminal) ws.send(JSON.stringify({ type: "step", step: terminal }));
        }
        if (options.complete) ws.send(JSON.stringify({ type: "complete", state: "AVAILABLE" }));
      },
    },
  });
  return { baseUrl: `http://localhost:${server.port}`, server, sends: () => sends, reads: () => reads };
}

test("a missing complete frame is confirmed through the same terminal request, without resending it", async () => {
  const e = endpoint({});
  try {
    const result = await runAgentTurn("test", "current question", { baseUrl: e.baseUrl, timeoutMs: 1800 });
    expect(result.completed).toBe(true);
    expect(result.completionSource).toBe("rest");
    expect(result.finalAnswer).toBe("saved answer");
    expect(result.errors).toEqual([]);
    expect(e.sends()).toBe(1);
    expect(e.reads()).toBe(1);
  } finally {
    e.server.stop(true);
  }
});

test("a lost terminal step and complete frame recover only the acknowledged request", async () => {
  const e = endpoint({ omitTerminal: true });
  try {
    const result = await runAgentTurn("test", "current question", { baseUrl: e.baseUrl, timeoutMs: 6200 });
    expect(result.completed).toBe(true);
    expect(result.completionSource).toBe("rest");
    expect(result.finalAnswer).toBe("saved answer");
    expect(e.sends()).toBe(1);
    expect(e.reads()).toBe(1);
  } finally {
    e.server.stop(true);
  }
}, 8000);

test("a terminal answer from init cannot complete the new request", async () => {
  const e = endpoint({ omitNewSteps: true });
  try {
    const result = await runAgentTurn("test", "current question", { baseUrl: e.baseUrl, timeoutMs: 100 });
    expect(result.completed).toBe(false);
    expect(result.finalAnswer).toBe("");
    expect(e.reads()).toBe(0);
    expect(e.sends()).toBe(1);
  } finally {
    e.server.stop(true);
  }
});

test("a terminal step cannot complete a request while the agent is still generating", async () => {
  const e = endpoint({ response: () => ({ state: "GENERATING", steps: [old, user, terminal] }) });
  try {
    const result = await runAgentTurn("test", "current question", { baseUrl: e.baseUrl, timeoutMs: 1300 });
    expect(result.completed).toBe(false);
    expect(e.reads()).toBe(1);
    expect(e.sends()).toBe(1);
  } finally {
    e.server.stop(true);
  }
});

test("an available agent with a different latest request cannot confirm completion", async () => {
  const e = endpoint({
    response: () => ({ state: "AVAILABLE", steps: [old, user, terminal, { ...old, id: "later" }] }),
  });
  try {
    const result = await runAgentTurn("test", "current question", { baseUrl: e.baseUrl, timeoutMs: 1300 });
    expect(result.completed).toBe(false);
    expect(e.reads()).toBe(1);
  } finally {
    e.server.stop(true);
  }
});

test("normal completion needs no recovery request", async () => {
  const e = endpoint({ complete: true });
  try {
    const result = await runAgentTurn("test", "current question", { baseUrl: e.baseUrl, timeoutMs: 1800 });
    expect(result.completed).toBe(true);
    expect(result.completionSource).toBe("websocket");
    expect(e.reads()).toBe(0);
    expect(e.sends()).toBe(1);
  } finally {
    e.server.stop(true);
  }
});
