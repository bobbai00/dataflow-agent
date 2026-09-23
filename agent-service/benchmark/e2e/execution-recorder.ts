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

import type { SyncExecutionResult } from "../../src/types/execution";

type Outcome = "passed" | "failed" | "not_attempted" | "unknown";
type PhaseMetrics = NonNullable<SyncExecutionResult["phaseMetrics"]>;
const STATES = new Set([
  "Uninitialized",
  "Ready",
  "Running",
  "Pausing",
  "Paused",
  "Resuming",
  "Completed",
  "CompletedFromCache",
  "Failed",
  "Killed",
  "Terminated",
  "CompilationFailed",
  "ValidationFailed",
  "Error",
  "Unknown",
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Unknown measurements stay unknown. In particular, legacy CompilationFailed
 * is partly a keyword heuristic, and Failed can mean a compiler-call failure.
 * No Python preflight pass is inferred from these engine phases either. */
export function engineMeasurement(raw: unknown) {
  const body = object(raw);
  const state = typeof body?.state === "string" && STATES.has(body.state) ? body.state : null;
  const success = typeof body?.success === "boolean" ? body.success : null;
  const phase = object(body?.phaseMetrics);
  let normalized: PhaseMetrics | null = null;
  let phaseEvidence: "recorded" | "missing" | "invalid" = body?.phaseMetrics == null ? "missing" : "invalid";
  if (
    phase?.version === 1 &&
    ["not_attempted", "running", "passed", "failed"].includes(String(phase.compilation)) &&
    typeof phase.runtimeStartAttempted === "boolean"
  ) {
    const terminal = phase.compilation === "passed" || phase.compilation === "failed";
    const durationValid = terminal
      ? typeof phase.compilationDurationMs === "number" &&
        Number.isFinite(phase.compilationDurationMs) &&
        phase.compilationDurationMs >= 0
      : phase.compilationDurationMs == null;
    const consistent =
      (!phase.runtimeStartAttempted || phase.compilation === "passed") &&
      (success !== true || phase.runtimeStartAttempted);
    if (durationValid && consistent) {
      normalized = {
        version: 1,
        compilation: phase.compilation as PhaseMetrics["compilation"],
        compilationDurationMs: (phase.compilationDurationMs as number | null) ?? null,
        runtimeStartAttempted: phase.runtimeStartAttempted,
      };
      phaseEvidence = "recorded";
    }
  }
  let compilation: Outcome = "unknown",
    execution: Outcome = "unknown";
  if (normalized) {
    compilation = normalized.compilation === "running" ? "unknown" : normalized.compilation;
    if (!normalized.runtimeStartAttempted) execution = "not_attempted";
    else if (success === true && (state === "Completed" || state === "CompletedFromCache")) execution = "passed";
    else if (success === false && state && ["Failed", "Killed", "Terminated", "Completed"].includes(state))
      execution = "failed";
  }
  // Execution IDs are decimal database identities, not arbitrary response text.
  const executionId =
    typeof body?.executionId === "string" && /^\d{1,30}$/.test(body.executionId) ? body.executionId : null;
  return { state, success, executionId, phaseMetrics: normalized, phaseEvidence, compilation, execution };
}

export interface ExecutionRequestRecord extends ReturnType<typeof engineMeasurement> {
  version: 1;
  requestId: string;
  workflowId: number;
  computingUnitId: number;
  startedAt: string;
  elapsedMs: number;
  httpStatus: number | null;
  transport: "response" | "network_error" | "aborted";
  operatorCount: number | null;
  targetOperatorIds: string[];
  requestSummaryTruncated: boolean;
  structuredResults: boolean;
}

export type ExecutionRequestStart = Pick<
  ExecutionRequestRecord,
  | "version"
  | "requestId"
  | "workflowId"
  | "computingUnitId"
  | "startedAt"
  | "operatorCount"
  | "targetOperatorIds"
  | "requestSummaryTruncated"
  | "structuredResults"
>;

export type ExecutionRecorderEvent =
  | { version: 1; instanceId: string; kind: "request_started"; record: ExecutionRequestStart }
  | { version: 1; instanceId: string; kind: "request_finished"; record: ExecutionRequestRecord };

/** Test/evaluation-only loopback proxy, shared by reference and candidate agents.
 * Set their WORKFLOW_EXECUTION_SERVICE_ENDPOINT to its URL (and unset any
 * EXECUTION_ENDPOINT_TEMPLATE). It starts NO Texera service or computing unit.
 * Only explicitly registered pilot CUs can be forwarded. JWT authorization is
 * still enforced by Texera; the supplied Authorization header is passed through,
 * never decoded/stored. Source, rows, logs and raw error text are never retained.
 *
 * One record is one forwarded HTTP request, not one operator/batch. An abort
 * does NOT prove that the backend stopped; never automatically retry it.
 * A synchronous onEvent sink can fsync start evidence before forwarding and
 * completion evidence afterward. A start without a finish is unknown, not
 * backend termination. No source/token/row content enters either event.
 */
export function startExecutionRecorder(options: {
  backend: string;
  computingUnitIds: readonly number[];
  port?: number;
  maxRequests?: number;
  /** Must finish persistence synchronously. A rejected/async sink disables
   * further admission; a finish failure does not alter the backend response. */
  onEvent?: (event: ExecutionRecorderEvent) => undefined;
}) {
  const backend = new URL(options.backend);
  if (
    !["http:", "https:"].includes(backend.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname) ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    backend.pathname !== "/"
  ) {
    throw new Error("Execution recorder backend must be a credential-free loopback origin");
  }
  const units = new Set(options.computingUnitIds);
  if (!units.size || [...units].some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Execution recorder requires explicit positive pilot computing-unit IDs");
  }
  const maxRequests = options.maxRequests ?? 1000;
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) throw new Error("Invalid recorder request limit");
  const records: ExecutionRequestRecord[] = [];
  const instanceId = crypto.randomUUID();
  let pending = 0;
  let persistenceFailed = false;
  let accepting = true;
  const status = () => ({
    version: 1 as const,
    kind: "execution-recorder" as const,
    instanceId,
    backend: backend.origin,
    computingUnitIds: [...units].sort((a, b) => a - b),
    maxRequests,
    pending,
    completed: records.length,
    accepting: accepting && !persistenceFailed,
    sinkConfigured: options.onEvent !== undefined,
    persistenceFailed,
  });
  const emit = (event: ExecutionRecorderEvent): boolean => {
    if (!options.onEvent) return true;
    try {
      const result: unknown = options.onEvent(structuredClone(event));
      if (result !== undefined) {
        // An async callback is not a durability barrier. Avoid an unhandled
        // rejection (which may print raw exception text), then fail closed.
        if (result instanceof Promise) result.catch(() => {});
        throw new Error("Execution journal sink must be synchronous");
      }
      return true;
    } catch {
      persistenceFailed = true;
      return false;
    }
  };
  const finish = (record: ExecutionRequestRecord) => {
    records.push(record);
    emit({ version: 1, instanceId, kind: "request_finished", record });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    // The proxy deliberately retains the backend's full body transiently to
    // forward byte-identically, but never keeps it in recorded artifacts.
    maxRequestBodySize: 20 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      // Read-only loopback health for the outer launch/attempt guard. No
      // credentials, source code, response bodies or arbitrary proxy routes.
      if (request.method === "GET" && !url.search && url.pathname === "/__recorder/status")
        return Response.json(status());
      const path = /^\/api\/execution\/([1-9]\d*)\/([1-9]\d*)\/run$/.exec(url.pathname);
      const workflowId = Number(path?.[1]),
        computingUnitId = Number(path?.[2]);
      if (
        request.method !== "POST" ||
        url.search ||
        !path ||
        !Number.isSafeInteger(workflowId) ||
        !units.has(computingUnitId)
      ) {
        return new Response("Not a registered pilot execution route", { status: 403 });
      }
      if (!accepting || persistenceFailed)
        return new Response("Execution recorder is not accepting work; do not automatically retry", { status: 503 });
      if (records.length + pending >= maxRequests)
        return new Response("Recorder request limit reached", { status: 503 });
      pending++;
      const started = performance.now();
      const base = {
        version: 1 as const,
        requestId: crypto.randomUUID(),
        workflowId,
        computingUnitId,
        startedAt: new Date().toISOString(),
        operatorCount: null as number | null,
        targetOperatorIds: [] as string[],
        requestSummaryTruncated: false,
        structuredResults: false,
      };
      let forwarded = false;
      try {
        const bytes = await request.arrayBuffer();
        try {
          const data = object(JSON.parse(new TextDecoder().decode(bytes)));
          const plan = object(data?.logicalPlan);
          base.operatorCount = Array.isArray(plan?.operators) ? plan.operators.length : null;
          base.structuredResults = data?.structuredResults === true;
          if (Array.isArray(data?.targetOperatorIds)) {
            const ids = data.targetOperatorIds;
            base.targetOperatorIds = ids
              .filter((id): id is string => typeof id === "string" && id.length <= 240)
              .slice(0, 1000);
            base.requestSummaryTruncated = base.targetOperatorIds.length !== ids.length;
          }
        } catch {
          /* Preserve malformed bytes for the backend's own validation. */
        }
        const headers = new Headers();
        for (const name of ["content-type", "authorization"]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        if (!emit({ version: 1, instanceId, kind: "request_started", record: base }))
          return new Response("Execution journal unavailable; do not automatically retry", { status: 503 });
        forwarded = true;
        const response = await fetch(`${backend.origin}${url.pathname}`, {
          method: "POST",
          headers,
          body: bytes,
          redirect: "manual",
          signal: request.signal,
        });
        const responseBytes = await response.arrayBuffer();
        let payload: unknown;
        if (response.ok) {
          try {
            payload = JSON.parse(new TextDecoder().decode(responseBytes));
          } catch {
            /* unknown */
          }
        }
        const responseHeaders = new Headers();
        // fetch decompresses bodies; do not copy stale content-encoding/length.
        // Never propagate Location or cookies to broaden this forwarding route.
        for (const name of ["content-type", "retry-after"]) {
          const value = response.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        const forwardedResponse = new Response([204, 205, 304].includes(response.status) ? null : responseBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
        finish({
          ...base,
          elapsedMs: performance.now() - started,
          httpStatus: response.status,
          transport: "response",
          ...engineMeasurement(payload),
        });
        return forwardedResponse;
      } catch {
        if (forwarded)
          finish({
            ...base,
            elapsedMs: performance.now() - started,
            httpStatus: null,
            transport: request.signal.aborted ? "aborted" : "network_error",
            ...engineMeasurement(undefined),
          });
        return new Response("No backend execution response available; do not automatically retry", { status: 502 });
      } finally {
        pending--;
      }
    },
  });
  return {
    url: server.url.origin,
    instanceId,
    status,
    records: (): ExecutionRequestRecord[] => structuredClone(records),
    pending: () => pending,
    stopAccepting: () => {
      accepting = false;
    },
    close: () => {
      accepting = false;
      return server.stop(false);
    },
  };
}
