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
 * Control tools (startExecution / pauseExecution / resumeExecution /
 * killExecution) send their request and then BLOCK on `watcher.await()`
 * until the watcher's wake rules fire — no timeout, no `awaitExecution`
 * sidekick. The watcher is the sole arbiter of "something significant
 * happened"; tools just report whatever wakes them.
 *
 * Inspection / debug tools (getOperatorResult / evalPython /
 * liveModifyOperator / retryCurrentTuple / getConsoleLogs) are correlation-
 * or read-based and do NOT block on the watcher.
 */

import { tool } from "ai";
import { z } from "zod";

import {
  ExecutionWatcher,
  snapshotWasFromCache,
  type AwaitResult,
  type ExecutionWatcherSnapshot,
  type SnapshotDiff,
  type WakeSignal,
} from "../agent/execution-watcher";
import type { ExecutionDiagnostics } from "../types/agent";
import { getConsoleMessageType, type ConsoleMessage } from "../types/execution-ws";
import type { WorkflowState as AgentWorkflowState } from "../workflow/workflow-state";
import type { LogicalPlan } from "../api/execution-api";
import { buildLogicalPlan, validateWorkflow, type ExecutionConfig } from "./execution-tools";
import { createErrorResult, createToolResult } from "./tools-utility";

// ─── Tool name constants ──────────────────────────────────────────────────

export const TOOL_NAME_START_EXECUTION = "startExecution";
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

// ─── State → allowed-actions matrix ──────────────────────────────────────

type StateCategory =
  | "no-execution"
  | "alive-running"
  | "alive-running-with-auto-paused-op"
  | "alive-paused"
  | "alive-transient";

function categorize(
  state: string,
  hasWatcher: boolean,
  hasAutoPausedOperator: boolean = false,
): StateCategory {
  if (!hasWatcher) return "no-execution";
  switch (state) {
    case "Uninitialized":
    case "Completed":
    case "Failed":
    case "Killed":
    case "Terminated":
      return "no-execution";
    case "Running":
      return hasAutoPausedOperator ? "alive-running-with-auto-paused-op" : "alive-running";
    case "Paused":
      return "alive-paused";
    case "Initializing":
    case "Pausing":
    case "Resuming":
    case "Recovering":
    default:
      return "alive-transient";
  }
}

/**
 * `hasAutoPausedOperator` flips the matrix into the auto-paused-op variant
 * — used both when rendering tool-error hints and when assembling the
 * `# Active Execution` section's "what you can do" footer.
 */
