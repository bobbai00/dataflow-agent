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
 * ExecutionWatcher — sole arbiter of "something significant happened" in the
 * running workflow execution. One per agent.
 *
 * Architecture (rule-based, no timers):
 *
 *   ┌─────────────┐  WS event
 *   │ WsClient    │ ───────────► applyEvent()
 *   └─────────────┘                  │
 *                                    ▼
 *                       1. compute per-event SnapshotDiff
 *                       2. mutate snapshot
 *                       3. run wake rules → WakeSignal[]
 *                       4. route signals + diff to ONE consumer:
 *                          • if an awaiter is registered → deliver directly
 *                          • else → merge into mailbox
 *
 * Tool/agent loop interaction:
 *   • Control tools (start/pause/resume/kill) call `await()` after sending
 *     their request. `await()` blocks until rules fire, returns the diff +
 *     signals, no timeout.
 *   • prepareStep peeks/drains the mailbox to inject `[execution]` user-role
 *     messages into the conversation between agent steps.
 *   • Mailbox seals once a terminal-state diff has been drained, so editing-
 *     phase prepareSteps don't keep re-surfacing stale events.
 */

import type { ExecutionWsClient } from "../api/execution-ws-client";
import {
  getConsoleMessageType,
  type ConsoleMessage,
  type ModifyLogicCompletedEvent,
  type ModifyLogicResponse,
  type OperatorAggregatedMetrics,
  type PaginatedResultEvent,
  type PythonExpressionEvaluateResponse,
  type TexeraWebSocketEvent,
  type WorkflowExecuteRequest,
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
   */
  mostRecentStartedAt: number;
  mostRecentPausedAt?: number;
  mostRecentResumedAt?: number;
  /**
   * Set when we transitioned INTO a terminal state; cleared when we transition
   * out (e.g., engine state-replay then new execution).
   */
  mostRecentCompletedAt?: number;
  currentState: WorkflowState;
  perOperatorState: Record<string, PerOperatorState>;
  workerIdsByOperator: Record<string, string[]>;
  currentTuplesByOperator: Record<string, unknown>;
  recentConsoleMessages: ConsoleMessage[];
  consoleMessagesByOperator: Record<string, ConsoleMessage[]>;
  recentConsoleErrors: ConsoleMessage[];
  fatalErrors: WorkflowFatalError[];
  engineDurationMs?: number;
}

/**
 * What changed in a single event (or, when coalesced, between mailbox
 * drains). All fields are optional — the diff only contains what actually
 * changed. Lists (`newConsoleMessages`, `newFatalErrors`) are NEVER capped;
 * coalescing concatenates rather than truncating.
 */
export interface SnapshotDiff {
  /** Workflow-level state transition. Coalescing keeps first `from`, latest `to`. */
  workflowState?: { from: WorkflowState; to: WorkflowState };

  /** Per-operator state transitions. Coalescing keeps first `from`, latest `to` per opId. */
  perOperator?: Record<string, { from?: PerOperatorState; to: PerOperatorState }>;

  /** Console messages added by this event/window. Concatenated on coalesce. */
  newConsoleMessages?: ConsoleMessage[];

  /** Fatal errors added. Concatenated on coalesce. */
  newFatalErrors?: WorkflowFatalError[];

  /** Worker assignments observed. Latest-per-key wins. */
  newWorkerAssignments?: Record<string, string[]>;

  /** Per-op currentTuples observed. Latest-per-key wins. */
  newCurrentTuples?: Record<string, unknown>;

  /** Engine-reported duration update. Latest wins. */
  engineDurationMs?: number;
}

/**
 * Reason why a wake fired, surfaced to the agent. Narrow on purpose — we're
 * being careful about what counts as a discrete signal class. Add cautiously.
 */
export type WakeReason =
  | "paused"
  | "resumed"
  | "completed"
  | "completed-from-cache"
  | "failed"
  | "killed"
  | "console-error"
  | "fatal-error"
  /** A single operator's worker auto-paused (typically EXCEPTION_PAUSE on a
   *  Python UDF) while the workflow as a whole is still Running. */
  | "operator-auto-paused";

/**
 * One rule firing. Signals are LABELS over the diff — the data the agent
 * needs is in the diff itself, signals tell the agent which rules thought
 * the change was worth surfacing.
 */
export interface WakeSignal {
  ruleId: string;
  reason: WakeReason;
  severity: "milestone" | "anomaly" | "critical";
  summary: string;
}

/**
 * One raw WebSocket event that contributed to a wake signal. Non-wake events
 * (routine OperatorStatistics ticks, etc.) are absorbed into the snapshot
 * silently and NOT recorded — the goal is a small, diagnostic-grade list.
 */
export interface RecordedEvent {
  timestamp: number;
  event: TexeraWebSocketEvent;
}

export interface MailboxContents {
  diff: SnapshotDiff;
  signals: WakeSignal[];
  firstEventAt: number;
  lastEventAt: number;
  /** Wake-firing events that landed in this mailbox window, in arrival order. */
  contributingEvents: RecordedEvent[];
  /** Snapshot just before the first event in `contributingEvents`. */
  beforeSnapshot: ExecutionWatcherSnapshot;
}

