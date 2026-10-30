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

// Output uses plain markdown rather than XML-like tags to reduce format
// mimicry, where the model echoes the context shape into its output instead
// of calling tools via the native protocol.

import type { ModelMessage } from "ai";
import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { ReActStep } from "../../types/agent";
import type { SnapshotData, WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { retiredPreviews } from "../native/selection";
import { asNativeBatchResult, batchObservedIds, TOOL_NAME_DATAFLOW } from "../tools/native-batch-tools";
import { asDataflowActionsResult, renderDataflowActionsResult } from "../tools/dataflow-actions";
import { formatOperatorResult } from "../tools/result-formatting";
import { observationFormat, type ObservationFormatOptions } from "../native/observation-format";
import { buildNativeFrames } from "../context/summarize/native-frames";
import type { FormatOperatorResultOptions } from "../tools/result-formatting";
import { createLogger } from "../../logger";

/** The operator a tool call wrote: `operatorId` (the operator tools of older
 *  traces) or `id` (the typed tools' deleteOperator). Undefined for read-only
 *  tools and for the `dataflow` program, which writes several operators (see
 *  its receipt). */
export function writtenOperatorId(toolName: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  if (typeof inp.operatorId === "string" && inp.operatorId) return inp.operatorId;
  if (toolName === "deleteOperator" && typeof inp.id === "string" && inp.id) return inp.id;
  return undefined;
}

const log = createLogger("ContextAssembler");

export interface AssembleContextOptions extends ObservationFormatOptions {
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  /** Called once per rendered agent event with the step that produced it, so
   *  the message builder can emit that step's REAL tool calls (true
   *  toolCallIds) instead of inferring them from the rendered text. */
  eventStepSink?: (eventIndex: number, step: ReActStep) => void;
  /** W1: cap the per-operator TSV sample to first+last N rows (true row count).
   *  0/undefined = no cap. */
  maxResultRows?: number;
  /** The arm's per-operator result character budget (the engine-side sample
   *  cap). Undefined ⇒ 2000, the campaign default. */
  maxOperatorResultCharLimit?: number;
  /** V2 exposure and budget. Derived from the data/flow settings when absent,
   * not a second budget. */
  nativeEvidence?: {
    data: boolean;
    flow: boolean;
    maxChars: number;
    dataMaxChars?: number;
    flowMaxChars?: number;
  } & ObservationFormatOptions;
}

/**
 * Build the assembled context the LLM sees on the next `prepareStep`. A
 * context is a path on the snapshot tree from the root (empty snapshot) to the
 * leaf (current snapshot). Each edge on the path is rendered as `## Agent
 * Event N` (thought + actions) followed by an observation that shows only the
 * operators that changed at that event (delta), and each request stays at its
 * position among the events.
 *
 * Action rendering: the tool calls of an event render in tool-call form (see
 * serializeTurn), and the transcript replaces that text with the assistant
 * turn's tool-call parts (buildNativeFrames).
 */
export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  options: AssembleContextOptions
): ModelMessage[] {
  // The transcript carries the step that produced each rendered event, so each
  // event's REAL tool calls (true toolCallIds) frame it.
  const stepByEvent = new Map<number, ReActStep>();
  const text = renderContextCore(visibleSteps, workflowState, snapshotStorage, {
    ...options,
    eventStepSink: (eventIndex, step) => stepByEvent.set(eventIndex, step),
  });
  return buildNativeFrames(text, stepByEvent).messages;
}

/**
 * The context as markdown, before the transcript frames it: every event of the
 * path as Thought / Action / Observation. Renders from its own copy of the
 * options it reads.
 */
