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
 * ExecutionWatcher — in-memory snapshot of an agent's currently-active workflow
 * execution. Updated continuously by an ExecutionWsClient. Queried by tools
 * (awaitExecution, getOperatorResult) and by prepareStep (Active Execution
 * section). One per agent.
 */

import type { ExecutionWsClient } from "../api/execution-ws-client";
import {
  isConsoleUpdateEvent,
  isOperatorStatisticsUpdateEvent,
  isPaginatedResultEvent,
  isWorkflowErrorEvent,
  isWorkflowStateEvent,
  getConsoleMessageType,
  type ConsoleMessage,
  type ModifyLogicCompletedEvent,
  type ModifyLogicResponse,
  type OperatorAggregatedMetrics,
  type PaginatedResultEvent,
  type PythonExpressionEvaluateResponse,
  type TexeraWebSocketEvent,
  type WorkflowFatalError,
  type WorkflowState,
} from "../types/execution-ws";

// ─── Public types ─────────────────────────────────────────────────────────

export interface PerOperatorState {
  state: string; // OperatorState from engine
  inputTupleCount: number;
  outputTupleCount: number;
  numWorkers: number;
}

export interface ExecutionWatcherSnapshot {
  executionName: string;
  /**
   * Wall-clock when the *current* execution started (set in
   * `markExecutionStarting`, before the engine confirms via Initializing).
   * Renamed from `startedAt` so the LLM doesn't misread it as "the execution
   * is currently starting" — these `mostRecent*` timestamps are always
   * historical, regardless of `currentState`.
   */
  mostRecentStartedAt: number;
  mostRecentPausedAt?: number;
  mostRecentResumedAt?: number;
  /**
   * Set when we transitioned INTO a terminal state; cleared when we transition
   * out (e.g., engine state-replay then new execution). Read via `currentState`
   * to know if the execution is currently terminal — this is just the timestamp
   * of when it most recently became so.
   */
  mostRecentCompletedAt?: number;
  currentState: WorkflowState;
  perOperatorState: Record<string, PerOperatorState>;
  /** Workers per operator (from WorkerAssignmentUpdateEvent). Needed for retry. */
  workerIdsByOperator: Record<string, string[]>;
  /** Per-operator currentTuples while paused (from OperatorCurrentTuplesUpdateEvent). */
  currentTuplesByOperator: Record<string, unknown>;
  /** All recent console messages across all levels and operators (most recent last, ring buffer). */
  recentConsoleMessages: ConsoleMessage[];
  /** Per-operator console messages (most recent last, capped per op). Lets
   *  `getConsoleLogs(operatorId)` scope to one operator without re-parsing
   *  workerIds from the flat buffer. */
  consoleMessagesByOperator: Record<string, ConsoleMessage[]>;
  /** Filtered view: ERROR-only messages — used to drive console-error significant events. */
  recentConsoleErrors: ConsoleMessage[];
  fatalErrors: WorkflowFatalError[];
  /** Engine-reported wall-clock duration (ExecutionDurationUpdateEvent), if any. */
  engineDurationMs?: number;
}

export type SignificantEventReason =
  | "tick"
  | "paused"
  | "resumed"
  | "completed"
  | "completed-from-cache"
  | "failed"
  | "killed"
  | "console-error"
  | "aborted";

export interface SignificantEventInfo {
  reason: SignificantEventReason;
  /** WS event that triggered, if any. */
  triggeringEvent?: TexeraWebSocketEvent;
}

