/**
 * Phase 4 unit tests for the Active Execution section in assembleContext.
 *
 * Run: bun test src/agent/context-assembler.test.ts
 */

import { describe, expect, test } from "bun:test";
import { assembleContext } from "./context-assembler";
import { WorkflowState } from "../workflow/workflow-state";
import type { ExecutionWatcherSnapshot } from "./execution-watcher";
import type { ReActStep } from "../types/agent";

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
    pauseRequestedByAgent: false,
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

  // Note: per-operator delta annotations and "Since last wake" callouts have
  // been removed from # Active Execution. Diffs between agent steps are
  // surfaced via `[execution]` user-role messages drained from the watcher
  // mailbox; the # Active Execution section now shows the current snapshot
  // only. See execution-watcher.test.ts for diff/coalesce coverage.

  test("[execution] steps are filtered out when currentRenderedExecutionName is null (post-DAG-edit)", () => {
    const userStep: ReActStep = {
      id: "u1", parentId: undefined, messageId: "m1", stepId: 0, timestamp: 0,
      role: "user", content: "do the thing", isBegin: true, isEnd: true,
    };
    const execStep: ReActStep = {
      id: "e1", parentId: "u1", messageId: "m1", stepId: 1, timestamp: 0,
      role: "execution", content: "[execution] op2 paused", executionName: "exec-1",
      isBegin: false, isEnd: false,
    };
    const agentStep: ReActStep = {
      id: "a1", parentId: "e1", messageId: "m1", stepId: 2, timestamp: 0,
      role: "agent", content: "ok", isBegin: false, isEnd: true,
    };
    // currentRenderedExecutionName=null → execStep should be dropped.
    const msgs = assembleContext(
      [userStep, execStep, agentStep], emptyWorkflow(), new Map(), false, null, null,
      null,
    );
    const content = msgs[0].content as string;
    expect(content).not.toContain("op2 paused");
    expect(content).toContain("ok"); // agent step still there
  });

  test("[execution] steps from non-current executionName are filtered out", () => {
    const userStep: ReActStep = {
      id: "u1", parentId: undefined, messageId: "m1", stepId: 0, timestamp: 0,
      role: "user", content: "do the thing", isBegin: true, isEnd: true,
    };
    const oldExec: ReActStep = {
      id: "e1", parentId: "u1", messageId: "m1", stepId: 1, timestamp: 0,
      role: "execution", content: "[execution] OLD: op2 paused", executionName: "exec-1",
      isBegin: false, isEnd: false,
    };
    const newExec: ReActStep = {
      id: "e2", parentId: "e1", messageId: "m1", stepId: 2, timestamp: 0,
      role: "execution", content: "[execution] NEW: workflow completed", executionName: "exec-2",
      isBegin: false, isEnd: false,
    };
    const msgs = assembleContext(
      [userStep, oldExec, newExec], emptyWorkflow(), new Map(), false, null, null,
      "exec-2",
    );
    const content = msgs[0].content as string;
    expect(content).not.toContain("OLD: op2 paused");
    expect(content).toContain("NEW: workflow completed");
  });

  test("# Active Execution shows current per-operator snapshot only (no deltas)", () => {
    const snap = snapshotWithDefaults({
      currentState: "Running",
      perOperatorState: {
        op1: { state: "Running", inputTupleCount: 100, outputTupleCount: 32, numWorkers: 1 },
      },
    });
    const msgs = assembleContext([], emptyWorkflow(), new Map(), false, null, snap);
    const content = msgs[0].content as string;
    expect(content).toContain("op1: Running");
    expect(content).toContain("100 rows");
    expect(content).toContain("32 rows");
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