export interface AwaitResult {
  reason: "events" | "aborted";
  snapshot: ExecutionWatcherSnapshot;
  diff: SnapshotDiff;
  signals: WakeSignal[];
  /** Wake-firing events received during this await (or pulled from mailbox). */
  contributingEvents: RecordedEvent[];
  /**
   * Snapshot just before the first event in `contributingEvents`. For aborted
   * results (no events), this is the snapshot at the time of the abort.
   */
  beforeSnapshot: ExecutionWatcherSnapshot;
}

// ─── State helpers ────────────────────────────────────────────────────────

function isTerminalState(state: WorkflowState): boolean {
  return state === "Completed" || state === "Failed" || state === "Killed" || state === "Terminated";
}

function isStateAlive(state: WorkflowState): boolean {
  if (isTerminalState(state)) return false;
  if (state === "Uninitialized") return false;
  return true;
}

function isAnyOperatorFromCache(perOp: Record<string, PerOperatorState>): boolean {
  for (const st of Object.values(perOp)) {
    if (typeof st.state === "string" && st.state.includes("FromCache")) return true;
  }
  return false;
}

export function snapshotIsTerminal(s: ExecutionWatcherSnapshot): boolean {
  return isTerminalState(s.currentState);
}

export function snapshotWasFromCache(s: ExecutionWatcherSnapshot): boolean {
  return s.currentState === "Completed" && isAnyOperatorFromCache(s.perOperatorState);
}

// ─── Wake rules ───────────────────────────────────────────────────────────
//
// Each rule is a pure function over (prev, curr, diff) that returns 0+
// signals. Rules are evaluated per-event; signals merge into the mailbox by
// ruleId dedupe (first occurrence wins for label fields; the diff carries
// the underlying data).

type WakeRule = (
  prev: ExecutionWatcherSnapshot,
  curr: ExecutionWatcherSnapshot,
  diff: SnapshotDiff,
) => WakeSignal[];

const ruleStateMilestone: WakeRule = (_prev, curr, diff) => {
  if (!diff.workflowState) return [];
  const to = diff.workflowState.to;
  if (to === "Paused") {
    return [{
      ruleId: "state-paused",
      reason: "paused",
      severity: "milestone",
      summary: `workflow paused`,
    }];
  }
  if (to === "Completed") {
    if (snapshotWasFromCache(curr)) {
      return [{
        ruleId: "state-completed-from-cache",
        reason: "completed-from-cache",
        severity: "milestone",
        summary: `workflow completed by returning cached results without re-running operators`,
      }];
    }
    return [{
      ruleId: "state-completed",
      reason: "completed",
      severity: "milestone",
      summary: `workflow completed`,
    }];
  }
  if (to === "Killed" || to === "Terminated") {
    return [{
      ruleId: "state-killed",
      reason: "killed",
      severity: "milestone",
      summary: `workflow ${to.toLowerCase()}`,
    }];
  }
  // Failed is special — we wait for the WorkflowErrorEvent to populate fatal
  // errors before firing the signal. See ruleFailedAfterFatal.
  return [];
};

/**
 * Failed state requires a fatal-error event to be useful. We fire only when
 * BOTH have happened; the fatal-error rule below handles the case where the
 * fatal error arrives after state=Failed.
 */
const ruleFailedAfterFatal: WakeRule = (_prev, curr, diff) => {
  // Fire on either: state just became Failed and we already have errors,
  // OR new fatal errors arrived while state is Failed.
  const becameFailed = diff.workflowState?.to === "Failed";
  const newErrors = (diff.newFatalErrors?.length ?? 0) > 0;
  if (curr.currentState !== "Failed") return [];
  if (!becameFailed && !newErrors) return [];
  if (curr.fatalErrors.length === 0 && !newErrors) return []; // wait for errors
  return [{
    ruleId: "state-failed",
    reason: "failed",
    severity: "critical",
    summary: `workflow failed (${curr.fatalErrors.length} fatal error${curr.fatalErrors.length === 1 ? "" : "s"})`,
  }];
};

const ruleConsoleError: WakeRule = (_prev, _curr, diff) => {
  const msgs = diff.newConsoleMessages ?? [];
  const errors = msgs.filter(m => getConsoleMessageType(m) === "ERROR");
  if (errors.length === 0) return [];
  return [{
    ruleId: "console-error",
    reason: "console-error",
    severity: "anomaly",
    summary: `${errors.length} ERROR-level console message${errors.length === 1 ? "" : "s"}`,
  }];
};

/**
 * Detect per-operator auto-pause: a single operator's per-op state went to
 * "Paused" while the workflow as a whole is NOT Pausing/Paused. The engine
 * does this on EXCEPTION_PAUSE — a Python UDF raised, the worker caught it,
 * paused itself, and parked the failing tuple. Other workers keep running.
 *
 * Critical for the agent: the `liveModifyOperator` precondition is workflow-
 * level Paused, not per-operator. So when this rule fires, the agent must
 * call `pauseExecution` first to quiesce the rest of the workflow before
 * `liveModifyOperator` will be allowed.
 */