export interface AwaitResult {
  reason: SignificantEventReason;
  elapsedSinceStartMs: number;
  elapsedSinceLastWakeMs: number;
  snapshot: ExecutionWatcherSnapshot;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function isTerminalState(state: WorkflowState): boolean {
  return state === "Completed" || state === "Failed" || state === "Killed" || state === "Terminated";
}

const SIGNIFICANT_STATE_TRANSITIONS = new Set<WorkflowState>([
  "Paused",
  "Completed",
  "Failed",
  "Killed",
  "Terminated",
]);

/**
 * True iff any operator's state string contains "FromCache". The engine emits
 * states like "CompletedFromCache" via OperatorStatisticsUpdateEvent when a
 * cached output was reused instead of running the operator.
 */
function isAnyOperatorFromCache(perOp: Record<string, PerOperatorState>): boolean {
  for (const st of Object.values(perOp)) {
    if (typeof st.state === "string" && st.state.includes("FromCache")) return true;
  }
  return false;
}

/**
 * True iff `currentState` is terminal. The single source of truth — derived
 * from currentState only, never stored as a separate latched field.
 */
export function snapshotIsTerminal(s: ExecutionWatcherSnapshot): boolean {
  return isTerminalState(s.currentState);
}

/**
 * True iff the execution reached Completed *and* at least one operator was
 * served from the reuse-cache. Derived from currentState + per-operator state.
 */
export function snapshotWasFromCache(s: ExecutionWatcherSnapshot): boolean {
  return s.currentState === "Completed" && isAnyOperatorFromCache(s.perOperatorState);
}

function reasonForState(
  state: WorkflowState,
  perOp: Record<string, PerOperatorState>,
): SignificantEventReason | null {
  switch (state) {
    case "Paused":
      return "paused";
    case "Completed":
      return isAnyOperatorFromCache(perOp) ? "completed-from-cache" : "completed";
    case "Failed":
      return "failed";
    case "Killed":
    case "Terminated":
      return "killed";
    default:
      return null;
  }
}

// ─── ExecutionWatcher ─────────────────────────────────────────────────────

interface PendingPagination {
  resolve: (event: PaginatedResultEvent) => void;
  reject: (err: Error) => void;
}

/**
 * One in-flight `evalPython` request waiting for the matching response.
 * Wire format has no requestID, so correlation key is `(operatorId, expression)`.
 * If two evals fire for the same key, responses arrive in send order — hence
 * a FIFO array per key.
 */
interface PendingPythonEval {
  resolve: (event: PythonExpressionEvaluateResponse) => void;
  reject: (err: Error) => void;
}

/**
 * One in-flight `liveModifyOperator` request, awaiting both the synchronous
 * `ModifyLogicResponse` (validation) and the asynchronous
 * `ModifyLogicCompletedEvent` (engine has applied the new logic). Correlation
 * key: `opId`.
 */
export interface ModifyLogicResult {
  isValid: boolean;
  errorMessage: string;
  /** True iff a `ModifyLogicCompletedEvent` arrived for this opId before
   *  the timeout. False means the response was valid but we never got
   *  confirmation that it took effect. */
  applied: boolean;
}

interface PendingModifyLogic {
  resolve: (r: ModifyLogicResult) => void;
  reject: (err: Error) => void;
}

interface PendingAwaiter {
  resolve: (info: SignificantEventInfo) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortHandler: (() => void) | null;
  abortSignal: AbortSignal | null;
}

export class ExecutionWatcher {
  private snapshot: ExecutionWatcherSnapshot;
  private readonly wsClient: ExecutionWsClient;
  private wsUnsubscribe: (() => void) | null = null;

  // Awaiters waiting for the next significant event (one-shot).
  private awaiters: Set<PendingAwaiter> = new Set();
  // Pagination requests keyed by requestID.
  private pendingPagination: Map<string, PendingPagination> = new Map();
  // Python eval requests, keyed by `${operatorId}::${expression}`. FIFO queue
  // because the wire protocol has no requestID and we may have multiple of
  // the same expression in flight (engine responses arrive in send order).
  private pendingPythonEval: Map<string, PendingPythonEval[]> = new Map();
  // Modify-logic requests, keyed by opId. FIFO queue per op.
  private pendingModifyLogic: Map<string, PendingModifyLogic[]> = new Map();
  // Track when the last awaitExecution returned (for elapsedSinceLastWakeMs).
  private lastWakeAt: number;
  // Snapshot captured at the moment the most recent `await()` returned. The
  // assembler uses this to compute deltas (output growth, state transitions,
  // new errors) since the LLM last looked at execution state.
  private snapshotAtLastWake: ExecutionWatcherSnapshot | null = null;

  constructor(wsClient: ExecutionWsClient, executionName: string) {
    this.wsClient = wsClient;
    const now = Date.now();
    this.lastWakeAt = now;
    this.snapshot = {
      executionName,
      mostRecentStartedAt: now,
      currentState: "Uninitialized",
      perOperatorState: {},
      workerIdsByOperator: {},
      currentTuplesByOperator: {},
      recentConsoleMessages: [],
      consoleMessagesByOperator: {},
      recentConsoleErrors: [],
      fatalErrors: [],
    };
  }

