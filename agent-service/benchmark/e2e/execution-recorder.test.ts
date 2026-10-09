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

import { expect, test } from "bun:test";
import { engineMeasurement, startExecutionRecorder } from "./execution-recorder";

const phases = (compilation: string, runtimeStartAttempted: boolean) => ({
  version: 1,
  compilation,
  compilationDurationMs: 2.5,
  runtimeStartAttempted,
});

test("compile outcome follows actual phase measurement, not Failed text", () => {
  const value = engineMeasurement({ success: false, state: "Failed", phaseMetrics: phases("failed", false) });
  expect(value.compilation).toBe("failed");
  expect(value.execution).toBe("not_attempted");
  const runtime = engineMeasurement({ success: false, state: "Failed", phaseMetrics: phases("passed", true) });
  expect(runtime.compilation).toBe("passed");
  expect(runtime.execution).toBe("failed");
});

test("missing/invalid measurements and transport-style Error cannot become passes", () => {
  for (const phaseMetrics of [
    undefined,
    { version: 2 },
    phases("failed", true),
    { ...phases("passed", true), compilationDurationMs: -1 },
  ]) {
    const value = engineMeasurement({ success: true, state: "Completed", phaseMetrics });
    expect(value.compilation).toBe("unknown");
    expect(value.execution).toBe("unknown");
  }
  expect(engineMeasurement({ success: false, state: "CompilationFailed" }).compilation).toBe("unknown");
  expect(engineMeasurement({ success: false, state: "Error", phaseMetrics: phases("passed", true) }).execution).toBe(
    "unknown"
  );
});

test("successful execution, timeout, and setup failure have separate denominators", () => {
  expect(engineMeasurement({ success: true, state: "Completed", phaseMetrics: phases("passed", true) }).execution).toBe(
    "passed"
  );
  expect(engineMeasurement({ success: false, state: "Killed", phaseMetrics: phases("passed", true) }).execution).toBe(
    "failed"
  );
  expect(engineMeasurement({ success: false, state: "Failed", phaseMetrics: phases("passed", false) }).execution).toBe(
    "not_attempted"
  );
});

test("recorder forwards unchanged bytes and bearer, retaining no code, cells or errors", async () => {
  const body = JSON.stringify({
    logicalPlan: { operators: [{ operatorID: "s", code: "secret-user-code" }], links: [] },
    targetOperatorIds: ["s"],
    structuredResults: true,
  });
  const result = JSON.stringify({
    success: true,
    state: "Completed",
    executionId: "123",
    phaseMetrics: phases("passed", true),
    operators: { s: { result: [{ cell: "secret-table-value" }], error: "secret-traceback" } },
  });
  let calls = 0;
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      expect(new URL(request.url).pathname).toBe("/api/execution/42/7/run");
      expect(request.headers.get("authorization")).toBe("Bearer secret-delegation");
      expect(await request.text()).toBe(body);
      return new Response(result, { headers: { "content-type": "application/json" } });
    },
  });
  const recorder = startExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7] });
  try {
    const response = await fetch(`${recorder.url}/api/execution/42/7/run`, {
      method: "POST",
      body,
      headers: { Authorization: "Bearer secret-delegation", "Content-Type": "application/json" },
    });
    expect(await response.text()).toBe(result);
    expect(calls).toBe(1);
    const [record] = recorder.records();
    expect(record.workflowId).toBe(42);
    expect(record.computingUnitId).toBe(7);
    expect(record.operatorCount).toBe(1);
    expect(record.targetOperatorIds).toEqual(["s"]);
    expect(record.executionId).toBe("123");
    expect(record.compilation).toBe("passed");
    expect(record.execution).toBe("passed");
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(record)).not.toContain("secret");
    record.targetOperatorIds.push("mutated-copy");
    expect(recorder.records()[0].targetOperatorIds).toEqual(["s"]);
  } finally {
    await recorder.close();
    await backend.stop(true);
  }
});

test("recorder restricts routing to explicit pilot computing units and never redirects", async () => {
  let calls = 0;
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response(null, { status: 302, headers: { location: "http://example.invalid/secret" } });
    },
  });
  const recorder = startExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7] });
  try {
    for (const path of ["/api/execution/42/8/run", "/api/auth/login", "/api/execution/42/7/run?extra=1"]) {
      const response = await fetch(`${recorder.url}${path}`, { method: "POST", body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(calls).toBe(0);
    const response = await fetch(`${recorder.url}/api/execution/42/7/run`, {
      method: "POST",
      body: "{}",
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBeNull(); // do not delegate the caller to a redirect target
    expect(calls).toBe(1);
    expect(recorder.records()[0].compilation).toBe("unknown");
    expect(recorder.records()[0].execution).toBe("unknown");
  } finally {
    await recorder.close();
    await backend.stop(true);
  }
});

test("HTTP errors retain status but never use their body as diagnostic/phase evidence", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json(
        { success: true, state: "Completed", phaseMetrics: phases("passed", true), token: "secret" },
        { status: 503 }
      );
    },
  });
  const recorder = startExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7] });
  try {
    const response = await fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    const [record] = recorder.records();
    expect(record.httpStatus).toBe(503);
    expect(record.compilation).toBe("unknown");
    expect(JSON.stringify(record)).not.toContain("secret");
  } finally {
    await recorder.close();
    await backend.stop(true);
  }
});

