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
import { isDeepStrictEqual } from "node:util";
import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { AgentSettings, CompactionStrategy, ReActStep } from "../../types/agent";
import type { SnapshotData, WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { OperatorInfo } from "../../types/execution";
import { retiredPreviews } from "../native/selection";
import { asNativeBatchResult, batchObservedIds, TOOL_NAME_DATAFLOW } from "../tools/native-batch-tools";
import { asDataflowActionsResult, renderDataflowActionsResult } from "../tools/dataflow-actions";
import { formatOperatorResult } from "../tools/result-formatting";
import {
  observationFormat,
  describeOperator,
  operatorBlock,
  type ObservationFormatOptions,
} from "../native/observation-format";
import { buildNativeFrames } from "../context/summarize/native-frames";
import type { FormatOperatorResultOptions } from "../tools/result-formatting";
import { nativeCheckLines } from "../native/checks";
import { resultScope } from "../native/result-scope";
import { createLogger } from "../../logger";
import { requestEntries, sessionRequests, type SessionRequest } from "../request-catalog";

/** The operator a tool call wrote: `operatorId` (code-mode tools) or `id`
 *  (native mode's deleteOperator). Undefined for read-only tools and for the
 *  `dataflow` program, which writes several operators (see its receipt). */
export function writtenOperatorId(toolName: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  if (typeof inp.operatorId === "string" && inp.operatorId) return inp.operatorId;
  if (toolName === "deleteOperator" && typeof inp.id === "string" && inp.id) return inp.id;
  return undefined;
}

const log = createLogger("ContextAssembler");

export interface AssembleContextOptions extends ObservationFormatOptions {
  /** Several requests in one session (AgentSettings.multiRequest): "catalog"
   *  shows each earlier request as its request and one catalog entry. */
  multiRequest?: AgentSettings["multiRequest"];
  /** Catalog entries' functions (AgentSettings.catalogSource). */
  catalogSource?: AgentSettings["catalogSource"];
  /** Recent requests a catalog keeps as transcript (AgentSettings.catalogRecent). */
  catalogRecent?: AgentSettings["catalogRecent"];
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  /** Native `check:` lines under executed operators (see native/checks.ts). */
  nativeChecks?: boolean;
  /** Called once per rendered agent event with the step that produced it, so
   *  the message builder can emit that step's REAL tool calls (true
   *  toolCallIds) instead of inferring them from the rendered text. */
  eventStepSink?: (eventIndex: number, step: ReActStep) => void;
  /** Event-owned requests from dataflow batches, reconstructed from receipts. */
  batchObservationsByStep?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Where the `# User Task` block goes: "top" (legacy) or "bottom". Bottom
   *  keeps the history a byte-stable prefix across turns, which is what prompt
   *  caching matches on; see AgentSettings.userTaskPlacement. */
  userTaskPlacement?: "top" | "bottom";
  /** Per-operator detail in each `# Catalog` turn entry: "ids" (id + verb),
   *  "brief" (+ summary and shape, default), "schema" (+ column inventory).
   *  Capped by design: a full snapshot per turn is O(turns x operators), which
   *  was the $12.39 NFL blowup (323 operators re-rendered every step). */
  catalogDetail?: "ids" | "brief" | "schema";
  /** GLOBAL turn number per messageId — the order turns were asked in over the
   *  whole session, which is NOT the position on the current branch after a
   *  checkout. Absent ⇒ fall back to branch position (single-branch sessions,
   *  where the two agree). */
  turnNumberByMessageId?: Map<string, number>;
  /** DELTA context-window budget, in *tokens* (estimated via `estimateTokens`).
   *  Bounds the assembled trajectory user-message — the true model window minus
   *  the ~constant system prompt + response headroom, which the caller folds
   *  into this number. Unset / ≤ 0 ⇒ unbounded (lossless raw delta — legacy).
   *  When > 0, the assembler renders the "original" raw delta (schema-only, no
   *  stats) while it fits, then COMPACTS via `compactionStrategy` once it would
   *  overflow. */
  contextWindowTokens?: number;
  /** How to compact once the raw delta exceeds `contextWindowTokens`:
   *   - "sliding": drop the OLDEST whole agent events until it fits (an
   *     `(… N earlier events omitted …)` marker stands in their place).
   *   - "compress": fold the oldest events into a `# Dataflow (compacted)` deck
   *     — the boundary snapshot rendered per-operator as Column Schema and stats
   *     + a `deckSampleRatio` row peek — then resume raw delta for the fresh
   *     suffix (rolling compaction). Default "compress". */
  compactionStrategy?: CompactionStrategy;
  /** compress-deck row sampling: fraction of each folded operator's output rows
   *  to keep as a peek alongside its stats, clamped to `[3, maxResultRows||20]`.
   *  Undefined ⇒ 0.10. */
  deckSampleRatio?: number;
  /** Internal (computed by the truncation/compaction pass): keep only agent events whose
   *  `eventIndex >= keepFromEventIndex`; earlier events are dropped. Undefined ⇒
   *  keep all (lossless). */
  keepFromEventIndex?: number;
  /** Internal: how many oldest events were dropped (drives the omitted marker). */
  omittedEventsCount?: number;
  /** Context layout and result sampling are independent of data/flow evidence. */
  schemaInResult?: boolean;
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
    checks?: boolean;
    dataMaxChars?: number;
    flowMaxChars?: number;
  } & ObservationFormatOptions;
  /** Internal compact-deck marker: shorten recorded V2 frames, never enrich. */
  nativeObservationCompaction?: boolean;
  /** DELTA `Inputs:` line (structure-consistent with the compacted deck). The
   *  leaf snapshot supplies the current DAG adjacency (single source of truth via
   *  formatOperatorAdjacency); the map gives each op's last-edit eventIndex so the
   *  line renders once, on the op's most-recent edit, reflecting the latest wiring.
   *  Set by renderAgentEvents; read in the DELTA observation. */
  deltaInputsLeaf?: SnapshotData;
  deltaLastEditByOp?: Map<string, number>;
}

