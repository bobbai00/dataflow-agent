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
 * Context assembler — builds the model's context as a single structured
 * user message containing completed tasks, the ongoing task, and the
 * current workflow DAG with execution results.
 */

import type { ModelMessage } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import type { OperatorPredicate, OperatorPortSchemaMap, PortSchema } from "../types/workflow";
import type { ReActStep } from "../types/agent";
import type { WorkflowCompilationResponse, WorkflowFatalError } from "../api/compile-api";
import { extractOperatorInputPortSchemaMap } from "../workflow/workflow-util";
import type { ExecutionWatcherSnapshot } from "./execution-watcher";

/**
 * Build the full model context as a single user message.
 *
 * Layout:
 *   # Completed Tasks
 *   <task status="completed">...</task>
 *   ...
 *   # Ongoing Task
 *   <task status="ongoing">...</task>
 *   (instruction line)
 *   # Current Workflow
 *   <operator ...>...</operator>
 *   <links>...</links>
 *
 * @param visibleSteps  - ReActSteps on the HEAD ancestor path (ordered root→HEAD)
 * @param workflowState - Live workflow state
 * @param operatorExecutionResults - Map of operatorId → formatted result text
 * @param useRedact     - If true, strip operator properties (except for errored operators)
 * @param compilationResult - Optional compilation response with output schemas and errors (general mode only)
 * @returns Single-element ModelMessage array with the assembled context
 */
export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>,
  useRedact: boolean = false,
  compilationResult?: WorkflowCompilationResponse | null,
  executionSnapshot?: ExecutionWatcherSnapshot | null,
  /**
   * Snapshot at the moment the most recent `awaitExecution` returned, plus the
   * wall-clock time of that wake. When provided, the # Active Execution
   * section renders deltas (output growth, throughput, stall, transitions)
   * relative to that snapshot.
   */
  executionSnapshotAtLastWake?: { snapshot: ExecutionWatcherSnapshot; atMs: number } | null
): ModelMessage[] {
  // Group steps by messageId, preserving insertion order
  const messageIds: string[] = [];
  const stepsByMessage = new Map<string, ReActStep[]>();
  for (const step of visibleSteps) {
    let group = stepsByMessage.get(step.messageId);
    if (!group) {
      group = [];
      stepsByMessage.set(step.messageId, group);
      messageIds.push(step.messageId);
    }
    group.push(step);
  }

  const sections: string[] = [];
  let completedCount = 0;
  let hasOngoing = false;

  // Determine completed vs ongoing: a task is ongoing if none of its steps has isEnd=true
  for (const msgId of messageIds) {
    const steps = stepsByMessage.get(msgId)!;
    // A task is completed when an agent step has isEnd=true (not user steps,
    // which always have isEnd=true as they are single-step messages).
    const isCompleted = steps.some(s => s.role === "agent" && s.isEnd);

    if (isCompleted) {
      if (completedCount === 0) {
        sections.push("# Completed Tasks");
      }
      sections.push(serializeTask(steps, "completed"));
      completedCount++;
    } else {
      hasOngoing = true;
      sections.push("");
      sections.push("# Ongoing Task");
      sections.push(serializeTask(steps, "ongoing"));
      sections.push("");
      sections.push("Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow.");
    }
  }

  // --- Active Execution (between Ongoing Task and Current Workflow) ---
  if (executionSnapshot) {
    const activeExecutionSection = serializeActiveExecution(executionSnapshot, executionSnapshotAtLastWake ?? null);
    if (activeExecutionSection) {
      sections.push("");
      sections.push("# Active Execution");
      sections.push(activeExecutionSection);
    }
  }

  // --- Current Workflow ---
  const dagSection = serializeDag(workflowState, operatorExecutionResults, useRedact, compilationResult, executionSnapshot);
  if (dagSection) {
    sections.push("");
    sections.push("# Current Workflow");
    sections.push(dagSection);
  }

  const content = sections.join("\n");

  console.log(
    `[ContextAssembler] Built context: ${completedCount} completed tasks, ` +
      `${hasOngoing ? 1 : 0} ongoing, ${operatorExecutionResults.size} operator results, ` +
      `${executionSnapshot ? `executionState=${executionSnapshot.currentState}` : "no active execution"}, useRedact: ${useRedact}`
  );

  return [{ role: "user", content }];
}

