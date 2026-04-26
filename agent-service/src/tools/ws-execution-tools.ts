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
 * WS-based execution tools.
 *
 * Replaces the sync-HTTP `executeOperator` tool with six decomposed
 * tools that share a long-lived ExecutionWatcher + WS subscription:
 *
 *   - startExecution
 *   - awaitExecution
 *   - pauseExecution
 *   - resumeExecution
 *   - killExecution
 *   - getOperatorResult
 *
 * The agent's TexeraAgent class owns the ExecutionWatcher slot. Tools
 * receive accessors (getWatcher, setWatcher) so they can read/mutate it.
 */

import { tool } from "ai";
import { z } from "zod";

import { ExecutionWsClient } from "../api/execution-ws-client";
import {
  ExecutionWatcher,
  snapshotWasFromCache,
  type AwaitResult,
  type ExecutionWatcherSnapshot,
} from "../agent/execution-watcher";
import { getConsoleMessageType, type ConsoleMessage } from "../types/execution-ws";
import { getBackendConfig } from "../api/backend-api";
import type { WorkflowState as AgentWorkflowState } from "../workflow/workflow-state";
import type { LogicalPlan } from "../api/execution-api";
import { buildLogicalPlan, validateWorkflow, type ExecutionConfig } from "./execution-tools";
import { createErrorResult, createToolResult } from "./tools-utility";

// ─── Tool name constants ──────────────────────────────────────────────────

export const TOOL_NAME_START_EXECUTION = "startExecution";
export const TOOL_NAME_AWAIT_EXECUTION = "awaitExecution";
export const TOOL_NAME_PAUSE_EXECUTION = "pauseExecution";
export const TOOL_NAME_RESUME_EXECUTION = "resumeExecution";
export const TOOL_NAME_KILL_EXECUTION = "killExecution";
export const TOOL_NAME_GET_OPERATOR_RESULT = "getOperatorResult";
export const TOOL_NAME_DEBUG_PYTHON = "debugPython";
export const TOOL_NAME_LIVE_MODIFY_OPERATOR = "liveModifyOperator";
export const TOOL_NAME_RETRY_CURRENT_TUPLE = "retryCurrentTuple";
export const TOOL_NAME_GET_CONSOLE_LOGS = "getConsoleLogs";

// ─── Watcher accessor contract ────────────────────────────────────────────