/**
 * Python code operators whose `operatorProperties` (chiefly the `code` blob)
 * are always stripped from the assembled context: their source is large and
 * already surfaced inline on error, so echoing it in every snapshot is pure
 * token cost. All other operator types render their properties.
 */
const CODE_OPERATOR_TYPES = new Set(["PythonUDFV2", "DataLoading", "DataProcessing"]);

/**
 * Chars-per-token divisor for the context-window budget. Matches the agent's own
 * input-token estimate (`Math.ceil(userMessage.length / 4)` in texera-agent.ts)
 * so the window the caller sets in tokens lines up with the usage the agent
 * reports.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a rendered context string. The single seam every
 * budget decision routes through — a real tokenizer (e.g. gpt-tokenizer) drops
 * in here later without touching any caller. Today: the deterministic chars/4
 * heuristic (±10–15% on English + code), which needs no dependency and never
 * disagrees with the agent's own input-token accounting.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build the assembled context the LLM sees on the next `prepareStep`. A
 * context is a path on the snapshot tree from the root (empty snapshot) to the
 * leaf (current snapshot). Each edge on the path is rendered as `## Agent
 * Event N` (thought + actions) followed by an observation that shows only the
 * operators that changed at that event (delta), and each request stays at its
 * position among the events.
 *
 * Action rendering: each tool call inside an event renders as one
 * natural-language line — `- create operator "X", result: …` / `- modify
 * operator "X", result: …` / `- delete operator "X", result: …`. Create vs.
 * modify is decided by walking the path: an op id that hasn't been seen yet
 * (or that was deleted) reads as `create`, otherwise as `modify`. The
 * submitted `code` and `summary` are NOT included on event lines — the
 * snapshot below carries the relevant state.
 *
 * Snapshot trimming (paper §4.3): the Python code operators'
 * (`CODE_OPERATOR_TYPES`) computation function (`code`) is always dropped —
 * the user's `OperatorInfo` result already carries the source code on error,
 * so dropping it doesn't hide what's needed to debug. All other operators
 * render their `operatorProperties` as a `Properties:` line.
 */
export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  options: AssembleContextOptions
): ModelMessage[] {
  if (options.multiRequest === "catalog") {
    const requests = sessionRequests(
      visibleSteps.filter(step => !isInitStep(step)),
      options.turnNumberByMessageId
    );
    if (requests.length > 1) return catalogContext(requests, workflowState, snapshotStorage, options);
  }
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
 * Requests a catalog shows as entries when `earlier` requests precede the
 * current one: all of them, or with `recent` = K, all but the most recent K to
 * 2K-1. Entries are added K at a time, so the layout, and with it the cached
 * prefix, changes once every K requests.
 */
export function catalogedRequests(earlier: number, recent = 0): number {
  return recent > 0 ? Math.max(0, recent * (Math.floor(earlier / recent) - 1)) : earlier;
}

/**
 * Earlier requests as request and catalog-entry pairs, then the transcript of
 * the requests not yet in the catalog, the current one last. Request frames
 * are framed as the transcript frames them, the first under its heading and
 * later ones as plain user turns, and a finished request's entry never
 * changes, so the prefix only grows between catalog additions.
 */
function catalogContext(
  requests: readonly SessionRequest[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  options: AssembleContextOptions
): ModelMessage[] {
  const inner: AssembleContextOptions = { ...options, multiRequest: undefined };
  const opening = (request: SessionRequest) =>
    request.steps.find(step => step.role === "user" && step.isBegin) ?? request.steps[0];
  const cataloged = requests.slice(0, catalogedRequests(requests.length - 1, options.catalogRecent ?? 0));
  const transcript = requests.slice(cataloged.length).flatMap(request => request.steps);
  if (!cataloged.length) return assembleContext(transcript, workflowState, snapshotStorage, inner);
  const entries = requestEntries(snapshotStorage, cataloged, options.catalogSource ?? "full");
  const messages: ModelMessage[] = [];
  cataloged.forEach((request, i) => {
    messages.push(
      ...(i === 0
        ? assembleContext([opening(request)], workflowState, snapshotStorage, inner)
        : [{ role: "user" as const, content: opening(request).content }]),
      { role: "assistant", content: entries[i] }
    );
  });
  const own = assembleContext(transcript, workflowState, snapshotStorage, inner);
  const first = own[0];
  if (first?.role === "user" && typeof first.content === "string")
    own[0] = { ...first, content: first.content.replace(/^# Agent Events\n\n## User Event \d+\n\n/, "") };
  return [...messages, ...own];
}

/**
 * The context as markdown, before the transcript frames it: every event of the
 * path as Thought / Action / Observation, compacted once it outgrows
 * `contextWindowTokens`. Renders from its own copy of the options it reads.
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
      ...(given.nativeChecks === true ? { checks: true } : {}),
    },
    contextWindowTokens: given.contextWindowTokens,
    compactionStrategy: given.compactionStrategy ?? "compress",
    deckSampleRatio: given.deckSampleRatio ?? 0.1,
    schemaInResult: given.schemaInResult === true,
    maxResultRows: given.maxResultRows ?? 0,
    eventStepSink: given.eventStepSink,
  };
  const { path, initSnapshot } = buildPath(visibleSteps, snapshotStorage);
  const batchObservations = new Map<string, ReadonlySet<string>>();
  // Read-only steps inherit the last batch's display selection in the compacted
  // deck; every event still resolves its own immutable request independently.
  let lastObserved: ReadonlySet<string> | undefined;
  for (const node of path) {
    lastObserved = batchObservedIds(node.step) ?? lastObserved;
    if (lastObserved && node.snapshot?.reactStepId) batchObservations.set(node.snapshot.reactStepId, lastObserved);
  }
  options.batchObservationsByStep = batchObservations;

  // A compacted render heads with the latest user message as its `# User Task`
  // block. Its step id lets renderers skip rendering the same user event
  // inline in the events list. Older user messages (multi-task continuation)
  // still render inline as `## User Event N`.
  const latestUserStep = findLatestUserStepInPath(path);
  const latestUserContent = latestUserStep?.step.content;
  const latestUserStepId = latestUserStep?.step.id;

  const tasks = groupIntoTasks(path);

  // Per-step create-vs-modify flags. Linear walk over the path: each
  // `createOrModifyOperator` call records whether the op id was already
  // known (modify) or fresh (create). `deleteOperator` removes from the
  // known set so a later create-on-same-id reads as `create` again.
  const createFlagsByStep = buildCreateFlagsByStep(path);
  const windowTokens =
    options.contextWindowTokens && options.contextWindowTokens > 0 ? options.contextWindowTokens : undefined;
  // Unbounded window (0/unset) ⇒ lossless delta. A positive window switches to
  // the budgeted path: "original" raw delta (schema-only) while it fits, then
  // compaction (sliding | compress) once it would overflow.
  const content =
    windowTokens === undefined
      ? renderInterleaved(tasks, workflowState, options, initSnapshot, createFlagsByStep)
      : assembleBudgetedContext(
          tasks,
          workflowState,
          options,
          initSnapshot,
          latestUserContent,
          latestUserStepId,
          createFlagsByStep,
          windowTokens
        );

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
 * the first real action can still diff against it (Delta) and so the
 * compacted deck can tell what a task changed.
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
   *  to seed delta diffing and as the compacted deck's baseline. */
  initSnapshot: SnapshotData | undefined;
}

/** Pick the latest external user request from a full path. Used to hoist the
 *  latest user message into the `# User Task` block at the top of a
 *  compacted context, and to skip rendering the same node inline within
 *  its `# Agent Events` (older user messages still render inline as
 *  `## User Event N`). */
function findLatestUserStepInPath(path: PathNode[]): PathNode | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i];
    // Runtime feedback belongs at its chronological position. Hoisting it
    // replaces the task and rewrites the cacheable prefix during a repair.
    // A canvas action likewise reports what the user did; it is not a request.
    if (
      n.step.role === "user" &&
      n.step.messageSource !== "feedback" &&
      n.step.messageSource !== "correction" &&
      n.step.messageSource !== "action" &&
      n.step.content
    )
      return n;
  }
  return undefined;
}