export function renderContextCore(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  given: AssembleContextOptions
): string {
  const options: AssembleContextOptions = {
    nativeEvidence: given.nativeEvidence ?? {
      ...observationFormat(given),
      data: given.dataEvidence === true,
      flow: given.flowEvidence === true,
      maxChars: given.maxOperatorResultCharLimit ?? 2000,
    },
    maxResultRows: given.maxResultRows ?? 0,
    eventStepSink: given.eventStepSink,
  };
  const { path, initSnapshot } = buildPath(visibleSteps, snapshotStorage);
  const tasks = groupIntoTasks(path);

  // Per-step create-vs-modify flags, from one linear walk over the path.
  const createFlagsByStep = buildCreateFlagsByStep(path);
  const content = renderInterleaved(tasks, workflowState, options, initSnapshot, createFlagsByStep);

  log.debug(
    {
      tasks: tasks.length,
      pathLength: path.length,
      actionBearing: path.filter(n => n.snapshot !== undefined).length,
      initExcluded: initSnapshot !== undefined,
    },
    "built context"
  );

  return content;
}

/* ============================================================================
 *  Path & task grouping
 * ========================================================================= */

/**
 * One node on the event path: the ReAct step itself plus its destination
 * snapshot when the step is action-bearing (carries tool calls). Action-less
 * steps (user message, plain reply, parse error) have `snapshot = undefined`.
 *
 * `eventIndex` is a 1-based counter assigned in path order. It drives the
 * `# Event N (...)` heading so users see a single flat numbering across the
 * whole context — independent of the underlying ReAct step IDs (which restart
 * per messageId and are 0-based).
 */
interface PathNode {
  step: ReActStep;
  snapshot: SnapshotData | undefined;
  eventIndex: number;
}

/**
 * The synthetic `initialize` step (Event 0) is the baseline workflow load,
 * not a user-visible action. We strip it from the rendered path so the LLM
 * doesn't see the init event, but we preserve its snapshot separately so
 * the first real action can still diff against it (Delta).
 *
 * Identified by the synthetic `initialize` tool call; matches what
 * `recordInitializationStep` emits in texera-agent.ts.
 */
function isInitStep(step: ReActStep): boolean {
  if (step.role !== "agent") return false;
  if (!step.toolCalls || step.toolCalls.length !== 1) return false;
  return step.toolCalls[0].toolName === "initialize";
}

interface BuiltPath {
  /** Visible events in chronological order. The init step (Event 0) is
   *  filtered out here, so `eventIndex` numbers start at 1. */
  path: PathNode[];
  /** Snapshot captured at the init step, if it was on the input path. Used
   *  to seed delta diffing. */
  initSnapshot: SnapshotData | undefined;
}

function buildPath(visibleSteps: ReActStep[], storage: WorkflowSnapshotStorage): BuiltPath {
  let initSnapshot: SnapshotData | undefined;
  const remaining: ReActStep[] = [];
  for (const step of visibleSteps) {
    if (isInitStep(step)) {
      // Capture init's snapshot once for downstream use, then drop the step.
      if (storage.hasSnapshotFor(step.id)) {
        initSnapshot = storage.getAssociatedSnapshot(step.id);
      }
      continue;
    }
    remaining.push(step);
  }
  const path: PathNode[] = remaining.map((step, i) => ({
    step,
    snapshot: storage.hasSnapshotFor(step.id) ? storage.getAssociatedSnapshot(step.id) : undefined,
    eventIndex: i + 1,
  }));
  return { path, initSnapshot };
}

interface TaskGroup {
  /** Path nodes belonging to this task, in chronological order. */
  nodes: PathNode[];
  /** `true` once any agent step in the group has `isEnd=true` — i.e. the
   *  LLM declared the task done. */
  isCompleted: boolean;
}

function groupIntoTasks(path: PathNode[]): TaskGroup[] {
  const byMessageId = new Map<string, PathNode[]>();
  const order: string[] = [];
  for (const node of path) {
    let g = byMessageId.get(node.step.messageId);
    if (!g) {
      g = [];
      byMessageId.set(node.step.messageId, g);
      order.push(node.step.messageId);
    }
    g.push(node);
  }
  return order.map(id => {
    const nodes = byMessageId.get(id)!;
    return { nodes, isCompleted: nodes.some(n => n.step.role === "agent" && n.step.isEnd) };
  });
}