// ============================================================================
// Active Execution Serialization
// ============================================================================

function formatElapsedSeconds(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m${remSec}s`;
}

/**
 * Serialize the active execution snapshot. Returns null if there's nothing
 * worth showing (snapshot exists but is empty/uninitialized).
 *
 * Layout:
 *   - Status line with elapsed times (historical, from `mostRecent*` fields)
 *   - Per-operator state with inline delta annotations vs. last-wake snapshot
 *     (output growth, throughput, stall warnings, state transitions)
 *   - Recent console errors (if any)
 *   - Fatal errors (if any)
 *   - "Since last wake" line (only if there's a delta worth a callout)
 *   - Soft conversational hint based on current state
 *
 * Elapsed times are computed AT CALL TIME (Date.now() vs snapshot timestamps)
 * so durations are always fresh even when the snapshot is cached across ticks.
 */
function serializeActiveExecution(
  s: ExecutionWatcherSnapshot,
  prev: { snapshot: ExecutionWatcherSnapshot; atMs: number } | null,
): string | null {
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

  // ── Per-operator state with delta annotations ──
  const opEntries = Object.entries(s.perOperatorState);
  if (opEntries.length > 0) {
    lines.push("");
    lines.push("Per-operator state:");
    for (const [opId, st] of opEntries) {
      const main = `${st.state} (input: ${st.inputTupleCount} rows, output: ${st.outputTupleCount} rows, workers: ${st.numWorkers})`;
      const delta = renderOperatorDelta(opId, st, prev, now);
      lines.push(`  - ${opId}: ${main}${delta ? `; ${delta}` : ""}`);
    }
  }

  // ── Recent console errors ──
  if (s.recentConsoleErrors.length > 0) {
    lines.push("");
    lines.push(`Recent console errors (${s.recentConsoleErrors.length}, most recent first):`);
    const recentMost = s.recentConsoleErrors.slice(-3).reverse();
    for (const err of recentMost) {
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

  // ── "Since last wake" callout — only if there's something worth saying ──
  const sinceLastWake = renderSinceLastWake(s, prev, now);
  if (sinceLastWake.length > 0) {
    lines.push("");
    lines.push("Since last wake:");
    for (const line of sinceLastWake) lines.push(`  - ${line}`);
  }

  // ── Conversational hint based on current state ──
  const hint = availableActionsHint(s.currentState);
  if (hint) {
    lines.push("");
    lines.push(hint);
  }

  return lines.join("\n");
}

/**
 * Render a per-operator delta annotation: throughput, stall, or state
 * transition vs. the last-wake snapshot. Returns null if no prev or no
 * notable delta.
 */
function renderOperatorDelta(
  opId: string,
  current: { state: string; outputTupleCount: number; inputTupleCount: number },
  prev: { snapshot: ExecutionWatcherSnapshot; atMs: number } | null,
  now: number,
): string | null {
  if (!prev) return null;
  const prevOp = prev.snapshot.perOperatorState[opId];
  const elapsedMs = now - prev.atMs;
  if (elapsedMs <= 0) return null;

  // State transition takes precedence
  if (prevOp && prevOp.state !== current.state) {
    return `transitioned ${prevOp.state} → ${current.state} since last wake`;
  }

  // Output delta
  if (!prevOp) {
    // Operator is new since last wake (rare — usually start-of-execution case)
    if (current.outputTupleCount > 0) return `+${current.outputTupleCount} rows so far`;
    return null;
  }
  const outDelta = current.outputTupleCount - prevOp.outputTupleCount;
  const elapsedSec = elapsedMs / 1000;

  // Stall: no output growth and the operator is in a state where progress is expected
  const expectingProgress = current.state === "Running";
  if (outDelta === 0 && expectingProgress && elapsedSec >= 5) {
    return `no progress in last ${formatElapsedSeconds(elapsedMs)}`;
  }

  if (outDelta > 0) {
    const ratePerSec = outDelta / elapsedSec;
    const rateStr =
      ratePerSec >= 100 ? `~${Math.round(ratePerSec)} rows/sec` : `~${ratePerSec.toFixed(1)} rows/sec`;
    const etaStr = renderEta(current, prevOp, ratePerSec);
    return `+${outDelta} rows in last ${formatElapsedSeconds(elapsedMs)}, ${rateStr}${etaStr ? `, ${etaStr}` : ""}`;
  }

  return null;
}

/**
 * Render an ETA annotation when we can make a defensible estimate. Conditions:
 *   - operator is still actively producing (rate > 0)
 *   - there's a measurable backlog (input count exceeds output count)
 *   - input has stopped growing since last wake (signals upstream is done; if
 *     it's still feeding, ETA would underestimate). Falls back to a "drain
 *     current backlog" framing that the LLM can read as a lower bound.
 *
 * Skipped silently otherwise — we'd rather omit ETA than mislead.
 */
function renderEta(
  current: { inputTupleCount: number; outputTupleCount: number },
  prevOp: { inputTupleCount: number; outputTupleCount: number },
  ratePerSec: number,
): string | null {
  if (ratePerSec <= 0) return null;
  const remaining = current.inputTupleCount - current.outputTupleCount;
  if (remaining <= 0) return null;

  const inputStable = current.inputTupleCount === prevOp.inputTupleCount;
  const etaSec = remaining / ratePerSec;
  if (!isFinite(etaSec) || etaSec < 1) return null;
  const etaMs = etaSec * 1000;
  // Cap absurdly long ETAs — past a point, the number is just noise.
  if (etaSec > 24 * 3600) return null;

  return inputStable
    ? `ETA ~${formatElapsedSeconds(etaMs)} to finish current input`
    : `~${formatElapsedSeconds(etaMs)} to drain current backlog (input still growing)`;
}

/**
 * Build the "Since last wake:" callout lines: state transitions at the
 * workflow level, new fatal errors, new console errors. Per-operator
 * deltas are already inline; this is for cross-cutting changes.
 */
function renderSinceLastWake(
  s: ExecutionWatcherSnapshot,
  prev: { snapshot: ExecutionWatcherSnapshot; atMs: number } | null,
  _now: number,
): string[] {
  if (!prev) return [];
  const out: string[] = [];

  if (prev.snapshot.currentState !== s.currentState) {
    out.push(`workflow state changed: ${prev.snapshot.currentState} → ${s.currentState}`);
  }

  const newFatals = s.fatalErrors.length - prev.snapshot.fatalErrors.length;
  if (newFatals > 0) {
    out.push(`${newFatals} new fatal error(s) (see above)`);
  }

  const newConsoleErrs = s.recentConsoleErrors.length - prev.snapshot.recentConsoleErrors.length;
  if (newConsoleErrs > 0) {
    out.push(`${newConsoleErrs} new console error(s) (see above)`);
  }

  return out;
}

/**
 * Conversational nudge based on the execution's current state.
 *
 * These are *guidance for the agent's reasoning*, not API references.
 * Avoid listing tool names — the model already has the tool catalog. The goal
 * here is to remind the agent what makes sense to do next in plain language,
 * so it doesn't fall into action-tool-report register in user-facing replies.
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

// ============================================================================
// Task Serialization
// ============================================================================

/**
 * Serialize a task (one user message + its assistant steps) into XML-like format.
 */
function serializeTask(steps: ReActStep[], status: "completed" | "ongoing"): string {
  const lines: string[] = [];
  lines.push(`<task status="${status}">`);

  const userStep = steps.find(s => s.role === "user");
  const assistantSteps = steps.filter(s => s.role === "agent");

  // User request
  if (userStep) {
    lines.push(`<user-request>`);
    lines.push(userStep.content);
    lines.push(`</user-request>`);
  }

  // Assistant steps
  // Wrapper used to be `<assistant-stepN>...</assistant-stepN>`. We saw the
  // LLM continue that templated pattern in its own output (treating the
  // history's record-keeping format as a model). The neutral `<step n="N">`
  // shape with N as an attribute reads as data, not as a continuable element
  // name, and removes the hallucination temptation.
  for (const step of assistantSteps) {
    lines.push("");
    lines.push(`<step n="${step.stepId}">`);
    if (step.content) {
      lines.push(`<thought>${step.content}</thought>`);
    }
    if (step.toolCalls && step.toolCalls.length > 0) {
      for (let i = 0; i < step.toolCalls.length; i++) {
        const tc = step.toolCalls[i];
        const tr = step.toolResults?.[i];
        const isError = tr?.isError;
        const statusAttr = isError ? "failed" : "succeeded";
        const outputStr = tr ? (typeof tr.output === "string" ? tr.output : String(tr.output ?? "")) : "";
        lines.push(`<action tool="${tc.toolName}" status="${statusAttr}">${outputStr}</action>`);
      }
    }
    lines.push(`</step>`);
  }

  lines.push(`</task>`);
  return lines.join("\n");
}

// ============================================================================
// DAG Serialization
// ============================================================================

/**
 * Serialize the workflow into XML-like operator entries with links.
 */
function serializeDag(
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>,
  useRedact: boolean,
  compilationResult?: WorkflowCompilationResponse | null,
  executionSnapshot?: ExecutionWatcherSnapshot | null,
): string | null {
  const allOperators = workflowState.getAllOperators();
  if (allOperators.length === 0) return null;

  const lines: string[] = [];

  // Build topological ordering
  const allLinks = workflowState.getAllLinks();
  const opIds = new Set(allOperators.map(op => op.operatorID));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of opIds) {
    inDegree.set(id, 0);
    children.set(id, []);
  }
  for (const link of allLinks) {
    children.get(link.source.operatorID)?.push(link.target.operatorID);
    inDegree.set(link.target.operatorID, (inDegree.get(link.target.operatorID) ?? 0) + 1);
  }
  const queue: string[] = [...opIds].filter(id => (inDegree.get(id) ?? 0) === 0);
  const topoOrder = new Map<string, number>();
  let rank = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    topoOrder.set(node, rank++);
    for (const child of children.get(node) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  const sortedOps = [...allOperators].sort(
    (a, b) => (topoOrder.get(a.operatorID) ?? 0) - (topoOrder.get(b.operatorID) ?? 0)
  );

  // Pre-compute per-operator input schemas from compilation output schemas + links
  const outputSchemas = compilationResult?.operatorOutputSchemas ?? {};
  const compilationErrors = compilationResult?.operatorErrors ?? {};

  for (const op of sortedOps) {
    const inputSchemaMap = extractOperatorInputPortSchemaMap(op.operatorID, op, outputSchemas, allLinks);
    const outputSchemaMap = outputSchemas[op.operatorID];
    const compilationError = compilationErrors[op.operatorID];
    const enginePerOpState = executionSnapshot?.perOperatorState[op.operatorID]?.state;
    lines.push(serializeOperator(
      op,
      operatorExecutionResults.get(op.operatorID),
      useRedact,
      enginePerOpState,
      inputSchemaMap,
      outputSchemaMap,
      compilationError,
    ));
  }

  // Links section
  if (allLinks.length > 0) {
    const sortedLinks = [...allLinks].sort((a, b) => {
      const srcA = topoOrder.get(a.source.operatorID) ?? 0;
      const srcB = topoOrder.get(b.source.operatorID) ?? 0;
      if (srcA !== srcB) return srcA - srcB;
      return (topoOrder.get(a.target.operatorID) ?? 0) - (topoOrder.get(b.target.operatorID) ?? 0);
    });

    lines.push("");
    lines.push("<links>");
    for (const link of sortedLinks) {
      lines.push(`${link.source.operatorID} --> ${link.target.operatorID}`);
    }
    lines.push("</links>");
  }

  return lines.join("\n");
}

/**
 * Map engine-truth (when present) or fallback proxy to a status string.
 * Engine state wins; the proxy only kicks in for legacy paths with no
 * active execution snapshot.
 */
function computeOperatorStatus(
  enginePerOpState: string | undefined,
  execResult: string | undefined,
  hasError: boolean,
): string {
  if (enginePerOpState) {
    switch (enginePerOpState) {
      case "Completed": return "executed";
      case "CompletedFromCache": return "executed-from-cache";
      case "Failed": return "failed";
      case "Running": return "running";
      case "Paused":
      case "Pausing": return "paused";
      default: return "not-executed"; // Ready, Uninitialized, Resuming, …
    }
  }
  if (hasError) return "failed";
  if (execResult) return "executed";
  return "not-executed";
}

/**
 * Serialize a single operator entry.
 */
function serializeOperator(
  op: OperatorPredicate,
  execResult: string | undefined,
  useRedact: boolean,
  enginePerOpState: string | undefined,
  inputSchemaMap?: OperatorPortSchemaMap,
  outputSchemaMap?: OperatorPortSchemaMap,
  compilationError?: WorkflowFatalError,
): string {
  const hasError = execResult !== undefined && execResult.includes("[ERROR]");
  // Status comes from the engine's per-operator state when an active
  // execution is present — that's the authoritative answer. The
  // result-store-as-proxy fallback exists only for the case where the
  // agent never had an active WS execution (e.g. synchronous-HTTP era),
  // and only signals whether *the agent fetched* the result, not whether
  // the engine ran the operator. Don't confuse the two.
  const status = computeOperatorStatus(enginePerOpState, execResult, hasError);

  const summary = op.customDisplayName || op.operatorID;
  const showProperties = !useRedact || hasError;

  const lines: string[] = [];
  lines.push(`<operator type="${op.operatorType}" id="${op.operatorID}" status="${status}">`);
  lines.push(`  Summary: ${summary}`);

  // Input schemas (derived from upstream operators' output schemas)
  if (inputSchemaMap) {
    for (const [portId, schema] of Object.entries(inputSchemaMap)) {
      if (schema) {
        lines.push(`  Input Schema (port ${parsePortIndex(portId)}): ${formatSchema(schema)}`);
      }
    }
  }

  if (showProperties) {
    const props = op.operatorProperties;
    if (props && Object.keys(props).length > 0) {
      lines.push(`  Properties:`);
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined && value !== null && value !== "") {
          const valueStr = typeof value === "string" ? value : JSON.stringify(value);
          lines.push(`    ${key}: ${valueStr}`);
        }
      }
    }
  }

  // Output schema (from compilation) — assume single output port
  if (outputSchemaMap) {
    const firstSchema = Object.values(outputSchemaMap).find(s => s !== undefined);
    if (firstSchema) {
      lines.push(`  Output Schema: ${formatSchema(firstSchema)}`);
    }
  }

  // Compilation error
  if (compilationError) {
    lines.push(`  Compilation Error: ${compilationError.message}`);
  }

  if (execResult) {
    lines.push(`  Result:`);
    const indented = execResult.split("\n").map(l => "  " + l).join("\n");
    lines.push(indented);
  }

  lines.push(`</operator>`);
  return lines.join("\n");
}

/**
 * Format a port schema as a compact bracket notation.
 * Example: [name: string, age: integer, city: string]
 */
function formatSchema(schema: PortSchema): string {
  const attrs = schema.map(a => `${a.attributeName}: ${a.attributeType}`);
  return `[${attrs.join(", ")}]`;
}

/**
 * Extract the port index from a serialized port identity (e.g. "0_false" → "0").
 */
function parsePortIndex(portId: string): string {
  const idx = portId.indexOf("_");
  return idx >= 0 ? portId.substring(0, idx) : portId;
}