const ruleOperatorAutoPaused: WakeRule = (_prev, curr, diff) => {
  if (!diff.perOperator) return [];
  // Only meaningful while workflow itself is non-paused.
  if (curr.currentState === "Paused" || curr.currentState === "Pausing") return [];
  const pausedOps: string[] = [];
  for (const [opId, change] of Object.entries(diff.perOperator)) {
    if (change.to.state === "Paused" && change.from?.state !== "Paused") {
      pausedOps.push(opId);
    }
  }
  if (pausedOps.length === 0) return [];
  return [{
    ruleId: "operator-auto-paused",
    reason: "operator-auto-paused",
    severity: "anomaly",
    summary: `${pausedOps.length === 1 ? "operator" : "operators"} ${pausedOps.join(", ")} auto-paused (likely EXCEPTION_PAUSE); workflow as a whole still Running. Call pauseExecution before liveModifyOperator.`,
  }];
};

const RULES: WakeRule[] = [ruleStateMilestone, ruleFailedAfterFatal, ruleConsoleError, ruleOperatorAutoPaused];

function runRules(
  prev: ExecutionWatcherSnapshot,
  curr: ExecutionWatcherSnapshot,
  diff: SnapshotDiff,
): WakeSignal[] {
  const out: WakeSignal[] = [];
  for (const rule of RULES) {
    const sigs = rule(prev, curr, diff);
    for (const s of sigs) out.push(s);
  }
  return out;
}

// ─── Diff coalescing ──────────────────────────────────────────────────────

/**
 * Merge a per-event diff into the mailbox-accumulated diff. Coalescing rules:
 *   - workflowState: keep first `from`, latest `to`.
 *   - perOperator[opId]: keep first `from`, latest `to`.
 *   - newConsoleMessages / newFatalErrors: concat (no cap).
 *   - newWorkerAssignments / newCurrentTuples: latest-per-key wins.
 *   - engineDurationMs: latest wins.
 */
function mergeDiff(into: SnapshotDiff, add: SnapshotDiff): SnapshotDiff {
  const out: SnapshotDiff = { ...into };

  if (add.workflowState) {
    if (out.workflowState) {
      out.workflowState = { from: out.workflowState.from, to: add.workflowState.to };
    } else {
      out.workflowState = { ...add.workflowState };
    }
  }

  if (add.perOperator) {
    out.perOperator = { ...(out.perOperator ?? {}) };
    for (const [opId, change] of Object.entries(add.perOperator)) {
      const existing = out.perOperator[opId];
      if (existing) {
        out.perOperator[opId] = { from: existing.from, to: change.to };
      } else {
        out.perOperator[opId] = { ...change };
      }
    }
  }

  if (add.newConsoleMessages?.length) {
    out.newConsoleMessages = [...(out.newConsoleMessages ?? []), ...add.newConsoleMessages];
  }
  if (add.newFatalErrors?.length) {
    out.newFatalErrors = [...(out.newFatalErrors ?? []), ...add.newFatalErrors];
  }
  if (add.newWorkerAssignments) {
    out.newWorkerAssignments = { ...(out.newWorkerAssignments ?? {}), ...add.newWorkerAssignments };
  }
  if (add.newCurrentTuples) {
    out.newCurrentTuples = { ...(out.newCurrentTuples ?? {}), ...add.newCurrentTuples };
  }
  if (add.engineDurationMs !== undefined) {
    out.engineDurationMs = add.engineDurationMs;
  }
  return out;
}

function diffIsEmpty(d: SnapshotDiff): boolean {
  if (d.workflowState) return false;
  if (d.perOperator && Object.keys(d.perOperator).length > 0) return false;
  if (d.newConsoleMessages?.length) return false;
  if (d.newFatalErrors?.length) return false;
  if (d.newWorkerAssignments && Object.keys(d.newWorkerAssignments).length > 0) return false;
  if (d.newCurrentTuples && Object.keys(d.newCurrentTuples).length > 0) return false;
  if (d.engineDurationMs !== undefined) return false;
  return true;
}

/**
 * Dedupe signals by ruleId — first occurrence wins for the label fields.
 * The underlying data lives in the diff, so we don't need to merge payloads.
 */
function mergeSignals(into: WakeSignal[], add: WakeSignal[]): WakeSignal[] {
  if (add.length === 0) return into;
  const out = [...into];
  const seen = new Set(out.map(s => s.ruleId));
  for (const s of add) {
    if (!seen.has(s.ruleId)) {
      out.push(s);
      seen.add(s.ruleId);
    }
  }
  return out;
}

// ─── ExecutionWatcher ─────────────────────────────────────────────────────

interface PendingPagination {
  resolve: (event: PaginatedResultEvent) => void;
  reject: (err: Error) => void;
}

interface PendingPythonEval {
  resolve: (event: PythonExpressionEvaluateResponse) => void;
  reject: (err: Error) => void;
}

export interface ModifyLogicResult {
  isValid: boolean;
  errorMessage: string;
  applied: boolean;
}

interface PendingModifyLogic {
  resolve: (r: ModifyLogicResult) => void;
  reject: (err: Error) => void;
}

interface PendingAwaiter {
  resolve: (r: AwaitResult) => void;
  abortHandler: (() => void) | null;
  abortSignal: AbortSignal | null;
}

