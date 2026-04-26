/**
 * Unit tests for ws-execution-tools (Phase 3 verification, code-level).
 *
 * Mocks the watcher slot so we can verify each tool's pre-flight checks,
 * state transitions, and error formatting without a real engine.
 *
 * Run: bun test src/tools/ws-execution-tools.test.ts
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { createWsExecutionTools, type WatcherSlot } from "./ws-execution-tools";
import { WorkflowState } from "../workflow/workflow-state";
import type { ExecutionWatcher, ExecutionWatcherSnapshot, AwaitResult } from "../agent/execution-watcher";
import type { ExecutionConfig } from "./execution-tools";

// ─── Mock ExecutionWatcher ─────────────────────────────────────────────────

function makeMockSnapshot(overrides: Partial<ExecutionWatcherSnapshot> = {}): ExecutionWatcherSnapshot {
  return {
    executionName: "mock-exec",
    mostRecentStartedAt: Date.now(),
    currentState: "Running",
    perOperatorState: {},
    workerIdsByOperator: {},
    currentTuplesByOperator: {},
    recentConsoleMessages: [],
    consoleMessagesByOperator: {},
    recentConsoleErrors: [],
    fatalErrors: [],
    ...overrides,
  };
}

interface MockWatcher {
  watcher: ExecutionWatcher;
  pauseCalled: number;
  resumeCalled: number;
  killCalled: number;
  awaitCalled: number;
  paginationCalled: { operatorId: string; pageIndex: number; pageSize: number }[];
  debugCommandCalled: { operatorId: string; workerId: string; cmd: string }[];
  modifyLogicCalled: { operatorPayload: any }[];
  retryWorkersCalled: string[][];
  snapshot: ExecutionWatcherSnapshot;
  awaitResultOverride?: AwaitResult;
  debugCommandShouldThrow?: Error;
  /** When set, the mock pushes these messages into snapshot.consoleMessagesByOperator
   *  on the next sendDebugCommand call so the tool's poll-loop can find them. */
  debugCommandAppendOnSend?: { operatorId: string; messages: any[] };
  modifyLogicResultOverride?: { isValid: boolean; errorMessage: string; applied: boolean };
  modifyLogicShouldThrow?: Error;
}