/* ============================================================================
 *  Create / modify / delete flag computation
 *
 *  A single linear walk over the full path classifies every operator a step
 *  landed as either "create" or "modify": a `dataflow` receipt says which, and
 *  an `addOperators` batch's operator is a create when its id was not already
 *  known in the path's accumulated state. `deleteOperator` calls remove the id
 *  from the known set so a later add of the same id reads as `create` again,
 *  which matches the workflow's actual lifecycle.
 *
 *  The output is keyed by `step.id` so renderers can look up per-event
 *  flags without re-walking the path each time.
 * ========================================================================= */

function buildCreateFlagsByStep(fullPath: PathNode[]): Map<string, Map<string, boolean>> {
  const result = new Map<string, Map<string, boolean>>();
  const known = new Set<string>();
  for (const node of fullPath) {
    if (node.step.role !== "agent" || !node.step.toolCalls) continue;
    const eventFlags = new Map<string, boolean>();
    for (const tc of node.step.toolCalls) {
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      if (tc.toolName === TOOL_NAME_DATAFLOW) {
        const receipt = asNativeBatchResult(node.step.toolResults?.find(r => r.toolCallId === tc.toolCallId)?.output);
        for (const outcome of receipt?.operators ?? []) {
          if (outcome.status !== "added" && outcome.status !== "modified") continue;
          eventFlags.set(outcome.id, outcome.status === "added");
          known.add(outcome.id);
        }
        continue;
      }
      // NATIVE `addOperators`: every operator the batch LANDED (present in the
      // step's snapshot) is a create; a refused batch marks nothing.
      const batch = Array.isArray(inp.operators) ? (inp.operators as Array<Record<string, unknown>>) : undefined;
      if (batch) {
        const landed = new Set((node.snapshot?.workflow.operators ?? []).map(o => o.operatorID));
        for (const spec of batch) {
          const id = typeof spec?.id === "string" ? spec.id : "";
          if (!id || !landed.has(id)) continue;
          eventFlags.set(id, !known.has(id));
          known.add(id);
        }
        continue;
      }
      const opId = writtenOperatorId(tc.toolName, inp);
      if (tc.toolName === "deleteOperator" && opId) known.delete(opId);
    }
    if (eventFlags.size > 0) result.set(node.step.id, eventFlags);
  }
  return result;
}

/* ============================================================================
 *  Rendering: interleaved events
 * ========================================================================= */

/**
 * Render the agent trajectory as the sequence of per-event Thought / Action /
 * Observation bodies (delta-style). The rolling prevSnapshot (seeded by the
 * hidden init snapshot) drives the per-event "operator X added/updated" diff in
 * each Observation. Returns the joined bodies, or the empty-trajectory
 * placeholder.
 */
function renderAgentEvents(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const bodies: string[] = [];
  let prevSnapshot: SnapshotData | undefined = initSnapshot;
  for (const task of tasks) {
    const body = serializeTaskBody(
      task,
      workflowState,
      options,
      () => prevSnapshot,
      s => {
        prevSnapshot = s;
      },
      createFlagsByStep
    );
    if (body) bodies.push(body);
  }
  return bodies.length ? bodies.join("\n\n") : "(no agent actions yet)";
}

function renderInterleaved(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const sections: string[] = [];

  // # Agent Events — every event in the path as a Thought / Action /
  // Observation triplet (the Observation lists the operators changed or
  // re-executed by that event; see serializeTaskBody). The frames are a
  // conversation, so each request stays at its original position: hoisting
  // the latest request rewrites the prefix at task changes, and repeating it
  // at the tail prevents reuse after every new action.
  sections.push("# Agent Events");
  sections.push("");

  // Each event as a Thought/Action/Observation body, diffed against a rolling
  // previous snapshot (seeded by the hidden init snapshot).
  sections.push(renderAgentEvents(tasks, workflowState, options, initSnapshot, createFlagsByStep));
  sections.push("");

  return sections.join("\n").trimEnd();
}