test("refuses non-local or credential-bearing forwarding configuration", () => {
  for (const backend of ["https://example.com", "http://user:secret@localhost:8085", "http://localhost:8085/other"]) {
    expect(() => startExecutionRecorder({ backend, computingUnitIds: [7] })).toThrow("backend");
  }
  expect(() => startExecutionRecorder({ backend: "http://localhost:8085", computingUnitIds: [] })).toThrow("computing");
});

test("empty successful HTTP responses are one unknown attempt, never duplicated", async () => {
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
  const recorder = startExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7] });
  try {
    const response = await fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(recorder.records()).toHaveLength(1);
    expect(recorder.records()[0].execution).toBe("unknown");
  } finally {
    await recorder.close();
    await backend.stop(true);
  }
});

test("network failure stays unknown and a full recorder refuses new forwarding", async () => {
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  const origin = backend.url.origin;
  const recorder = startExecutionRecorder({ backend: origin, computingUnitIds: [7], maxRequests: 1 });
  await backend.stop(true); // allocate both ports first so the recorder cannot reuse the backend port
  try {
    const send = () => fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
    expect((await send()).status).toBe(502);
    const [record] = recorder.records();
    expect(record.transport).toBe("network_error");
    expect(record.httpStatus).toBeNull();
    expect(record.compilation).toBe("unknown");
    expect(record.execution).toBe("unknown");
    expect((await send()).status).toBe(503);
    expect(recorder.records()).toHaveLength(1);
    expect(recorder.pending()).toBe(0);
  } finally {
    await recorder.close();
  }
});

test("start evidence is emitted before forwarding and completion is a separate event", async () => {
  const events: any[] = [];
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => (release = resolve));
  const admitted = new Promise<void>(resolve => (entered = resolve));
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      expect(events.map(event => event.kind)).toEqual(["request_started"]);
      entered();
      await waiting;
      return Response.json({ success: true, state: "Completed", phaseMetrics: phases("passed", true) });
    },
  });
  const recorder = startExecutionRecorder({
    backend: backend.url.origin,
    computingUnitIds: [7],
    onEvent(event) {
      events.push(event);
    },
  });
  const response = fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
  try {
    await admitted;
    expect(recorder.pending()).toBe(1);
    expect(recorder.records()).toEqual([]);
    expect(events[0].record).not.toHaveProperty("compilation");
    const status = (await (await fetch(`${recorder.url}/__recorder/status`)).json()) as ReturnType<
      typeof recorder.status
    >;
    expect(status.instanceId).toBe(recorder.instanceId);
    expect(status.pending).toBe(1);
    expect(status.persistenceFailed).toBe(false);
    release();
    expect((await response).status).toBe(200);
    expect(events.map(event => event.kind)).toEqual(["request_started", "request_finished"]);
    expect(events[0].record.requestId).toBe(events[1].record.requestId);
    expect(events[1].record.execution).toBe("passed");
  } finally {
    release();
    await response;
    await recorder.close();
    await backend.stop(true);
  }
});

test("a failed start journal blocks forwarding and poisons subsequent admission", async () => {
  let calls = 0;
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json({});
    },
  });
  const recorder = startExecutionRecorder({
    backend: backend.url.origin,
    computingUnitIds: [7],
    onEvent() {
      throw new Error("private journal failure");
    },
  });
  try {
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private");
    }
    expect(calls).toBe(0);
    expect(recorder.records()).toEqual([]);
    expect(recorder.status().persistenceFailed).toBe(true);
  } finally {
    await recorder.close();
    await backend.stop(true);
  }
});

test("a failed finish journal preserves the real response but rejects new executions", async () => {
  let calls = 0;
  const result = { success: true, state: "Completed", phaseMetrics: phases("passed", true) };
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json(result);
    },
  });
  const recorder = startExecutionRecorder({
    backend: backend.url.origin,
    computingUnitIds: [7],
    onEvent(event) {
      if (event.kind === "request_finished") throw new Error("disk full");
    },
  });
  try {
    const response = await fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(recorder.records()[0].transport).toBe("response");
    expect(recorder.status().persistenceFailed).toBe(true);
    expect((await fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" })).status).toBe(503);
    expect(calls).toBe(1);
  } finally {
    await recorder.close();
    await backend.stop(true);
  }
});