export interface WatcherSlot {
  get(): ExecutionWatcher | null;
  set(w: ExecutionWatcher | null): void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildWsUrl(): string {
  const cfg = getBackendConfig();
  // wsEndpoint is e.g. "ws://localhost:8085" — append the WS path.
  const base = cfg.wsEndpoint.replace(/\/$/, "");
  return `${base}/wsapi/workflow-websocket`;
}

/**
 * Translate the internal `SignificantEventReason` enum to a natural-language
 * sentence the LLM can surface to the user without sounding like internal
 * jargon.
 */
function naturalWakeReason(
  reason: AwaitResult["reason"],
  fromCache: boolean,
): string {
  if (reason === "completed" && fromCache) {
    return "the workflow completed by returning cached results without re-running operators";
  }
  switch (reason) {
    case "tick":
      return "the wait timer expired with nothing notable happening";
    case "paused":
      return "the workflow paused";
    case "resumed":
      return "the workflow resumed";
    case "completed":
      return "the workflow completed";
    case "completed-from-cache":
      return "the workflow completed by returning cached results without re-running operators";
    case "failed":
      return "the workflow failed";
    case "killed":
      return "the workflow was killed";
    case "console-error":
      return "a worker logged an error to the console";
    case "aborted":
      return "the wait was aborted";
    default:
      return String(reason);
  }
}

function formatSnapshot(s: ExecutionWatcherSnapshot, awaitResult?: AwaitResult): string {
  const lines: string[] = [];
  const fromCache = snapshotWasFromCache(s);
  // When cache-served, surface that distinction in the state line itself.
  if (fromCache) {
    lines.push(`Execution state: Completed (from cache — engine returned cached results without re-running operators)`);
  } else {
    lines.push(`Execution state: ${s.currentState}`);
  }

  if (awaitResult) {
    lines.push(`Returning because ${naturalWakeReason(awaitResult.reason, fromCache)}.`);
    lines.push(`Elapsed since execution started: ${formatMs(awaitResult.elapsedSinceStartMs)}.`);
    lines.push(`Elapsed since last wake: ${formatMs(awaitResult.elapsedSinceLastWakeMs)}.`);
  }

  if (s.currentState === "Paused" && s.mostRecentPausedAt) {
    lines.push(`Paused ${formatMs(Date.now() - s.mostRecentPausedAt)} ago.`);
  }

  // Per-operator state
  const ops = Object.entries(s.perOperatorState);
  if (ops.length > 0) {
    lines.push("");
    lines.push("Per-operator state:");
    for (const [opId, st] of ops) {
      lines.push(`  - ${opId}: ${st.state} (input: ${st.inputTupleCount} rows, output: ${st.outputTupleCount} rows)`);
    }
  }

  // Recent console errors (just last few)
  if (s.recentConsoleErrors.length > 0) {
    lines.push("");
    lines.push(`Recent console errors (${s.recentConsoleErrors.length}):`);
    const showCount = Math.min(s.recentConsoleErrors.length, 3);
    for (let i = s.recentConsoleErrors.length - showCount; i < s.recentConsoleErrors.length; i++) {
      const e = s.recentConsoleErrors[i];
      lines.push(`  - [${e.workerId}] ${e.title}: ${e.message.slice(0, 200)}`);
    }
  }

  // Fatal errors
  if (s.fatalErrors.length > 0) {
    lines.push("");
    lines.push(`Fatal errors (${s.fatalErrors.length}):`);
    for (const err of s.fatalErrors.slice(0, 3)) {
      lines.push(`  - ${err.type}: ${err.message}`);
    }
  }

  return lines.join("\n");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m${remSec}s`;
}

function formatPaginatedRows(table: any[], schema: { attributeName: string; attributeType: string }[]): string {
  if (table.length === 0) return "(no rows)";
  const headers = schema.map(s => s.attributeName);
  const lines: string[] = [];
  lines.push(`Schema: ${schema.map(s => `${s.attributeName}:${s.attributeType}`).join(", ")}`);
  lines.push(`Rows: ${table.length}`);
  lines.push("");
  // Compact single-line per row
  for (const row of table) {
    const vals = headers.map(h => {
      const v = row[h];
      const s = v === null || v === undefined ? "null" : typeof v === "string" ? v : JSON.stringify(v);
      return s.length > 80 ? s.slice(0, 77) + "..." : s;
    });
    lines.push(vals.join(" | "));
  }
  return lines.join("\n");
}

// ─── Tool factory ─────────────────────────────────────────────────────────

export interface CreateWsExecutionToolsOptions {
  workflowState: AgentWorkflowState;
  watcherSlot: WatcherSlot;
  /** Returns the current execution config (token, workflow id, etc.). */
  getExecutionConfig: () => ExecutionConfig;
  /** Optional: agent's abort signal for the current message. */
  getAbortSignal?: () => AbortSignal | undefined;
  /** Called after a successful `getOperatorResult` so the store reflects
   *  what the agent has fetched — keeps `# Current Workflow` rendering in
   *  sync with WS-era result fetches (parallel to the post-step hook for
   *  add/modify operators). Receives the operatorId and a synthesized
   *  OperatorInfo built from the PaginatedResultEvent. */
  onOperatorResult?: (
    operatorId: string,
    operatorInfo: {
      state: string;
      inputTuples: number;
      outputTuples: number;
      resultMode: string;
      result: Record<string, any>[];
      totalRowCount?: number;
      displayedRows?: number;
      truncated?: boolean;
    },
  ) => void;
}

export function createWsExecutionTools(opts: CreateWsExecutionToolsOptions) {
  const { workflowState, watcherSlot, getExecutionConfig, getAbortSignal, onOperatorResult } = opts;

  // ── startExecution ──
  const startExecution = tool({
    description:
      "Start executing the workflow. Returns immediately once the engine has accepted the request. " +
      "The execution runs in the background; use `awaitExecution` to wait for state changes, " +
      "`getOperatorResult` to fetch results, `pauseExecution`/`resumeExecution` to control. " +
      "Only one execution can be in-flight per agent at a time.",
    inputSchema: z.object({
      targetOperatorIds: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of operator IDs to focus the execution on. If provided, the engine will " +
            "only run the sub-DAG required to compute these operators' outputs. If omitted, " +
            "executes the entire workflow.",
        ),
    }),
    execute: async ({ targetOperatorIds }) => {
      try {
        if (watcherSlot.get() && watcherSlot.get()!.isAlive()) {
          return createErrorResult(
            "An execution is already in flight. Use `awaitExecution` to wait for it, or `killExecution` to abort it before starting another.",
          );
        }

        // Validate workflow
        const validation = validateWorkflow(workflowState);
        if (!validation.isValid) {
          const lines = ["Workflow validation failed:"];
          for (const [opId, errs] of Object.entries(validation.errors)) {
            for (const [field, msg] of Object.entries(errs)) {
              lines.push(`  - ${opId}.${field}: ${msg}`);
            }
          }
          return createErrorResult(lines.join("\n"));
        }

        // Build logical plan (sub-DAG if targetOperatorIds provided)
        const logicalPlan: LogicalPlan = buildLogicalPlan(workflowState, targetOperatorIds);
        if (logicalPlan.operators.length === 0) {
          return createErrorResult("No operators to execute (workflow is empty or targetOperatorIds resolved to empty sub-DAG).");
        }

        const config = getExecutionConfig();
        const wsClient = new ExecutionWsClient({
          url: buildWsUrl(),
          token: config.userToken,
          workflowId: config.workflowId,
          computingUnitId: config.computingUnitId ?? 1,
        });

        // Stale watcher cleanup before opening a new one
        const staleWatcher = watcherSlot.get();
        if (staleWatcher) {
          try {
            staleWatcher.dispose();
          } catch {
            /* ignore */
          }
        }

        await wsClient.connect();

        const executionName = `agent-execution-${Date.now()}`;
        const watcher = new ExecutionWatcher(wsClient, executionName);
        watcher.start();
        watcherSlot.set(watcher);

        wsClient.sendExecuteRequest({
          executionName,
          engineVersion: "1.0",
          logicalPlan: {
            operators: logicalPlan.operators as any,
            links: logicalPlan.links as any,
            opsToViewResult: logicalPlan.opsToViewResult ?? [],
            opsToReuseResult: [],
          },
          replayFromExecution: null,
          workflowSettings: { dataTransferBatchSize: 400 },
          emailNotificationEnabled: false,
          computingUnitId: config.computingUnitId ?? 1,
        });
        // Optimistic snapshot bump: closes the gap between sending the request
        // and the engine emitting Initializing/Running for the new execution.
        // Any prior-run replay events (like Completed) that arrived between
        // ws.connect() and now are clobbered here.
        watcher.markExecutionStarting();

        // Brief synchronous wait: gives a cache-hit (or any other extremely
        // fast completion) a chance to land before we return, so the tool
        // result can reflect the actual outcome rather than always reading
        // "started, use awaitExecution to track." Capped at 2s so slow runs
        // pay only a small upfront latency. The agent can still call
        // awaitExecution for longer waits.
        const earlyResult = await watcher.await(2000, getAbortSignal?.());
        // Anything other than "tick" (timer expired, nothing happened) is a
        // real outcome worth returning inline. Terminal states, console
        // errors, and even unexpected paused-states are all more useful to
        // surface than a generic "started" string.
        if (earlyResult.reason !== "tick" && earlyResult.reason !== "aborted") {
          return createToolResult(
            `Execution started (name="${executionName}", ${logicalPlan.operators.length} operators${targetOperatorIds ? `, targets=${targetOperatorIds.join(",")}` : ""}).\n\n` +
              formatSnapshot(earlyResult.snapshot, earlyResult),
          );
        }
        return createToolResult(
          `Execution started (name="${executionName}", ${logicalPlan.operators.length} operators${targetOperatorIds ? `, targets=${targetOperatorIds.join(",")}` : ""}). Use awaitExecution to track progress.`,
        );
      } catch (err: any) {
        return createErrorResult(`Failed to start execution: ${err?.message ?? String(err)}`);
      }
    },
  });