  /**
   * Subscribe to the WS client's event stream. Idempotent.
   */
  start(): void {
    if (this.wsUnsubscribe) return;
    this.wsUnsubscribe = this.wsClient.onEvent(evt => this.applyEvent(evt));
  }

  /**
   * Optimistically mark the snapshot as "an execution is starting right now."
   * Call this immediately after sending WorkflowExecuteRequest, *before* any
   * engine state event for the new execution arrives. Closes the small window
   * during which the snapshot would otherwise still reflect the prior run's
   * terminal state (which the engine replays to new WS subscribers on connect).
   *
   * The engine's subsequent WorkflowStateEvent("Initializing") / "Running"
   * will overwrite these fields naturally.
   */
  markExecutionStarting(): void {
    const now = Date.now();
    this.snapshot = {
      ...this.snapshot,
      // ── Per-execution lifecycle fields: reset to "fresh execution" ──
      currentState: "Initializing",
      mostRecentStartedAt: now,            // pivot the start clock to NOW
      mostRecentCompletedAt: undefined,
      mostRecentPausedAt: undefined,
      mostRecentResumedAt: undefined,
      // ── Per-execution accumulators: clear (no carryover from prior run) ──
      perOperatorState: {},
      workerIdsByOperator: {},
      currentTuplesByOperator: {},
      recentConsoleMessages: [],
      consoleMessagesByOperator: {},
      recentConsoleErrors: [],
      fatalErrors: [],
      engineDurationMs: undefined,
      // executionName is intentionally NOT reset here — it's set by the
      // constructor (each call to startExecution constructs a new watcher
      // with its own fresh executionName).
    };
    // Reset the wake clock so `elapsedSinceLastWakeMs` on the first
    // post-start await reflects time since this start, not since watcher
    // construction.
    this.lastWakeAt = now;
    // Clear prior-execution wake snapshot — it's not a meaningful baseline
    // for diffing against the new run.
    this.snapshotAtLastWake = null;
    // Reject any leftover eval/modify awaiters from a prior run — engine
    // won't answer them after a new execution starts.
    for (const [, queue] of this.pendingPythonEval) {
      for (const p of queue) p.reject(new Error("Execution restarted"));
    }
    this.pendingPythonEval.clear();
    for (const [, queue] of this.pendingModifyLogic) {
      for (const p of queue) p.reject(new Error("Execution restarted"));
    }
    this.pendingModifyLogic.clear();
    console.log(
      `[ExecutionWatcher ${this.snapshot.executionName}] markExecutionStarting: snapshot reset to Initializing`
    );
  }