/** Exposed for unit tests. */
export const __forTesting = {
  findLatestUserStepInPath,
};

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
 *  A single linear walk over the full path classifies every
 *  `createOrModifyOperator` tool call as either "create" (the op id was not
 *  already known in the path's accumulated state) or "modify" (it was).
 *  `deleteOperator` calls remove the id from the known set so a later
 *  `createOrModifyOperator` on the same id reads as `create` again, which
 *  matches the workflow's actual lifecycle.
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
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : typeof inp.id === "string" ? inp.id : "";
      if (!opId) continue;
      if (tc.toolName === "createOrModifyOperator") {
        const isCreate = !known.has(opId);
        eventFlags.set(opId, isCreate);
        known.add(opId);
      } else if (tc.toolName === "deleteOperator") {
        known.delete(opId);
      }
    }
    if (eventFlags.size > 0) result.set(node.step.id, eventFlags);
  }
  return result;
}

/* ============================================================================
 *  Rendering: interleaved events and their compaction
 * ========================================================================= */

/**
 * The budgeted DELTA orchestrator (contextWindowTokens > 0). Renders the
 * "original" raw delta — full trajectory, each observation showing raw records +
 * a `Schema:` line ONLY (stats are the compression currency, reserved for the
 * deck) — and, once that would overflow the window, COMPACTS via the chosen
 * strategy:
 *
 *   - "sliding":  drop the OLDEST whole agent events until it fits, leaving an
 *                 `(… N earlier events omitted …)` marker (renderDeltaTruncated).
 *   - "compress": fold the oldest events into a `# Dataflow (compacted)` deck —
 *                 the boundary snapshot rendered per-operator as stats + a
 *                 ratio-sampled row peek — then resume raw delta for the fresh
 *                 suffix (renderCompressed). This is the rolling compaction: as
 *                 the suffix regrows past the window, the boundary advances and
 *                 the deck re-renders from a newer snapshot.
 *
 * The budget is measured (via estimateTokens) against this function's output —
 * the assembled trajectory user-message. The compaction is recomputed each turn
 * from the current window; because a linear trajectory only grows, the chosen
 * boundary advances monotonically without any persisted state.
 */