function makeMockWatcher(snapshot: ExecutionWatcherSnapshot): MockWatcher {
  const m: MockWatcher = {
    watcher: null as any,
    pauseCalled: 0,
    resumeCalled: 0,
    killCalled: 0,
    awaitCalled: 0,
    paginationCalled: [],
    debugCommandCalled: [],
    modifyLogicCalled: [],
    retryWorkersCalled: [],
    snapshot,
  };
  m.watcher = {
    pause: () => {
      m.pauseCalled++;
    },
    resume: () => {
      m.resumeCalled++;
    },
    kill: () => {
      m.killCalled++;
    },
    isAlive: () => {
      const s = m.snapshot.currentState;
      return s !== "Completed" && s !== "Failed" && s !== "Killed" && s !== "Terminated";
    },
    getSnapshot: () => m.snapshot,
    await: async (timeoutMs: number) => {
      m.awaitCalled++;
      return (
        m.awaitResultOverride ?? {
          reason: "tick",
          elapsedSinceStartMs: 1234,
          elapsedSinceLastWakeMs: timeoutMs,
          snapshot: m.snapshot,
        }
      );
    },
    requestPaginatedResult: async (operatorId: string, pageIndex: number, pageSize: number) => {
      m.paginationCalled.push({ operatorId, pageIndex, pageSize });
      return {
        type: "PaginatedResultEvent" as const,
        requestID: "mock-id",
        operatorID: operatorId,
        pageIndex,
        table: [{ x: 1, y: "a" }, { x: 2, y: "b" }],
        schema: [
          { attributeName: "x", attributeType: "integer" },
          { attributeName: "y", attributeType: "string" },
        ],
      };
    },
    requestModifyLogic: async (operatorPayload: any) => {
      m.modifyLogicCalled.push({ operatorPayload });
      if (m.modifyLogicShouldThrow) throw m.modifyLogicShouldThrow;
      return m.modifyLogicResultOverride ?? { isValid: true, errorMessage: "", applied: true };
    },
    retryWorkers: (workers: string[]) => {
      m.retryWorkersCalled.push(workers);
    },
    sendDebugCommand: (req: { operatorId: string; workerId: string; cmd: string }) => {
      m.debugCommandCalled.push(req);
      if (m.debugCommandShouldThrow) throw m.debugCommandShouldThrow;
      if (m.debugCommandAppendOnSend) {
        const { operatorId, messages } = m.debugCommandAppendOnSend;
        const existing = m.snapshot.consoleMessagesByOperator[operatorId] ?? [];
        m.snapshot = {
          ...m.snapshot,
          consoleMessagesByOperator: {
            ...m.snapshot.consoleMessagesByOperator,
            [operatorId]: [...existing, ...messages],
          },
        };
      }
    },
    start: () => {},
    applyEvent: () => {},
    waitForSignificantEvent: async () => ({ reason: "tick" }),
    dispose: () => {},
  } as unknown as ExecutionWatcher;
  return m;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ws-execution-tools", () => {
  let workflowState: WorkflowState;
  let watcherRef: { current: ExecutionWatcher | null };
  let watcherSlot: WatcherSlot;
  let mockConfig: ExecutionConfig;

  beforeEach(() => {
    workflowState = new WorkflowState();
    watcherRef = { current: null };
    watcherSlot = {
      get: () => watcherRef.current,
      set: w => {
        watcherRef.current = w;
      },
    };
    mockConfig = {
      userToken: "fake-token",
      workflowId: 1,
      computingUnitId: 1,
    };
  });

  test("startExecution: rejects empty workflow", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.startExecution as any).execute({});
    expect(typeof result).toBe("string");
    expect(result).toContain("[ERROR]");
  });

  test("startExecution: rejects when watcher already alive", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Running" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.startExecution as any).execute({});
    expect(result).toContain("already in flight");
  });

  test("awaitExecution: errors when no watcher", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.awaitExecution as any).execute({ maxWaitSeconds: 5 });
    expect(result).toContain("No execution in flight");
  });

  test("awaitExecution: returns formatted snapshot from watcher.await", async () => {
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Running",
        perOperatorState: {
          op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 50, numWorkers: 1 },
        },
      }),
    );
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });

    const result = await (tools.awaitExecution as any).execute({ maxWaitSeconds: 5 });
    expect(result).toContain("Execution state: Running");
    expect(result).toContain("op1: Running (input: 100 rows, output: 50 rows)");
    expect(result).toContain("Returning because the wait timer expired with nothing notable happening");
    expect(mock.awaitCalled).toBe(1);
  });

  test("pauseExecution: errors when not Running", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.pauseExecution as any).execute({});
    expect(result).toContain("Cannot pause from state 'Paused'");
    expect(mock.pauseCalled).toBe(0);
  });

  test("pauseExecution: pauses when Running", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Running" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.pauseExecution as any).execute({});
    expect(result).toContain("Pause request sent");
    expect(mock.pauseCalled).toBe(1);
  });

  test("resumeExecution: errors when not Paused", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Running" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.resumeExecution as any).execute({});
    expect(result).toContain("Cannot resume from state 'Running'");
    expect(mock.resumeCalled).toBe(0);
  });

  test("resumeExecution: resumes when Paused", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.resumeExecution as any).execute({});
    expect(result).toContain("Resume request sent");
    expect(mock.resumeCalled).toBe(1);
  });

  test("killExecution: kills regardless of state", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Running" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.killExecution as any).execute({});
    expect(result).toContain("Kill request sent");
    expect(mock.killCalled).toBe(1);
  });

  test("liveModifyOperator: errors when no watcher", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.liveModifyOperator as any).execute({
      operatorId: "op1",
      properties: { code: "print(1)" },
    });
    expect(result).toContain("No execution in flight");
  });

  test("liveModifyOperator: errors when not paused", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Running" }));
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.liveModifyOperator as any).execute({
      operatorId: "op1",
      properties: { code: "print(1)" },
    });
    expect(result).toContain("requires a Paused execution");
    expect(mock.modifyLogicCalled.length).toBe(0);
  });

  test("liveModifyOperator: errors when operator missing from workflow state", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.liveModifyOperator as any).execute({
      operatorId: "ghost-op",
      properties: { code: "print(1)" },
    });
    expect(result).toContain("not found in the workflow");
    expect(mock.modifyLogicCalled.length).toBe(0);
  });

  test("liveModifyOperator: dispatches request, applies on success, updates local state", async () => {
    workflowState.addOperator({
      operatorID: "op1",
      operatorType: "PythonUDFV2",
      operatorVersion: "1",
      operatorProperties: { code: "old", workers: 1 },
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      isDisabled: false,
    } as any);
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.liveModifyOperator as any).execute({
      operatorId: "op1",
      properties: { code: "new" },
    });
    expect(mock.modifyLogicCalled.length).toBe(1);
    const payload = mock.modifyLogicCalled[0].operatorPayload;
    expect(payload.operatorID).toBe("op1");
    expect(payload.operatorType).toBe("PythonUDFV2");
    expect(payload.code).toBe("new");
    expect(payload.workers).toBe(1); // shallow-merged, preserved
    expect(result).toContain("logic queued (validated)");
    // local state updated
    expect(workflowState.getOperator("op1")!.operatorProperties.code).toBe("new");
  });

  test("liveModifyOperator: surfaces engine validation rejection without updating local state", async () => {
    workflowState.addOperator({
      operatorID: "op1",
      operatorType: "PythonUDFV2",
      operatorVersion: "1",
      operatorProperties: { code: "old" },
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      isDisabled: false,
    } as any);
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    mock.modifyLogicResultOverride = { isValid: false, errorMessage: "syntax error on line 3", applied: false };
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.liveModifyOperator as any).execute({
      operatorId: "op1",
      properties: { code: "broken" },
    });
    expect(result).toContain("Engine rejected");
    expect(result).toContain("syntax error on line 3");
    // local state NOT updated
    expect(workflowState.getOperator("op1")!.operatorProperties.code).toBe("old");
  });

  test("retryCurrentTuple: errors when no watcher", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.retryCurrentTuple as any).execute({ operatorId: "op1" });
    expect(result).toContain("No execution in flight");
  });

  test("retryCurrentTuple: errors when not paused", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Running" }));
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.retryCurrentTuple as any).execute({ operatorId: "op1" });
    expect(result).toContain("requires a Paused execution");
    expect(mock.retryWorkersCalled.length).toBe(0);
  });

  test("retryCurrentTuple: errors when no workers assigned", async () => {
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Paused",
        workerIdsByOperator: {},
      }),
    );
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.retryCurrentTuple as any).execute({ operatorId: "op1" });
    expect(result).toContain("No workers assigned");
    expect(mock.retryWorkersCalled.length).toBe(0);
  });

  test("retryCurrentTuple: sends retry to assigned workers", async () => {
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Paused",
        workerIdsByOperator: { op1: ["WF1-op1-main-0", "WF1-op1-main-1"] },
      }),
    );
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.retryCurrentTuple as any).execute({ operatorId: "op1" });
    expect(mock.retryWorkersCalled).toEqual([["WF1-op1-main-0", "WF1-op1-main-1"]]);
    expect(result).toContain("Retry request sent to 2 workers");
  });

  test("getConsoleLogs: errors when no watcher", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.getConsoleLogs as any).execute({ operatorId: "op1" });
    expect(result).toContain("No execution in flight");
  });

  test("getConsoleLogs: returns 'no messages' when buffer empty for operator", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.getConsoleLogs as any).execute({ operatorId: "op1" });
    expect(result).toContain("No console messages buffered");
  });

  test("getConsoleLogs: returns messages most recent first, respects limit + level filter", async () => {
    const mk = (level: "PRINT" | "ERROR", workerId: string, title: string, msg: string) => ({
      workerId,
      timestamp: { seconds: 0, nanos: 0 },
      msgType: { name: level } as { name: "PRINT" | "ERROR" },
      source: "test",
      title,
      message: msg,
    });
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Paused",
        consoleMessagesByOperator: {
          op1: [
            mk("PRINT", "WF1-op1-main-0", "", "msgA"),
            mk("ERROR", "WF1-op1-main-0", "KeyError", "missing 'foo'"),
            mk("PRINT", "WF1-op1-main-0", "", "msgC"),
          ],
        },
      }),
    );
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    // Default — all levels, limit 20, most recent first
    const all = await (tools.getConsoleLogs as any).execute({ operatorId: "op1" });
    const idxC = (all as string).indexOf("msgC");
    const idxA = (all as string).indexOf("msgA");
    expect(idxC).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(idxC); // most recent first → msgC appears before msgA

    // ERROR-only filter
    const errsOnly = await (tools.getConsoleLogs as any).execute({
      operatorId: "op1",
      levels: ["ERROR"],
    });
    expect(errsOnly).toContain("KeyError");
    expect(errsOnly).not.toContain("msgC");
    expect(errsOnly).not.toContain("msgA");
  });

  test("getOperatorResult: errors when no watcher", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.getOperatorResult as any).execute({
      operatorId: "op1",
      offset: 0,
      limit: 10,
    });
    expect(result).toContain("No execution in flight");
  });

  test("debugPython: errors when no watcher", async () => {
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.debugPython as any).execute({
      operatorId: "op1",
      workerId: "WF1-op1-main-0",
      cmd: "p tuple_",
    });
    expect(result).toContain("No execution in flight");
  });

  test("debugPython: works while workflow is Running (no Paused gate)", async () => {
    // The whole point of removing the Paused gate: workflow-level pause
    // would actually prevent the worker from progressing past the debug
    // command. The tool must accept Running and dispatch the command.
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Running",
        perOperatorState: {
          op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 50, numWorkers: 1 },
        },
      }),
    );
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.debugPython as any).execute({
      operatorId: "op1",
      workerId: "WF1-op1-main-0",
      cmd: "b 5",
    });
    expect(mock.debugCommandCalled).toEqual([
      { operatorId: "op1", workerId: "WF1-op1-main-0", cmd: "b 5" },
    ]);
    expect(result).not.toContain("requires a Paused execution");
  });

  test("debugPython: errors when operator unknown", async () => {
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Paused",
        perOperatorState: {
          opA: { state: "Paused", inputTupleCount: 0, outputTupleCount: 0, numWorkers: 1 },
        },
      }),
    );
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.debugPython as any).execute({
      operatorId: "missing-op",
      workerId: "WF1-missing-main-0",
      cmd: "p tuple_",
    });
    expect(result).toContain("not part of the active execution");
    expect(mock.debugCommandCalled.length).toBe(0);
  });

  test("debugPython: dispatches command and surfaces new DEBUGGER output", async () => {
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Paused",
        perOperatorState: {
          op1: { state: "Paused", inputTupleCount: 100, outputTupleCount: 50, numWorkers: 1 },
        },
        consoleMessagesByOperator: {},
      }),
    );
    mock.debugCommandAppendOnSend = {
      operatorId: "op1",
      messages: [
        {
          workerId: "WF1-op1-main-0",
          timestamp: { seconds: 0, nanos: 0 },
          msgType: { name: "DEBUGGER" },
          source: "pdb",
          title: "",
          message: "(Pdb) 42",
        },
      ],
    };
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.debugPython as any).execute({
      operatorId: "op1",
      workerId: "WF1-op1-main-0",
      cmd: "p len(self.cache)",
    });
    expect(mock.debugCommandCalled).toEqual([
      { operatorId: "op1", workerId: "WF1-op1-main-0", cmd: "p len(self.cache)" },
    ]);
    expect(result).toContain("(Pdb) 42");
  });

  test("debugPython: surfaces send errors", async () => {
    const mock = makeMockWatcher(
      makeMockSnapshot({
        currentState: "Paused",
        perOperatorState: {
          op1: { state: "Paused", inputTupleCount: 0, outputTupleCount: 0, numWorkers: 1 },
        },
      }),
    );
    mock.debugCommandShouldThrow = new Error("WebSocket closed");
    watcherRef.current = mock.watcher;
    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.debugPython as any).execute({
      operatorId: "op1",
      workerId: "WF1-op1-main-0",
      cmd: "n",
    });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("WebSocket closed");
  });

  test("getOperatorResult: fetches and formats rows", async () => {
    const mock = makeMockWatcher(makeMockSnapshot({ currentState: "Paused" }));
    watcherRef.current = mock.watcher;

    const tools = createWsExecutionTools({
      workflowState,
      watcherSlot,
      getExecutionConfig: () => mockConfig,
    });
    const result = await (tools.getOperatorResult as any).execute({
      operatorId: "op1",
      offset: 20,
      limit: 10,
    });
    expect(result).toContain("Operator op1");
    expect(result).toContain("Schema: x:integer, y:string");
    expect(result).toContain("Rows: 2");
    // pageIndex is 1-based on the wire (engine convention). offset=20, limit=10 → page 3.
    expect(mock.paginationCalled).toEqual([{ operatorId: "op1", pageIndex: 3, pageSize: 10 }]);
  });
});