  // ── awaitExecution ──
  const awaitExecution = tool({
    description:
      "Wait for the next significant event in the running execution (Paused, Failed, Completed, Killed, or a console error), " +
      "or for the timer to elapse, whichever comes first. Returns the current execution snapshot. " +
      "Call this repeatedly to watch progress over time. Default wait is 15 seconds.",
    inputSchema: z.object({
      maxWaitSeconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe(
          "Maximum seconds to wait before returning a 'tick' result. Default 15. " +
            "Use a longer value (e.g. 60) for very slow workflows; shorter (e.g. 5) if you want frequent updates.",
        ),
    }),
    execute: async ({ maxWaitSeconds }) => {
      const watcher = watcherSlot.get();
      if (!watcher) {
        return createErrorResult("No execution in flight. Call startExecution first.");
      }
      const timeoutMs = (maxWaitSeconds ?? 15) * 1000;
      const result = await watcher.await(timeoutMs, getAbortSignal?.());
      return createToolResult(formatSnapshot(result.snapshot, result));
    },
  });

  // ── pauseExecution ──
  const pauseExecution = tool({
    description:
      "Pause the currently running execution. The engine quiesces all workers and emits a Paused state event. " +
      "Only valid while execution is Running. Returns immediately; use awaitExecution to confirm the Paused state.",
    inputSchema: z.object({}),
    execute: async () => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const state = watcher.getSnapshot().currentState;
      if (state !== "Running") {
        return createErrorResult(`Cannot pause from state '${state}'. Pause is only valid when Running.`);
      }
      watcher.pause();
      return createToolResult("Pause request sent. Use awaitExecution to confirm the Paused state.");
    },
  });

  // ── resumeExecution ──
  const resumeExecution = tool({
    description:
      "Resume a paused execution. Continues processing from where it was paused. " +
      "Only valid while execution is Paused.",
    inputSchema: z.object({}),
    execute: async () => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const state = watcher.getSnapshot().currentState;
      if (state !== "Paused") {
        return createErrorResult(`Cannot resume from state '${state}'. Resume is only valid when Paused.`);
      }
      watcher.resume();
      return createToolResult("Resume request sent. Use awaitExecution to confirm the Running state.");
    },
  });

  // ── killExecution ──
  const killExecution = tool({
    description:
      "Kill the currently running or paused execution. Engine shuts down workers immediately. " +
      "All progress is lost; cannot be undone. Use this when results are clearly unrecoverable.",
    inputSchema: z.object({}),
    execute: async () => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      watcher.kill();
      return createToolResult("Kill request sent. The execution will be terminated.");
    },
  });

  // ── getOperatorResult ──
  const getOperatorResult = tool({
    description:
      "Fetch a page of result rows for a specific operator. Works during execution (any state with materialized output) or after completion. " +
      "Use small limits (10-50) for inspection.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator ID to fetch results for."),
      offset: z.number().int().min(0).default(0).describe("Row offset (0-based)."),
      limit: z.number().int().min(1).max(500).default(20).describe("Max rows to return."),
    }),
    execute: async ({ operatorId, offset, limit }) => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight. Call startExecution first.");
      try {
        // Engine's pageIndex is 1-based (`from = pageSize * (pageIndex - 1)`).
        // Translate offset → 1-based page number.
        const pageIndex = Math.floor(offset / limit) + 1;
        const evt = await watcher.requestPaginatedResult(operatorId, pageIndex, limit);

        // Mirror the HTTP path: write the fetched rows into the operator
        // result store so `# Current Workflow` shows them under Result.
        // Pull engine state from the snapshot if available so the stored
        // OperatorInfo carries an accurate state field.
        if (onOperatorResult) {
          const snap = watcher.getSnapshot();
          const opState = snap.perOperatorState[operatorId];
          onOperatorResult(operatorId, {
            state: opState?.state ?? "Completed",
            inputTuples: opState?.inputTupleCount ?? 0,
            outputTuples: opState?.outputTupleCount ?? evt.table.length,
            resultMode: "table",
            result: evt.table,
            displayedRows: evt.table.length,
          });
        }

        return createToolResult(
          `Operator ${operatorId} (page ${pageIndex}, ${evt.table.length} rows):\n${formatPaginatedRows(
            evt.table,
            evt.schema,
          )}`,
        );
      } catch (err: any) {
        return createErrorResult(`Failed to fetch result for ${operatorId}: ${err?.message ?? String(err)}`);
      }
    },
  });


  // ── debugPython ──
  // Send a single pdb command into a Python UDF worker (Udon-style line-by-line
  // debugger). Output comes back asynchronously as DEBUGGER-level console
  // messages — we poll the snapshot briefly to capture the immediate response.
  const debugPython = tool({
    description:
      "Send a single Python `pdb` command to a paused Python UDF worker for line-by-line debugging. " +
      "Output appears as DEBUGGER-level console messages; this tool waits up to 3s for new output " +
      "and returns it. If your command resumes execution (c/n/s/r) and output hasn't surfaced yet, " +
      "follow up with getConsoleLogs(operatorId, levels=['DEBUGGER']).\n\n" +
      "Common commands (full pdb syntax supported):\n" +
      "  - b N         set breakpoint at line N of the UDF source (line numbering relative to the UDF code)\n" +
      "  - cl          clear all breakpoints   |   cl N: clear at line N\n" +
      "  - n           step over (next line)\n" +
      "  - s           step into a function call\n" +
      "  - r           run until current function returns\n" +
      "  - c           continue until next breakpoint or end\n" +
      "  - p EXPR      print expression value (replaces the older evalPython)\n" +
      "  - pp EXPR     pretty-print expression\n" +
      "  - l / ll      list source around current line / for current function\n" +
      "  - w           backtrace\n" +
      "  - a           current function arguments\n" +
      "  - disable / enable [N]   toggle breakpoint(s)\n\n" +
      "The worker auto-prefixes the UDF module name to `b N`, so you only need the line number. " +
      "Pdb runs inside the worker process — `p self.cache.clear()` will actually mutate state. " +
      "Requires execution to be Paused (engine pause, exception pause, or breakpoint hit).",
    inputSchema: z.object({
      operatorId: z.string().describe("The Python UDF operator."),
      workerId: z
        .string()
        .describe(
          "The specific worker (read it from getConsoleLogs output or the # Active Execution prompt). " +
            "Each worker maintains its own pdb state.",
        ),
      cmd: z.string().min(1).describe("A single pdb command, e.g. 'n', 'b 5', 'p tuple_'."),
    }),
    execute: async ({ operatorId, workerId, cmd }) => {
      const watcher = watcherSlot.get();
      if (!watcher) {
        return createErrorResult("No execution in flight. Call startExecution first.");
      }
      const snap0 = watcher.getSnapshot();
      if (snap0.currentState !== "Paused") {
        return createErrorResult(
          `debugPython requires a Paused execution; current state is '${snap0.currentState}'. ` +
            `Pause the workflow first (or wait for an exception/breakpoint to auto-pause it).`,
        );
      }
      const opState = snap0.perOperatorState[operatorId];
      if (!opState) {
        return createErrorResult(
          `Operator '${operatorId}' is not part of the active execution. Known: ${
            Object.keys(snap0.perOperatorState).join(", ") || "(none)"
          }.`,
        );
      }

      // Snapshot current DEBUGGER message count so we can return only the
      // output produced by THIS command.
      const beforeCount = (snap0.consoleMessagesByOperator[operatorId] ?? []).filter(
        m => getConsoleMessageType(m) === "DEBUGGER" && m.workerId === workerId,
      ).length;

      try {
        watcher.sendDebugCommand({ operatorId, workerId, cmd });
      } catch (err: any) {
        return createErrorResult(`Failed to send debug command: ${err?.message ?? String(err)}`);
      }

      // Poll the snapshot for up to 3s waiting for new DEBUGGER output from
      // this worker. Pdb usually responds within tens of ms, but breakpoint
      // hits and step-into can take longer when crossing tuple boundaries.
      const deadline = Date.now() + 3000;
      let newMessages: ConsoleMessage[] = [];
      while (Date.now() < deadline) {
        const all = (watcher.getSnapshot().consoleMessagesByOperator[operatorId] ?? []).filter(
          m => getConsoleMessageType(m) === "DEBUGGER" && m.workerId === workerId,
        );
        if (all.length > beforeCount) {
          newMessages = all.slice(beforeCount);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (newMessages.length === 0) {
        return createToolResult(
          `Sent \`${cmd}\` to ${workerId}. No DEBUGGER output captured within 3s — the command may be still running, ` +
            `or it resumed the worker (c/n/s/r) without producing visible output yet. ` +
            `Use getConsoleLogs(operatorId='${operatorId}', levels=['DEBUGGER']) to check later.`,
        );
      }

      const lines: string[] = [`Sent \`${cmd}\` to ${workerId}. Debugger output:`];
      for (const m of newMessages) {
        const text = m.message?.length > 0 ? m.message : m.title;
        const trunc = text.length > 600 ? text.slice(0, 600) + "…" : text;
        lines.push(`  ${trunc}`);
      }
      return createToolResult(lines.join("\n"));
    },
  });

  // ── liveModifyOperator ──
  // Distinct from the design-time `modifyOperator` tool (which edits the
  // workflow DAG) if the execution is not executed. `liveModifyOperator` hot-replaces operator properties
  // (typically code) on a paused execution without restarting the workflow.
  const liveModifyOperator = tool({
    description:
      "Queue a hot-replace of an operator's properties (typically the code field of a Python UDF) for a paused execution. " +
      "The engine validates the change synchronously (returned in this tool's result). Application happens on the NEXT " +
      "resumeExecution / retryCurrentTuple — do not expect new code to take effect until you resume. " +
      "Typical loop: pause → evalPython to inspect → liveModifyOperator → retryCurrentTuple or resumeExecution. " +
      "Requires the execution to be Paused. Properties are merged onto the existing ones (shallow); existing keys " +
      "you don't mention are preserved. Schema-changing edits (port count, output schema) are NOT supported here — " +
      "use the design-time modifyOperator tool and re-run the workflow for those.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator to modify."),
      properties: z
        .record(z.any())
        .describe(
          "Partial properties object to merge. For Python UDFs, typically `{ code: '<full updated code>' }`. " +
            "Provide the full new value for each key — values are replaced, not deep-merged.",
        ),
    }),
    execute: async ({ operatorId, properties }) => {
      const watcher = watcherSlot.get();
      if (!watcher) {
        return createErrorResult("No execution in flight. Call startExecution first, then pauseExecution before liveModifyOperator.");
      }
      const snap = watcher.getSnapshot();
      if (snap.currentState !== "Paused") {
        return createErrorResult(
          `liveModifyOperator requires a Paused execution; current state is '${snap.currentState}'. Pause the workflow first.`,
        );
      }
      const operator = workflowState.getOperator(operatorId);
      if (!operator) {
        return createErrorResult(`Operator '${operatorId}' not found in the workflow.`);
      }

      // Build the wire payload mirroring the FE: operator properties spread
      // with operatorID + operatorType, no port descriptors. Engine treats
      // this as the new LogicalOp body for the operator.
      const mergedProperties = { ...operator.operatorProperties, ...properties };
      const operatorPayload = {
        ...mergedProperties,
        operatorID: operator.operatorID,
        operatorType: operator.operatorType,
      };

      try {
        const result = await watcher.requestModifyLogic(operatorPayload);
        if (!result.isValid) {
          return createErrorResult(
            `Engine rejected the modify-logic request for '${operatorId}': ${result.errorMessage || "(no error message)"}. The original logic is still in effect.`,
          );
        }
        // Engine validated and queued the change → update local WorkflowState
        // so subsequent tool reads (getCurrentWorkflow, etc.) see the new code.
        // The engine actually applies on the next resumeExecution / retryCurrentTuple.
        workflowState.updateOperatorProperties(operatorId, properties);
        return createToolResult(
          `Operator '${operatorId}' logic queued (validated). It will be applied when you call resumeExecution ` +
            `or retryCurrentTuple. The new code will run from the next tuple onward.`,
        );
      } catch (err: any) {
        return createErrorResult(`liveModifyOperator failed for '${operatorId}': ${err?.message ?? String(err)}`);
      }
    },
  });

  // ── retryCurrentTuple ──
  const retryCurrentTuple = tool({
    description:
      "Re-process the most recent in-flight tuple on the given operator's workers. Pairs with liveModifyOperator: " +
      "after fixing the code, call retryCurrentTuple to re-run the row that triggered the original failure rather " +
      "than skipping it. Requires the execution to be Paused, and the operator must have at least one assigned worker.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator whose workers should retry their current tuple."),
    }),
    execute: async ({ operatorId }) => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const snap = watcher.getSnapshot();
      if (snap.currentState !== "Paused") {
        return createErrorResult(
          `retryCurrentTuple requires a Paused execution; current state is '${snap.currentState}'.`,
        );
      }
      const workers = snap.workerIdsByOperator[operatorId] ?? [];
      if (workers.length === 0) {
        return createErrorResult(
          `No workers assigned to operator '${operatorId}'. Either the operator hasn't started yet or its worker assignments haven't been received.`,
        );
      }
      try {
        watcher.retryWorkers(workers);
        return createToolResult(
          `Retry request sent to ${workers.length} worker${workers.length === 1 ? "" : "s"} of '${operatorId}'. ` +
            `Use awaitExecution to observe the result, or resumeExecution to continue.`,
        );
      } catch (err: any) {
        return createErrorResult(`retryCurrentTuple failed for '${operatorId}': ${err?.message ?? String(err)}`);
      }
    },
  });

  // ── getConsoleLogs ──
  const getConsoleLogs = tool({
    description:
      "Read recent console output (PRINT, ERROR, DEBUGGER) for a specific operator's workers. " +
      "Use this when investigating why an operator stalled or printed something interesting — " +
      "the # Active Execution section only shows ERROR-level messages, this tool returns all levels. " +
      "Buffer holds up to ~50 most recent messages per operator.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator whose workers' console output you want."),
      levels: z
        .array(z.enum(["PRINT", "ERROR", "DEBUGGER", "COMMAND"]))
        .optional()
        .describe("Filter to specific log levels (default: all)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max messages to return, most recent first. Default 20."),
    }),
    execute: async ({ operatorId, levels, limit }) => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const snap = watcher.getSnapshot();
      const all = snap.consoleMessagesByOperator[operatorId] ?? [];
      if (all.length === 0) {
        return createToolResult(`No console messages buffered for operator '${operatorId}'.`);
      }
      const filtered = levels && levels.length > 0
        ? all.filter(m => levels.includes(getConsoleMessageType(m)))
        : all;
      const cap = limit ?? 20;
      const slice = filtered.slice(-cap).reverse(); // most recent first
      if (slice.length === 0) {
        return createToolResult(
          `No console messages matching levels=${levels?.join(",")} for operator '${operatorId}'.`,
        );
      }
      const lines: string[] = [];
      lines.push(
        `Recent console output for '${operatorId}' (${slice.length} of ${filtered.length} buffered, most recent first):`,
      );
      for (const m of slice) {
        const lvl = getConsoleMessageType(m);
        const trunc = m.message.length > 300 ? m.message.slice(0, 300) + "…" : m.message;
        lines.push(`  - [${lvl}] [${m.workerId}]${m.title ? ` ${m.title}:` : ""} ${trunc}`);
      }
      return createToolResult(lines.join("\n"));
    },
  });

  return {
    [TOOL_NAME_START_EXECUTION]: startExecution,
    [TOOL_NAME_AWAIT_EXECUTION]: awaitExecution,
    [TOOL_NAME_PAUSE_EXECUTION]: pauseExecution,
    [TOOL_NAME_RESUME_EXECUTION]: resumeExecution,
    [TOOL_NAME_KILL_EXECUTION]: killExecution,
    [TOOL_NAME_GET_OPERATOR_RESULT]: getOperatorResult,
    [TOOL_NAME_DEBUG_PYTHON]: debugPython,
    [TOOL_NAME_LIVE_MODIFY_OPERATOR]: liveModifyOperator,
    [TOOL_NAME_RETRY_CURRENT_TUPLE]: retryCurrentTuple,
    [TOOL_NAME_GET_CONSOLE_LOGS]: getConsoleLogs,
  };
}
