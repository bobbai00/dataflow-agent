/**
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
 * Renders the live execution context for the `executionControl` (WS) mode:
 *
 *   - **Recent execution events** — the pre-rendered narrative of each
 *     `role:"execution"` ReActStep drained from the watcher mailbox between
 *     agent steps (`renderMailboxAsExecutionMessage`), filtered to the current
 *     execution so observations from a now-invalidated prior run are dropped.
 *   - **Current execution state** — the live `ExecutionWatcherSnapshot`
 *     (per-operator states, worker ids, console/fatal errors, an allowed-actions
 *     matrix), re-derived fresh each turn.
 *
 * This is appended to the assembled context as a single `# Execution` section,
 * mode-independent (works under both DELTA and LATEST) — the execution-role
 * steps never flow through the snapshot-path renderers. Ported from the
 * ai-debugging branch's `serializeActiveExecution`.
 */

import type { ReActStep } from "../../types/agent";
import type { ExecutionWatcherSnapshot } from "../execution-watcher";
import { formatAllowedActions, snapshotHasAutoPausedOperator } from "../tools/ws-execution-tools";

/**
 * Build the `# Execution` context block. Returns null when there is nothing
 * worth showing (no current execution observations AND no live execution).
 */
export function renderExecutionContext(
  visibleSteps: ReActStep[],
  snapshot: ExecutionWatcherSnapshot | null | undefined,
  currentRenderedExecutionName: string | null | undefined
): string | null {
  const execSteps = filterCurrentExecutionSteps(visibleSteps, currentRenderedExecutionName ?? null);
  const activeSection =
    snapshot && snapshot.currentState !== "Uninitialized" ? serializeActiveExecution(snapshot) : null;

  if (execSteps.length === 0 && !activeSection) return null;

  const lines: string[] = ["# Execution"];

  if (execSteps.length > 0) {
    lines.push("");
    lines.push("## Recent execution events");
    for (const step of execSteps) {
      lines.push("");
      lines.push(step.content);
    }
  }

  if (activeSection) {
    lines.push("");
    lines.push("## Current execution state");
    lines.push(activeSection);
  }

  return lines.join("\n");
}

/**
 * Keep only `role:"execution"` steps belonging to the current execution.
 * When `currentRenderedExecutionName` is null (e.g. after a DAG edit), ALL
 * execution steps are dropped — they refer to a now-meaningless prior run.
 * The steps remain in the step tree for replay/audit; this only changes what
 * the model sees.
 */
function filterCurrentExecutionSteps(
  steps: ReActStep[],
  currentRenderedExecutionName: string | null
): ReActStep[] {
  if (currentRenderedExecutionName === null) return [];
  return steps.filter(s => s.role === "execution" && s.executionName === currentRenderedExecutionName);
}

function formatElapsedSeconds(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m${remSec}s`;
}

/**
 * Serialize the active execution snapshot. Elapsed times are computed AT CALL
 * TIME so durations stay fresh even when the snapshot is cached across ticks.
 */
function serializeActiveExecution(s: ExecutionWatcherSnapshot): string {
  const lines: string[] = [];
  const now = Date.now();

  // ── Status line ──
  let statusLine = `Status: ${s.currentState}`;
  if (s.mostRecentStartedAt) {
    statusLine += `, started ${formatElapsedSeconds(now - s.mostRecentStartedAt)} ago`;
  }
  if (s.currentState === "Paused" && s.mostRecentPausedAt) {
    statusLine += `, paused ${formatElapsedSeconds(now - s.mostRecentPausedAt)} ago`;
  }
  if (s.mostRecentCompletedAt) {
    statusLine += `, finished ${formatElapsedSeconds(now - s.mostRecentCompletedAt)} ago`;
  }
  lines.push(statusLine);

  // ── Per-operator state ──
  const opEntries = Object.entries(s.perOperatorState);
  if (opEntries.length > 0) {
    lines.push("");
    lines.push("Per-operator state:");
    for (const [opId, st] of opEntries) {
      lines.push(
        `  - ${opId}: ${st.state} (input: ${st.inputTupleCount} rows, output: ${st.outputTupleCount} rows, workers: ${st.numWorkers})`
      );
      // Surface actual worker actor ids so debugPython / retryCurrentTuple can
      // target a specific worker by its real engine identity (e.g.
      // "WF4-PythonUDFV2-9a31a1-main-0"). The engine routes the RPC by
      // ActorVirtualIdentity(workerId); a guessed id lands in the dead-letter
      // queue with no error to the caller.
      const workers = s.workerIdsByOperator[opId] ?? [];
      if (workers.length > 0) {
        lines.push(`      worker ids: ${workers.join(", ")}`);
      }
    }
  }

  // ── Recent console errors ──
  if (s.recentConsoleErrors.length > 0) {
    lines.push("");
    lines.push(`Recent console errors (${s.recentConsoleErrors.length}, most recent first):`);
    for (const err of s.recentConsoleErrors.slice(-3).reverse()) {
      const truncMsg = err.message.length > 200 ? err.message.slice(0, 200) + "..." : err.message;
      lines.push(`  - [${err.workerId}] ${err.title}: ${truncMsg}`);
    }
  }

  // ── Fatal errors ──
  if (s.fatalErrors.length > 0) {
    lines.push("");
    lines.push(`Fatal errors (${s.fatalErrors.length}):`);
    for (const err of s.fatalErrors.slice(0, 3)) {
      const msg = err.message.length > 200 ? err.message.slice(0, 200) + "..." : err.message;
      lines.push(`  - ${err.type ?? "FATAL"}: ${msg}${err.operatorId ? ` (op=${err.operatorId})` : ""}`);
    }
  }

  // ── Conversational hint based on current state ──
  const hint = availableActionsHint(s.currentState);
  if (hint) {
    lines.push("");
    lines.push(hint);
  }

  // ── Allowed-actions reference (single source of truth shared with tool
  //    error messages, so the agent gets the same matrix in both places). ──
  lines.push("");
  lines.push("What you can do in this state:");
  lines.push(formatAllowedActions(s.currentState, true, snapshotHasAutoPausedOperator(s)));

  return lines.join("\n");
}

/**
 * Plain-language nudge based on current state — guidance for the agent's
 * reasoning, not an API reference (the model already has the tool catalog).
 */
function availableActionsHint(state: ExecutionWatcherSnapshot["currentState"]): string | null {
  switch (state) {
    case "Running":
      return "The workflow is in progress. You can keep watching it, or step in if something looks off (pause to inspect, or stop it).";
    case "Pausing":
      return "A pause has been requested; the engine is quiescing the workers. The next state-change wake will report when it's actually paused.";
    case "Paused":
      return "Execution is held. While paused, you can read intermediate output from any operator, then continue or abandon the run.";
    case "Resuming":
      return "Resuming. The next state-change wake will confirm the workflow is running again.";
    case "Completed":
      return "Done. Final outputs are available for inspection.";
    case "Failed":
    case "Killed":
    case "Terminated":
      return "The execution stopped before producing complete results. Check the console errors and fatal errors above to diagnose.";
    default:
      return null;
  }
}