function assembleBudgetedContext(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  windowTokens: number
): string {
  // Phase-A "original" profile: raw records + schema line only. The data-stats
  // family (column stats / structural hints / value-format / coercion) is off in
  // the suffix — those are what the compress deck spends its budget on.
  const suffixOptions: AssembleContextOptions = {
    ...options,
    schemaInResult: true,
    keepFromEventIndex: undefined,
    omittedEventsCount: 0,
  };

  // Phase A: lossless raw delta. If it fits the window, send it untouched (the
  // append-only prefix keeps the prompt cache warm).
  const lossless = renderInterleaved(tasks, workflowState, suffixOptions, initSnapshot, createFlagsByStep);
  if (estimateTokens(lossless) <= windowTokens) return lossless;

  // Snapshot-bearing agent events, oldest→newest — the fold/evict candidates.
  const evs: { idx: number; snap: SnapshotData }[] = [];
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role === "agent" && node.snapshot) evs.push({ idx: node.eventIndex, snap: node.snapshot });
    }
  }
  if (evs.length <= 1) return lossless; // nothing meaningful to fold/evict

  if ((options.compactionStrategy ?? "compress") === "sliding") {
    return renderDeltaTruncated(tasks, workflowState, suffixOptions, initSnapshot, createFlagsByStep, windowTokens);
  }

  // compress: fold the oldest d events into a stats deck (the boundary snapshot),
  // keep the rest as raw-delta suffix. Advance the fold forward until it fits;
  // larger folds shrink the raw suffix faster than the stats deck grows. When
  // d === evs.length everything folds into the deck (empty suffix = the deck alone).
  let best = lossless;
  let bestTokens = estimateTokens(lossless);
  let folded = 0;
  for (let d = 1; d <= evs.length; d++) {
    const boundarySnap = evs[d - 1].snap;
    const keepFrom = d < evs.length ? evs[d].idx : evs[d - 1].idx + 1; // suffix start (past-end ⇒ empty)
    best = renderCompressed(
      tasks,
      workflowState,
      options,
      suffixOptions,
      boundarySnap,
      keepFrom,
      latestUserContent,
      latestUserStepId,
      createFlagsByStep,
      initSnapshot
    );
    bestTokens = estimateTokens(best);
    folded = d;
    if (bestTokens <= windowTokens) break;
  }
  log[bestTokens > windowTokens ? "warn" : "debug"](
    { windowTokens, folded, kept: evs.length - folded, tokens: bestTokens },
    bestTokens > windowTokens
      ? "context over window even after folding every event into the compacted deck"
      : "compress compaction"
  );
  return best;
}

/**
 * compress render: `# User Task` + a `# Dataflow (compacted)` deck of the
 * boundary snapshot (per-operator stats + a ratio-sampled row peek) + the fresh
 * `# Agent Events` suffix (raw delta for events at/after `keepFrom`, diffed
 * against the boundary snapshot) + the leaf FLOW section. The deck REPLACES the
 * dropped events' raw trajectory: their tables collapse to a few stat lines.
 */
function renderCompressed(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  suffixOptions: AssembleContextOptions,
  boundarySnap: SnapshotData,
  keepFrom: number,
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  initSnapshot?: SnapshotData
): string {
  const sections: string[] = [];

  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }

  // Deck: the folded prefix, as statistics + sampled rows (deckOptions turns the
  // stats family ON — the inverse of the schema-only suffix).
  const deckOptions: AssembleContextOptions = {
    ...options,
    schemaInResult: true,
  };
  // A single current task can inherit a large historical workflow. Checkpoint
  // only its changed definitions and explicitly observed live operators; the
  // task index and retrieval tools retain access to earlier work. References
  // to unchanged inputs stay in the definitions without expanding upstreams.
  let checkpoint = boundarySnap;
  if (tasks.length === 1 && initSnapshot) {
    const baseline = new Map(initSnapshot.workflow.operators.map(op => [op.operatorID, op]));
    const observed = new Set<string>();
    for (const node of tasks[0].nodes) {
      if (node.eventIndex < keepFrom)
        for (const id of Object.keys(node.snapshot?.nativeObservations ?? {})) observed.add(id);
    }
    const operators = boundarySnap.workflow.operators.filter(
      op => observed.has(op.operatorID) || !isDeepStrictEqual(baseline.get(op.operatorID), op)
    );
    const ids = new Set(operators.map(op => op.operatorID));
    checkpoint = {
      ...boundarySnap,
      workflow: {
        ...boundarySnap.workflow,
        operators,
        links: boundarySnap.workflow.links.filter(
          link => ids.has(link.source.operatorID) && ids.has(link.target.operatorID)
        ),
      },
    };
  }
  const deck = serializeSnapshotCompact(checkpoint, workflowState, deckOptions, /*sectionLevel=*/ 2);
  if (deck) {
    sections.push(
      "# Dataflow (compacted — earlier events folded into this snapshot; results shown as statistics + sampled rows)"
    );
    sections.push(deck);
    sections.push("");
  }

  // Suffix: raw-delta agent events at/after the boundary. Reseed the rolling
  // prev-snapshot to the boundary so the first surviving event diffs against the
  // deck (not the empty init). No omitted-marker — the deck stands in its place.
  const suffix: AssembleContextOptions = { ...suffixOptions, keepFromEventIndex: keepFrom, omittedEventsCount: 0 };
  const events = renderAgentEvents(tasks, workflowState, suffix, boundarySnap, latestUserStepId, createFlagsByStep);
  if (events && events !== "(no agent actions yet)") {
    sections.push("# Agent Events (since the compacted snapshot above)");
    sections.push("");
    sections.push(events);
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

/**
 * DELTA sliding-window compaction (compactionStrategy="sliding"). Lossless raw
 * delta is sent untouched while it fits the window; once it exceeds, the OLDEST
 * whole agent events are dropped (entire Thought/Action/Observation turns) until
 * it fits. The prev-snapshot is RESEEDED to the state just before the first
 * surviving event, so the survivors' per-turn deltas stay correct (otherwise the
 * first survivor would diff against the empty init and re-render every operator
 * as "added"). An `(… N earlier events omitted …)` marker stands in their place.
 *
 * This is the naive eviction baseline: it drops the early operators' structure +
 * results wholesale, whereas compress keeps them as a compact stats deck — the
 * contrast the experiments measure.
 */
function renderDeltaTruncated(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  windowTokens: number
): string {
  const renderKeeping = (cutoff: number | undefined, reseed: SnapshotData | undefined, omitted: number): string => {
    options.keepFromEventIndex = cutoff;
    options.omittedEventsCount = omitted;
    return renderInterleaved(tasks, workflowState, options, reseed, createFlagsByStep);
  };

  // Lossless first (keep every event) — preserves the cache-stable prefix while
  // it fits the window.
  const lossless = renderKeeping(undefined, initSnapshot, 0);
  if (estimateTokens(lossless) <= windowTokens) return lossless;

  // Snapshot-bearing agent events, oldest→newest.
  const evs: { idx: number; snap: SnapshotData }[] = [];
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role === "agent" && node.snapshot) evs.push({ idx: node.eventIndex, snap: node.snapshot });
    }
  }
  if (evs.length <= 1) return lossless; // nothing meaningful to drop

  // Drop the oldest events; keep the largest surviving suffix that fits. Dropping
  // more only shrinks the render (the first survivor reseeds against a later
  // snapshot, so its delta also shrinks), so first-fit while scanning the drop
  // count upward gives the smallest sufficient drop.
  let bestOut = lossless;
  let bestTokens = estimateTokens(lossless);
  let dropped = 0;
  for (let d = 1; d <= evs.length - 1; d++) {
    bestOut = renderKeeping(evs[d].idx, evs[d - 1].snap, d); // keep eventIndex >= evs[d].idx
    bestTokens = estimateTokens(bestOut);
    dropped = d;
    if (bestTokens <= windowTokens) break;
  }
  log[bestTokens > windowTokens ? "warn" : "debug"](
    { windowTokens, dropped, kept: evs.length - dropped, tokens: bestTokens },
    bestTokens > windowTokens
      ? "context over window even after keeping only the most recent event"
      : "sliding compaction"
  );
  return bestOut;
}