/* ============================================================================
 *  Per-task serialization (events ± inline snapshots)
 * ========================================================================= */

/**
 * Serialize one task's user request + turns. When `flavour !== "events-only"`
 * each action-bearing turn is followed by its snapshot inline.
 */
function serializeTaskBody(
  task: TaskGroup,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  getPrev: () => SnapshotData | undefined,
  setPrev: (s: SnapshotData) => void,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const lines: string[] = [];

  for (const node of task.nodes) {
    if (node.step.role === "user") {
      lines.push(serializeUserEventInline(node));
      lines.push("");
      continue;
    }
    if (node.step.role !== "agent") continue;

    lines.push(serializeTurn(node, options, createFlagsByStep.get(node.step.id)));
    lines.push("");

    // Historical inspectResult/inspectError traces: a read-only pull's OUTPUT
    // persists inline, as an ordinary observation — snapshot or not (a pull
    // writes nothing, so it never owns a snapshot and the block below never
    // fires for it). Without persistence the output evaporates on re-render
    // and the model re-asks (measured at 98 calls in one turn).
    const pulls: string[] = [];
    (node.step.toolCalls ?? []).forEach((tc, i) => {
      if (tc.toolName !== "inspectResult" && tc.toolName !== "inspectError") return;
      const results = node.step.toolResults ?? [];
      const output = (results.find(result => result.toolCallId === tc.toolCallId) ?? results[i])?.output;
      const out = stringifyOutput(output).trimEnd();
      if (out.length === 0) return;
      pulls.push(`- ${tc.toolName} output:\n${out.replace(/^#/gm, "####")}`);
    });
    if (pulls.length > 0) {
      lines.push("Observation:");
      lines.push("");
      lines.push(pulls.join("\n"));
      lines.push("");
    }

    const actionResults = (node.step.toolResults ?? [])
      .map(tr => asDataflowActionsResult(tr.output))
      .filter(r => r !== undefined);
    if (actionResults.length) {
      lines.push("Observation:", "", ...actionResults.map(renderDataflowActionsResult), "");
      if (node.snapshot) setPrev(node.snapshot);
    }
    if (node.snapshot && !actionResults.length) {
      // Observation = the execution outcome of the Action: a per-operator list.
      // Every operator that CHANGED or RE-EXECUTED this step (the Δ — incl.
      // downstream ops refreshed by runPostStepExecution, via computeDelta case
      // c) renders as `- operator <id> <added|updated|deleted>` followed by its
      // result. On error the result keeps the engine's exception + `at line N`
      // pointer + the `Operator code:` block (self-contained — the failing line
      // shown in context; see renderRawResult).
      const prev = getPrev();
      const delta = computeDelta(prev, node.snapshot);
      const createFlags = createFlagsByStep.get(node.step.id);
      const calls = node.step.toolCalls ?? [];
      const results = node.step.toolResults ?? [];

      // Verb for each directly-acted operator (create→added, modify→updated);
      // deletes are collected separately (a deleted op is gone from the snapshot,
      // so it never appears in Δ).
      const actedVerb = new Map<string, string>();
      const deletedOps: string[] = [];
      const noChangeOutcome: string[] = [];
      const requestedResults = batchObservedIds(node.step);
      calls.forEach((tc, i) => {
        if (tc.toolName === "inspectResult" || tc.toolName === "inspectError") return;
        const inp = tc.input as Record<string, unknown> | undefined;
        const opId = writtenOperatorId(tc.toolName, inp) ?? "";
        if (tc.toolName === TOOL_NAME_DATAFLOW) {
          const output = results.find(result => result.toolCallId === tc.toolCallId)?.output;
          const receipt = asNativeBatchResult(output);
          if (!receipt) noChangeOutcome.push(`- dataflow: ${conciseOutcome(output)}`);
          for (const outcome of receipt?.operators ?? []) {
            if (outcome.status === "added" || outcome.status === "modified") {
              actedVerb.set(outcome.id, outcome.status === "added" ? "added" : "updated");
              delta.add(outcome.id);
            } else if (outcome.status === "deleted") noChangeOutcome.push(`- deleted operator \`${outcome.id}\``);
            else
              noChangeOutcome.push(
                `- ${outcome.op === "edits" || outcome.op === "program" ? "statement" : outcome.op === "delete" ? "delete" : `${outcome.op} operator`} \`${outcome.id}\` ${outcome.status}: ${outcome.message}`
              );
          }
          for (const error of receipt?.observationErrors ?? []) noChangeOutcome.push(`- observe: ${error}`);
          return;
        }
        const batch = Array.isArray(inp?.operators) ? (inp!.operators as Array<Record<string, unknown>>) : undefined;
        if (tc.toolName === "deleteOperator" && opId) {
          // The CALL is not the fact; the post-step snapshot is. `deleteOperator`
          // is refused when the operator still feeds a consumer, or when the id
          // does not exist — reporting those as deletes told the model an
          // operator was gone while it was still in the DAG (and still rendering
          // in later observations).
          // No snapshot for this step ⇒ no evidence either way; keep the prior
          // behaviour rather than inventing a refusal.
          if (node.snapshot?.workflow.operators.some(o => o.operatorID === opId) ?? false) {
            noChangeOutcome.push(`- operator ${opId} (not deleted): ${conciseOutcome(results[i]?.output)}`);
          } else {
            deletedOps.push(opId);
          }
        } else if (batch) {
          // NATIVE `addOperators`: one verb per landed operator. A refused (or
          // partly refused) batch keeps its error as a one-line outcome, so the
          // model sees why nothing (or not everything) landed.
          let landed = 0;
          for (const spec of batch) {
            const id = typeof spec?.id === "string" ? spec.id : "";
            if (id && delta.has(id)) {
              actedVerb.set(id, createFlags?.get(id) ? "added" : "updated");
              landed++;
            }
          }
          if (landed < batch.length) {
            noChangeOutcome.push(
              `- addOperators (${batch.length - landed} of ${batch.length} not added): ${conciseOutcome(results[i]?.output)}`
            );
          }
          return;
        } else if (tc.toolName === "modifyOperator" && opId) {
          actedVerb.set(opId, "updated");
        }
        // An action whose operator isn't reflected in Δ (a rejected/no-op edit, or
        // a non-operator tool) keeps a one-line outcome so the attempt isn't lost.
        if (opId && tc.toolName !== "deleteOperator" && !delta.has(opId)) {
          noChangeOutcome.push(`- operator ${opId} (no change): ${conciseOutcome(results[i]?.output)}`);
        }
      });

      // A spent preview (see retiredPreviews) shows no result: the real scan
      // that superseded it carries the data.
      const retired = retiredPreviews(node.snapshot.workflow.operators, node.snapshot.workflow.links);

      const obs: string[] = [];
      const sharedUpstream = new Map<string, string>();
      for (const opId of deletedOps) obs.push(`- operator ${opId} deleted`);
      const { sortedOps } = topoSortDag(node.snapshot.workflow);
      for (const op of sortedOps) {
        if (!delta.has(op.operatorID) && !requestedResults?.has(op.operatorID)) continue;
        const currInfo = node.snapshot.results.get(op.operatorID)?.info;
        // `- filter operator \`id\` added` for typed operators, `- operator id added` for the others.
        obs.push(
          op.nativeOp
            ? `- ${op.nativeOp.type.toLowerCase()} operator \`${op.operatorID}\` ${currInfo?.nativeError?.phase === "attempt" ? "edit rejected (not executed)" : currInfo?.nativeError?.diagnostic.stage === "dependency" ? "blocked (not executed)" : (actedVerb.get(op.operatorID) ?? (requestedResults ? (delta.has(op.operatorID) ? "re-executed" : "observed (cached)") : "updated"))}`
            : `- operator ${op.operatorID} ${actedVerb.get(op.operatorID) ?? "updated"}`
        );
        // Successful hidden outputs keep a compact receipt. Errors bypass the
        // display choice and continue through the full error renderer below.
        if (requestedResults && !requestedResults.has(op.operatorID) && !currInfo?.error) {
          const rows = currInfo?.totalRowCount ?? currInfo?.outputTuples;
          obs.push(
            currInfo
              ? `  result: executed${rows !== undefined ? `, ${rows} rows` : ""}; result not requested`
              : "  result: unavailable; result not requested"
          );
          continue;
        }
        const info = node.snapshot.results.get(op.operatorID)?.info;
        if (!requestedResults && retired.has(op.operatorID) && info && !info.error) continue;
        const resultText = info
          ? renderRawResult(
              op.operatorID,
              info,
              workflowState,
              options,
              (id: string) => outputColsFromSnapshot(node.snapshot, id),
              {
                // The same event owns the failing parameters / UDF code. A
                // later edit must not rewrite an earlier error's tool frame.
                ...(op.nativeOp ? { operatorAtEvent: op } : {}),
                nativeEvidence: nativeEvidenceAtSnapshot(op.operatorID, node.snapshot, options, sharedUpstream),
              }
            )
          : "(not executed)";
        const rlines = resultText.split("\n");
        if (rlines.length <= 1) {
          obs.push(`  result: ${rlines[0] ?? ""}`);
        } else {
          obs.push("  result:");
          for (const l of rlines) obs.push(`    ${l}`);
        }
      }
      obs.push(...noChangeOutcome);

      if (obs.length > 0) {
        lines.push("Observation:");
        lines.push("");
        lines.push(...obs);
        lines.push("");
      }
      setPrev(node.snapshot);
    }
  }
  return lines.join("\n").trimEnd();
}