export class ExecutionWatcher {
  private snapshot: ExecutionWatcherSnapshot;
  private readonly wsClient: ExecutionWsClient;
  private wsUnsubscribe: (() => void) | null = null;

  // ── Mailbox + awaiter ──
  // At any moment, events go to EXACTLY ONE consumer:
  //   • if `currentAwaiter` is set, events bypass the mailbox and go to it.
  //   • else, events accumulate in `mailbox`.
  // The mailbox is drained by prepareStep (rendering as `[execution]` user
  // messages) or by an awaiter starting (fast-path: drain mailbox and return
  // immediately).
  private mailbox: MailboxContents | null = null;
  private mailboxSealed: boolean = false;
  private currentAwaiter: PendingAwaiter | null = null;

  // ── inExecution gate ──
  // When false, events are still applied to the snapshot (so the snapshot
  // mirrors engine state), but wake rules don't fire and nothing reaches
  // mailbox or awaiter. This lets us:
  //   - silently absorb engine state-replay on first WS connection (the
  //     prior workflow's terminal state) before the agent has issued any
  //     execute request — fixes the spurious "completed" wake from a
  //     replayed previous run.
  //   - silently absorb late teardown chatter after a terminal drain —
  //     the engine may emit a few more events after Killed/Completed that
  //     are not interesting to the agent.
  // Flipped to true by `markExecutionStarting()`. Flipped back to false
  // when the watcher consumes a terminal-state signal.
  private inExecution: boolean = false;
  // True once `connect()` has resolved at least once. Subsequent calls are
  // no-ops. Connection is owned by the watcher now (one per agent), not
  // per-execution — see TexeraAgent constructor.
  private connected: boolean = false;
  private connectPromise: Promise<void> | null = null;

  // ── Correlated request/response queues (unchanged from prior design) ──
  private pendingPagination: Map<string, PendingPagination> = new Map();
  private pendingPythonEval: Map<string, PendingPythonEval[]> = new Map();
  private pendingModifyLogic: Map<string, PendingModifyLogic[]> = new Map();