/**
 * Render the agent trajectory as the sequence of per-event Thought / Action /
 * Observation bodies (delta-style). Shared by the `# Agent Events` section and
 * the compacted render's suffix. The rolling prevSnapshot (seeded by the hidden
 * init snapshot) drives the per-event "operator X added/updated" diff in each
 * Observation. Returns the joined bodies, or the empty-trajectory placeholder.
 */
function renderAgentEvents(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const bodies: string[] = [];
  // DELTA `Inputs:` line: the leaf snapshot is the single source of DAG
  // adjacency; each op's last-edit event is where the line renders (once, on
  // its most-recent edit, so it sits with the op's latest code and reflects
  // the current wiring).
  options.deltaInputsLeaf = lastSnapshotOf(tasks);
  const lastEdit = new Map<string, number>();
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role !== "agent") continue;
      for (const tc of node.step.toolCalls ?? []) {
        const opId = writtenOperatorId(tc.toolName, tc.input);
        if (typeof opId === "string" && opId && tc.toolName !== "deleteOperator") {
          lastEdit.set(opId, node.eventIndex);
        }
      }
    }
  }
  options.deltaLastEditByOp = lastEdit;
  let prevSnapshot: SnapshotData | undefined = initSnapshot;
  for (const [taskIndex, task] of tasks.entries()) {
    const body = serializeTaskBody(
      task,
      workflowState,
      options,
      () => prevSnapshot,
      s => {
        prevSnapshot = s;
      },
      latestUserStepId,
      createFlagsByStep,
      /*laterTurn=*/ taskIndex > 0
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

  // Sliding-window truncation marker (truncateOldest): the dropped oldest events
  // are replaced by a single placeholder so the model knows history was elided.
  if (options.omittedEventsCount && options.omittedEventsCount > 0) {
    const n = options.omittedEventsCount;
    sections.push(`(… ${n} earlier event${n === 1 ? "" : "s"} omitted to fit the context budget …)`);
    sections.push("");
  }

  // Each event as a Thought/Action/Observation body, diffed against a rolling
  // previous snapshot (seeded by the hidden init snapshot).
  sections.push(renderAgentEvents(tasks, workflowState, options, initSnapshot, undefined, createFlagsByStep));
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
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  /** True for every task group after the first (a later user turn). */
  laterTurn = false
): string {
  const lines: string[] = [];

  for (const node of task.nodes) {
    // Sliding-window truncation (truncateOldest): drop events older than the
    // cutoff entirely. `continue` BEFORE any setPrev so the rolling prev stays at
    // the reseeded snapshot until the first surviving event (keeps its delta correct).
    if (options.keepFromEventIndex !== undefined && node.eventIndex < options.keepFromEventIndex) continue;
    if (node.step.role === "user") {
      // A caller that hoists the latest user message into a top-level
      // `# User Task` block passes its id. Skip it here so it doesn't appear
      // twice — except on a later turn: there the request must also be the
      // LAST message of the transcript (the model answered "please provide
      // the next question" to a `Continue.` 70k tokens after a request placed
      // on top), and an inline copy at its chronological position keeps the
      // prompt append-only within the turn.
      if (node.step.id === latestUserStepId && !laterTurn) continue;
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
      // Each observation uses the same evidence controls as the compacted
      // deck. Every operator that CHANGED or
      // RE-EXECUTED this step (the Δ — incl. downstream ops refreshed by
      // runPostStepExecution, via computeDelta case c) renders as
      // `- operator <id> <added|updated|deleted>` followed by its result. On
      // error the result keeps the engine's exception + `at line N` pointer + the
      // `Operator code:` block (self-contained — the failing line shown in context;
      // see renderRawResult), even though the Action above also carries the code.
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
        } else if (tc.toolName === "createOrModifyOperator" && opId) {
          actedVerb.set(opId, createFlags?.get(opId) ? "added" : "updated");
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
        // `- filter operator \`id\` added` for typed operators, `- operator id added` for code ones.
        obs.push(
          op.nativeOp
            ? `- ${op.nativeOp.type.toLowerCase()} operator \`${op.operatorID}\` ${currInfo?.nativeError?.phase === "attempt" ? "edit rejected (not executed)" : currInfo?.nativeError?.diagnostic.stage === "dependency" ? "blocked (not executed)" : (actedVerb.get(op.operatorID) ?? (requestedResults ? (delta.has(op.operatorID) ? "re-executed" : "observed (cached)") : "updated"))}`
            : `- operator ${op.operatorID} ${actedVerb.get(op.operatorID) ?? "updated"}`
        );
        // Checks are the operator's own violated assumptions: shown whether or
        // not its table was requested, from this event's immutable snapshot.
        if (op.nativeOp && currInfo && !currInfo.error && (options.nativeEvidence?.checks ?? options.nativeChecks))
          for (const line of nativeCheckLines(op, currInfo)) obs.push(`  check: ${line}`);
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
        // `Inputs:` line — structure-consistent with the compacted deck, from
        // the LEAF snapshot's DAG (current wiring) via the same
        // formatOperatorAdjacency the deck uses. Code mode: rendered
        // once, on the op's most-recent edit (byte-parity with the golden
        // renders). Typed operators: on EVERY event that changed the op — moving
        // the line on a later edit rewrote an earlier observation and broke the
        // prompt cache for everything after it. Skipped for ops no longer in the
        // leaf.
        const leaf = requestedResults ? node.snapshot : options.deltaInputsLeaf;
        if (leaf && (op.nativeOp ? true : options.deltaLastEditByOp?.get(op.operatorID) === node.eventIndex)) {
          const leafOp = leaf.workflow.operators.find(o => o.operatorID === op.operatorID);
          if (leafOp) {
            const leafInfo = leaf.results.get(op.operatorID)?.info;
            for (const l of formatOperatorAdjacency(leafOp, leaf.workflow.links, leafInfo, leaf)) obs.push(`  ${l}`);
          }
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
                // Typed operators already carry the consolidated `Inputs:` line
                // above (formatOperatorAdjacency); repeating it inside the
                // result was a duplicate on every observation.
                // The same event owns the failing parameters / UDF code. A
                // later edit must not rewrite an earlier error's tool frame.
                ...(op.nativeOp ? { inputsInResult: false, operatorAtEvent: op } : {}),
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

/** Inline render of an older user-role step inside `# Agent Events`.
 *  Emits H2 `## User Event N` to nest under the H1 wrapper. The latest
 *  user step is never rendered here — it lives in the top-level
 *  `# User Task` block. */
function serializeUserEventInline(node: PathNode): string {
  const lines: string[] = [];
  lines.push(`## User Event ${node.eventIndex}`);
  lines.push("");
  if (node.step.content) lines.push(node.step.content);
  return lines.join("\n").trimEnd();
}

/**
 * Render one agent event as `## Agent Event N` + optional `Thought:` +
 * optional `Action:` block. Each tool call is rendered in standard tool-call
 * form by `renderToolCall` — the registered tool name (`createOrModifyOperator`
 * / `deleteOperator`) plus every parameter as a `key: value` pair, with the
 * multi-line `code` parameter as an indented block. Lossless: exactly what the
 * model emitted. The execution outcome is rendered separately as the caller's
 * `Observation:` block.
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
  // renderToolCall (tool name + `key: value` params + `code` block). Lossless.
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
 * `- <toolName>` followed by every parameter as an indented `key: value` pair,
 * with the multi-line `code` parameter rendered LAST as its own indented block.
 * Lossless — this is exactly what the model emitted (in CODE mode the operator's
 * predecessors are the `def process(<predecessors>)` arg names, so the `code`
 * block already carries them). Non-`code` string values are whitespace-collapsed
 * onto a single `key: value` line; non-strings are JSON-encoded.
 */
function renderToolCall(tc: { toolName: string; input?: unknown }): string[] {
  const inp = (tc.input ?? {}) as Record<string, unknown>;
  const lines: string[] = [`- ${tc.toolName}`];
  for (const [k, v] of Object.entries(inp)) {
    if (k === "code") continue; // rendered last as a block
    const val = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : JSON.stringify(v);
    lines.push(`    ${k}: ${val}`);
  }
  if (typeof inp.code === "string" && inp.code.length > 0) {
    lines.push("    code:");
    for (const l of inp.code.split("\n")) lines.push(`      ${l}`);
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
 *  Snapshot rendering (the compacted deck and the per-event delta)
 * ========================================================================= */

/**
 * Rows to keep as a peek in the compress deck for one operator: `ratio` of the
 * operator's true output-row count, clamped to `[3, maxResultRows||20]`. The
 * ratio keeps the sample proportional to the data; the cap guarantees the deck
 * stays a compression (a 50k-row table can't dump thousands of rows). Errored /
 * empty operators have no rows to sample ⇒ the floor of 3 (harmless).
 */
export function deckRowCap(
  info: OperatorInfo | undefined,
  ratio: number | undefined,
  maxRows: number | undefined
): number {
  const rows =
    info?.totalRowCount ?? info?.outputTuples ?? (Array.isArray(info?.result) ? (info!.result as unknown[]).length : 0);
  const hardCap = maxRows && maxRows > 0 ? maxRows : 20;
  const r = ratio && ratio > 0 ? ratio : 0.1;
  return Math.max(3, Math.min(hardCap, Math.ceil(rows * r)));
}

/**
 * Compact ("deck") snapshot render for the compress compaction: one block per
 * operator, each Result rendered as statistics (Column Schema and stats) plus a
 * `deckSampleRatio` row peek instead of its full table — the folded prefix's raw
 * trajectory collapses to a few stat lines per operator. Per-operator
 * `maxResultRows` is the ratio-sampled cap.
 */
function serializeSnapshotCompact(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  sectionLevel: number
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const lines: string[] = [];
  const sharedUpstream = new Map<string, string>();
  const { sortedOps, allLinks } = topoSortDag(workflow);
  const sectionHash = "#".repeat(sectionLevel);
  const operatorLevel = sectionLevel + 1;

  lines.push(`${sectionHash} Operators`);
  lines.push("");
  for (const op of sortedOps) {
    const info = snapshot.results.get(op.operatorID)?.info;
    const perOpOptions: AssembleContextOptions = {
      ...options,
      maxResultRows: deckRowCap(info, options.deckSampleRatio, options.maxResultRows),
      nativeObservationCompaction: true,
    };
    lines.push(
      serializeOperatorFull(op, snapshot, workflowState, perOpOptions, allLinks, operatorLevel, sharedUpstream)
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

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
    compact: options.nativeObservationCompaction === true,
    sharedUpstream,
  };
}

function resultFormatOptions(options: AssembleContextOptions): FormatOperatorResultOptions {
  return {
    schemaInResult: options.schemaInResult,
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

/**
 * The operator's single consolidated `Inputs:` line, embedded in the operator
 * block so upstream connectivity is local (no separate `## Links` section).
 * Lists each upstream operator id + `(R rows, C cols)` when the op has executed
 * (rows from this op's input port metrics, cols resolved from the upstream
 * operator's output). Source operators emit nothing. Order is by port —
 * cosmetic only; the engine binds `process()` params by NAME=id, not position.
 */
function formatOperatorAdjacency(
  op: OperatorPredicate,
  allLinks: WorkflowContent["links"],
  opInfo?: OperatorInfo,
  snapshot?: SnapshotData
): string[] {
  // V2 measured relationships belong inside the observed result's budget.
  // Do not infer unmatched rows from output/min(input), or expose these
  // legacy heuristics in the evidence-off framework control.
  if (op.nativeOp) return []; // the operands are in the definition line
  const lines: string[] = [];
  const inbound = allLinks
    .filter(l => l.target.operatorID === op.operatorID)
    .map(l => ({ up: l.source.operatorID, port: op.inputPorts?.findIndex(p => p.portID === l.target.portID) ?? -1 }))
    .sort((a, b) => a.port - b.port);
  if (inbound.length > 0) {
    const shapes = opInfo?.inputPortShapes ?? [];
    // The single consolidated Inputs line: upstream id + (rows, cols) when the
    // op has executed, in a stable order (by port — cosmetic only; the engine
    // binds process() params by NAME=id, not position). Input row count comes
    // from this op's port metrics; input column count from the upstream
    // operator's output (engine port metrics omit it).
    const parts = inbound.map(i => {
      const shape = shapes.find(s => s.portIndex === i.port);
      const rowsPart = typeof shape?.rows === "number" ? `${shape.rows} rows` : undefined;
      const colN = typeof shape?.columns === "number" ? shape.columns : outputColsFromSnapshot(snapshot, i.up);
      const colsPart = typeof colN === "number" ? `${colN} cols` : undefined;
      const shapeStr = [rowsPart, colsPart].filter(Boolean).join(", ");
      return shapeStr ? `${i.up} (${shapeStr})` : i.up;
    });
    lines.push("Inputs: " + parts.join(", "));
  }
  return lines;
}

function serializeOperatorFull(
  op: OperatorPredicate,
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  allLinks: WorkflowContent["links"],
  operatorLevel: number,
  sharedUpstream?: Map<string, string>
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  // Visibility is a serializer invariant: a block shows only the results its
  // step requested (and every error).
  const requested = snapshot.reactStepId ? options.batchObservationsByStep?.get(snapshot.reactStepId) : undefined;
  if (requested && !requested.has(op.operatorID) && !info?.error) {
    const rows = info?.totalRowCount ?? info?.outputTuples;
    if (op.nativeOp)
      return operatorBlock(
        describeOperator(op, info, {
          scope: resultScope(op, snapshot.workflow, id => snapshot.results.get(id)?.info),
          issues: ["- note: result not requested."],
        })
      );
    return [
      `${"#".repeat(operatorLevel)} ${op.operatorType} operator \`${op.operatorID}\``,
      info
        ? `Result: executed${rows !== undefined ? `, ${rows} rows` : ""}; result not requested`
        : "Result: unavailable; result not requested",
    ].join("\n");
  }
  const execText = info
    ? formatOperatorResult(op.operatorID, info, workflowState, {
        ...resultFormatOptions(options),
        // The operator block renders a single consolidated `Inputs:` (with counts)
        // via formatOperatorAdjacency, so skip the in-Result one.
        inputsInResult: false,
        operatorAtEvent: op,
        nativeEvidence: nativeEvidenceAtSnapshot(op.operatorID, snapshot, options, sharedUpstream),
      })
    : undefined;

  if (op.nativeOp) {
    const block = describeOperator(op, info, {
      scope: resultScope(op, snapshot.workflow, id => snapshot.results.get(id)?.info),
      implementation: true,
      usedBy: snapshot.workflow.operators
        .filter(item => item.nativeOp?.inputs.includes(op.operatorID))
        .map(item => item.operatorID),
      issues: info?.error && execText ? execText.split("\n") : [],
    });
    if (execText?.startsWith("columns: ")) block.columns = [];
    return [operatorBlock(block), ...(execText && !info?.error ? [execText] : [])].join("\n");
  }

  // No status label in the header. Execution state is conveyed by the Result
  // section itself:
  //   - no info AND no errored upstream → no `Result:` block
  //     (operator hasn't been executed yet)
  //   - no info BUT an upstream op has info.error
  //                                    → `Result: (skipped — upstream
  //     operator `X` errored; …)` so the agent can distinguish "blocked
  //     by upstream failure" from "not yet built". Walks transitively
  //     through upstreams that themselves have no info, so a long
  //     skipped chain points back to the actual root-cause error.
  //   - successful info               → `Result:` block with the data preview
  //   - error info                    → `Result:` block beginning with
  //     `[ERROR] …`, which (per the Amber backend's format) carries the
  //     user's code + line marker inline.
  const opHash = "#".repeat(operatorLevel);
  const lines: string[] = [];
  // NATIVE operators: `### filter operator \`id\`` — the type is the header, the
  // parameters are the summary. Code operators keep `### Operator \`id\` (Type)` + Summary.
  lines.push(`${opHash} Operator \`${op.operatorID}\` (${op.operatorType})`);
  lines.push(`Summary: ${op.customDisplayName || op.operatorID}`);
  for (const l of formatOperatorAdjacency(op, allLinks, info, snapshot)) lines.push(l);

  // Operator properties (config). Rendered for every operator except the
  // Python code operators (whose `code` is stripped — see CODE_OPERATOR_TYPES)
  // when there is at least one property to show. Empty-property operators
  // render nothing.
  if (
    !op.nativeOp &&
    !CODE_OPERATOR_TYPES.has(op.operatorType) &&
    op.operatorProperties &&
    Object.keys(op.operatorProperties).length > 0
  ) {
    lines.push(`Properties: ${JSON.stringify(op.operatorProperties)}`);
  }

  if (execText) {
    lines.push("Result:");
    for (const l of execText.split("\n")) lines.push("  " + l);
  } else if (!info) {
    // No own result/error AND no info entry for this op. Distinguish
    // "blocked by upstream error" from "not yet executed" by walking
    // upstreams transitively (through ops that also have no info) to
    // find any ancestor with info.error.
    const failedUpstreams = collectFailedUpstreamRoots(op.operatorID, snapshot, allLinks);
    if (failedUpstreams.length > 0) {
      const noun = failedUpstreams.length === 1 ? "operator" : "operators";
      const list = failedUpstreams.map(id => `\`${id}\``).join(", ");
      lines.push(`Result: (skipped — upstream ${noun} ${list} errored; see [ERROR] above)`);
    }
  }

  // Print output (debug-only). Surface the operator's captured stdout so the model
  // can see what it printed instead of having it silently dropped. It is NOT the
  // operator's result and is NOT passed downstream — the returned DataFrame remains
  // the only data plane.
  if (info?.consoleLogs && info.consoleLogs.length > 0) {
    // Only actual print() output (ConsoleMessageType.PRINT). consoleLogs also
    // carries ERROR/COMMAND/DEBUGGER messages — the error traceback is already in
    // the Result block, so including it here would duplicate + mislabel it.
    const text = info.consoleLogs
      .filter(c => {
        const t = String(c.msgType ?? "").toUpperCase();
        return t === "PRINT" || t === "0";
      })
      // print() text is carried in `title` (message is empty); prefer whichever is set.
      .map(c => (typeof c.title === "string" && c.title.trim().length > 0 ? c.title : c.message))
      .filter(m => typeof m === "string" && m.trim().length > 0)
      .join("\n")
      .trimEnd();
    if (text) {
      lines.push(
        "Print output (your print(...) calls — for debugging only; NOT this operator's result and not passed downstream):"
      );
      for (const l of text.split("\n")) lines.push("  " + l);
    }
  }

  return lines.join("\n");
}

/**
 * Walk upstream from `opId` and return the set of ancestor operators
 * whose `info.error` is set, when this op has no info of its own.
 *
 * Traversal rules:
 *   - If an ancestor has `info.error` → record it, do not traverse past it
 *     (it's the chain's root cause for this branch).
 *   - If an ancestor has an `info` without an error → traversal of this
 *     branch stops (that ancestor ran successfully; it's not why our
 *     op was blocked).
 *   - If an ancestor has no `info` → keep walking; the error might be
 *     further up.
 *
 * Returns deduplicated upstream IDs in DAG-link discovery order.
 */
function collectFailedUpstreamRoots(
  opId: string,
  snapshot: SnapshotData,
  allLinks: WorkflowContent["links"]
): string[] {
  const childToParents = new Map<string, string[]>();
  for (const link of allLinks) {
    const arr = childToParents.get(link.target.operatorID) ?? [];
    arr.push(link.source.operatorID);
    childToParents.set(link.target.operatorID, arr);
  }
  const visited = new Set<string>();
  const failed: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...(childToParents.get(opId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const upInfo = snapshot.results.get(cur)?.info;
    if (upInfo?.error) {
      if (!seen.has(cur)) {
        seen.add(cur);
        failed.push(cur);
      }
      continue;
    }
    if (upInfo) {
      // Ran successfully — not why we're blocked.
      continue;
    }
    for (const p of childToParents.get(cur) ?? []) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  return failed;
}

// `buildLineageErrorContext` (#28) now lives in context/decorate/flow/error-context.

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
  return { sortedOps, allLinks, topoOrder };
}

function lastSnapshotOf(tasks: TaskGroup[]): SnapshotData | undefined {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    for (let j = t.nodes.length - 1; j >= 0; j--) {
      if (t.nodes[j].snapshot) return t.nodes[j].snapshot;
    }
  }
  return undefined;
}
