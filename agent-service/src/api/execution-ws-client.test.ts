/**
 * Unit tests for ExecutionWsClient (Phase 1 verification).
 *
 * Mocks the global WebSocket constructor so we can drive the lifecycle
 * synchronously without a real engine.
 *
 * Run with: bun test src/api/execution-ws-client.test.ts
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { ExecutionWsClient } from "./execution-ws-client";
import type { TexeraWebSocketEvent, WorkflowStateEvent } from "../types/execution-ws";

// ─── Mock WebSocket ───────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = 0;
  onopen: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  // Simulate the onopen flow
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  simulateClose(code: number = 1000, reason: string = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.simulateClose();
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  // Cast: we're providing just enough surface for the client.
  (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ExecutionWsClient", () => {
  test("buildUrl includes access-token, wid, and cuid", async () => {
    const client = new ExecutionWsClient({
      url: "ws://localhost:8085/wsapi/workflow-websocket",
      token: "abc.def.ghi",
      workflowId: 42,
      computingUnitId: 7,
      heartbeatIntervalMs: 0, // disable heartbeat for the test
    });

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws.url).toContain("access-token=abc.def.ghi");
    expect(ws.url).toContain("wid=42");
    expect(ws.url).toContain("cuid=7");

    ws.simulateOpen();
    await connectPromise;
    expect(client.isOpen()).toBe(true);
    client.close();
  });

  test("send serializes request as JSON with type discriminator", async () => {
    const client = new ExecutionWsClient({
      url: "ws://localhost:8085/wsapi/workflow-websocket",
      token: "t",
      workflowId: 1,
      computingUnitId: 1,
      heartbeatIntervalMs: 0,
    });

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    await connectPromise;

    client.sendPauseRequest();
    client.sendResumeRequest();
    client.sendKillRequest();
    client.sendPaginationRequest({
      requestID: "req-1",
      operatorID: "op-2",
      pageIndex: 0,
      pageSize: 50,
    });

    expect(ws.sentMessages).toHaveLength(4);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: "WorkflowPauseRequest" });
    expect(JSON.parse(ws.sentMessages[1])).toEqual({ type: "WorkflowResumeRequest" });
    expect(JSON.parse(ws.sentMessages[2])).toEqual({ type: "WorkflowKillRequest" });
    expect(JSON.parse(ws.sentMessages[3])).toEqual({
      type: "ResultPaginationRequest",
      requestID: "req-1",
      operatorID: "op-2",
      pageIndex: 0,
      pageSize: 50,
    });

    client.close();
  });

  test("incoming events are parsed and dispatched to listeners", async () => {
    const client = new ExecutionWsClient({
      url: "ws://localhost:8085/wsapi/workflow-websocket",
      token: "t",
      heartbeatIntervalMs: 0,
    });

    const received: TexeraWebSocketEvent[] = [];
    const unsubscribe = client.onEvent(evt => {
      received.push(evt);
    });

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    await connectPromise;

    const stateEvent: WorkflowStateEvent = { type: "WorkflowStateEvent", state: "Running" };
    ws.simulateMessage(stateEvent);
    ws.simulateMessage({ type: "HeartBeatResponse" });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(stateEvent);
    expect((received[1] as any).type).toBe("HeartBeatResponse");

    unsubscribe();
    ws.simulateMessage({ type: "WorkflowStateEvent", state: "Completed" });
    // No new events should land — listener was unsubscribed.
    expect(received).toHaveLength(2);

    client.close();
  });

  test("send throws if WS is closed", async () => {
    const client = new ExecutionWsClient({
      url: "ws://localhost:8085/wsapi/workflow-websocket",
      token: "t",
      heartbeatIntervalMs: 0,
    });

    expect(() => client.sendPauseRequest()).toThrow();

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    await connectPromise;

    client.close();
    expect(() => client.sendPauseRequest()).toThrow();
  });

  test("close listener fires on close", async () => {
    const client = new ExecutionWsClient({
      url: "ws://localhost:8085/wsapi/workflow-websocket",
      token: "t",
      heartbeatIntervalMs: 0,
    });

    const closeFn = mock<(code: number, reason: string) => void>();
    client.onClose(closeFn);

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    await connectPromise;

    ws.simulateClose(1006, "abnormal");
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(closeFn).toHaveBeenCalledWith(1006, "abnormal");
  });

  test("malformed incoming message is logged but does not throw", async () => {
    const client = new ExecutionWsClient({
      url: "ws://localhost:8085/wsapi/workflow-websocket",
      token: "t",
      heartbeatIntervalMs: 0,
    });

    const received: TexeraWebSocketEvent[] = [];
    client.onEvent(evt => received.push(evt));

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    await connectPromise;

    const consoleErr = mock(() => {});
    const original = console.error;
    console.error = consoleErr;
    try {
      ws.simulateMessage("not valid json {{");
      // Listener should not have been called for malformed message
      expect(received).toHaveLength(0);
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      console.error = original;
    }

    // After malformed, valid message still works
    ws.simulateMessage({ type: "WorkflowStateEvent", state: "Paused" });
    expect(received).toHaveLength(1);

    client.close();
  });
});
