/**
 * Phase 4 unit tests for the Active Execution section in assembleContext.
 *
 * Run: bun test src/agent/context-assembler.test.ts
 */

import { describe, expect, test } from "bun:test";
import { assembleContext } from "./context-assembler";
import { WorkflowState } from "../workflow/workflow-state";
import type { ExecutionWatcherSnapshot } from "./execution-watcher";

function emptyWorkflow(): WorkflowState {
  return new WorkflowState();
}

function snapshotWithDefaults(over: Partial<ExecutionWatcherSnapshot> = {}): ExecutionWatcherSnapshot {
  return {
    executionName: "test",
    mostRecentStartedAt: Date.now() - 30_000, // 30s ago
    currentState: "Running",
    perOperatorState: {},
    workerIdsByOperator: {},
    currentTuplesByOperator: {},
    recentConsoleMessages: [],
    consoleMessagesByOperator: {},
    recentConsoleErrors: [],
    fatalErrors: [],
    ...over,
  };
}

describe("assembleContext: Active Execution section", () => {
  test("absent when no executionSnapshot provided", () => {
    const msgs = assembleContext([], emptyWorkflow(), new Map());
    const content = (msgs[0].content as string) ?? "";
    expect(content).not.toContain("# Active Execution");
  });

  test("absent when executionSnapshot is null", () => {
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, null);
    const content = (msgs[0].content as string) ?? "";
    expect(content).not.toContain("# Active Execution");
  });

  test("Running state shows status + elapsed + actions hint", () => {
    const snap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 50, numWorkers: 1 },
        op2: { state: "Ready", inputTupleCount: 0, outputTupleCount: 0, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap);
    const content = msgs[0].content as string;
    expect(content).toContain("# Active Execution");
    expect(content).toContain("Status: Running");
    expect(content).toContain("started ");
    expect(content).toContain("op1: Running (input: 100 rows, output: 50 rows, workers: 1)");
    expect(content).toContain("op2: Ready (input: 0 rows, output: 0 rows, workers: 1)");
    // Hint should be conversational, not list tool names verbatim
    expect(content).toContain("The workflow is in progress");
    expect(content).not.toContain("awaitExecution()");
    expect(content).not.toContain("pauseExecution()");
  });

  test("Paused state shows pause-specific actions", () => {
    const snap = snapshotWithDefaults({
      currentState: "Paused",
      mostRecentPausedAt: Date.now() - 5_000, // 5s ago
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap);
    const content = msgs[0].content as string;
    expect(content).toContain("Status: Paused");
    expect(content).toContain("paused ");
    expect(content).toContain("Execution is held");
    expect(content).not.toContain("getOperatorResult(");
    expect(content).not.toContain("resumeExecution()");
  });

  test("Completed state shows completed-specific actions", () => {
    const snap = snapshotWithDefaults({
      currentState: "Completed",
      mostRecentCompletedAt: Date.now() - 1_000,
      perOperatorState: {
        op1: { state: "Completed", inputTupleCount: 100, outputTupleCount: 100, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap);
    const content = msgs[0].content as string;
    expect(content).toContain("Status: Completed");
    expect(content).toContain("finished ");
    expect(content).toContain("Done.");
    expect(content).not.toContain("startExecution()");
  });

  test("Console errors appear in section", () => {
    const snap = snapshotWithDefaults({
      currentState: "Running",
      recentConsoleErrors: [
        {
          workerId: "WF1-op1-main-0",
          timestamp: { seconds: 0, nanos: 0 },
          msgType: { name: "ERROR" },
          source: "test",
          title: "KeyError",
          message: "KeyError: 'foo'",
        },
      ],
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap);
    const content = msgs[0].content as string;
    expect(content).toContain("Recent console errors");
    expect(content).toContain("WF1-op1-main-0");
    expect(content).toContain("KeyError");
  });

  test("Fatal errors appear in section", () => {
    const snap = snapshotWithDefaults({
      currentState: "Failed",
      fatalErrors: [
        {
          type: "EXECUTION_FAILURE",
          message: "Schema propagation failed",
          operatorId: "op1",
        },
      ],
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap);
    const content = msgs[0].content as string;
    expect(content).toContain("Fatal errors");
    expect(content).toContain("EXECUTION_FAILURE");
    expect(content).toContain("Schema propagation failed");
    expect(content).toContain("op=op1");
  });

  test("delta: throughput annotation when output grew since last wake", () => {
    const now = Date.now();
    const prevSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 20, numWorkers: 1 },
      },
    });
    const curSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 32, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, curSnap, {
      snapshot: prevSnap,
      atMs: now - 15_000, // 15s ago
    });
    const content = msgs[0].content as string;
    expect(content).toContain("+12 rows in last 15s");
    expect(content).toContain("rows/sec");
    expect(content).not.toContain("no progress");
  });

  test("delta: ETA annotation when input has stopped growing and there's backlog", () => {
    const now = Date.now();
    const prevSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 1000, outputTupleCount: 200, numWorkers: 1 },
      },
    });
    const curSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 1000, outputTupleCount: 300, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, curSnap, {
      snapshot: prevSnap,
      atMs: now - 10_000,
    });
    const content = msgs[0].content as string;
    expect(content).toContain("rows/sec");
    expect(content).toContain("ETA ~");
    expect(content).toContain("to finish current input");
  });

  test("delta: ETA annotation framed as 'drain current backlog' when input still growing", () => {
    const now = Date.now();
    const prevSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 800, outputTupleCount: 200, numWorkers: 1 },
      },
    });
    const curSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 1000, outputTupleCount: 300, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, curSnap, {
      snapshot: prevSnap,
      atMs: now - 10_000,
    });
    const content = msgs[0].content as string;
    expect(content).toContain("drain current backlog");
    expect(content).toContain("input still growing");
  });

  test("delta: 'no progress in last Xs' annotation when output frozen during Running", () => {
    const now = Date.now();
    const prevSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 32, numWorkers: 1 },
      },
    });
    const curSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 32, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, curSnap, {
      snapshot: prevSnap,
      atMs: now - 30_000,
    });
    const content = msgs[0].content as string;
    expect(content).toContain("no progress in last 30s");
  });

  test("delta: state transition annotation overrides throughput", () => {
    const now = Date.now();
    const prevSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 50, numWorkers: 1 },
      },
    });
    const curSnap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Completed", inputTupleCount: 100, outputTupleCount: 100, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, curSnap, {
      snapshot: prevSnap,
      atMs: now - 5_000,
    });
    const content = msgs[0].content as string;
    expect(content).toContain("transitioned Running → Completed");
  });

  test("'Since last wake:' callout when fatal/console errors are new", () => {
    const now = Date.now();
    const prevSnap = snapshotWithDefaults({
      currentState: "Running",
      fatalErrors: [],
      recentConsoleErrors: [],
    });
    const curSnap = snapshotWithDefaults({
      currentState: "Running",
      fatalErrors: [{ type: "EXEC", message: "boom", operatorId: "op1" }],
      recentConsoleErrors: [
        {
          workerId: "w1",
          timestamp: { seconds: 0, nanos: 0 },
          msgType: { name: "ERROR" },
          source: "test",
          title: "KeyError",
          message: "KeyError: 'foo'",
        },
      ],
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, curSnap, {
      snapshot: prevSnap,
      atMs: now - 5_000,
    });
    const content = msgs[0].content as string;
    expect(content).toContain("Since last wake:");
    expect(content).toContain("1 new fatal error");
    expect(content).toContain("1 new console error");
  });

  test("no 'Since last wake:' callout when nothing new", () => {
    const now = Date.now();
    const sameSnap = snapshotWithDefaults({ currentState: "Running" });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, sameSnap, {
      snapshot: sameSnap,
      atMs: now - 5_000,
    });
    const content = msgs[0].content as string;
    expect(content).not.toContain("Since last wake:");
  });

  test("no delta annotations when no prev snapshot (first wake)", () => {
    const snap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 32, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap, null);
    const content = msgs[0].content as string;
    expect(content).toContain("op1: Running");
    expect(content).not.toContain("rows/sec");
    expect(content).not.toContain("no progress");
    expect(content).not.toContain("Since last wake:");
  });

  test("section is placed BEFORE # Current Workflow", () => {
    const snap = snapshotWithDefaults({ currentState: "Running" });
    // Add an operator so there's a Current Workflow section
    const ws = new WorkflowState();
    ws.addOperator({
      operatorID: "op1",
      operatorType: "PythonUDF",
      operatorVersion: "1",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [{ portID: "output-0", displayName: "", allowMultiInputs: false, isDynamicPort: false }],
      showAdvanced: false,
      isDisabled: false,
    } as any);

    const msgs = assembleContext([], ws, new Map(), false, null, snap);
    const content = msgs[0].content as string;
    const activeIdx = content.indexOf("# Active Execution");
    const workflowIdx = content.indexOf("# Current Workflow");
    expect(activeIdx).toBeGreaterThan(-1);
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(workflowIdx);
  });
});