  /**
   * Apply a single WS event to the snapshot. Public for testing — production
   * code should rely on the subscription set up in `start()`.
   *
   * Dispatch shape mirrors the FE (see ExecuteWorkflowService) — we switch
   * on `event.type` and update the relevant slice of state. Events that we
   * don't yet make use of are listed explicitly with TODO/Phase markers so
   * future work has a clear hook.
   *
   * Note on engine state-replay: when we open a fresh WS, the engine replays
   * the latest WorkflowStateEvent (often the prior run's `Completed`). That
   * IS the truthful state at connect-time, and we reflect it. The new
   * execution's events then take over and overwrite naturally.
   */
  applyEvent(event: TexeraWebSocketEvent): void {
    const t = (event as { type: string }).type;
    switch (t) {
      // ── State + status ──
      case "WorkflowStateEvent":
        this.handleWorkflowStateEvent(event as Extract<TexeraWebSocketEvent, { type: "WorkflowStateEvent" }>);
        return;
      case "OperatorStatisticsUpdateEvent":
        this.handleOperatorStatisticsUpdateEvent(
          event as Extract<TexeraWebSocketEvent, { type: "OperatorStatisticsUpdateEvent" }>,
        );
        return;
      case "RecoveryStartedEvent":
        this.snapshot = { ...this.snapshot, currentState: "Recovering" };
        console.log(`[ExecutionWatcher ${this.snapshot.executionName}] RecoveryStartedEvent → state: Recovering`);
        return;
      case "WorkerAssignmentUpdateEvent": {
        const e = event as { operatorId: string; workerIds: string[] };
        this.snapshot = {
          ...this.snapshot,
          workerIdsByOperator: { ...this.snapshot.workerIdsByOperator, [e.operatorId]: [...e.workerIds] },
        };
        return;
      }
      case "ExecutionDurationUpdateEvent": {
        const e = event as { duration: number };
        this.snapshot = { ...this.snapshot, engineDurationMs: Number(e.duration) };
        return;
      }
      case "OperatorCurrentTuplesUpdateEvent": {
        // Per-operator in-flight tuple snapshot, populated while paused so
        // the agent can inspect what each worker was holding.
        const e = event as { operatorID: string };
        this.snapshot = {
          ...this.snapshot,
          currentTuplesByOperator: { ...this.snapshot.currentTuplesByOperator, [e.operatorID]: e },
        };
        return;
      }

      // ── Console + errors ──
      case "ConsoleUpdateEvent":
        this.handleConsoleUpdateEvent(event as Extract<TexeraWebSocketEvent, { type: "ConsoleUpdateEvent" }>);
        return;
      case "WorkflowErrorEvent":
        this.handleWorkflowErrorEvent(event as Extract<TexeraWebSocketEvent, { type: "WorkflowErrorEvent" }>);
        return;

      // ── Request/response correlation ──
      case "PaginatedResultEvent": {
        const e = event as Extract<TexeraWebSocketEvent, { type: "PaginatedResultEvent" }>;
        const pending = this.pendingPagination.get(e.requestID);
        if (pending) {
          this.pendingPagination.delete(e.requestID);
          pending.resolve(e);
        }
        return;
      }

      // ── Heartbeat ──
      case "HeartBeatResponse":
        return; // silent

      // ── Advanced features (Phases 9-15) — TODO: wire up when those land ──
      case "PythonExpressionEvaluateResponse": {
        const e = event as PythonExpressionEvaluateResponse;
        // Correlation: response carries the original expression but not the
        // operatorId. We can't disambiguate which operator's worker answered
        // when multiple ops have a pending eval for the same expression. In
        // practice the engine routes responses back through the same socket
        // that sent the request, and we only ever queue one per (op, expr)
        // from the agent. Match against any pending key whose expression
        // suffix equals e.expression — first non-empty queue wins.
        const matchedKey = this.findFirstPendingPythonEvalKey(e.expression);
        if (matchedKey) {
          const queue = this.pendingPythonEval.get(matchedKey)!;
          const pending = queue.shift()!;
          if (queue.length === 0) this.pendingPythonEval.delete(matchedKey);
          pending.resolve(e);
        } else {
          console.log(
            `[ExecutionWatcher ${this.snapshot.executionName}] PythonExpressionEvaluateResponse with no pending awaiter (expr=${e.expression.slice(0, 60)})`,
          );
        }
        return;
      }
      case "ModifyLogicResponse": {
        // The engine validates and queues the change synchronously here, but
        // doesn't actually apply it until the next resume (Fries semantics:
        // reconfigurations batched during pause, applied on resume). So
        // resolving on `ModifyLogicResponse` is the right semantic for the
        // tool — the agent should call resumeExecution to trigger application.
        const e = event as ModifyLogicResponse;
        const queue = this.pendingModifyLogic.get(e.opId);
        if (!queue || queue.length === 0) {
          console.log(
            `[ExecutionWatcher ${this.snapshot.executionName}] ModifyLogicResponse with no pending awaiter (opId=${e.opId})`,
          );
          return;
        }
        const head = queue.shift()!;
        if (queue.length === 0) this.pendingModifyLogic.delete(e.opId);
        head.resolve({
          isValid: e.isValid,
          errorMessage: e.errorMessage,
          // `applied: true` here means "queued and will be applied on resume" —
          // the actual engine apply happens in performReconfigurationOnResume,
          // and the corresponding ModifyLogicCompletedEvent surfaces via state
          // diffing for downstream consumers (UI badges, etc.) but is no longer
          // gating this Promise.
          applied: e.isValid,
        });
        return;
      }
      case "ModifyLogicCompletedEvent": {
        // After the change above, the Promise is already resolved by the time
        // ModifyLogicCompletedEvent arrives (engine applies on resume). This
        // event is still useful for downstream UI consumers, but no longer
        // drives `pendingModifyLogic` resolution.
        const e = event as ModifyLogicCompletedEvent;
        console.log(
          `[ExecutionWatcher ${this.snapshot.executionName}] ModifyLogicCompletedEvent: ${e.opIds.join(",")} (engine applied)`,
        );
        return;
      }

      // ── Events we don't currently consume but could be useful later ──
      case "WebResultUpdateEvent":
        // TODO(phase-future): partial result deltas. We currently use
        // ResultPaginationRequest for explicit fetches. Could supplement.
        return;
      case "WorkflowAvailableResultEvent":
        // TODO(phase-future): list of operators with materialized results.
        // Today we infer from per-operator state; this is more authoritative.
        return;
      case "CacheStatusUpdateEvent":
      case "CacheUsageUpdateEvent":
      case "CacheEntryUpdateEvent":
        // TODO(phase-future): reuse-cache visibility (which ops will be
        // cache-served before they run). Today we surface CompletedFromCache
        // post-hoc via per-op state.
        return;
      case "ResultExportResponse":
        // TODO(phase-future): if/when agent supports export operations.
        return;
      case "RegionUpdateEvent":
      case "RegionStateEvent":
        // TODO(phase-future): scheduling region visibility. Internal detail
        // for now — could expose for advanced execution-plan diagnosis.
        return;
      case "ClusterStatusUpdateEvent":
        // TODO(phase-future): cluster health (worker count, node availability).
        return;

      default:
        console.log(`[ExecutionWatcher ${this.snapshot.executionName}] unhandled event type: ${t}`);
        return;
    }
  }

