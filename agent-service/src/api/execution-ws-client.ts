/*
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

/**
 * Thin WebSocket client to the Texera workflow-websocket endpoint.
 *
 * One client per ExecutionWatcher (one per agent execution).
 *
 * No reconnection logic. If the socket dies mid-execution we surface the
 * error rather than silently reconnecting and missing events.
 */

import type {
  TexeraWebSocketRequest,
  TexeraWebSocketEvent,
  WorkflowExecuteRequest,
  WorkflowPauseRequest,
  WorkflowResumeRequest,
  WorkflowKillRequest,
  ResultPaginationRequest,
  PythonExpressionEvaluateRequest,
  ModifyLogicRequest,
  RetryRequest,
  HeartBeatRequest,
} from "../types/execution-ws";

export type ExecutionWsEventListener = (event: TexeraWebSocketEvent) => void;
export type ExecutionWsCloseListener = (code: number, reason: string) => void;
export type ExecutionWsErrorListener = (error: Error) => void;

export interface ExecutionWsClientOptions {
  /** Endpoint without query params, e.g. "ws://localhost:8085/wsapi/workflow-websocket" */
  url: string;
  /** JWT used as `?access-token=...`. Same convention as the FE. */
  token: string;
  /** Workflow id passed as `?wid=...` (mirrors FE behavior). */
  workflowId?: number;
  /** Computing unit id passed as `?cuid=...`. */
  computingUnitId?: number;
  /** Heartbeat interval in ms. Set to 0 to disable. Default 30000. */
  heartbeatIntervalMs?: number;
}

/**
 * Wraps a WebSocket connection to the Texera workflow-websocket endpoint.
 *
 * Lifecycle:
 *   const client = new ExecutionWsClient({ url, token, workflowId, computingUnitId });
 *   await client.connect();
 *   client.onEvent(evt => ...);
 *   client.send({ type: "WorkflowExecuteRequest", ... });
 *   ...
 *   client.close();
 */
export class ExecutionWsClient {
  private ws: WebSocket | null = null;
  private readonly options: Required<ExecutionWsClientOptions>;
  private readonly eventListeners = new Set<ExecutionWsEventListener>();
  private readonly closeListeners = new Set<ExecutionWsCloseListener>();
  private readonly errorListeners = new Set<ExecutionWsErrorListener>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectPromise: Promise<void> | null = null;
  private explicitlyClosed = false;

  constructor(options: ExecutionWsClientOptions) {
    this.options = {
      url: options.url,
      token: options.token,
      workflowId: options.workflowId ?? 0,
      computingUnitId: options.computingUnitId ?? 0,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    };
  }

  /**
   * Build the full WS URL with query params (token, wid, cuid).
   */
  private buildUrl(): string {
    const params = new URLSearchParams();
    if (this.options.token) params.set("access-token", this.options.token);
    if (this.options.workflowId) params.set("wid", String(this.options.workflowId));
    if (this.options.computingUnitId) params.set("cuid", String(this.options.computingUnitId));
    const sep = this.options.url.includes("?") ? "&" : "?";
    return `${this.options.url}${sep}${params.toString()}`;
  }

  /**
   * Open the WebSocket and resolve once it's open.
   */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        const url = this.buildUrl();
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws.onopen = () => {
        this.startHeartbeat();
        resolve();
      };

      this.ws.onmessage = (msg: MessageEvent) => {
        this.handleMessage(msg);
      };

      this.ws.onclose = (closeEvent: CloseEvent) => {
        this.stopHeartbeat();
        for (const l of this.closeListeners) {
          try {
            l(closeEvent.code, closeEvent.reason);
          } catch (e) {
            console.error("[ExecutionWsClient] close listener threw:", e);
          }
        }
        // If the socket closes during connect, reject the connect promise
        if (this.ws?.readyState !== WebSocket.OPEN && !this.explicitlyClosed) {
          reject(new Error(`WebSocket closed before open: code=${closeEvent.code} reason=${closeEvent.reason}`));
        }
      };

      this.ws.onerror = (errEvent: Event) => {
        const error = new Error(`WebSocket error: ${(errEvent as any).message || "unknown"}`);
        for (const l of this.errorListeners) {
          try {
            l(error);
          } catch (e) {
            console.error("[ExecutionWsClient] error listener threw:", e);
          }
        }
      };
    });

    return this.connectPromise;
  }

  private handleMessage(msg: MessageEvent): void {
    let parsed: TexeraWebSocketEvent;
    try {
      parsed = typeof msg.data === "string" ? JSON.parse(msg.data) : (msg.data as any);
    } catch (e) {
      console.error("[ExecutionWsClient] failed to parse message:", e, msg.data);
      return;
    }
    for (const l of this.eventListeners) {
      try {
        l(parsed);
      } catch (e) {
        console.error("[ExecutionWsClient] event listener threw:", e);
      }
    }
  }

  /**
   * Send a typed request over the WS. Throws if not connected.
   */
  send(request: TexeraWebSocketRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot send on closed WebSocket (readyState=${this.ws?.readyState})`);
    }
    this.ws.send(JSON.stringify(request));
  }

  // ─── Convenience senders ────────────────────────────────────────────────

  sendExecuteRequest(req: Omit<WorkflowExecuteRequest, "type">): void {
    this.send({ type: "WorkflowExecuteRequest", ...req });
  }

  sendPauseRequest(): void {
    const req: WorkflowPauseRequest = { type: "WorkflowPauseRequest" };
    this.send(req);
  }

  sendResumeRequest(): void {
    const req: WorkflowResumeRequest = { type: "WorkflowResumeRequest" };
    this.send(req);
  }

  sendKillRequest(): void {
    const req: WorkflowKillRequest = { type: "WorkflowKillRequest" };
    this.send(req);
  }

  sendPaginationRequest(req: Omit<ResultPaginationRequest, "type">): void {
    this.send({ type: "ResultPaginationRequest", ...req });
  }

  sendPythonEvalRequest(req: Omit<PythonExpressionEvaluateRequest, "type">): void {
    this.send({ type: "PythonExpressionEvaluateRequest", ...req });
  }

  sendModifyLogicRequest(req: Omit<ModifyLogicRequest, "type">): void {
    this.send({ type: "ModifyLogicRequest", ...req });
  }

  sendRetryRequest(req: Omit<RetryRequest, "type">): void {
    this.send({ type: "RetryRequest", ...req });
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to all incoming events. Returns an unsubscribe function.
   */
  onEvent(listener: ExecutionWsEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: ExecutionWsCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: ExecutionWsErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.options.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const req: HeartBeatRequest = { type: "HeartBeatRequest" };
        try {
          this.ws.send(JSON.stringify(req));
        } catch (e) {
          console.warn("[ExecutionWsClient] heartbeat send failed:", e);
        }
      }
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.explicitlyClosed = true;
    this.stopHeartbeat();
    this.eventListeners.clear();
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch (e) {
        console.warn("[ExecutionWsClient] close threw:", e);
      }
    }
    this.ws = null;
  }
}