export function formatAllowedActions(
  state: string,
  hasWatcher: boolean,
  hasAutoPausedOperator: boolean = false,
): string {
  const cat = categorize(state, hasWatcher, hasAutoPausedOperator);
  const lines: string[] = [];
  lines.push("Always allowed (read-only / metadata):");
  lines.push("  - listDatasets, listDatasetFiles, listAllAvailableOperatorTypes, getOperatorSchema");
  lines.push("");

  switch (cat) {
    case "no-execution":
      lines.push("DAG editing: addOperator, modifyOperator, createOrModifyOperator, deleteOperator");
      lines.push("Execution control: startExecution");
      lines.push("Inspection: getOperatorResult on operators that have materialized output from a prior run");
      lines.push("Not available now: pauseExecution, resumeExecution, killExecution,");
      lines.push("                   evalPython, liveModifyOperator, retryCurrentTuple, getConsoleLogs");
      lines.push("(They require an alive execution.)");
      break;
    case "alive-running":
      lines.push("Execution control: pauseExecution, killExecution");
      lines.push("Inspection: getOperatorResult, getConsoleLogs");
      lines.push("DAG editing is BLOCKED while execution is alive (would diverge from engine plan).");
      lines.push("  To edit the DAG: killExecution first, then edit, then startExecution.");
      lines.push("  To hot-fix a Python UDF without restart: pause first, then liveModifyOperator.");
      lines.push("Not available now: resumeExecution (not paused), startExecution (one is in flight),");
      lines.push("                   evalPython, liveModifyOperator, retryCurrentTuple (need Paused).");
      break;
    case "alive-running-with-auto-paused-op":
      lines.push("⚠ A Python UDF raised an exception. The engine auto-paused that single worker;");
      lines.push("  other workers are still running. The workflow as a whole is still Running.");
      lines.push("");
      lines.push("Recommended next step: pauseExecution to quiesce the whole workflow, then debug.");
      lines.push("Execution control: pauseExecution, killExecution");
      lines.push("Inspection: getConsoleLogs (pull the full traceback), getOperatorResult");
      lines.push("Not available until you call pauseExecution: evalPython, liveModifyOperator,");
      lines.push("                                             retryCurrentTuple (need workflow-level Paused).");
      lines.push("DAG editing is BLOCKED while execution is alive.");
      break;
    case "alive-paused":
      lines.push("Execution control: resumeExecution, killExecution");
      lines.push("Inspection: getOperatorResult, getConsoleLogs");
      lines.push("Runtime debug (Python UDF only): evalPython, liveModifyOperator, retryCurrentTuple");
      lines.push("DAG editing is BLOCKED while execution is alive. To make a structural change:");
      lines.push("  killExecution first, then addOperator/modifyOperator/createOrModifyOperator/deleteOperator,");
      lines.push("  then startExecution. (To swap a Python UDF's code in place, use liveModifyOperator instead.)");
      lines.push("Not available now: pauseExecution (already paused), startExecution (one is in flight).");
      break;
    case "alive-transient":
      lines.push("Execution is in a transient state — wait for the next [execution] update.");
      lines.push("Available: killExecution, getConsoleLogs, getOperatorResult");
      lines.push("DAG editing is BLOCKED while execution is alive.");
      lines.push("Not available now: pauseExecution, resumeExecution, evalPython, liveModifyOperator,");
      lines.push("                   retryCurrentTuple (wait for Running or Paused first).");
      break;
  }
  return lines.join("\n");
}

/**
 * True iff any operator's per-op state is Paused while the workflow itself
 * isn't workflow-level Paused/Pausing — that's the EXCEPTION_PAUSE shape.
 * Used to decide which allowed-actions matrix variant to render.
 */
export function snapshotHasAutoPausedOperator(s: ExecutionWatcherSnapshot): boolean {
  if (s.currentState === "Paused" || s.currentState === "Pausing") return false;
  for (const st of Object.values(s.perOperatorState)) {
    if (st.state === "Paused") return true;
  }
  return false;
}