  // ─── Per-event handlers ────────────────────────────────────────────────

  private handleWorkflowStateEvent(
    event: Extract<TexeraWebSocketEvent, { type: "WorkflowStateEvent" }>,
  ): void {
    const newState = event.state;
    const oldState = this.snapshot.currentState;

    const enteringTerminal = isTerminalState(newState);
    this.snapshot = {
      ...this.snapshot,
      currentState: newState,
      mostRecentCompletedAt: enteringTerminal ? Date.now() : undefined,
    };

    // Pause/resume timestamps
    if (newState === "Paused" && !this.snapshot.mostRecentPausedAt) {
      this.snapshot = { ...this.snapshot, mostRecentPausedAt: Date.now() };
    } else if (newState === "Running" && oldState === "Resuming") {
      this.snapshot = { ...this.snapshot, mostRecentResumedAt: Date.now(), mostRecentPausedAt: undefined };
    } else if (
      !isTerminalState(newState) &&
      newState !== "Paused" &&
      newState !== "Pausing" &&
      (oldState === "Paused" || oldState === "Resuming")
    ) {
      this.snapshot = { ...this.snapshot, mostRecentPausedAt: undefined };
    }

    console.log(
      `[ExecutionWatcher ${this.snapshot.executionName}] WorkflowStateEvent: ${oldState} -> ${newState}, terminal=${snapshotIsTerminal(this.snapshot)}`,
    );

    if (SIGNIFICANT_STATE_TRANSITIONS.has(newState) && newState !== oldState) {
      // FE pattern: defer "failed" emission until the follow-up
      // WorkflowErrorEvent arrives — gives downstream consumers a snapshot
      // with `fatalErrors` populated rather than a bare "Failed" state.
      if (newState === "Failed") {
        console.log(
          `[ExecutionWatcher ${this.snapshot.executionName}] WorkflowStateEvent("Failed") seen; deferring significant emission until WorkflowErrorEvent arrives.`,
        );
        return;
      }
      const reason = reasonForState(newState, this.snapshot.perOperatorState);
      if (reason) {
        console.log(
          `[ExecutionWatcher ${this.snapshot.executionName}] emit significant: reason=${reason} (state=${newState})`,
        );
        this.emitSignificant({ reason, triggeringEvent: event });
      }
    }
  }

  private handleOperatorStatisticsUpdateEvent(
    event: Extract<TexeraWebSocketEvent, { type: "OperatorStatisticsUpdateEvent" }>,
  ): void {
    const updated: Record<string, PerOperatorState> = { ...this.snapshot.perOperatorState };
    for (const [opId, metrics] of Object.entries(event.operatorStatistics)) {
      const m = metrics as OperatorAggregatedMetrics;
      updated[opId] = {
        state: m.operatorState,
        inputTupleCount: Number(m.aggregatedInputRowCount ?? 0),
        outputTupleCount: Number(m.aggregatedOutputRowCount ?? 0),
        numWorkers: Number(m.numWorkers ?? 0),
      };
    }
    this.snapshot = { ...this.snapshot, perOperatorState: updated };
    // Per-operator stats are noisy by design — never emit significant.
  }