  constructor(wsClient: ExecutionWsClient, executionName: string) {
    this.wsClient = wsClient;
    const now = Date.now();
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

  start(): void {
    if (this.wsUnsubscribe) return;
    this.wsUnsubscribe = this.wsClient.onEvent(evt => this.applyEvent(evt));
  }

  /**
   * Open the WS connection to the engine. Idempotent — safe to call multiple
   * times; only the first invocation actually connects. Used by the agent
   * lazily on the first `startExecution`. Replayed state events arriving
   * after connect are absorbed silently because `inExecution` is still false.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.wsClient.connect().then(() => {
      this.connected = true;
    });
    return this.connectPromise;
  }

  /**
   * Send a WorkflowExecuteRequest on the existing WS, then mark the watcher
   * as in-execution so subsequent rule firings are surfaced. Replaces the
   * old per-execution "create new ws + watcher" dance — same WS is reused
   * across executions in a single agent session.
   */
  sendExecuteRequest(request: Omit<WorkflowExecuteRequest, "type">): void {
    this.wsClient.sendExecuteRequest({ ...request });
    this.markExecutionStarting(request.executionName);
  }

  /**
   * Optimistically mark the snapshot as "an execution is starting right now."
   * Resets per-execution accumulators and clears the mailbox seal. If
   * `executionName` is provided, updates the watcher's name to that — the
   * watcher persists across executions (single-WS design), so the name is
   * a per-execution identifier rather than constructor-time fixed.
   */
  markExecutionStarting(executionName?: string): void {
    const now = Date.now();
    this.snapshot = {
      ...this.snapshot,
      executionName: executionName ?? this.snapshot.executionName,
      currentState: "Initializing",
      mostRecentStartedAt: now,
      mostRecentCompletedAt: undefined,
      mostRecentPausedAt: undefined,
      mostRecentResumedAt: undefined,
      perOperatorState: {},
      workerIdsByOperator: {},
      currentTuplesByOperator: {},
      recentConsoleMessages: [],
      consoleMessagesByOperator: {},
      recentConsoleErrors: [],
      fatalErrors: [],
      engineDurationMs: undefined,
    };
    this.mailbox = null;
    this.mailboxSealed = false;
    // Open the gate: events from this point on may produce wake signals.
    this.inExecution = true;
    for (const [, queue] of this.pendingPythonEval) {
      for (const p of queue) p.reject(new Error("Execution restarted"));
    }
    this.pendingPythonEval.clear();
    for (const [, queue] of this.pendingModifyLogic) {
      for (const p of queue) p.reject(new Error("Execution restarted"));
    }
    this.pendingModifyLogic.clear();
    console.log(
      `[ExecutionWatcher ${this.snapshot.executionName}] markExecutionStarting: snapshot reset to Initializing, inExecution=true`
    );
  }

  /**
   * Apply a single WS event. Public for testing — production wiring is via
   * the subscription set up in `start()`.
   */
  applyEvent(event: TexeraWebSocketEvent): void {
    const t = (event as { type: string }).type;
    const prev = this.snapshot;
    let diff: SnapshotDiff = {};

    switch (t) {
      case "WorkflowStateEvent": {
        diff = this.handleWorkflowStateEvent(
          event as Extract<TexeraWebSocketEvent, { type: "WorkflowStateEvent" }>,
        );
        break;
      }
      case "OperatorStatisticsUpdateEvent": {
        diff = this.handleOperatorStatisticsUpdateEvent(
          event as Extract<TexeraWebSocketEvent, { type: "OperatorStatisticsUpdateEvent" }>,
        );
        break;
      }
      case "RecoveryStartedEvent": {
        diff = { workflowState: { from: prev.currentState, to: "Recovering" } };
        this.snapshot = { ...this.snapshot, currentState: "Recovering" };
        console.log(`[ExecutionWatcher ${this.snapshot.executionName}] RecoveryStartedEvent → state: Recovering`);
        break;
      }
      case "WorkerAssignmentUpdateEvent": {
        const e = event as { operatorId: string; workerIds: string[] };
        this.snapshot = {
          ...this.snapshot,
          workerIdsByOperator: { ...this.snapshot.workerIdsByOperator, [e.operatorId]: [...e.workerIds] },
        };
        diff = { newWorkerAssignments: { [e.operatorId]: [...e.workerIds] } };
        break;
      }
      case "ExecutionDurationUpdateEvent": {
        const e = event as { duration: number };
        const dur = Number(e.duration);
        this.snapshot = { ...this.snapshot, engineDurationMs: dur };
        diff = { engineDurationMs: dur };
        break;
      }
      case "OperatorCurrentTuplesUpdateEvent": {
        const e = event as { operatorID: string };
        this.snapshot = {
          ...this.snapshot,
          currentTuplesByOperator: { ...this.snapshot.currentTuplesByOperator, [e.operatorID]: e },
        };
        diff = { newCurrentTuples: { [e.operatorID]: e } };
        break;
      }
      case "ConsoleUpdateEvent": {
        diff = this.handleConsoleUpdateEvent(
          event as Extract<TexeraWebSocketEvent, { type: "ConsoleUpdateEvent" }>,
        );
        break;
      }
      case "WorkflowErrorEvent": {
        diff = this.handleWorkflowErrorEvent(
          event as Extract<TexeraWebSocketEvent, { type: "WorkflowErrorEvent" }>,
        );
        break;
      }
      case "PaginatedResultEvent": {
        // Correlation-only — does not contribute to diffs/signals.
        const e = event as Extract<TexeraWebSocketEvent, { type: "PaginatedResultEvent" }>;
        const pending = this.pendingPagination.get(e.requestID);
        if (pending) {
          this.pendingPagination.delete(e.requestID);
          pending.resolve(e);
        }
        return;
      }
      case "HeartBeatResponse":
        return;
      case "PythonExpressionEvaluateResponse": {
        const e = event as PythonExpressionEvaluateResponse;
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
            `[ExecutionWatcher ${this.snapshot.executionName}] ModifyLogicResponse received but no pending awaiter (opId=${e.opId}, isValid=${e.isValid}, errorMessage=${JSON.stringify(e.errorMessage)})`,
          );
          return;
        }
        const head = queue.shift()!;
        if (queue.length === 0) this.pendingModifyLogic.delete(e.opId);
        if (e.isValid) {
          console.log(
            `[ExecutionWatcher ${this.snapshot.executionName}] ModifyLogicResponse VALIDATED (opId=${e.opId}); engine will apply on resume — resolving immediately with applied=true`,
          );
        } else {
          console.log(
            `[ExecutionWatcher ${this.snapshot.executionName}] ModifyLogicResponse REJECTED (opId=${e.opId}): ${JSON.stringify(e.errorMessage)}; resolving liveModifyOperator with isValid=false`,
          );
        }
        head.resolve({
          isValid: e.isValid,
          errorMessage: e.errorMessage,
          // `applied: e.isValid` here means "queued and will be applied on
          // resume" — the actual engine apply happens in
          // performReconfigurationOnResume, and the corresponding
          // ModifyLogicCompletedEvent surfaces via state diffing for
          // downstream consumers (UI badges, etc.) but is no longer
          // gating this Promise. Fixes the 30s liveModify timeout where
          // the worker never reached a tuple boundary to apply.
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
          `[ExecutionWatcher ${this.snapshot.executionName}] ModifyLogicCompletedEvent received for opIds=[${e.opIds.join(", ")}] (engine applied; informational only — Promise was resolved on ModifyLogicResponse)`,
        );
        return;
      }
      case "WebResultUpdateEvent":
      case "WorkflowAvailableResultEvent":
      case "CacheStatusUpdateEvent":
      case "CacheUsageUpdateEvent":
      case "CacheEntryUpdateEvent":
      case "ResultExportResponse":
      case "RegionUpdateEvent":
      case "RegionStateEvent":
      case "ClusterStatusUpdateEvent":
        return;
      default:
        console.log(`[ExecutionWatcher ${this.snapshot.executionName}] unhandled event type: ${t}`);
        return;
    }

    if (diffIsEmpty(diff)) return;

    // inExecution gate: if the agent hasn't issued an execute request yet,
    // OR we're past a terminal-state drain for the prior execution, the
    // snapshot still mutates (to mirror engine state) but no signals fire.
    // This silences engine state-replay on first connect AND post-terminal
    // teardown chatter — both of which would otherwise mislead the agent.
    if (!this.inExecution) return;

    const signals = runRules(prev, this.snapshot, diff);
    // Only surface signal-firing events. Non-signal diffs (e.g. routine
    // operator-stats updates) are absorbed silently into the snapshot —
    // the # Active Execution section reads the cumulative snapshot, so
    // the agent still has visibility into current numbers without
    // getting woken on every counter tick.
    if (signals.length === 0) return;

    // If any of the signals is a terminal-state milestone, flip
    // `inExecution` off AFTER routing — subsequent late events (engine
    // teardown chatter, etc.) will be silenced. The agent's next
    // startExecution will flip it back on via markExecutionStarting().
    const isTerminal = signals.some(s =>
      s.ruleId === "state-completed" ||
      s.ruleId === "state-completed-from-cache" ||
      s.ruleId === "state-failed" ||
      s.ruleId === "state-killed",
    );
    const recorded: RecordedEvent = { timestamp: Date.now(), event };
    this.routeEvent(diff, signals, recorded, prev);
    if (isTerminal) {
      this.inExecution = false;
      console.log(
        `[ExecutionWatcher ${this.snapshot.executionName}] terminal signal drained; inExecution=false (post-terminal events will be silent)`,
      );
    }
  }

