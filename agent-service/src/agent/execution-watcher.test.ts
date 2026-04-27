/**
 * Unit tests for ExecutionWatcher.
 *
 * Covers the new rule-based, single-consumer architecture:
 *   - Per-event SnapshotDiff computation
 *   - Mailbox structural coalescing + sealing
 *   - await() single-consumer routing (awaiter vs mailbox)
 *   - Wake rules (state milestones, console errors, fatal errors)
 *   - Correlated request/response (pagination, python eval, modify logic)
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { ExecutionWatcher, snapshotIsTerminal, snapshotWasFromCache } from "./execution-watcher";
import type { ExecutionWsClient } from "../api/execution-ws-client";
import type {
  ConsoleUpdateEvent,
  OperatorStatisticsUpdateEvent,
  PaginatedResultEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent,
} from "../types/execution-ws";

// ─── Mock WS client ──────────────────────────────────────────────────────

interface MockWsClient {
  client: ExecutionWsClient;
  emit: (event: any) => void;
  sent: any[];
}

function makeMockWsClient(): MockWsClient {
  let listener: ((evt: any) => void) | null = null;
  const sent: any[] = [];
  const client = {
    onEvent: (l: any) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    onClose: () => () => {},
    onError: () => () => {},
    send: (req: any) => {
      sent.push(req);
    },
    sendPauseRequest: () => sent.push({ type: "WorkflowPauseRequest" }),
    sendResumeRequest: () => sent.push({ type: "WorkflowResumeRequest" }),
    sendKillRequest: () => sent.push({ type: "WorkflowKillRequest" }),
    sendPaginationRequest: (req: any) => sent.push({ type: "ResultPaginationRequest", ...req }),
    sendPythonEvalRequest: (req: any) => sent.push({ type: "PythonExpressionEvaluateRequest", ...req }),
    sendModifyLogicRequest: (req: any) => sent.push({ type: "ModifyLogicRequest", ...req }),
    sendRetryRequest: (req: any) => sent.push({ type: "RetryRequest", ...req }),
    sendExecuteRequest: (req: any) => sent.push({ type: "WorkflowExecuteRequest", ...req }),
    isOpen: () => true,
    close: () => {},
    connect: async () => {},
  } as unknown as ExecutionWsClient;

  return {
    client,
    emit: (event: any) => listener?.(event),
    sent,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ExecutionWatcher", () => {
  let mockWs: MockWsClient;
  let watcher: ExecutionWatcher;

  beforeEach(() => {
    mockWs = makeMockWsClient();
    watcher = new ExecutionWatcher(mockWs.client, "test-execution");
    watcher.start();
    // Most tests exercise wake-rule firing, which requires the inExecution
    // gate to be open. The pre-execute behavior (silent snapshot mutation)
    // is covered explicitly in the "before markExecutionStarting" suite.
    watcher.markExecutionStarting();
  });

  // ─── Pre-execute (gate closed) behavior ────────────────────────────────

  test("before markExecutionStarting: snapshot mutates silently, mailbox stays empty", () => {
    const fresh = new ExecutionWatcher(mockWs.client, "fresh");
    fresh.start();
    // Don't call markExecutionStarting — gate is closed.
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" }); // would normally fire
    expect(fresh.getSnapshot().currentState).toBe("Completed"); // snapshot mutated
    expect(fresh.peekMailbox()).toBeNull(); // but no signal fired
  });

  // ─── Snapshot mutation ─────────────────────────────────────────────────

  test("initial snapshot reflects markExecutionStarting (Initializing, no operators)", () => {
    const s = watcher.getSnapshot();
    expect(s.currentState).toBe("Initializing");
    expect(s.perOperatorState).toEqual({});
    expect(snapshotIsTerminal(s)).toBe(false);
    expect(s.executionName).toBe("test-execution");
  });

  test("WorkflowStateEvent updates currentState", () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Running" } as WorkflowStateEvent);
    expect(watcher.getSnapshot().currentState).toBe("Running");
  });

  test("OperatorStatisticsUpdateEvent updates per-operator state", () => {
    const evt: OperatorStatisticsUpdateEvent = {
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: {
        op1: {
          operatorState: "Running",
          aggregatedInputRowCount: 100,
          aggregatedInputSize: 0,
          inputPortMetrics: {},
          aggregatedOutputRowCount: 80,
          aggregatedOutputSize: 0,
          outputPortMetrics: {},
          numWorkers: 1,
          aggregatedDataProcessingTime: 0,
          aggregatedControlProcessingTime: 0,
          aggregatedIdleTime: 0,
        },
      },
    };
    mockWs.emit(evt);
    expect(watcher.getSnapshot().perOperatorState.op1).toEqual({
      state: "Running",
      inputTupleCount: 100,
      outputTupleCount: 80,
      numWorkers: 1,
    });
  });

  // ─── Mailbox accumulation when no awaiter ─────────────────────────────

  test("WorkflowStateEvent → Paused fires state-paused rule into mailbox", () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Paused" });
    const m = watcher.peekMailbox();
    expect(m).not.toBeNull();
    expect(m!.diff.workflowState).toEqual({ from: "Initializing", to: "Paused" });
    expect(m!.signals.map(s => s.ruleId)).toContain("state-paused");
  });

  test("Console ERROR messages fire console-error rule into mailbox", () => {
    const consoleEvt: ConsoleUpdateEvent = {
      type: "ConsoleUpdateEvent",
      operatorId: "op1",
      messages: [
        { workerId: "w1", timestamp: { seconds: 0, nanos: 0 }, msgType: { name: "ERROR" }, source: "test", title: "boom", message: "boom message" },
        { workerId: "w1", timestamp: { seconds: 0, nanos: 0 }, msgType: { name: "PRINT" }, source: "test", title: "info", message: "info message" },
      ],
    };
    mockWs.emit(consoleEvt);
    const m = watcher.peekMailbox();
    expect(m).not.toBeNull();
    expect(m!.signals.map(s => s.ruleId)).toContain("console-error");
    expect(m!.diff.newConsoleMessages?.length).toBe(2);
    // Snapshot's recentConsoleErrors filtered down to ERROR-only.
    expect(watcher.getSnapshot().recentConsoleErrors).toHaveLength(1);
  });

  test("Running state does NOT fire any rule (mailbox stays empty)", () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Initializing" });
    mockWs.emit({ type: "WorkflowStateEvent", state: "Running" });
    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: { op1: { operatorState: "Running", aggregatedInputRowCount: 0, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 0, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 1, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 } },
    });
    expect(watcher.peekMailbox()).toBeNull();
    expect(watcher.isMailboxEmpty()).toBe(true);
  });

  // ─── Mailbox structural coalescing (no budget) ─────────────────────────

  test("workflowState coalesce when multiple signal-firing events stack between drains", () => {
    // Console errors arrive (signal-firing) at multiple workflow states.
    // The mailbox should accumulate the cumulative state transition.
    const errMsg = (msg: string) => ({
      workerId: "w1",
      timestamp: { seconds: 0, nanos: 0 },
      msgType: { name: "ERROR" as const },
      source: "test",
      title: "boom",
      message: msg,
    });
    mockWs.emit({ type: "WorkflowStateEvent", state: "Running" }); // silent
    mockWs.emit({ type: "ConsoleUpdateEvent", operatorId: "op1", messages: [errMsg("e1")] }); // signal: console-error
    mockWs.emit({ type: "WorkflowStateEvent", state: "Pausing" }); // silent
    mockWs.emit({ type: "WorkflowStateEvent", state: "Paused" }); // signal: state-paused
    const m = watcher.peekMailbox();
    expect(m).not.toBeNull();
    // Workflow-state coalesce: first `from` (when console-error fired,
    // state had just become Running), latest `to` (Paused).
    expect(m!.diff.workflowState?.to).toBe("Paused");
    // Console errors carried forward across the events.
    expect(m!.diff.newConsoleMessages?.length).toBe(1);
    // Both rules fired.
    expect(m!.signals.map(s => s.ruleId)).toContain("console-error");
    expect(m!.signals.map(s => s.ruleId)).toContain("state-paused");
  });

  test("console errors concat without cap (no truncation budget)", () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({
      workerId: "w1",
      timestamp: { seconds: 0, nanos: 0 },
      msgType: { name: "ERROR" as const },
      source: "test",
      title: `err ${i}`,
      message: `error #${i}`,
    }));
    // Send in batches of 10
    for (let i = 0; i < 25; i++) {
      mockWs.emit({
        type: "ConsoleUpdateEvent",
        operatorId: "op1",
        messages: messages.slice(i * 10, (i + 1) * 10),
      });
    }
    const m = watcher.peekMailbox();
    expect(m).not.toBeNull();
    expect(m!.diff.newConsoleMessages?.length).toBe(250);
    expect(m!.signals.filter(s => s.ruleId === "console-error").length).toBe(1); // dedupe by ruleId
  });

  test("operator stats updates are absorbed silently when no rule fires; snapshot reflects cumulative", () => {
    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: { op1: { operatorState: "Ready", aggregatedInputRowCount: 0, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 0, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 1, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 } },
    });
    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: { op1: { operatorState: "Running", aggregatedInputRowCount: 100, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 90, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 1, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 } },
    });
    // No rule fires on stats updates → mailbox stays empty.
    expect(watcher.peekMailbox()).toBeNull();
    // BUT the snapshot reflects the latest counts.
    expect(watcher.getSnapshot().perOperatorState.op1).toEqual({
      state: "Running",
      inputTupleCount: 100,
      outputTupleCount: 90,
      numWorkers: 1,
    });
  });

  // ─── await() routing ──────────────────────────────────────────────────

  test("await() fast-paths from non-empty mailbox", async () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Paused" });
    expect(watcher.peekMailbox()).not.toBeNull();
    const result = await watcher.await();
    expect(result.reason).toBe("events");
    expect(result.diff.workflowState?.to).toBe("Paused");
    expect(result.signals.map(s => s.ruleId)).toContain("state-paused");
    // Mailbox was drained.
    expect(watcher.peekMailbox()).toBeNull();
  });

  test("await() blocks until rule fires when mailbox empty (events bypass mailbox)", async () => {
    expect(watcher.peekMailbox()).toBeNull();
    const promise = watcher.await();
    // Event arrives while awaiter is registered → goes directly to awaiter.
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" });
    const result = await promise;
    expect(result.reason).toBe("events");
    expect(result.signals.map(s => s.ruleId)).toContain("state-completed");
    expect(result.snapshot.currentState).toBe("Completed");
    // Mailbox stayed empty (event went to awaiter, not mailbox).
    expect(watcher.peekMailbox()).toBeNull();
  });

  test("await() resolves on abort signal", async () => {
    const ctrl = new AbortController();
    const promise = watcher.await(ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    const result = await promise;
    expect(result.reason).toBe("aborted");
  });

  test("await() with pre-aborted signal returns immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await watcher.await(ctrl.signal);
    expect(result.reason).toBe("aborted");
  });

  test("await() does NOT fire on Running/Initializing (no rule for them)", async () => {
    let resolved = false;
    const p = watcher.await().then(r => {
      resolved = true;
      return r;
    });
    mockWs.emit({ type: "WorkflowStateEvent", state: "Initializing" });
    mockWs.emit({ type: "WorkflowStateEvent", state: "Running" });
    // Give the event loop a tick.
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);
    // Releasing path: emit Paused (a wake-firing transition).
    mockWs.emit({ type: "WorkflowStateEvent", state: "Paused" });
    const r = await p;
    expect(r.reason).toBe("events");
    expect(r.signals.map(s => s.ruleId)).toContain("state-paused");
  });

  // ─── Wake rules ───────────────────────────────────────────────────────

  test("Completed with CompletedFromCache fires 'completed-from-cache' (not 'completed')", async () => {
    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: {
        op1: { operatorState: "CompletedFromCache", aggregatedInputRowCount: 0, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 120, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 0, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 },
      },
    });
    const promise = watcher.await();
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" });
    const result = await promise;
    expect(result.signals.map(s => s.ruleId)).toContain("state-completed-from-cache");
    expect(result.signals.map(s => s.ruleId)).not.toContain("state-completed");
    expect(snapshotWasFromCache(watcher.getSnapshot())).toBe(true);
  });

  test("Completed without FromCache fires 'completed'", async () => {
    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: {
        op1: { operatorState: "Completed", aggregatedInputRowCount: 0, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 120, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 1, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 },
      },
    });
    const promise = watcher.await();
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" });
    const result = await promise;
    expect(result.signals.map(s => s.ruleId)).toContain("state-completed");
    expect(snapshotWasFromCache(watcher.getSnapshot())).toBe(false);
  });

  test("operator-auto-paused fires when single op goes Paused while workflow Running (EXCEPTION_PAUSE)", async () => {
    // Workflow is Running; engine emits per-op stats showing op2 paused on
    // exception. This is the EXCEPTION_PAUSE shape — workflow as a whole is
    // not Paused/Pausing.
    mockWs.emit({ type: "WorkflowStateEvent", state: "Running" });
    expect(watcher.peekMailbox()).toBeNull(); // Running alone fires no rule

    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: {
        op2: { operatorState: "Paused", aggregatedInputRowCount: 1, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 0, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 1, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 },
      },
    });
    const result = await watcher.await();
    expect(result.signals.map(s => s.ruleId)).toContain("operator-auto-paused");
    expect(result.signals.find(s => s.ruleId === "operator-auto-paused")!.summary).toContain("op2");
  });

  test("operator-auto-paused does NOT fire when workflow itself is Paused (regular pause)", async () => {
    // Agent-requested pause: workflow goes Paused, ops follow. This is NOT
    // an EXCEPTION_PAUSE.
    mockWs.emit({ type: "WorkflowStateEvent", state: "Paused" }); // fires state-paused
    watcher.drainMailbox();
    mockWs.emit({
      type: "OperatorStatisticsUpdateEvent",
      operatorStatistics: {
        op2: { operatorState: "Paused", aggregatedInputRowCount: 1, aggregatedInputSize: 0, inputPortMetrics: {}, aggregatedOutputRowCount: 0, aggregatedOutputSize: 0, outputPortMetrics: {}, numWorkers: 1, aggregatedDataProcessingTime: 0, aggregatedControlProcessingTime: 0, aggregatedIdleTime: 0 },
      },
    });
    expect(watcher.peekMailbox()).toBeNull(); // gated out — workflow is Paused
  });

  test("Killed/Terminated fires 'state-killed'", async () => {
    const promise = watcher.await();
    mockWs.emit({ type: "WorkflowStateEvent", state: "Killed" });
    const result = await promise;
    expect(result.signals.map(s => s.ruleId)).toContain("state-killed");
  });

  test("Failed: state-only event silently absorbed; signal fires when fatal error follows", async () => {
    // FE pattern: WorkflowStateEvent("Failed") arrives first (no fatal errors
    // populated yet), then WorkflowErrorEvent. The state-failed rule waits
    // for fatal errors before firing — state alone is not surfaced.
    mockWs.emit({ type: "WorkflowStateEvent", state: "Failed" });
    expect(watcher.peekMailbox()).toBeNull(); // silently absorbed
    expect(watcher.getSnapshot().currentState).toBe("Failed");

    const errEvt: WorkflowErrorEvent = {
      type: "WorkflowErrorEvent",
      fatalErrors: [{ type: "EXECUTION_FAILURE", message: "boom", details: "stack", operatorId: "op1" }],
    };
    mockWs.emit(errEvt);

    const result = await watcher.await();
    expect(result.signals.map(s => s.ruleId)).toContain("state-failed");
    expect(watcher.getSnapshot().fatalErrors).toHaveLength(1);
  });

  // ─── Mailbox sealing ──────────────────────────────────────────────────

  test("draining at terminal state seals the mailbox", async () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" });
    expect(watcher.peekMailbox()).not.toBeNull();
    watcher.drainMailbox();
    expect(watcher.peekMailbox()).toBeNull();
    // A late console error should NOT re-fill the mailbox.
    mockWs.emit({
      type: "ConsoleUpdateEvent",
      operatorId: "op1",
      messages: [{ workerId: "w1", timestamp: { seconds: 0, nanos: 0 }, msgType: { name: "ERROR" }, source: "test", title: "late", message: "after seal" }],
    });
    expect(watcher.peekMailbox()).toBeNull();
    expect(watcher.shouldSurfaceToPrepareStep()).toBe(false);
  });

  test("draining empty mailbox at terminal state still seals", () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Killed" });
    watcher.drainMailbox();
    // Ensure sealed even if there's nothing to drain.
    mockWs.emit({
      type: "ConsoleUpdateEvent",
      operatorId: "op1",
      messages: [{ workerId: "w1", timestamp: { seconds: 0, nanos: 0 }, msgType: { name: "ERROR" }, source: "test", title: "x", message: "y" }],
    });
    // Even though we didn't drain, the post-Killed drain attempt seals.
    watcher.drainMailbox(); // First drain holds the sealed flag.
    expect(watcher.shouldSurfaceToPrepareStep()).toBe(false);
  });

  test("markExecutionStarting clears seal", () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" });
    watcher.drainMailbox();
    expect(watcher.shouldSurfaceToPrepareStep()).toBe(false);

    watcher.markExecutionStarting();
    // Seal cleared — new events should accumulate.
    mockWs.emit({ type: "WorkflowStateEvent", state: "Paused" });
    expect(watcher.peekMailbox()).not.toBeNull();
    expect(watcher.shouldSurfaceToPrepareStep()).toBe(true);
  });

  test("markExecutionStarting clobbers stale prior-run snapshot fields", () => {
    mockWs.emit({ type: "WorkflowStateEvent", state: "Completed" });
    expect(snapshotIsTerminal(watcher.getSnapshot())).toBe(true);

    watcher.markExecutionStarting();
    const s = watcher.getSnapshot();
    expect(s.currentState).toBe("Initializing");
    expect(snapshotIsTerminal(s)).toBe(false);
    expect(s.mostRecentCompletedAt).toBeUndefined();
    expect(snapshotWasFromCache(s)).toBe(false);
    expect(s.perOperatorState).toEqual({});
  });

  // ─── Control + correlated request/response (preserved from prior design) ─

  test("pause/resume/kill send the right requests", () => {
    watcher.pause();
    expect(mockWs.sent.at(-1)).toEqual({ type: "WorkflowPauseRequest" });
    watcher.resume();
    expect(mockWs.sent.at(-1)).toEqual({ type: "WorkflowResumeRequest" });
    watcher.kill();
    expect(mockWs.sent.at(-1)).toEqual({ type: "WorkflowKillRequest" });
  });

  test("requestPaginatedResult: resolves on matching response", async () => {
    const promise = watcher.requestPaginatedResult("op1", 0, 50);
    const sentReq = mockWs.sent[0];
    expect(sentReq.type).toBe("ResultPaginationRequest");

    const responseEvent: PaginatedResultEvent = {
      type: "PaginatedResultEvent",
      requestID: sentReq.requestID,
      operatorID: "op1",
      pageIndex: 0,
      table: [{ x: 1 }, { x: 2 }],
      schema: [{ attributeName: "x", attributeType: "integer" }],
    };
    mockWs.emit(responseEvent);
    const result = await promise;
    expect(result.table).toHaveLength(2);
  });

  test("requestPaginatedResult: ignores non-matching response", async () => {
    const promise = watcher.requestPaginatedResult("op1", 0, 50, 200);
    mockWs.emit({
      type: "PaginatedResultEvent",
      requestID: "wrong-id",
      operatorID: "op1",
      pageIndex: 0,
      table: [],
      schema: [],
    });
    let timedOut = false;
    try {
      await promise;
    } catch (e) {
      timedOut = true;
      expect((e as Error).message).toContain("timed out");
    }
    expect(timedOut).toBe(true);
  });

  test("dispose resolves outstanding awaiter and rejects pending pagination", async () => {
    const awaitPromise = watcher.await();
    const pagPromise = watcher.requestPaginatedResult("op1", 0, 50, 30_000);
    let pagRejected = false;
    pagPromise.catch(() => {
      pagRejected = true;
    });
    watcher.dispose();
    const result = await awaitPromise;
    expect(result.reason).toBe("aborted");
    await new Promise(r => setTimeout(r, 10));
    expect(pagRejected).toBe(true);
  });

  test("requestPythonEval: dispatches request and resolves on matching response", async () => {
    const promise = watcher.requestPythonEval("op1", "len(self.cache)");
    expect(mockWs.sent).toEqual([
      { type: "PythonExpressionEvaluateRequest", expression: "len(self.cache)", operatorId: "op1" },
    ]);
    mockWs.emit({
      type: "PythonExpressionEvaluateResponse",
      expression: "len(self.cache)",
      values: [
        { value: { expression: "len(self.cache)", valueRef: "r1", valueStr: "7", valueType: "int", expandable: false }, attributes: [] },
      ],
    });
    const result = await promise;
    expect(result.values[0].value.valueStr).toBe("7");
  });

  test("requestPythonEval: timeout rejects", async () => {
    const promise = watcher.requestPythonEval("op1", "slow()", 50);
    let rejected = false;
    promise.catch(() => {
      rejected = true;
    });
    await new Promise(r => setTimeout(r, 100));
    expect(rejected).toBe(true);
  });

  test("requestModifyLogic: resolves on Response(valid) + Completed", async () => {
    const promise = watcher.requestModifyLogic({ operatorID: "op1", operatorType: "PythonUDFV2", code: "new" });
    mockWs.emit({ type: "ModifyLogicResponse", opId: "op1", isValid: true, errorMessage: "" });
    mockWs.emit({ type: "ModifyLogicCompletedEvent", opIds: ["op1"] });
    const result = await promise;
    expect(result.isValid).toBe(true);
    expect(result.applied).toBe(true);
  });

  test("requestModifyLogic: resolves with isValid=false on rejection", async () => {
    const promise = watcher.requestModifyLogic({ operatorID: "op1", operatorType: "PythonUDFV2", code: "broken" });
    mockWs.emit({ type: "ModifyLogicResponse", opId: "op1", isValid: false, errorMessage: "syntax error" });
    const result = await promise;
    expect(result.isValid).toBe(false);
    expect(result.applied).toBe(false);
  });

  test("retryWorkers: sends RetryRequest", () => {
    watcher.retryWorkers(["w1", "w2"]);
    expect(mockWs.sent).toEqual([{ type: "RetryRequest", workers: ["w1", "w2"] }]);
  });

  test("ConsoleUpdateEvent populates per-operator buffer", () => {
    mockWs.emit({
      type: "ConsoleUpdateEvent",
      operatorId: "op1",
      messages: [{ workerId: "WF1-op1-main-0", timestamp: { seconds: 0, nanos: 0 }, msgType: { name: "PRINT" }, source: "test", title: "", message: "hello" }],
    });
    const s = watcher.getSnapshot();
    expect(s.consoleMessagesByOperator.op1.length).toBe(1);
    expect(s.consoleMessagesByOperator.op1[0].message).toBe("hello");
    expect(s.recentConsoleMessages.length).toBe(1);
  });
});