  private handleConsoleUpdateEvent(
    event: Extract<TexeraWebSocketEvent, { type: "ConsoleUpdateEvent" }>,
  ): void {
    // Buffer ALL console messages (across all levels) so the agent can pull
    // recent stdout. Maintain a separate ERROR-only filter to drive the
    // console-error significant event, and a per-operator map for the
    // `getConsoleLogs` tool.
    const allMerged = [...this.snapshot.recentConsoleMessages, ...event.messages];
    const allTrimmed = allMerged.length > 100 ? allMerged.slice(-100) : allMerged;

    const opId = event.operatorId;
    const perOpUpdated = { ...this.snapshot.consoleMessagesByOperator };
    if (opId) {
      const prevForOp = perOpUpdated[opId] ?? [];
      const mergedForOp = [...prevForOp, ...event.messages];
      perOpUpdated[opId] = mergedForOp.length > 50 ? mergedForOp.slice(-50) : mergedForOp;
    }

    const errors: ConsoleMessage[] = [];
    for (const msg of event.messages) {
      if (getConsoleMessageType(msg) === "ERROR") errors.push(msg);
    }
    let updated: ExecutionWatcherSnapshot = {
      ...this.snapshot,
      recentConsoleMessages: allTrimmed,
      consoleMessagesByOperator: perOpUpdated,
    };
    if (errors.length > 0) {
      const merged = [...this.snapshot.recentConsoleErrors, ...errors];
      updated = {
        ...updated,
        recentConsoleErrors: merged.length > 100 ? merged.slice(-100) : merged,
      };
    }
    this.snapshot = updated;

    if (errors.length > 0) {
      this.emitSignificant({ reason: "console-error", triggeringEvent: event });
    }
  }

  private handleWorkflowErrorEvent(
    event: Extract<TexeraWebSocketEvent, { type: "WorkflowErrorEvent" }>,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      fatalErrors: [...this.snapshot.fatalErrors, ...event.fatalErrors],
    };
    // FE pattern: WorkflowErrorEvent typically follows WorkflowStateEvent("Failed").
    // We deferred the "failed" significant emission earlier; emit it now that
    // fatalErrors is populated, so awaiters see a coherent snapshot.
    if (this.snapshot.currentState === "Failed") {
      console.log(
        `[ExecutionWatcher ${this.snapshot.executionName}] emit significant: reason=failed (deferred — fatalErrors now populated)`,
      );
      this.emitSignificant({ reason: "failed", triggeringEvent: event });
    }
  }

  private emitSignificant(info: SignificantEventInfo): void {
    if (this.awaiters.size === 0) return;
    // Snapshot the set first because resolvers may add new awaiters re-entrantly.
    const toFire = [...this.awaiters];
    this.awaiters.clear();
    for (const a of toFire) {
      if (a.timer !== null) clearTimeout(a.timer);
      if (a.abortHandler && a.abortSignal) {
        a.abortSignal.removeEventListener("abort", a.abortHandler);
      }
      a.resolve(info);
    }
  }