  /**
   * Single-consumer routing: events go to either the registered awaiter OR
   * the mailbox, never both. Sealed mailbox drops new events.
   */
  private routeEvent(
    diff: SnapshotDiff,
    signals: WakeSignal[],
    recorded: RecordedEvent,
    prevBeforeEvent: ExecutionWatcherSnapshot,
  ): void {
    if (this.currentAwaiter) {
      const awaiter = this.currentAwaiter;
      this.currentAwaiter = null;
      if (awaiter.abortHandler && awaiter.abortSignal) {
        awaiter.abortSignal.removeEventListener("abort", awaiter.abortHandler);
      }
      awaiter.resolve({
        reason: "events",
        snapshot: this.getSnapshot(),
        diff,
        signals,
        contributingEvents: [recorded],
        beforeSnapshot: prevBeforeEvent,
      });
      return;
    }

    if (this.mailboxSealed) return;

    const now = Date.now();
    if (this.mailbox === null) {
      this.mailbox = {
        diff,
        signals,
        firstEventAt: now,
        lastEventAt: now,
        contributingEvents: [recorded],
        beforeSnapshot: prevBeforeEvent,
      };
    } else {
      this.mailbox = {
        diff: mergeDiff(this.mailbox.diff, diff),
        signals: mergeSignals(this.mailbox.signals, signals),
        firstEventAt: this.mailbox.firstEventAt,
        lastEventAt: now,
        contributingEvents: [...this.mailbox.contributingEvents, recorded],
        beforeSnapshot: this.mailbox.beforeSnapshot,
      };
    }
  }

  // ─── Per-event handlers (return per-event diff, mutate snapshot) ──────

  private handleWorkflowStateEvent(
    event: Extract<TexeraWebSocketEvent, { type: "WorkflowStateEvent" }>,
  ): SnapshotDiff {
    const newState = event.state;
    const oldState = this.snapshot.currentState;
    if (newState === oldState) return {};

    const enteringTerminal = isTerminalState(newState);
    let next: ExecutionWatcherSnapshot = {
      ...this.snapshot,
      currentState: newState,
      mostRecentCompletedAt: enteringTerminal ? Date.now() : undefined,
    };

    if (newState === "Paused" && !next.mostRecentPausedAt) {
      next = { ...next, mostRecentPausedAt: Date.now() };
    } else if (newState === "Running" && oldState === "Resuming") {
      next = { ...next, mostRecentResumedAt: Date.now(), mostRecentPausedAt: undefined };
    } else if (
      !isTerminalState(newState) &&
      newState !== "Paused" &&
      newState !== "Pausing" &&
      (oldState === "Paused" || oldState === "Resuming")
    ) {
      next = { ...next, mostRecentPausedAt: undefined };
    }

    this.snapshot = next;
    console.log(
      `[ExecutionWatcher ${this.snapshot.executionName}] WorkflowStateEvent: ${oldState} -> ${newState}`,
    );
    return { workflowState: { from: oldState, to: newState } };
  }

  private handleOperatorStatisticsUpdateEvent(
    event: Extract<TexeraWebSocketEvent, { type: "OperatorStatisticsUpdateEvent" }>,
  ): SnapshotDiff {
    const updated: Record<string, PerOperatorState> = { ...this.snapshot.perOperatorState };
    const perOperator: Record<string, { from?: PerOperatorState; to: PerOperatorState }> = {};
    for (const [opId, metrics] of Object.entries(event.operatorStatistics)) {
      const m = metrics as OperatorAggregatedMetrics;
      const next: PerOperatorState = {
        state: m.operatorState,
        inputTupleCount: Number(m.aggregatedInputRowCount ?? 0),
        outputTupleCount: Number(m.aggregatedOutputRowCount ?? 0),
        numWorkers: Number(m.numWorkers ?? 0),
      };
      const existing = updated[opId];
      if (
        !existing ||
        existing.state !== next.state ||
        existing.inputTupleCount !== next.inputTupleCount ||
        existing.outputTupleCount !== next.outputTupleCount ||
        existing.numWorkers !== next.numWorkers
      ) {
        perOperator[opId] = { from: existing, to: next };
      }
      updated[opId] = next;
    }
    this.snapshot = { ...this.snapshot, perOperatorState: updated };
    if (Object.keys(perOperator).length === 0) return {};
    return { perOperator };
  }