/* ============================================================================
 *  Turn rendering (shared)
 * ========================================================================= */

/** Inline render of a user-role step inside `# Agent Events`, at its position
 *  among the events. Emits H2 `## User Event N` to nest under the H1 wrapper. */
function serializeUserEventInline(node: PathNode): string {
  const lines: string[] = [];
  lines.push(`## User Event ${node.eventIndex}`);
  lines.push("");
  if (node.step.content) lines.push(node.step.content);
  return lines.join("\n").trimEnd();
}

/**
 * Render one agent event as `## Agent Event N` + optional `Thought:` +
 * optional `Action:` block. A native tool call renders by
 * `renderNativeToolCall`, any other in standard tool-call form by
 * `renderToolCall` — the registered tool name plus every parameter as a
 * `key: value` pair. Lossless: exactly what the model emitted. The execution
 * outcome is rendered separately as the caller's `Observation:` block.
 */
function serializeTurn(node: PathNode, options?: AssembleContextOptions, createFlags?: Map<string, boolean>): string {
  const step = node.step;
  options?.eventStepSink?.(node.eventIndex, step);
  const lines: string[] = [];
  lines.push(`## Agent Event ${node.eventIndex}`);
  lines.push("");
  if (step.content) {
    lines.push(`Thought: ${step.content}`);
    lines.push("");
  }

  // Action: the tool call(s) the model issued, in standard tool-call form via
  // renderToolCall (tool name + `key: value` params). Lossless.
  // NATIVE typed tools render as one line, `- add filter operator \`id\`; inputs: …; properties: {…}`.
  if (step.toolCalls && step.toolCalls.length > 0) {
    lines.push("Action:");
    for (const tc of step.toolCalls) {
      const nativeLines = renderNativeToolCall(tc, createFlags);
      if (nativeLines) {
        lines.push(...nativeLines);
        continue;
      }
      for (const l of renderToolCall(tc)) lines.push(l);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * NATIVE typed tool call as one Action line in the agreed shape:
 *   `- add filter operator \`web_fraud\`; inputs: contributors; properties: {"predicate":"…"}`
 *   `- modify join operator \`pairs\`; inputs: left = a, right = b; properties: {…}`
 *   `- delete operator \`x\``
 * A udf's code renders as an indented block under its line. Returns undefined
 * for non-native tools (the generic renderer handles those).
 */
function renderNativeToolCall(
  tc: { toolName: string; input?: unknown },
  createFlags?: Map<string, boolean>
): string[] | undefined {
  const inp = (tc.input ?? {}) as Record<string, unknown>;
  if (tc.toolName === TOOL_NAME_DATAFLOW && Array.isArray(inp.actions)) {
    return [
      "- dataflow",
      `  reasoning: ${String(inp.reasoning ?? "")}`,
      ...JSON.stringify(inp.actions, null, 2)
        .split("\n")
        .map(line => `  ${line}`),
    ];
  }
  const edits = typeof inp.edits === "string" ? inp.edits : typeof inp.program === "string" ? inp.program : undefined;
  if (tc.toolName === TOOL_NAME_DATAFLOW && edits !== undefined) {
    // The statements exactly as written; the receipt below says what landed.
    const lines = ["- dataflow"];
    // The model's stated intent and expectation, as written (dataflowReasoning).
    if (typeof inp.reasoning === "string" && inp.reasoning.trim())
      lines.push(`  reasoning: ${inp.reasoning.trim().replace(/\s*\n\s*/g, " ")}`);
    if (Array.isArray(inp.delete) && inp.delete.length) lines.push(`  delete: ${JSON.stringify(inp.delete)}`);
    const text = edits.trim();
    if (text) {
      lines.push("  edits:");
      for (const l of text.split("\n")) lines.push(`    ${l}`);
    } else
      lines.push(Array.isArray(inp.delete) && inp.delete.length ? "  edits: (none)" : "  edits: (empty: cached read)");
    // Describe the submitted action, not an inferred default: saved receipts
    // from older runs may have resolved an omitted observe differently.
    lines.push(`  observe: ${Array.isArray(inp.observe) ? JSON.stringify(inp.observe) : "omitted"}`);
    return lines;
  }
  const id = typeof inp.id === "string" ? inp.id : "";
  if (tc.toolName === "deleteOperator" && id) return [`- delete operator \`${id}\``];
  void createFlags;
  return undefined;
}

/** A one-line, code-free outcome for a tool result: `ok` or the first line of
 *  an `[ERROR] …` block, truncated. Used in the Observation only for actions
 *  whose effect is NOT carried by a result summary (a rejected / no-op edit that
 *  mutated nothing, or a non-operator tool) — the multi-line body (stack trace +
 *  echoed code) is deliberately dropped. */
function conciseOutcome(output: unknown): string {
  const txt = stringifyOutput(output).trim();
  if (txt.length === 0) return "ok";
  return txt.split("\n")[0].trim().slice(0, 200);
}

/**
 * Render one tool call in standard tool-call form for the DELTA `Action:` block:
 * `- <toolName>` followed by every parameter as an indented `key: value` pair.
 * Lossless — this is exactly what the model emitted. String values are
 * whitespace-collapsed onto a single `key: value` line; non-strings are
 * JSON-encoded.
 */
function renderToolCall(tc: { toolName: string; input?: unknown }): string[] {
  const inp = (tc.input ?? {}) as Record<string, unknown>;
  const lines: string[] = [`- ${tc.toolName}`];
  for (const [k, v] of Object.entries(inp)) {
    const val = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : JSON.stringify(v);
    lines.push(`    ${k}: ${val}`);
  }
  return lines;
}

function renderRawResult(
  operatorId: string,
  info: Parameters<typeof formatOperatorResult>[1],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  resolveInputColumns?: (upstreamOpId: string) => number | undefined,
  overrides: Partial<FormatOperatorResultOptions> = {}
): string {
  const raw = formatOperatorResult(operatorId, info, workflowState, {
    ...resultFormatOptions(options),
    resolveInputColumns,
    ...overrides,
  });
  const text = raw.trim();
  return text.length > 0 ? text : "(no result)";
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/* ============================================================================
 *  Snapshot rendering (the per-event delta)
 * ========================================================================= */

/**
 * Δᵢ = operators in snapshot S_i that differ from S_{i-1}.
 *
 * An operator is in Δ when (a) it didn't exist in the previous snapshot,
 * (b) its operatorProperties differ from the previous snapshot's
 * version, or (c) it has a newly-earned execution result at this
 * snapshot. (c) is detected via `ResultEntry.sourceStepId === snapshot's
 * reactStepId`, which the snapshot storage preserves through inheritance.
 *
 * (a) handles add; (b) handles modify; (c) handles "the action also
 * refreshed results downstream" — e.g. `runPostStepExecution` re-running
 * a sink after a modifyOperator on an ancestor.
 */
export function computeDelta(prev: SnapshotData | undefined, curr: SnapshotData): Set<string> {
  const delta = new Set<string>();
  const prevOps = new Map<string, OperatorPredicate>();
  if (prev) for (const op of prev.workflow.operators) prevOps.set(op.operatorID, op);

  for (const op of curr.workflow.operators) {
    const before = prevOps.get(op.operatorID);
    if (!before) {
      delta.add(op.operatorID); // newly added
      continue;
    }
    // Cheap structural compare; properties is the only mutable shape of
    // an operator the agent edits in place.
    if (JSON.stringify(before.operatorProperties) !== JSON.stringify(op.operatorProperties)) {
      delta.add(op.operatorID); // modified
    }
  }
  // Newly-earned results at this snapshot's owning step.
  if (curr.reactStepId !== undefined) {
    for (const [opId, entry] of curr.results) {
      if (entry.sourceStepId === curr.reactStepId) delta.add(opId);
    }
  }
  return delta;
}

function nativeEvidenceAtSnapshot(
  operatorId: string,
  snapshot: SnapshotData,
  options: AssembleContextOptions,
  sharedUpstream?: Map<string, string>
): FormatOperatorResultOptions["nativeEvidence"] {
  return {
    ...observationFormat(options.nativeEvidence ?? options),
    dataMaxChars: options.nativeEvidence?.dataMaxChars,
    flowMaxChars: options.nativeEvidence?.flowMaxChars,
    workflow: snapshot.workflow,
    resolveInput: id => snapshot.results.get(id)?.info,
    // Imported old events have no recorded exposure settings: do not invent
    // evidence that was never present in their model-facing observations.
    data: false,
    flow: false,
    maxChars: options.nativeEvidence?.maxChars ?? options.maxOperatorResultCharLimit ?? 2000,
    frozen: snapshot.nativeObservations?.[operatorId],
    sharedUpstream,
  };
}

function resultFormatOptions(options: AssembleContextOptions): FormatOperatorResultOptions {
  return {
    maxResultRows: options.maxResultRows,
  };
}

/** An operator's output column count = the visible-header count of its result's
 *  first row. Used to fill an input's `M cols` on the shape line (the engine's
 *  input port metrics carry only the row/tuple count). Undefined when unknown. */
function outputColsFromSnapshot(snapshot: SnapshotData | undefined, opId: string): number | undefined {
  const r = snapshot?.results.get(opId)?.info?.result;
  if (!Array.isArray(r) || !r[0] || typeof r[0] !== "object") return undefined;
  return Object.keys(r[0] as Record<string, unknown>).filter(k => k !== "__row_index__" && k !== "__is_visualization__")
    .length;
}

/* ============================================================================
 *  Shared helpers
 * ========================================================================= */

function topoSortDag(workflow: WorkflowContent) {
  const allOperators = workflow.operators;
  const allLinks = workflow.links;
  const opIds = new Set(allOperators.map(o => o.operatorID));
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
  return { sortedOps };
}