  /**
   * Wait for either the next significant event or the timeout, whichever
   * fires first. If `abortSignal` is provided and aborts before either,
   * resolves with reason: "aborted".
   */
  waitForSignificantEvent(
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<SignificantEventInfo> {
    if (abortSignal?.aborted) {
      return Promise.resolve({ reason: "aborted" });
    }

    return new Promise<SignificantEventInfo>(resolve => {
      const awaiter: PendingAwaiter = {
        resolve,
        timer: null,
        abortHandler: null,
        abortSignal: abortSignal ?? null,
      };

      // Timer
      if (timeoutMs > 0) {
        awaiter.timer = setTimeout(() => {
          this.awaiters.delete(awaiter);
          if (awaiter.abortHandler && awaiter.abortSignal) {
            awaiter.abortSignal.removeEventListener("abort", awaiter.abortHandler);
          }
          resolve({ reason: "tick" });
        }, timeoutMs);
      }

      // Abort
      if (abortSignal) {
        awaiter.abortHandler = () => {
          this.awaiters.delete(awaiter);
          if (awaiter.timer !== null) clearTimeout(awaiter.timer);
          resolve({ reason: "aborted" });
        };
        abortSignal.addEventListener("abort", awaiter.abortHandler, { once: true });
      }

      this.awaiters.add(awaiter);
    });
  }

  /**
   * Convenience: wait for a significant event, then return a structured
   * AwaitResult including elapsed timings and a fresh snapshot.
   *
   * If the execution is already in a terminal state when called, returns
   * immediately with a reason derived from the current state (no timer wait).
   * This handles the race where the engine completes before the agent's first
   * awaitExecution call (e.g., cache hit returns instantly).
   */
  async await(timeoutMs: number, abortSignal?: AbortSignal): Promise<AwaitResult> {
    let info: SignificantEventInfo;
    // Fast-path: derive terminal-ness from currentState (single source of
    // truth — no separate flag to drift out of sync).
    if (snapshotIsTerminal(this.snapshot)) {
      const reason = reasonForState(this.snapshot.currentState, this.snapshot.perOperatorState) ?? "completed";
      console.log(
        `[ExecutionWatcher ${this.snapshot.executionName}] await: fast-path on terminal state=${this.snapshot.currentState}, reason=${reason}`
      );
      info = { reason };
    } else {
      console.log(
        `[ExecutionWatcher ${this.snapshot.executionName}] await: blocking (timeout=${timeoutMs}ms, state=${this.snapshot.currentState})`
      );
      info = await this.waitForSignificantEvent(timeoutMs, abortSignal);
      console.log(
        `[ExecutionWatcher ${this.snapshot.executionName}] await: returned reason=${info.reason}, state=${this.snapshot.currentState}`
      );
    }
    const now = Date.now();
    const snapshot = this.getSnapshot();
    const result: AwaitResult = {
      reason: info.reason,
      elapsedSinceStartMs: now - this.snapshot.mostRecentStartedAt,
      elapsedSinceLastWakeMs: now - this.lastWakeAt,
      snapshot,
    };
    // Stash this snapshot as the reference for "what changed since the LLM
    // last looked." Subsequent prepareStep renders compare against it; the
    // next await call replaces it.
    this.snapshotAtLastWake = snapshot;
    this.lastWakeAt = now;
    return result;
  }

  /**
   * The snapshot at the moment the most recent `await()` returned, paired
   * with the wall-clock time of that wake. Used by the assembler to compute
   * deltas. Returns null if no `await()` has completed yet.
   */
  getSnapshotAtLastWake(): { snapshot: ExecutionWatcherSnapshot; atMs: number } | null {
    if (this.snapshotAtLastWake === null) return null;
    return { snapshot: this.snapshotAtLastWake, atMs: this.lastWakeAt };
  }

  private findFirstPendingPythonEvalKey(expression: string): string | null {
    const suffix = `::${expression}`;
    for (const key of this.pendingPythonEval.keys()) {
      if (key.endsWith(suffix)) return key;
    }
    return null;
  }

  /**
   * Send a Python eval request and resolve when the matching response event
   * arrives. Caller should validate that the operator is paused — engine
   * behavior on a non-paused worker is undefined.
   */
  requestPythonEval(
    operatorId: string,
    expression: string,
    timeoutMs: number = 30_000,
  ): Promise<PythonExpressionEvaluateResponse> {
    const key = `${operatorId}::${expression}`;
    return new Promise<PythonExpressionEvaluateResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pendingPythonEval.get(key);
        if (queue) {
          const idx = queue.findIndex(p => p.resolve === wrappedResolve);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) this.pendingPythonEval.delete(key);
        }
        reject(
          new Error(
            `Python eval timed out after ${timeoutMs}ms (op=${operatorId}, expression=${expression.slice(0, 60)})`,
          ),
        );
      }, timeoutMs);

      const wrappedResolve = (evt: PythonExpressionEvaluateResponse) => {
        clearTimeout(timer);
        resolve(evt);
      };
      const wrappedReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      const queue = this.pendingPythonEval.get(key) ?? [];
      queue.push({ resolve: wrappedResolve, reject: wrappedReject });
      this.pendingPythonEval.set(key, queue);

      try {
        this.wsClient.sendPythonEvalRequest({ expression, operatorId });
      } catch (err) {
        const q = this.pendingPythonEval.get(key);
        if (q) {
          const idx = q.findIndex(p => p.resolve === wrappedResolve);
          if (idx >= 0) q.splice(idx, 1);
          if (q.length === 0) this.pendingPythonEval.delete(key);
        }
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a modify-logic request and resolve once the engine has both
   * validated and applied the change.
   *
   * Resolution paths:
   *   - `ModifyLogicResponse(isValid=false)` → resolve with `{ isValid: false, ... }` immediately.
   *   - `ModifyLogicResponse(isValid=true)` then `ModifyLogicCompletedEvent` → resolve with `{ applied: true }`.
   *   - Timeout → reject. (May happen if the engine validates but never reaches
   *     a tuple boundary to apply — unusual but possible if the workflow is
   *     stuck.)
   */
  requestModifyLogic(
    operatorPayload: { operatorID: string; operatorType: string; [k: string]: any },
    timeoutMs: number = 30_000,
  ): Promise<ModifyLogicResult> {
    const opId = operatorPayload.operatorID;
    return new Promise<ModifyLogicResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pendingModifyLogic.get(opId);
        if (queue) {
          const idx = queue.findIndex(p => p === pending);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) this.pendingModifyLogic.delete(opId);
        }
        reject(new Error(`liveModifyOperator timed out after ${timeoutMs}ms (opId=${opId})`));
      }, timeoutMs);

      const pending: PendingModifyLogic = {
        resolve: r => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      };

      const queue = this.pendingModifyLogic.get(opId) ?? [];
      queue.push(pending);
      this.pendingModifyLogic.set(opId, queue);

      try {
        this.wsClient.sendModifyLogicRequest({ operator: operatorPayload });
      } catch (err) {
        const q = this.pendingModifyLogic.get(opId);
        if (q) {
          const idx = q.findIndex(p => p === pending);
          if (idx >= 0) q.splice(idx, 1);
          if (q.length === 0) this.pendingModifyLogic.delete(opId);
        }
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a retry request to the given workers (typically the workers of an
   * operator that just had its logic modified). Fire-and-forget — engine has
   * no synchronous response for retry; observable effect is the next tuple
   * being reprocessed and showing up in OperatorStatistics / Console events.
   */
  retryWorkers(workers: string[]): void {
    this.wsClient.sendRetryRequest({ workers });
  }

  /**
   * Send a pagination request and resolve when the matching event arrives.
   */
  requestPaginatedResult(
    operatorId: string,
    pageIndex: number,
    pageSize: number,
    timeoutMs: number = 30_000,
  ): Promise<PaginatedResultEvent> {
    const requestID = `${this.snapshot.executionName}-${operatorId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return new Promise<PaginatedResultEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPagination.delete(requestID);
        reject(new Error(`Pagination request timed out after ${timeoutMs}ms (op=${operatorId}, page=${pageIndex})`));
      }, timeoutMs);

      this.pendingPagination.set(requestID, {
        resolve: evt => {
          clearTimeout(timer);
          resolve(evt);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.wsClient.sendPaginationRequest({ requestID, operatorID: operatorId, pageIndex, pageSize });
      } catch (err) {
        this.pendingPagination.delete(requestID);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Control ────────────────────────────────────────────────────────────

  pause(): void {
    this.wsClient.sendPauseRequest();
  }

  resume(): void {
    this.wsClient.sendResumeRequest();
  }

  kill(): void {
    this.wsClient.sendKillRequest();
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  /**
   * Returns a frozen view of the current snapshot.
   */
  getSnapshot(): ExecutionWatcherSnapshot {
    return { ...this.snapshot, perOperatorState: { ...this.snapshot.perOperatorState } };
  }

  isAlive(): boolean {
    return !snapshotIsTerminal(this.snapshot);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  dispose(): void {
    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
    }
    // Resolve any outstanding awaiters with "aborted" so they don't hang
    const toFire = [...this.awaiters];
    this.awaiters.clear();
    for (const a of toFire) {
      if (a.timer !== null) clearTimeout(a.timer);
      a.resolve({ reason: "aborted" });
    }
    // Reject pending pagination requests
    for (const [, p] of this.pendingPagination) p.reject(new Error("Watcher disposed"));
    this.pendingPagination.clear();
    // Reject pending Python eval requests
    for (const [, queue] of this.pendingPythonEval) {
      for (const p of queue) p.reject(new Error("Watcher disposed"));
    }
    this.pendingPythonEval.clear();
    // Reject pending modify-logic requests
    for (const [, queue] of this.pendingModifyLogic) {
      for (const p of queue) p.reject(new Error("Watcher disposed"));
    }
    this.pendingModifyLogic.clear();
    try {
      this.wsClient.close();
    } catch {
      // already closed; ignore
    }
  }
}