  private handleConsoleUpdateEvent(
    event: Extract<TexeraWebSocketEvent, { type: "ConsoleUpdateEvent" }>,
  ): SnapshotDiff {
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

    return { newConsoleMessages: [...event.messages] };
  }

  private handleWorkflowErrorEvent(
    event: Extract<TexeraWebSocketEvent, { type: "WorkflowErrorEvent" }>,
  ): SnapshotDiff {
    this.snapshot = {
      ...this.snapshot,
      fatalErrors: [...this.snapshot.fatalErrors, ...event.fatalErrors],
    };
    return { newFatalErrors: [...event.fatalErrors] };
  }

  // ─── Awaiter API ──────────────────────────────────────────────────────

  /**
   * Block until at least one wake rule fires, OR fast-path return if the
   * mailbox already has content. No timeout.
   *
   * Single-consumer rule: while one awaiter is registered, new events go
   * directly to it (bypass mailbox). If a second `await()` is called while
   * another is in flight, the prior awaiter is rejected — control tools
   * should not race each other on the same watcher.
   */
  await(abortSignal?: AbortSignal): Promise<AwaitResult> {
    if (abortSignal?.aborted) {
      return Promise.resolve({
        reason: "aborted",
        snapshot: this.getSnapshot(),
        diff: {},
        signals: [],
        contributingEvents: [],
        beforeSnapshot: this.getSnapshot(),
      });
    }

    // Fast-path: drain mailbox if non-empty.
    if (this.mailbox !== null) {
      const m = this.mailbox;
      this.mailbox = null;
      return Promise.resolve({
        reason: "events",
        snapshot: this.getSnapshot(),
        diff: m.diff,
        signals: m.signals,
        contributingEvents: m.contributingEvents,
        beforeSnapshot: m.beforeSnapshot,
      });
    }

    // No mailbox content. If the mailbox is sealed (terminal+drained), we
    // STILL block — engine may emit something interesting (e.g. a console
    // error during teardown). The seal only prevents prepareStep from
    // re-rendering stale terminal events.
    return new Promise<AwaitResult>(resolve => {
      // If a prior awaiter is somehow still registered, evict it.
      if (this.currentAwaiter) {
        const stale = this.currentAwaiter;
        this.currentAwaiter = null;
        if (stale.abortHandler && stale.abortSignal) {
          stale.abortSignal.removeEventListener("abort", stale.abortHandler);
        }
        stale.resolve({
          reason: "aborted",
          snapshot: this.getSnapshot(),
          diff: {},
          signals: [],
          contributingEvents: [],
          beforeSnapshot: this.getSnapshot(),
        });
      }

      const awaiter: PendingAwaiter = {
        resolve,
        abortHandler: null,
        abortSignal: abortSignal ?? null,
      };
      if (abortSignal) {
        awaiter.abortHandler = () => {
          if (this.currentAwaiter === awaiter) this.currentAwaiter = null;
          resolve({
            reason: "aborted",
            snapshot: this.getSnapshot(),
            diff: {},
            signals: [],
            contributingEvents: [],
            beforeSnapshot: this.getSnapshot(),
          });
        };
        abortSignal.addEventListener("abort", awaiter.abortHandler, { once: true });
      }
      this.currentAwaiter = awaiter;
    });
  }

  // ─── Mailbox API (used by prepareStep) ────────────────────────────────

  /** True iff there's nothing for prepareStep to surface right now. */
  isMailboxEmpty(): boolean {
    return this.mailbox === null;
  }

  /**
   * Peek at the mailbox without draining. Used by prepareStep gating logic
   * before deciding to render.
   */
  peekMailbox(): MailboxContents | null {
    return this.mailbox;
  }

  /**
   * Drain the mailbox. Returns the drained contents and clears.
   * If the snapshot is currently terminal, ALSO seals — subsequent events
   * (engine teardown chatter) will not re-fill the mailbox until the next
   * `markExecutionStarting()`.
   */
  drainMailbox(): MailboxContents | null {
    if (this.mailbox === null) {
      // Even if nothing to drain, seal at terminal so future stragglers
      // don't queue up and surface during the editing phase.
      if (snapshotIsTerminal(this.snapshot)) this.mailboxSealed = true;
      return null;
    }
    const m = this.mailbox;
    this.mailbox = null;
    if (snapshotIsTerminal(this.snapshot)) this.mailboxSealed = true;
    return m;
  }

  /**
   * Whether the watcher should currently surface events to the agent via
   * prepareStep. Editing-phase invariant: once a terminal execution has
   * been acknowledged (drained at least once with no new content), stop.
   */
  shouldSurfaceToPrepareStep(): boolean {
    if (this.mailbox === null) return false;
    if (this.mailboxSealed) return false;
    return true;
  }