function rejectWithStateHint(
  toolName: string,
  required: string,
  actualState: string,
  hasWatcher: boolean,
  hasAutoPausedOperator: boolean = false,
): string {
  const allowed = formatAllowedActions(actualState, hasWatcher, hasAutoPausedOperator);
  return (
    `${toolName} requires ${required}; current execution state is '${actualState}'.\n\n` +
    `Allowed actions right now:\n${allowed}`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Render the awaited result. Same shape as the [execution] step renderer
 * in texera-agent.ts but framed as the outcome of the just-issued tool —
 * narrative paragraph first, structured details after.
 */
function renderAwaitResult(result: AwaitResult): string {
  if (result.reason === "aborted") {
    return "The wait was aborted before any execution event arrived.";
  }
  return renderSnapshotWithDiff(result.snapshot, result.diff, result.signals);
}

function renderSnapshotWithDiff(
  snapshot: ExecutionWatcherSnapshot,
  diff: SnapshotDiff,
  signals: WakeSignal[],
): string {
  const lines: string[] = [];

  // Narrative first.
  lines.push(composeNarrative(snapshot, diff, signals));

  // Structured details after.
  const details: string[] = [];

  if (diff.workflowState) {
    details.push(`State transition: ${diff.workflowState.from} → ${diff.workflowState.to}`);
  }

  if (diff.perOperator && Object.keys(diff.perOperator).length > 0) {
    details.push("Per-operator changes:");
    for (const [opId, change] of Object.entries(diff.perOperator)) {
      const fromStr = change.from
        ? `${change.from.state} (in: ${change.from.inputTupleCount}, out: ${change.from.outputTupleCount})`
        : "(new)";
      const toStr = `${change.to.state} (in: ${change.to.inputTupleCount}, out: ${change.to.outputTupleCount})`;
      details.push(`  - ${opId}: ${fromStr} → ${toStr}`);
    }
  }

  if (diff.newConsoleMessages?.length) {
    const errors = diff.newConsoleMessages.filter(m => getConsoleMessageType(m) === "ERROR");
    if (errors.length > 0) {
      details.push(`Console errors (${errors.length}):`);
      for (const e of errors) {
        const trunc = e.message.length > 300 ? e.message.slice(0, 300) + "…" : e.message;
        details.push(`  - [${e.workerId}] ${e.title}: ${trunc}`);
      }
    }
  }

  if (diff.newFatalErrors?.length) {
    details.push(`Fatal errors (${diff.newFatalErrors.length}):`);
    for (const err of diff.newFatalErrors) {
      const msg = err.message.length > 300 ? err.message.slice(0, 300) + "…" : err.message;
      details.push(`  - ${err.type ?? "FATAL"}: ${msg}${err.operatorId ? ` (op=${err.operatorId})` : ""}`);
    }
  }

  // Current per-operator state — agent often wants the full picture.
  const ops = Object.entries(snapshot.perOperatorState);
  if (ops.length > 0) {
    details.push("Current per-operator state:");
    for (const [opId, st] of ops) {
      details.push(`  - ${opId}: ${st.state} (input: ${st.inputTupleCount} rows, output: ${st.outputTupleCount} rows)`);
    }
  }

  if (signals.length > 0) {
    details.push(`Signals: ${signals.map(s => `${s.ruleId}/${s.severity}`).join(", ")}`);
  }

  if (details.length > 0) {
    lines.push("");
    lines.push("Details:");
    for (const d of details) lines.push(d);
  }

  return lines.join("\n");
}

/**
 * Plain-English summary of what happened. Mirrors the prepareStep
 * narrative composer but reads from snapshot+diff+signals directly (the
 * tool result doesn't have a Mailbox object — it has the AwaitResult).
 *
 * Lead with the most actionable signal class. Mention the in-flight
 * tuple as a pointer to evalPython rather than rendering it inline
 * (could be large, sensitive, or both).
 */
function composeNarrative(
  snapshot: ExecutionWatcherSnapshot,
  diff: SnapshotDiff,
  signals: WakeSignal[],
): string {
  const sigIds = new Set(signals.map(s => s.ruleId));
  const fromCache = snapshotWasFromCache(snapshot);

  if (sigIds.has("operator-auto-paused")) {
    const pausedOps: string[] = [];
    if (diff.perOperator) {
      for (const [opId, change] of Object.entries(diff.perOperator)) {
        if (change.to.state === "Paused" && change.from?.state !== "Paused") pausedOps.push(opId);
      }
    }
    const opsList = pausedOps.length > 0 ? pausedOps.join(", ") : "an operator";
    const errBlurb = consoleErrorOneLiner(diff);
    let s = `A Python UDF in ${opsList} raised an exception, and the engine auto-paused that worker (the failing tuple is parked in the worker for inspection — see \`evalPython(opId, "tuple_")\` once the workflow is fully Paused). Other workers are still running.`;
    if (errBlurb) s += ` The error was: ${errBlurb}.`;
    s += ` Call \`pauseExecution\` to quiesce the whole workflow first; \`liveModifyOperator\`, \`evalPython\`, and \`retryCurrentTuple\` all require workflow-level Paused.`;
    return s;
  }

  if (sigIds.has("state-failed") || sigIds.has("fatal-error")) {
    const fatal = diff.newFatalErrors?.[0];
    if (fatal) {
      return `Workflow failed at engine level: ${fatal.type ?? "FATAL"} — ${truncate(fatal.message, 200)}${fatal.operatorId ? ` (operator: ${fatal.operatorId})` : ""}. This is usually wiring/schema, not a UDF bug; design-time fix and restart is the path forward.`;
    }
    return `Workflow failed at engine level. See structured details below.`;
  }

  if (sigIds.has("console-error") && !sigIds.has("operator-auto-paused")) {
    const err = consoleErrorOneLiner(diff);
    return `A worker logged an ERROR${err ? `: ${err}` : ""}. The workflow is still running. Pull \`getConsoleLogs(opId)\` for the full traceback.`;
  }

  if (sigIds.has("state-paused")) {
    return `Workflow paused. While paused: \`evalPython\` for runtime introspection on Python UDFs, \`liveModifyOperator\` to hot-swap UDF code, \`retryCurrentTuple\` to retry the in-flight row, \`getOperatorResult\` for materialized output. Call \`resumeExecution\` to continue.`;
  }
  if (sigIds.has("state-completed-from-cache") || (sigIds.has("state-completed") && fromCache)) {
    return `Workflow completed by returning cached results — no operators ran fresh. If you expected fresh computation, modify an operator to invalidate the cache and re-run.`;
  }
  if (sigIds.has("state-completed")) {
    return `Workflow completed. Use \`getOperatorResult\` to inspect outputs.`;
  }
  if (sigIds.has("state-killed")) {
    return `Execution killed. All in-flight progress is gone.`;
  }

  // Fall-through: no specific narrative.
  if (fromCache) {
    return `Execution state: Completed (from cache).`;
  }
  return `Execution state: ${snapshot.currentState}.`;
}

function consoleErrorOneLiner(diff: SnapshotDiff): string | null {
  const errs = (diff.newConsoleMessages ?? []).filter(m => getConsoleMessageType(m) === "ERROR");
  if (errs.length === 0) return null;
  const first = errs[0];
  const head = first.title ? `${first.title}: ${first.message}` : first.message;
  return truncate(head.split("\n")[0], 180);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatPaginatedRows(table: any[], schema: { attributeName: string; attributeType: string }[]): string {
  if (table.length === 0) return "(no rows)";
  const headers = schema.map(s => s.attributeName);
  const lines: string[] = [];
  lines.push(`Schema: ${schema.map(s => `${s.attributeName}:${s.attributeType}`).join(", ")}`);
  lines.push(`Rows: ${table.length}`);
  lines.push("");
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
  getExecutionConfig: () => ExecutionConfig;
  getAbortSignal?: () => AbortSignal | undefined;
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
  /**
   * Sink for per-control-tool diagnostics. Called once per
   * start/pause/resume/kill execution after the await resolves. The agent
   * uses this to stamp `executionDiagnostics[]` onto the resulting ReActStep.
   * Diagnostics are pure trace metadata — they do NOT flow into the model.
   */
  recordExecutionDiagnostics?: (diag: ExecutionDiagnostics) => void;
}

export function createWsExecutionTools(opts: CreateWsExecutionToolsOptions) {
  const { workflowState, watcherSlot, getExecutionConfig, getAbortSignal, onOperatorResult, recordExecutionDiagnostics } = opts;

  /**
   * Build an ExecutionDiagnostics from a control-tool await result and forward
   * it to the agent. `awaitBefore` is the snapshot captured by the tool just
   * before it called `watcher.await()` — used as a fallback for aborted
   * results where the watcher's own beforeSnapshot is just "current".
   */
  function emitDiagnostics(
    toolName: string,
    toolCallIdHint: string | undefined,
    awaitBefore: ExecutionWatcherSnapshot,
    result: AwaitResult,
  ): void {
    if (!recordExecutionDiagnostics) return;
    recordExecutionDiagnostics({
      toolName,
      toolCallId: toolCallIdHint,
      // Prefer the watcher-reported beforeSnapshot (snapshot just before the
      // first wake-firing event). Fall back to the pre-await snapshot when
      // there were no contributing events (aborted, etc.).
      beforeSnapshot:
        result.contributingEvents.length > 0 ? result.beforeSnapshot : awaitBefore,
      afterSnapshot: result.snapshot,
      contributingEvents: result.contributingEvents,
      wakeSignals: result.signals,
    });
  }

  // ── startExecution ──
  const startExecution = tool({
    description:
      "Start executing the workflow. Sends the execute request and BLOCKS until the watcher reports a significant " +
      "execution event (typically completion, failure, auto-pause due to a runtime error, or a console error). " +
      "Returns the snapshot + the diff that caused the wake. Only one execution can be in-flight per agent at a time.",
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
        const watcher = watcherSlot.get();
        if (!watcher) {
          return createErrorResult("Execution watcher not initialized — agent missing delegate config?");
        }
        if (watcher.isAlive()) {
          const state = watcher.getSnapshot().currentState;
          return createErrorResult(
            rejectWithStateHint("startExecution", "no execution in flight", state, true),
          );
        }

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

        const logicalPlan: LogicalPlan = buildLogicalPlan(workflowState, targetOperatorIds);
        if (logicalPlan.operators.length === 0) {
          return createErrorResult("No operators to execute (workflow is empty or targetOperatorIds resolved to empty sub-DAG).");
        }

        const config = getExecutionConfig();
        // Persistent WS: connect once per agent session. Idempotent —
        // if already connected, this is a no-op. The first call awaits;
        // subsequent calls return immediately.
        await watcher.connect();

        const executionName = `agent-execution-${Date.now()}`;
        // sendExecuteRequest internally calls markExecutionStarting which
        // resets snapshot/mailbox/seal AND flips inExecution=true so wake
        // rules fire from this point forward.
        watcher.sendExecuteRequest({
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

        // Block until the watcher reports a significant event. There's no
        // timeout — engine will eventually emit terminal state, console
        // error, or get aborted. The agent abort signal is the only way
        // out for genuinely hung executions.
        const awaitBefore = watcher.getSnapshot();
        const result = await watcher.await(getAbortSignal?.());
        emitDiagnostics(TOOL_NAME_START_EXECUTION, undefined, awaitBefore, result);
        const targetSuffix = targetOperatorIds ? `, targets=${targetOperatorIds.join(",")}` : "";
        const header = `Execution "${executionName}" with ${logicalPlan.operators.length} operators${targetSuffix}.`;
        return createToolResult(`${header}\n\n${renderAwaitResult(result)}`);
      } catch (err: any) {
        return createErrorResult(`Failed to start execution: ${err?.message ?? String(err)}`);
      }
    },
  });

  // ── pauseExecution ──
  const pauseExecution = tool({
    description:
      "Pause the currently running execution. Sends a pause request and BLOCKS until the watcher reports a wake — " +
      "typically the workflow reaching Paused, but possibly a terminal state if the workflow finished while pausing. " +
      "Only valid while execution is Running. The returned snapshot reflects the post-wake state.",
    inputSchema: z.object({}),
    execute: async () => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const state = watcher.getSnapshot().currentState;
      if (state !== "Running") {
        return createErrorResult(rejectWithStateHint("pauseExecution", "Running state", state, true));
      }
      const awaitBefore = watcher.getSnapshot();
      watcher.pause();
      const result = await watcher.await(getAbortSignal?.());
      emitDiagnostics(TOOL_NAME_PAUSE_EXECUTION, undefined, awaitBefore, result);
      return createToolResult(`Pause request sent.\n\n${renderAwaitResult(result)}`);
    },
  });

  // ── resumeExecution ──
  const resumeExecution = tool({
    description:
      "Resume a paused execution. Sends a resume request and BLOCKS until the watcher reports a wake — typically " +
      "completion, failure, an auto-pause due to a new error, or a console error. " +
      "Only valid while execution is Paused.",
    inputSchema: z.object({}),
    execute: async () => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const state = watcher.getSnapshot().currentState;
      if (state !== "Paused") {
        return createErrorResult(rejectWithStateHint("resumeExecution", "Paused state", state, true));
      }
      const awaitBefore = watcher.getSnapshot();
      watcher.resume();
      const result = await watcher.await(getAbortSignal?.());
      emitDiagnostics(TOOL_NAME_RESUME_EXECUTION, undefined, awaitBefore, result);
      return createToolResult(`Resume request sent.\n\n${renderAwaitResult(result)}`);
    },
  });

  // ── killExecution ──
  const killExecution = tool({
    description:
      "Kill the currently running or paused execution. Engine shuts down workers immediately. " +
      "BLOCKS until the watcher reports a wake — typically the terminal Killed state. All progress is lost.",
    inputSchema: z.object({}),
    execute: async () => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const awaitBefore = watcher.getSnapshot();
      watcher.kill();
      const result = await watcher.await(getAbortSignal?.());
      emitDiagnostics(TOOL_NAME_KILL_EXECUTION, undefined, awaitBefore, result);
      return createToolResult(`Kill request sent.\n\n${renderAwaitResult(result)}`);
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
        const pageIndex = Math.floor(offset / limit) + 1;
        const evt = await watcher.requestPaginatedResult(operatorId, pageIndex, limit);

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
      "Send a single Python `pdb` command to a Python UDF worker for line-by-line debugging. " +
      "Output appears as DEBUGGER-level console messages; this tool waits up to 3s for new output " +
      "and returns it. If your command resumes the worker (c/n/s/r) and output hasn't surfaced yet, " +
      "follow up with getConsoleLogs(operatorId, levels=['DEBUGGER']).\n\n" +
      "**Do NOT call `pauseExecution` before debugPython.** workflow-level (controller) pause " +
      "prevents the controller from scheduling the worker, so even after the worker accepts the " +
      "debug command its next instruction can never run. Two correct ways to enter the debugger:\n" +
      "  1. Wait for the worker to auto-pause on a UDF exception (EXCEPTION_PAUSE) — call this tool " +
      "directly while the workflow keeps running for everyone else.\n" +
      "  2. Set a breakpoint with `b N` while the workflow is running; the worker will pause on its " +
      "own (DEBUG_PAUSE) when the line is hit.\n\n" +
      "Common commands (full pdb syntax supported):\n" +
      "  - b N         set breakpoint at line N of the UDF source (auto-prefixed with module name)\n" +
      "  - cl N        clear breakpoint at line N   |   cl <bpnum>: clear by 1-based id from `info break`\n" +
      "                (bare `cl` / `clear` is REJECTED — pdb's confirmation prompt reads from\n" +
      "                 sys.stdin which is closed in the worker, so it would silently no-op.)\n" +
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
      "Pdb runs inside the worker process — `p self.cache.clear()` will actually mutate state.",
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
      // Refuse when the agent itself just paused the workflow. In a controller-
      // level pause, every worker's MainLoop is blocked at the control queue
      // and never enters the `_switch_context` path that activates pdb.
      // Commands written to `_debug_in.value` get silently overwritten by the
      // next put_debug_command and pdb never reads any of them. EXCEPTION_PAUSE
      // and DEBUG_PAUSE (worker-self-pause from a UDF crash or breakpoint hit)
      // do NOT set this flag — pdb is genuinely active in those cases and
      // commands flow through.
      if (snap0.pauseRequestedByAgent) {
        return createErrorResult(
          "debugPython cannot drive pdb during a controller-level pause. " +
            "You called pauseExecution; the workflow is paused at the controller, which blocks the worker's main loop " +
            "before pdb can activate, so any pdb command sent now is silently dropped.\n\n" +
            "Correct workflow:\n" +
            "  1. resumeExecution to get back to Running.\n" +
            "  2. debugPython(opId, workerId, 'b N') while Running — sets the breakpoint without pausing.\n" +
            "  3. awaitExecution — the worker will self-pause (DEBUG_PAUSE) when it hits line N.\n" +
            "  4. Once paused on the breakpoint, debugPython('p tuple_'), 'n', 's', 'c', etc. now work — pdb is active.\n\n" +
            "Alternative: if the worker auto-paused on a UDF exception (EXCEPTION_PAUSE), you can call debugPython " +
            "directly without pausing first; that path is also fine.",
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
      // Reject bare `cl` / `clear`. Pdb's do_clear with no arg falls back to
      // `input('Clear all breaks? ')`, which reads sys.stdin — but Python
      // workers are spawned with `BasicIO.standard(false)`, i.e. stdin
      // closed. The input() raises EOFError, the handler treats reply as
      // 'no', and nothing is cleared. The agent then thinks the breakpoints
      // are gone when they aren't. Force a parameter so `do_clear` takes
      // the unambiguous path.
      const trimmed = cmd.trim();
      if (trimmed === "cl" || trimmed === "clear") {
        return createErrorResult(
          "Bare `cl` / `clear` is unusable here: pdb tries to read its 'Clear all breaks?' " +
            "confirmation from sys.stdin, but the Python worker is launched with stdin closed " +
            "(`BasicIO.standard(false)`). The input() raises EOFError, pdb treats it as 'no', " +
            "and no breakpoints are cleared.\n\n" +
            "Use one of these instead:\n" +
            "  - `cl N` to clear breakpoint at line N (e.g. 'cl 7')\n" +
            "  - `cl <bpnum>` to clear a specific breakpoint by its 1-based id (run `info break` first)",
        );
      }
      // Validate workerId against the real actor identities. Engine routes
      // the debug RPC via ActorVirtualIdentity(workerId); a wrong/guessed id
      // (e.g. "worker-0") matches no actor and silently lands in the
      // dead-letter queue — caller sees only the COMMAND echo, never any
      // DEBUGGER output. Real ids look like "WF4-PythonUDFV2-9a31a1-main-0".
      const knownWorkers = snap0.workerIdsByOperator[operatorId] ?? [];
      if (knownWorkers.length > 0 && !knownWorkers.includes(workerId)) {
        return createErrorResult(
          `Worker '${workerId}' is not assigned to operator '${operatorId}'. ` +
            `Known workers for this operator: ${knownWorkers.join(", ")}. ` +
            `Use one of those exact ids — engine routes the debug RPC by actor identity, ` +
            `so a guessed id like "worker-0" goes to the dead-letter queue and nothing happens.`,
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
  const liveModifyOperator = tool({
    description:
      "Queue a hot-replace of an operator's properties (typically the code field of a Python UDF) for a paused execution. " +
      "The engine validates the change synchronously (returned in this tool's result). Application happens on the NEXT " +
      "resumeExecution / retryCurrentTuple — do not expect new code to take effect until you resume. " +
      "Typical loop: wait for the worker to auto-pause on a UDF exception (or hit a `b N` breakpoint via debugPython) → " +
      "debugPython to inspect tuple_/state → liveModifyOperator → retryCurrentTuple or resumeExecution. " +
      "Requires the execution to be Paused. Properties are merged onto the existing ones (shallow); existing keys " +
      "you don't mention are preserved. Schema-changing edits (port count, output schema) are NOT supported here — " +
      "use the design-time modifyOperator tool and re-run the workflow for those.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator to modify."),
      properties: z
        .record(z.any())
        .describe("Partial properties object to merge. For Python UDFs, typically `{ code: '<full updated code>' }`."),
    }),
    execute: async ({ operatorId, properties }) => {
      const watcher = watcherSlot.get();
      if (!watcher) {
        return createErrorResult("No execution in flight. Call startExecution first, then pauseExecution before liveModifyOperator.");
      }
      const snap = watcher.getSnapshot();
      if (snap.currentState !== "Paused") {
        return createErrorResult(
          rejectWithStateHint("liveModifyOperator", "Paused state", snap.currentState, true, snapshotHasAutoPausedOperator(snap)),
        );
      }
      const operator = workflowState.getOperator(operatorId);
      if (!operator) {
        return createErrorResult(`Operator '${operatorId}' not found in the workflow.`);
      }

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
      "after fixing the code, call retryCurrentTuple to re-run the row that triggered the original failure. " +
      "Requires the execution to be Paused, and the operator must have at least one assigned worker.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator whose workers should retry their current tuple."),
    }),
    execute: async ({ operatorId }) => {
      const watcher = watcherSlot.get();
      if (!watcher) return createErrorResult("No execution in flight.");
      const snap = watcher.getSnapshot();
      if (snap.currentState !== "Paused") {
        return createErrorResult(
          rejectWithStateHint("retryCurrentTuple", "Paused state", snap.currentState, true, snapshotHasAutoPausedOperator(snap)),
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
            `Use resumeExecution to continue (which will block until the next significant event).`,
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
      "The # Active Execution section only shows ERROR-level messages by default; this tool returns all levels. " +
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
      const slice = filtered.slice(-cap).reverse();
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