  // ─── Correlated request/response ─────────────────────────────────────

  private findFirstPendingPythonEvalKey(expression: string): string | null {
    const suffix = `::${expression}`;
    for (const key of this.pendingPythonEval.keys()) {
      if (key.endsWith(suffix)) return key;
    }
    return null;
  }

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
   * Fire-and-forget: send a single pdb command into a Python UDF worker.
   *
   * No synchronous response — output arrives later as ConsoleUpdateEvent
   * with level=DEBUGGER from that worker. Callers (the `debugPython` tool)
   * poll `consoleMessagesByOperator` to capture the output.
   */
  sendDebugCommand(req: { operatorId: string; workerId: string; cmd: string }): void {
    this.wsClient.sendDebugCommandRequest(req);
  }

  /**
   * Send a modify-logic request. Resolves on `ModifyLogicResponse`:
   *
   *   - `isValid=false` → resolve with `{ isValid: false, applied: false }`.
   *   - `isValid=true`  → resolve with `{ isValid: true,  applied: true  }`.
   *
   * `applied: true` here means "queued and will be applied on resume" — the
   * actual engine apply happens in performReconfigurationOnResume. The
   * follow-up `ModifyLogicCompletedEvent` is informational only and no
   * longer gates this Promise (was the cause of the prior 30s timeout when
   * the worker couldn't reach a tuple boundary).
   *
   * Timeout still possible if the engine never even validates — rare.
   */
  requestModifyLogic(
    operatorPayload: { operatorID: string; operatorType: string; [k: string]: any },
    timeoutMs: number = 30_000,
  ): Promise<ModifyLogicResult> {
    const opId = operatorPayload.operatorID;
    const propsKeys = Object.keys(operatorPayload).filter(k => k !== "operatorID" && k !== "operatorType");
    console.log(
      `[ExecutionWatcher ${this.snapshot.executionName}] requestModifyLogic SEND (opId=${opId}, operatorType=${operatorPayload.operatorType}, propsKeys=[${propsKeys.join(", ")}], timeoutMs=${timeoutMs})`,
    );
    return new Promise<ModifyLogicResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pendingModifyLogic.get(opId);
        const queueDepth = queue?.length ?? 0;
        if (queue) {
          const idx = queue.findIndex(p => p === pending);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) this.pendingModifyLogic.delete(opId);
        }
        const snap = this.snapshot;
        const opState = snap.perOperatorState[opId]?.state ?? "(unknown)";
        // Post-merge model: ModifyLogicResponse alone resolves the Promise
        // (engine queues + applies on resume). A timeout means no response
        // arrived at all — engine never validated.
        console.log(
          `[ExecutionWatcher ${snap.executionName}] requestModifyLogic TIMEOUT (opId=${opId}) — workflow=${snap.currentState}, opState=${opState}, queueDepthAtTimeout=${queueDepth}, no ModifyLogicResponse received`,
        );
        reject(new Error(`liveModifyOperator timed out after ${timeoutMs}ms (opId=${opId}) — workflow=${snap.currentState}, opState=${opState}, no ModifyLogicResponse received`));
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

  retryWorkers(workers: string[]): void {
    this.wsClient.sendRetryRequest({ workers });
  }

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

  getSnapshot(): ExecutionWatcherSnapshot {
    return { ...this.snapshot, perOperatorState: { ...this.snapshot.perOperatorState } };
  }

  isAlive(): boolean {
    return isStateAlive(this.snapshot.currentState);
  }

  forgetOperators(operatorIds: Iterable<string>): void {
    const ids = new Set(operatorIds);
    if (ids.size === 0) return;
    const perOp = { ...this.snapshot.perOperatorState };
    const workers = { ...this.snapshot.workerIdsByOperator };
    const currentTuples = { ...this.snapshot.currentTuplesByOperator };
    const consoleByOp = { ...this.snapshot.consoleMessagesByOperator };
    for (const id of ids) {
      delete perOp[id];
      delete workers[id];
      delete currentTuples[id];
      delete consoleByOp[id];
    }
    this.snapshot = {
      ...this.snapshot,
      perOperatorState: perOp,
      workerIdsByOperator: workers,
      currentTuplesByOperator: currentTuples,
      consoleMessagesByOperator: consoleByOp,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  dispose(): void {
    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
    }
    if (this.currentAwaiter) {
      const a = this.currentAwaiter;
      this.currentAwaiter = null;
      if (a.abortHandler && a.abortSignal) {
        a.abortSignal.removeEventListener("abort", a.abortHandler);
      }
      a.resolve({
        reason: "aborted",
        snapshot: this.getSnapshot(),
        diff: {},
        signals: [],
        contributingEvents: [],
        beforeSnapshot: this.getSnapshot(),
      });
    }
    for (const [, p] of this.pendingPagination) p.reject(new Error("Watcher disposed"));
    this.pendingPagination.clear();
    for (const [, queue] of this.pendingPythonEval) {
      for (const p of queue) p.reject(new Error("Watcher disposed"));
    }
    this.pendingPythonEval.clear();
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
