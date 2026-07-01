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
import type { OperatorPredicate, OperatorPortSchemaMap, PortSchema, WorkflowContent } from "../../types/workflow";
import type { ReActStep } from "../../types/agent";
import { AgentMode, ContextMode } from "../../types/agent";
import type { WorkflowCompilationResponse, WorkflowFatalError } from "../../api/compile-api";
import type { SnapshotData, WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { OperatorInfo } from "../../types/execution";
import { extractOperatorInputPortSchemaMap } from "./workflow-utils";
import { formatOperatorResult } from "../tools/result-formatting";
import { levelsToFlags } from "../context/decorate/registry";
import type { DecorateLevel } from "../context/decorate/types";
import { formatLoaderHint } from "../context/decorate/flow/loader-remediation";
import { formatLineage } from "../context/decorate/flow/cardinality";
import {
  buildLineageErrorContext,
  lineageErrorPointer,
  upstreamInputSchema,
} from "../context/decorate/flow/error-context";
import { formatJoinTelemetry } from "../context/decorate/data/diagnostics";
import { buildReasoning, renderReasoning, type Reasoning } from "../context/select/reinjection/reasoning";
import {
  buildErrorReflection,
  renderFoldedError,
  DEFAULT_REFLECTION_THRESHOLD,
  type ErrorReflectionEntry,
} from "../context/select/reinjection/error-reflection";
import { createLogger } from "../../logger";

const log = createLogger("ContextAssembler");

/* ============================================================================
 *  Public entry
 * ========================================================================= */

export interface AssembleContextOptions {
  /** Compilation result for the *current* workflowState. Schemas it carries
   *  are only attached to operators in the current (last) snapshot — we
   *  can't recompile historical snapshots cheaply, so non-current snapshots
   *  render without schema lines regardless of mode. */
  compilationResult?: WorkflowCompilationResponse | null;
  agentMode: AgentMode;
  /** LATEST only: when true, render the full Thought/Action/Observation
   *  trajectory as a `# Agent Turns` section (delta-style) on top of the
   *  latest-state core — the same per-event serializer DELTA uses. The block is
   *  pre-rendered by assembleContext and stashed in `agentTurnsRendered`. */
  agentTurns?: boolean;
  /** Internal: the pre-rendered `# Agent Turns` body (set by assembleContext
   *  when `agentTurns` is on in LATEST mode; consumed by renderLatest). */
  agentTurnsRendered?: string;
  /** DELTA supersession-collapse. When true, an operator's result renders only
   *  at the latest turn that produced it AND only while the operator is still
   *  live in the DAG; every superseded / deleted / re-executed-away result is
   *  replaced with an `(omitted — superseded)` marker. Thoughts + Actions are
   *  never touched. Near-lossless (drops only obsolete results), so it bounds
   *  result content to the number of LIVE operators instead of trajectory
   *  length. `latestResultNode` / `liveOps` are precomputed by assembleContext. */
  collapseSuperseded?: boolean;
  /** Internal: opId → step id of the LAST turn that produced that op's result. */
  latestResultNode?: Map<string, string>;
  /** Internal: operator ids still present in the leaf (current) snapshot. */
  liveOps?: Set<string>;
  /** DELTA context-budget cap (the watermark), in *tokens* (estimated as
   *  chars / 4, matching the agent's own input-token estimate). Bounds the
   *  assembled user-message context; the fixed system prompt is a separate,
   *  ~constant message and is not counted. Only meaningful with
   *  `collapseSuperseded` on:
   *    - cap unset / ≤ 0 → legacy unconditional collapse (every superseded
   *      result is blanked).
   *    - cap > 0 → WATERMARK: lossless delta is sent untouched while it fits
   *      the cap (the append-only prefix stays intact → prompt cache stays
   *      warm). Only when delta exceeds the cap do we blank superseded results
   *      OLDEST-FIRST — the minimum prefix needed to get back under the cap.
   *  This is the knob that turns "always collapse" (cache-hostile) into "only
   *  collapse under size pressure". Default 0 (off). */
  contextBudgetTokens?: number;
  /** Internal (computed by assembleContext): the exact set of `${stepId}::${opId}`
   *  result entries to blank as superseded. Empty/undefined ⇒ lossless delta.
   *  Populated by the budget watermark — see `renderDeltaWithBudget`. */
  collapseSet?: Set<string>;
  /** DELTA naive sliding-window baseline (the comparator for collapseSuperseded).
   *  Shares the `contextBudgetTokens` cap: below the cap, lossless delta is sent
   *  untouched; above it, the OLDEST whole agent events are dropped (not just their
   *  results — the entire Thought/Action/Observation turn) until the context fits,
   *  with the prev-snapshot reseeded so the surviving events' deltas stay correct
   *  and an `(… N earlier events omitted …)` marker in their place. This is the
   *  standard "drop oldest turns" eviction; the contrast that shows DAG-aware
   *  supersession-collapse keeps more useful signal at the same budget. Off by
   *  default; takes precedence over collapseSuperseded when both are set. */
  truncateOldest?: boolean;
  /** Internal (computed by the truncation watermark): keep only agent events whose
   *  `eventIndex >= keepFromEventIndex`; earlier events are dropped. Undefined ⇒
   *  keep all (lossless). */
  keepFromEventIndex?: number;
  /** Internal: how many oldest events were dropped (drives the omitted marker). */
  omittedEventsCount?: number;
  /** When true (the default), each operator's `operatorProperties` render as
   *  a `Properties:` line in the snapshot, EXCEPT the Python code operators
   *  in `CODE_OPERATOR_TYPES` (their `code` is large and already surfaced on
   *  error, so it is always stripped). When false, no properties render at
   *  all (legacy paper-§4.3 strip-everything behavior). Undefined ⇒ true. */
  includeOperatorProperties?: boolean;
  /** When true, a compact `Schema:` line (col + type, all columns) precedes
   *  each non-error operator result, derived from `columnStats`/headers.
   *  Off by default. Internal flag — the public knob is `dataLevel` (≥1), which
   *  expands to this via the rung catalog. */
  schemaInResult?: boolean;
  /** When true, each non-error operator result carries the full per-column
   *  `Column Schema and stats:` block (null/mean/min/max/distinct/top-N/datetime-range)
   *  published by the worker. Standalone flag — independent of `dataLevel`, so
   *  it overlays on any data level. Off by default. */
  columnStats?: boolean;
  /** When true, a load-stage operator (`DataLoading`) that errored gets a
   *  compact `Loader hint:` remediation line appended to its Result, keyed on
   *  the exception class parsed from the error string. Off by default. */
  loaderHint?: boolean;
  /** When true, append a `Format hints:` line flagging string columns whose
   *  sample values look like currency/percent/thousands-separated/etc., with the
   *  cleaning to apply before numeric conversion. Targets silent coercion
   *  dataloss. Off by default. */
  valueFormatFlags?: boolean;
  /** When true, each operator result gets a `Lineage:` line: input→output row
   *  counts (kept %) plus a conservative alarm on empty-output / fan-out
   *  explosion. Derived from carried row counts; targets silent-cardinality
   *  wrong-answers and the cost spiral tail. Off by default. */
  lineageStats?: boolean;
  /** #28: on an errored (non-loader) operator, render its direct upstream inputs'
   *  schema + a few sample rows so the model fixes against real consumed data,
   *  not guessed columns. Render-time only. Default false. */
  lineageErrorContext?: boolean;
  /** When true, surface a `Join check ⚠` line for any degenerate merge the
   *  worker flagged (near-zero key match with an unmatched-key sample, or a
   *  many-to-many fan-out). Read from the reserved `__join_telemetry__` entry on
   *  columnStats. Alarm-only. Off by default. */
  joinTelemetry?: boolean;
  /** When true, a `DataLoading` operator whose output reaches NO downstream
   *  operator (a dead/forgotten load — pure typed-DAG reachability) gets a
   *  `Graph check ⚠` line telling the agent to wire it in or drop it. Current
   *  snapshot only. Uniquely enabled by the dataflow graph (a free-form script
   *  has no graph to audit). Off by default. */
  graphAudit?: boolean;
  /** When true, surface a coercion-dataloss line for any to_numeric/to_datetime
   *  (errors="coerce") the worker saw silently null a material block of values,
   *  with a sample of the dropped values. Read from `__coercion_telemetry__` on
   *  columnStats. Alarm-only. Off by default. */
  coercionTelemetry?: boolean;
  /** W1: cap the per-operator TSV sample to first+last N rows (true row count).
   *  0/undefined = no cap. */
  maxResultRows?: number;
  /** Per-cell char cap (reused as the truncation limit for the surfaced print
   *  output block). Undefined ⇒ no cap. */
  maxOperatorResultCellCharLimit?: number;
  /** #25/#26/#27: surface a `Data hints:` block of pre-emptive STRUCTURAL hints
   *  (grain/key, low-cardinality partition/gate columns, empty rows/cols + dups)
   *  computed name-agnostically by the worker. Render-time only. Default false. */
  tableStructureHint?: boolean;
  /** Thought-replay reinjection rung (LATEST only). When on, render a
   *  `# Reasoning` block — the last `thoughtReplayK` agent EVENTS, each as its
   *  thought + the compressed actions it produced — and tag each operator with a
   *  `Last edited: step N` back-pointer into that block. Recovers the reasoning
   *  LATEST otherwise folds away. Off by default. */
  thoughtReplay?: boolean;
  /** How many recent events the `# Reasoning` block shows. Undefined ⇒ 10. */
  thoughtReplayK?: number;
  /** Internal (computed in assembleContext, NOT a setting): the event-grouped
   *  reasoning structure + per-operator latest-edit map, fed to the LATEST
   *  renderer and the per-operator back-pointer. Built only when thoughtReplay
   *  is on and the mode is LATEST. */
  reasoning?: Reasoning;
  /** Error-reflection rung (LATEST only). When on, an operator that has been
   *  (re)written repeatedly gets an `Attempts: …` block in the end-of-context
   *  "Operators needing attention" section: attempt count, errored count, the
   *  distinct error signatures seen, and a "blocked → change strategy" verdict
   *  when the recent errors repeat. Recovers the past-attempt history LATEST
   *  folds away (the input the prompt's "change strategy after 2 fails" needs).
   *  Off by default. */
  errorReflection?: boolean;
  /** N: only after this many CONSECUTIVE same-operator (re)fixing attempts is the
   *  folded error/attempt history (input schema, count, diff, distinct errors)
   *  included for that operator. Below N the operator just shows its inline error.
   *  Undefined ⇒ DEFAULT_REFLECTION_THRESHOLD. */
  errorReflectionThreshold?: number;
  /** Internal (computed in assembleContext, NOT a setting): per-operator attempt
   *  / error history, built from the path only when errorReflection is on and the
   *  mode is LATEST. */
  errorReflectionMap?: Map<string, ErrorReflectionEntry>;
  /** W2: few-shot best-practices prompt toggle. Not used by the assembler (it
   *  affects the SYSTEM prompt, applied in TexeraAgent.rebuildSystemPrompt) —
   *  declared here only so the settings pass-through type-checks. */
  fewShotPrompt?: boolean;
  /** When true, an operator edited >= the reflection threshold times gets an
   *  `Attempt reflection:` block on the current snapshot (edit count + latest
   *  symptom + current code, otherwise stripped in CODE mode + a change-strategy
   *  directive). Targets same-operator thrashing. Off by default. */
  attemptReflection?: boolean;
  /** Internal (computed in assembleContext, NOT a setting): per-operatorId count
   *  of `createOrModifyOperator` calls across the visible trajectory. Feeds the
   *  attempt-reflection render — LATEST shows no history, so it's reconstructed
   *  from `visibleSteps`. */
  editCountsByOp?: Map<string, number>;
  /** DECORATE ordinal levels (claude/CONTEXT-DESIGN.md §5). When set (>=0), the
   *  flow/data facet level expands — via the rung catalog (context/decorate/
   *  registry.levelsToFlags) — into the individual render flags above, OR-ing
   *  them on. This is the new ordinal knob replacing the per-lever booleans;
   *  the booleans remain valid and any explicitly-set boolean is preserved
   *  (the level only turns rungs ON, never off). Undefined ⇒ legacy boolean
   *  behavior, no expansion. */
  flowLevel?: number;
  dataLevel?: number;
}

/**
 * Python code operators whose `operatorProperties` (chiefly the `code` blob)
 * are always stripped from the assembled context: their source is large and
 * already surfaced inline on error, so echoing it in every snapshot is pure
 * token cost. All other operator types render their properties when
 * `includeOperatorProperties` is on.
 */
const CODE_OPERATOR_TYPES = new Set(["PythonUDFV2", "DataLoading", "DataProcessing"]);

/**
 * plan3 — minimum cumulative edits to one operator before an `Attempt
 * reflection:` block is injected. 3 aligns with the prompt rule "change strategy
 * after 2 attempts" (reflect on the 3rd+). A general default, not eval-fit.
 */
const ATTEMPT_REFLECTION_THRESHOLD = 3;

/**
 * Chars-per-token divisor for the `contextBudgetTokens` watermark. Matches the
 * agent's own input-token estimate (`Math.ceil(userMessage.length / 4)` in
 * texera-agent.ts) so the cap the caller sets in tokens lines up with the usage
 * the agent reports. A real tokenizer can drop in here later.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Build the assembled user-message context the LLM sees on the next
 * `prepareStep`. A context is a path on the snapshot tree from the root
 * (empty snapshot) to the leaf (current snapshot). The path is rendered
 * differently per mode:
 *
 *   - LATEST: only the leaf snapshot is rendered. The LLM sees the user
 *     task plus the current dataflow — no events, no per-turn history.
 *
 *   - FULL: each edge on the path is rendered as `## Agent Event N`
 *     (thought + actions) followed by the full snapshot of state after
 *     that event.
 *
 *   - DELTA: same shape as FULL but each post-event snapshot block shows
 *     only the operators that changed at that event (delta), plus the
 *     full link set so the DAG wiring stays visible.
 *
 * Action rendering (Full/Delta only): each tool call inside an event
 * renders as one natural-language line — `- create operator "X", result:
 * …` / `- modify operator "X", result: …` / `- delete operator "X",
 * result: …`. Create vs. modify is decided by walking the path: an op
 * id that hasn't been seen yet (or that was deleted) reads as `create`,
 * otherwise as `modify`. The submitted `code` and `summary` are NOT
 * included on event lines — the snapshot below carries the relevant
 * state.
 *
 * Snapshot trimming (paper §4.3): the Python code operators'
 * (`CODE_OPERATOR_TYPES`) computation function (`code`) is always dropped —
 * the user's `OperatorInfo` result already carries the source code on error,
 * so dropping it doesn't hide what's needed to debug. All other operators
 * render their `operatorProperties` as a `Properties:` line when
 * `options.includeOperatorProperties` is on (the default); set it false to
 * restore the legacy strip-everything behavior.
 */
export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  mode: ContextMode,
  options: AssembleContextOptions
): ModelMessage[] {
  // DECORATE levels → render flags (claude/CONTEXT-DESIGN.md §5). When the
  // caller supplies ordinal facet levels, expand them through the rung catalog
  // and OR the resulting rung flags onto `options`. Levels only turn rungs ON;
  // an explicitly-set boolean is never cleared. Undefined levels ⇒ no-op, so
  // existing boolean-only callers are unaffected.
  if (options.flowLevel !== undefined || options.dataLevel !== undefined) {
    const clamp = (n: number | undefined): DecorateLevel =>
      Math.max(0, Math.min(3, Math.floor(n ?? 0))) as DecorateLevel;
    const expanded = levelsToFlags(clamp(options.flowLevel), clamp(options.dataLevel));
    const bag = options as unknown as Record<string, unknown>;
    for (const flag of Object.keys(expanded)) {
      bag[flag] = true;
    }
  }

  const { path, initSnapshot } = buildPath(visibleSteps, snapshotStorage);

  // The latest user-message content lives in its own top-of-prompt
  // `# User Task` block — single source of truth, always present, never
  // duplicated. Its step id lets renderers skip rendering the same user
  // event inline in the events list. Older user messages (multi-task
  // continuation) still render inline as `## User Event N`.
  const latestUserStep = findLatestUserStepInPath(path);
  const latestUserContent = latestUserStep?.step.content;
  const latestUserStepId = latestUserStep?.step.id;

  const tasks = groupIntoTasks(path);

  // Per-step create-vs-modify flags. Linear walk over the path: each
  // `createOrModifyOperator` call records whether the op id was already
  // known (modify) or fresh (create). `deleteOperator` removes from the
  // known set so a later create-on-same-id reads as `create` again.
  const createFlagsByStep = buildCreateFlagsByStep(path);
  // plan3: per-operator cumulative edit counts from the trajectory, for the
  // attempt-reflection render. LATEST mode shows no history, so reconstruct
  // from visibleSteps here. Stash on options so the per-operator serializer
  // (which doesn't see the path) can read it.
  options.editCountsByOp = buildEditCountsByOp(path);
  // Thought-replay reinjection rung (LATEST only): event-grouped recent thoughts
  // + compressed actions, plus the per-operator latest-edit map that drives the
  // `Last edited:` back-pointer. DELTA already shows thoughts inline via
  // serializeTurn, so this is scoped to LATEST to avoid double-rendering.
  if (options.thoughtReplay && mode === ContextMode.LATEST) {
    options.reasoning = buildReasoning(path);
  }
  if (options.errorReflection && mode === ContextMode.LATEST) {
    options.errorReflectionMap = buildErrorReflection(path);
  }
  // Supersession-collapse pre-pass (DELTA): which turn owns each operator's
  // current result, and which operators are still live in the leaf snapshot.
  if (options.collapseSuperseded) {
    options.latestResultNode = computeLatestResultNodes(tasks, initSnapshot);
    const leaf = lastSnapshotOf(tasks);
    options.liveOps = new Set((leaf?.workflow.operators ?? []).map(o => o.operatorID));
  }

  let content: string;
  switch (mode) {
    case ContextMode.DELTA: {
      const budgetChars =
        options.contextBudgetTokens && options.contextBudgetTokens > 0
          ? options.contextBudgetTokens * CHARS_PER_TOKEN
          : undefined;
      // truncateOldest (naive sliding window) takes precedence over the
      // supersession-collapse path when both are set; both share the cap.
      content =
        options.truncateOldest && budgetChars !== undefined
          ? renderDeltaTruncated(
              tasks,
              workflowState,
              options,
              initSnapshot,
              latestUserContent,
              latestUserStepId,
              createFlagsByStep,
              budgetChars
            )
          : renderDeltaWithBudget(
              tasks,
              workflowState,
              options,
              initSnapshot,
              latestUserContent,
              latestUserStepId,
              createFlagsByStep
            );
      break;
    }
    case ContextMode.LATEST: {
      // Latest = user task + the leaf snapshot. Optionally (agentTurns) also
      // prepend the full Thought/Action/Observation trajectory as a
      // `# Agent Turns` section — the same per-event bodies DELTA renders, on
      // top of the latest-state core.
      if (options.agentTurns) {
        // Thought + Action only — the per-operator results would just duplicate
        // the `# Current Dataflow` core that follows, so omit the Observation.
        options.agentTurnsRendered = renderAgentEvents(
          tasks,
          workflowState,
          options,
          initSnapshot,
          latestUserStepId,
          createFlagsByStep,
          /* omitObservation */ true
        );
      }
      const leafSnapshot = lastSnapshotOfPath(path) ?? initSnapshot ?? snapshotStorage.getRootSnapshot();
      content = renderLatest(workflowState, options, latestUserContent, leafSnapshot);
      break;
    }
  }

  log.debug(
    {
      mode,
      tasks: tasks.length,
      pathLength: path.length,
      actionBearing: path.filter(n => n.snapshot !== undefined).length,
      initExcluded: initSnapshot !== undefined,
    },
    "built context"
  );

  return [{ role: "user", content }];
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
export interface PathNode {
  step: ReActStep;
  snapshot: SnapshotData | undefined;
  eventIndex: number;
}

/**
 * The synthetic `initialize` step (Event 0) is the baseline workflow load,
 * not a user-visible action. We strip it from the rendered path so the LLM
 * doesn't see the init event, but we preserve its snapshot separately so
 * the first real action can still diff against it (Delta) and so the
 * Latest-mode trailing block can fall back to it when no other action has
 * produced a snapshot yet.
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
   *  to seed delta diffing and the Latest-mode trailing fallback. */
  initSnapshot: SnapshotData | undefined;
}

/** Pick the latest user-role node from a full path. Used to hoist the
 *  latest user message into the `# User Task` block at the top of the
 *  rendered context, and to skip rendering the same node inline within
 *  `# Recent Agent Events` (older user messages still render inline as
 *  `## User Event N`). */
function findLatestUserStepInPath(path: PathNode[]): PathNode | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i];
    if (n.step.role === "user" && n.step.content) return n;
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
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
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

/**
 * Per-operatorId cumulative count of `createOrModifyOperator` calls across the
 * visible trajectory (plan3). A high count signals same-operator thrashing —
 * the agent re-deriving variants because CODE mode strips its prior code. Used
 * by the attempt-reflection render. Counts every well-formed edit (create seeds
 * the count at 1); not decremented on delete (total churn is what matters).
 */
function buildEditCountsByOp(fullPath: PathNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of fullPath) {
    if (node.step.role !== "agent" || !node.step.toolCalls) continue;
    for (const tc of node.step.toolCalls) {
      if (tc.toolName !== "createOrModifyOperator") continue;
      const opId = (tc.input as Record<string, unknown> | undefined)?.operatorId;
      if (typeof opId === "string" && opId) counts.set(opId, (counts.get(opId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * W3 — compact construction timeline. LATEST mode renders only the current
 * snapshot (no events), so the model can't see the trajectory it took. This
 * walks the path's operator edits in order and renders the last K as
 * `created/modified/deleted \`op\` → ok|ERROR: …`, so the model sees what it
 * already tried (cheaply — one short line per event, not full FULL-mode
 * snapshots). Returns undefined when there are no edits yet.
 */
// The thought-replay reinjection rung lives in
// context/select/reinjection/reasoning (imported above). It supersedes the
// former structural-only `buildTimeline` rung, which was removed.

/* ============================================================================
 *  Rendering: interleaved (FULL & DELTA) + trailing-snapshot (LATEST)
 * ========================================================================= */

/**
 * Layout (shared across all modes):
 *
 *   # User Task
 *
 *   <latest user-message content>
 *
 *   # Recent Agent Events (last K of N events)
 *
 *   (... M earlier events omitted ...)
 *
 *   ## Agent Event N
 *   Thought: ...
 *   Actions:
 *   - createOrModifyOperator(operatorId="...", summary="...")
 *       code: |
 *         ...
 *       (result: ...)
 *
 *   ## User Event N   ← only when an older user-message lies inside the
 *                       cap window (multi-task continuation). The latest
 *                       user message is hoisted to `# User Task` above.
 *
 *   # Current Dataflow   ← FULL/DELTA modes also emit inline snapshots
 *                          between events under "Recent Agent Events"
 *                          (`### Dataflow ... after event N`).
 *   ## Operators
 *   ### Operator `x` (Type)
 *   ...
 */
/**
 * Supersession pre-pass: replay the per-turn deltas (same rolling-prev logic as
 * the renderer) and record, for each operator, the step id of the LATEST turn
 * that produced a result for it. Combined with the leaf snapshot's live-operator
 * set, this lets serializeTaskBody keep only each operator's current live result
 * and omit every superseded/deleted one (collapseSuperseded).
 */
function computeLatestResultNodes(
  tasks: TaskGroup[],
  initSnapshot: SnapshotData | undefined
): Map<string, string> {
  const latest = new Map<string, string>();
  let prev: SnapshotData | undefined = initSnapshot;
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role !== "agent" || !node.snapshot) continue;
      for (const opId of computeDelta(prev, node.snapshot)) latest.set(opId, node.step.id);
      prev = node.snapshot;
    }
  }
  return latest;
}

/**
 * Enumerate every superseded operator result the renderer COULD blank, in
 * oldest-first (path) order. A result is collapsible exactly when the inline
 * serializer's keep-test fails — i.e. it is NOT the operator's current live
 * result (latest result-turn AND still in the leaf DAG). Each entry is the
 * `${stepId}::${opId}` key the serializer matches against `options.collapseSet`.
 *
 * Mirrors the renderer's iteration precisely (rolling `computeDelta` seeded by
 * the init snapshot, then topo-sorted ops), so blanking the whole list is
 * byte-identical to the legacy unconditional collapse, and blanking a prefix
 * (`slice(0, k)`) drops the k oldest superseded results — the unit the budget
 * watermark searches over.
 */
function computeSupersededCandidates(
  tasks: TaskGroup[],
  initSnapshot: SnapshotData | undefined,
  latestResultNode: Map<string, string> | undefined,
  liveOps: Set<string> | undefined
): string[] {
  const keys: string[] = [];
  let prev: SnapshotData | undefined = initSnapshot;
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role !== "agent" || !node.snapshot) continue;
      const delta = computeDelta(prev, node.snapshot);
      const { sortedOps } = topoSortDag(node.snapshot.workflow);
      for (const op of sortedOps) {
        if (!delta.has(op.operatorID)) continue;
        const isLiveLatest =
          (liveOps?.has(op.operatorID) ?? false) && latestResultNode?.get(op.operatorID) === node.step.id;
        if (!isLiveLatest) keys.push(`${node.step.id}::${op.operatorID}`);
      }
      prev = node.snapshot;
    }
  }
  return keys;
}

/**
 * DELTA render with optional supersession-collapse under a context-budget cap.
 *
 * Lossless delta is the baseline (the proven-best keeper: append-only prefix →
 * warm prompt cache, full result history). `collapseSuperseded` enables blanking
 * superseded results; `contextBudgetTokens` (B) governs WHEN:
 *
 *   - B unset / ≤ 0 → legacy unconditional collapse (blank ALL superseded).
 *   - B > 0 → WATERMARK. Render lossless first; if it fits B, send it untouched
 *     (no retroactive edits, so the cache-stable prefix is preserved). Only once
 *     delta exceeds B do we blank superseded results OLDEST-FIRST — the minimum
 *     prefix that gets back under B. `size(k)` (blank oldest k) is monotone
 *     non-increasing in k, so we binary-search the smallest sufficient k. If even
 *     a full collapse can't reach B, blank all and log the residual overflow
 *     (never silently truncate).
 *
 * B is measured against this function's output (the assembled user message),
 * estimated as chars / CHARS_PER_TOKEN; the fixed system prompt is separate.
 */
function renderDeltaWithBudget(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const renderWith = (collapseSet: Set<string> | undefined): string => {
    options.collapseSet = collapseSet;
    return renderInterleaved(
      tasks,
      workflowState,
      options,
      initSnapshot,
      latestUserContent,
      latestUserStepId,
      createFlagsByStep
    );
  };

  if (!options.collapseSuperseded) return renderWith(undefined);

  const candidates = computeSupersededCandidates(tasks, initSnapshot, options.latestResultNode, options.liveOps);
  const budgetChars =
    options.contextBudgetTokens && options.contextBudgetTokens > 0
      ? options.contextBudgetTokens * CHARS_PER_TOKEN
      : undefined;

  // No cap → legacy unconditional collapse (blank every superseded result).
  if (budgetChars === undefined) return renderWith(new Set(candidates));

  // Watermark: keep lossless delta as long as it fits the cap.
  const lossless = renderWith(undefined);
  if (lossless.length <= budgetChars || candidates.length === 0) {
    if (lossless.length > budgetChars) {
      log.warn(
        { budgetChars, sizeChars: lossless.length },
        "context over budget but no superseded results available to collapse"
      );
    }
    return lossless;
  }

  // Over budget: blank superseded results OLDEST-FIRST until back under the cap.
  // A result whose block is no larger than the marker is left intact (blanking it
  // would only grow the prompt), so the context never exceeds lossless delta and
  // size is monotone non-increasing as we add blanks. Stop as soon as we fit. If
  // even every collapsible result isn't enough, keep the smallest and log the
  // residual overflow — never silently truncate.
  const chosen = new Set<string>();
  let bestOut = lossless;
  let bestLen = lossless.length;
  for (const key of candidates) {
    if (bestLen <= budgetChars) break;
    chosen.add(key);
    const trial = renderWith(chosen);
    if (trial.length < bestLen) {
      bestOut = trial;
      bestLen = trial.length;
    } else {
      chosen.delete(key); // marker ≥ this result — blanking wouldn't help
    }
  }
  log[bestLen > budgetChars ? "warn" : "debug"](
    { budgetChars, collapsed: chosen.size, candidates: candidates.length, sizeChars: bestLen },
    bestLen > budgetChars
      ? "context over budget even after collapsing every collapsible superseded result"
      : "watermark supersession-collapse"
  );
  return bestOut;
}

/**
 * DELTA naive sliding-window baseline (truncateOldest) — the comparator for the
 * supersession-collapse arm. Same watermark: lossless delta is sent untouched
 * while it fits the cap; once it exceeds, the OLDEST whole agent events are
 * dropped (entire Thought/Action/Observation turns, not just results) until it
 * fits. The prev-snapshot is RESEEDED to the state just before the first
 * surviving event, so the survivors' per-turn deltas stay correct (otherwise the
 * first survivor would diff against the empty init and re-render every operator
 * as "added"). An `(… N earlier events omitted …)` marker stands in their place.
 *
 * This is the standard eviction every agent framework does; the contrast is that
 * it drops the early-created operators' structure + results wholesale, whereas
 * collapse keeps the structural lines and the live frontier and blanks only the
 * superseded result bodies — so at the same budget collapse retains more signal.
 */
function renderDeltaTruncated(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  budgetChars: number
): string {
  const renderKeeping = (cutoff: number | undefined, reseed: SnapshotData | undefined, omitted: number): string => {
    options.keepFromEventIndex = cutoff;
    options.omittedEventsCount = omitted;
    return renderInterleaved(tasks, workflowState, options, reseed, latestUserContent, latestUserStepId, createFlagsByStep);
  };

  // Lossless first (keep every event) — preserves the cache-stable prefix while
  // it fits, exactly like the collapse watermark.
  const lossless = renderKeeping(undefined, initSnapshot, 0);
  if (lossless.length <= budgetChars) return lossless;

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
  let bestLen = lossless.length;
  let dropped = 0;
  for (let d = 1; d <= evs.length - 1; d++) {
    bestOut = renderKeeping(evs[d].idx, evs[d - 1].snap, d); // keep eventIndex >= evs[d].idx
    bestLen = bestOut.length;
    dropped = d;
    if (bestLen <= budgetChars) break;
  }
  log[bestLen > budgetChars ? "warn" : "debug"](
    { budgetChars, dropped, kept: evs.length - dropped, sizeChars: bestLen },
    bestLen > budgetChars
      ? "context over budget even after keeping only the most recent event"
      : "watermark truncate-oldest"
  );
  return bestOut;
}

/**
 * Render the agent trajectory as the sequence of per-event Thought / Action /
 * Observation bodies (delta-style). Shared by DELTA's `# Agent Events` section
 * and LATEST's optional `# Agent Turns` section (agentTurns). The rolling
 * prevSnapshot (seeded by the hidden init snapshot) drives the per-event
 * "operator X added/updated" diff in each Observation. Returns the joined
 * bodies, or the empty-trajectory placeholder.
 */
function renderAgentEvents(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  omitObservation = false
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
      latestUserStepId,
      createFlagsByStep,
      omitObservation
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
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const sections: string[] = [];

  // 1. # User Task
  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }

  // 2. # Agent Events — every event in the path as a Thought / Action /
  // Observation triplet (the Observation lists the operators changed or
  // re-executed by that event; see serializeTaskBody).
  sections.push("# Agent Events");
  sections.push("");

  // Sliding-window truncation marker (truncateOldest): the dropped oldest events
  // are replaced by a single placeholder so the model knows history was elided.
  if (options.omittedEventsCount && options.omittedEventsCount > 0) {
    const n = options.omittedEventsCount;
    sections.push(`(… ${n} earlier event${n === 1 ? "" : "s"} omitted to fit the context budget …)`);
    sections.push("");
  }

  // For Delta: each event as a Thought/Action/Observation body, diffed against
  // a rolling previous snapshot (seeded by the hidden init snapshot).
  sections.push(renderAgentEvents(tasks, workflowState, options, initSnapshot, latestUserStepId, createFlagsByStep));
  sections.push("");

  // FLOW section over the leaf snapshot (composable with delta too — placed
  // last, after the event/snapshot trajectory). Empty ⇒ omitted.
  const leaf = lastSnapshotOf(tasks);
  if (leaf) {
    const flow = buildFlowSection(leaf, workflowState, options, /*isLatest=*/ false);
    if (flow) {
      sections.push("");
      sections.push(flow);
    }
  }

  return sections.join("\n").trimEnd();
}

function renderLatest(
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  latestUserContent: string | undefined,
  leafSnapshot: SnapshotData
): string {
  const sections: string[] = [];

  // 1. # User Task
  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }

  // 1b. # Reasoning — thought-replay reinjection rung. LATEST otherwise folds
  //     away the trajectory; this re-injects the last K agent EVENTS, each as
  //     its thought + the compressed actions it produced (event-granular:
  //     one thought : N actions). Gated by the thoughtReplay flag.
  if (options.thoughtReplay && options.reasoning && !options.agentTurns) {
    const block = renderReasoning(options.reasoning, options.thoughtReplayK ?? 10);
    if (block) {
      sections.push("# Reasoning (your recent steps)");
      sections.push("");
      sections.push(block);
      sections.push("");
    }
  }

  // 1c. # Agent Turns — the full Thought/Action/Observation trajectory rendered
  //     delta-style (agentTurns flag), on top of the latest-state core. The
  //     fuller alternative to the last-K `# Reasoning` block above; pre-rendered
  //     by assembleContext.
  if (options.agentTurnsRendered) {
    sections.push("# Agent Turns");
    sections.push("");
    sections.push(options.agentTurnsRendered);
    sections.push("");
  }

  // 2. # Current Dataflow — the leaf snapshot of the path. Latest mode
  //    is defined as a single point on the snapshot tree, so no events
  //    are rendered above this.
  const dag = serializeSnapshotFull(leafSnapshot, workflowState, options, /*isCurrent=*/ true, /*sectionLevel=*/ 2);
  if (dag) {
    sections.push("# Current Dataflow");
    sections.push(dag);
  }

  // 3. # Operators needing attention — the FLOW section. A consolidated,
  //    root-cause-first projection of failures + anomalies over the leaf
  //    snapshot, placed last (highest-attention position). Gated by flowLevel
  //    (expanded into the per-rung flags); empty ⇒ omitted.
  const flow = buildFlowSection(leafSnapshot, workflowState, options, /*isLatest=*/ true);
  if (flow) {
    sections.push("");
    sections.push(flow);
  }
  return sections.join("\n").trimEnd();
}

/**
 * FLOW section (Phase-1 trajectory/graph projection). Scans the leaf snapshot
 * in topological order (root cause before downstream symptom) and emits a
 * self-contained entry for every operator that needs attention: hard errors,
 * upstream-blocked operators, and (level-gated) soft anomalies. Reuses the same
 * pure flow renderers that previously decorated each operator inline — now
 * consolidated into one end-of-context section so the actionable signal isn't
 * buried in the DAG dump. Returns undefined when nothing needs attention.
 *
 * Level gating (via the flags flowLevel expands into):
 *   L1 loaderHint            — remediation on failed DataLoading ops
 *   L2 lineageErrorContext   — errored process op: in DELTA, the upstream input
 *                              schema + sample rows (the model can't otherwise see
 *                              them); in LATEST, where every operator's Result is
 *                              already rendered, just a pointer to the upstream's
 *                              Result (no duplication).
 *   L2 lineageStats          — empty-output / fan-out cardinality alarms
 *   L3 graphAudit            — dead/disconnected loaders
 *   L3 joinTelemetry         — degenerate-join telemetry
 */
function buildFlowSection(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isLatest: boolean
): string | undefined {
  const anyFlow =
    options.loaderHint ||
    options.lineageStats ||
    options.lineageErrorContext ||
    options.graphAudit ||
    options.joinTelemetry ||
    options.errorReflection;
  if (!anyFlow) return undefined;

  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return undefined;
  const { sortedOps, allLinks } = topoSortDag(workflow);

  const entries: string[] = [];
  const erroredOps: string[] = []; // for the fold-mode pointer index
  for (const op of sortedOps) {
    const info = snapshot.results.get(op.operatorID)?.info;
    const lines: string[] = [];

    if (info?.error) {
      if (options.errorReflection) {
        // Fold mode: error detail (input schema, history) lives on the operator's
        // own block; here just record the id for the pointer index so any errored
        // operator stays salient.
        erroredOps.push(op.operatorID);
      } else {
        lines.push(`error: ${info.error.split("\n")[0]}`);
        if (options.loaderHint && op.operatorType === "DataLoading") {
          const hint = formatLoaderHint(info.error);
          if (hint) lines.push(...hint.split("\n"));
        }
        if (options.lineageErrorContext && op.operatorType !== "DataLoading") {
          // LATEST already renders every operator's Result, so reference the
          // upstream instead of re-dumping it; DELTA may have omitted the
          // upstream, so keep the full schema + sample-rows block there.
          const block = isLatest
            ? lineageErrorPointer(op.operatorID, snapshot, allLinks)
            : buildLineageErrorContext(op.operatorID, snapshot, allLinks);
          if (block) lines.push(...block.split("\n"));
        }
      }
    } else if (!info) {
      const roots = collectFailedUpstreamRoots(op.operatorID, snapshot, allLinks);
      if (roots.length > 0) {
        const noun = roots.length === 1 ? "operator" : "operators";
        lines.push(`blocked — upstream ${noun} ${roots.map(id => `\`${id}\``).join(", ")} errored; fix those first`);
      }
    } else {
      if (options.lineageStats) {
        const alarm = formatLineage(info);
        if (alarm) lines.push(alarm);
      }
      if (options.joinTelemetry) {
        const jt = formatJoinTelemetry(info);
        if (jt) lines.push(...jt.split("\n"));
      }
    }

    // Dead-loader audit (L3) — independent of execution state.
    if (options.graphAudit && op.operatorType === "DataLoading" && workflow.operators.length > 1) {
      const sinks = workflowState.getDownstreamSinks(op.operatorID);
      const feedsNothing = sinks.length === 0 || (sinks.length === 1 && sinks[0] === op.operatorID);
      if (feedsNothing) {
        lines.push(
          "Graph check ⚠: this loaded data is not consumed by any downstream operator — wire it into the pipeline or drop it."
        );
      }
    }

    if (lines.length > 0) {
      entries.push(`### \`${op.operatorID}\` (${op.operatorType})`);
      for (const l of lines) entries.push(l);
      entries.push("");
    }
  }

  // Fold mode: a one-line pointer index keeps errored operators salient (their
  // full detail is folded onto each operator's own block above), in root-cause
  // (topological) order. Prepended so it sits right under the section header.
  if (options.errorReflection && erroredOps.length > 0) {
    const ids = erroredOps.map(id => `\`${id}\``).join(", ");
    entries.unshift(
      `Operators with execution errors (see each operator's block above for the error, input schema, and attempt history): ${ids} — fix \`${erroredOps[0]}\` first (root cause), then re-run.`,
      ""
    );
  }

  if (entries.length === 0) return undefined;
  return ["# Operators needing attention (fix in this order)", "", ...entries].join("\n").trimEnd();
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
  /** When true, render only Thought + Action per event and omit the Observation
   *  block. Used by LATEST's `# Agent Turns` section, where the per-operator
   *  results would just duplicate `# Current Dataflow`. DELTA leaves it false. */
  omitObservation = false
): string {
  const lines: string[] = [];

  for (const node of task.nodes) {
    // Sliding-window truncation (truncateOldest): drop events older than the
    // cutoff entirely. `continue` BEFORE any setPrev so the rolling prev stays at
    // the reseeded snapshot until the first surviving event (keeps its delta correct).
    if (options.keepFromEventIndex !== undefined && node.eventIndex < options.keepFromEventIndex) continue;
    if (node.step.role === "user") {
      // The latest user message is hoisted into the top-level `# User Task`
      // block by the caller. Skip it here so it doesn't appear twice.
      if (node.step.id === latestUserStepId) continue;
      lines.push(serializeUserEventInline(node));
      lines.push("");
      continue;
    }
    if (node.step.role !== "agent") continue;

    lines.push(serializeTurn(node));
    lines.push("");

    if (node.snapshot && !omitObservation) {
      // Observation = the execution outcome of the Action: a per-operator list.
      // The operator-block STRUCTURAL decorations (Summary / Inputs)
      // are LATEST's view and stay out here; the DATA-facet decorations (Schema /
      // Data hints / Format hints) render per `dataLevel`, symmetric with LATEST
      // (see renderRawResult). Every operator that CHANGED or
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
      calls.forEach((tc, i) => {
        const inp = tc.input as Record<string, unknown> | undefined;
        const opId = typeof inp?.operatorId === "string" ? (inp.operatorId as string) : "";
        if (tc.toolName === "deleteOperator" && opId) {
          deletedOps.push(opId);
        } else if (tc.toolName === "createOrModifyOperator" && opId) {
          actedVerb.set(opId, createFlags?.get(opId) ? "added" : "updated");
        }
        // An action whose operator isn't reflected in Δ (a rejected/no-op edit, or
        // a non-operator tool) keeps a one-line outcome so the attempt isn't lost.
        if (opId && tc.toolName !== "deleteOperator" && !delta.has(opId)) {
          noChangeOutcome.push(`- operator ${opId} (no change): ${conciseOutcome(results[i]?.output)}`);
        }
      });

      const obs: string[] = [];
      for (const opId of deletedOps) obs.push(`- operator ${opId} deleted`);
      const { sortedOps } = topoSortDag(node.snapshot.workflow);
      for (const op of sortedOps) {
        if (!delta.has(op.operatorID)) continue;
        obs.push(`- operator ${op.operatorID} ${actedVerb.get(op.operatorID) ?? "updated"}`);
        // Supersession-collapse: blank this result iff assembleContext marked
        // this `${stepId}::${opId}` entry in `collapseSet` (a superseded result
        // selected by the budget watermark — oldest-first, or all of them under
        // the legacy unconditional/no-cap path). The structural "- operator X …"
        // line above is kept either way; only the result body is dropped.
        if (options.collapseSet?.has(`${node.step.id}::${op.operatorID}`)) {
          obs.push("  result: (omitted — superseded by a later edit)");
          continue;
        }
        const info = node.snapshot.results.get(op.operatorID)?.info;
        const resultText = info
          ? renderRawResult(op.operatorID, info, workflowState, options, (id: string) =>
              outputColsFromSnapshot(node.snapshot, id)
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
function serializeTurn(node: PathNode): string {
  const step = node.step;
  const lines: string[] = [];
  lines.push(`## Agent Event ${node.eventIndex}`);
  lines.push("");
  if (step.content) {
    lines.push(`Thought: ${step.content}`);
    lines.push("");
  }

  // Action: the tool call(s) the model issued, in standard tool-call form via
  // renderToolCall (tool name + `key: value` params + `code` block). Lossless.
  // The execution OUTCOME is rendered separately as the `Observation:` block.
  if (step.toolCalls && step.toolCalls.length > 0) {
    lines.push("Action:");
    for (const tc of step.toolCalls) {
      for (const l of renderToolCall(tc)) lines.push(l);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
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

/**
 * The execution result for the DELTA `Observation:` — output table (TSV,
 * row-capped) or the FULL error. Data-facet decorations (schema / structural
 * profile / value-format / coercion) are rendered per `dataLevel`, SYMMETRIC
 * with LATEST — the data ladder means the same thing in both context modes.
 * (The operator-block STRUCTURAL lines — Summary / Inputs — remain LATEST-only;
 * they are not part of the data facet.) The engine error's `Operator
 * code:` block is intentionally KEPT (it makes the error self-contained — the
 * agent sees the failing line in its own code right where the error is), even
 * though the same code also appears in the Action.
 */
function renderRawResult(
  operatorId: string,
  info: Parameters<typeof formatOperatorResult>[1],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  resolveInputColumns?: (upstreamOpId: string) => number | undefined
): string {
  const raw = formatOperatorResult(operatorId, info, workflowState, {
    schemaInResult: options.schemaInResult,
    columnStats: options.columnStats,
    tableStructureHint: options.tableStructureHint,
    valueFormatFlags: options.valueFormatFlags,
    coercionTelemetry: options.coercionTelemetry,
    maxResultRows: options.maxResultRows,
    resolveInputColumns,
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
 *  Snapshot rendering (Full and Delta variants of the per-snapshot DAG)
 * ========================================================================= */

/**
 * `sectionLevel` controls the depth of the "Operators" / "Links" headings (and,
 * derived, the per-operator headings one level deeper). It exists because the
 * snapshot is rendered in two contexts whose enclosing heading lives at
 * different depths:
 *   - Inline after a turn: parent heading is `#### Completed dataflow after
 *     turn N` (H4) → pass `sectionLevel = 5` so Operators is H5 and Operator
 *     `X` is H6, properly nested under the parent.
 *   - LATEST mode trailing block: parent heading is `# Current Dataflow` (H1)
 *     → pass `sectionLevel = 2` so Operators is H2 and Operator `X` is H3.
 */
function serializeSnapshotFull(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isCurrent: boolean,
  sectionLevel: number
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const lines: string[] = [];
  const { sortedOps, allLinks } = topoSortDag(workflow);
  const sectionHash = "#".repeat(sectionLevel);
  const operatorLevel = sectionLevel + 1;

  lines.push(`${sectionHash} Operators`);
  lines.push("");
  for (const op of sortedOps) {
    lines.push(serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks, operatorLevel));
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

/* ============================================================================
 *  Per-operator serialization
 * ========================================================================= */

/**
 * Stage-aware loader-remediation hint (plan4, goal.md lever D / Direction-1).
 * Maps the exception CLASS parsed from a load-stage operator's error string to
 * a compact, GENERAL pandas remediation directive. Keyed only on the exception
 * class — never a task/column/domain/answer literal — so it generalizes from
 * the (stage=DataLoading, error-class) structure alone. Returns `undefined`
 * for classes that aren't a known load-failure mode (then no hint renders).
 *
 * Motivation (baseline traces): the agent already SEES the `[ERROR]` block with
 * its own code, yet loops without fixing it (e.g. legal-hard-18 retried 8 steps
 * on a `0x93` byte that is plainly Windows-1252). The missing ingredient is
 * remediation knowledge, not visibility — so we inject the fix pattern once,
 * localized to the failing loader operator.
 */
// `formatLoaderHint` now lives in context/decorate/flow/loader-remediation and
// is re-exported here for back-compat with any existing importers.
export { formatLoaderHint } from "../context/decorate/flow/loader-remediation";

/** An operator's output column count = the visible-header count of its result's
 *  first row. Used to fill an input's `M cols` on the shape line (the engine's
 *  input port metrics carry only the row/tuple count). Undefined when unknown. */
function outputColsFromSnapshot(snapshot: SnapshotData | undefined, opId: string): number | undefined {
  const r = snapshot?.results.get(opId)?.info?.result;
  if (!Array.isArray(r) || !r[0] || typeof r[0] !== "object") return undefined;
  return Object.keys(r[0] as Record<string, unknown>).filter(
    k => k !== "__row_index__" && k !== "__is_visualization__"
  ).length;
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
  isCurrent: boolean,
  allLinks: WorkflowContent["links"],
  operatorLevel: number
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const execText = info
    ? formatOperatorResult(op.operatorID, info, workflowState, {
        schemaInResult: options.schemaInResult,
        columnStats: options.columnStats,
        valueFormatFlags: options.valueFormatFlags,
        coercionTelemetry: options.coercionTelemetry,
        maxResultRows: options.maxResultRows,
        tableStructureHint: options.tableStructureHint,
        // LATEST renders a single consolidated `Inputs:` (with counts) at the
        // operator-block level (formatOperatorAdjacency), so skip the in-Result one.
        inputsInResult: false,
      })
    : undefined;

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
  lines.push(`${opHash} Operator \`${op.operatorID}\` (${op.operatorType})`);
  lines.push(`Summary: ${op.customDisplayName || op.operatorID}`);
  for (const l of formatOperatorAdjacency(op, allLinks, info, snapshot)) lines.push(l);

  // Thought-replay back-pointer: tie this operator to the step whose thought
  // last edited it (latest-edit grain). The thought text lives once in the
  // `# Reasoning` block; this is just the O(1) reference. `reasoning` is only
  // populated when thoughtReplay is on AND the mode is LATEST.
  if (options.thoughtReplay) {
    const evt = options.reasoning?.opToEvent.get(op.operatorID);
    if (evt !== undefined) lines.push(`Last edited: step ${evt}`);
  }

  // Operator properties (config). Rendered for every operator except the
  // Python code operators (whose `code` is stripped — see CODE_OPERATOR_TYPES)
  // and only when the toggle is on (default) and there is at least one
  // property to show. Empty-property operators render nothing.
  const includeProps = options.includeOperatorProperties !== false;
  if (
    includeProps &&
    !CODE_OPERATOR_TYPES.has(op.operatorType) &&
    op.operatorProperties &&
    Object.keys(op.operatorProperties).length > 0
  ) {
    lines.push(`Properties: ${JSON.stringify(op.operatorProperties)}`);
  }

  // Schemas only on the current (last) snapshot — compilation only runs
  // against the live workflow.
  const showSchemas = isCurrent && options.agentMode === AgentMode.GENERAL && options.compilationResult;
  if (showSchemas) {
    const outputSchemas = options.compilationResult!.operatorOutputSchemas ?? {};
    const allLinks = snapshot.workflow.links;
    const inputSchemaMap = extractOperatorInputPortSchemaMap(op.operatorID, op, outputSchemas, allLinks);
    if (inputSchemaMap) {
      for (const [portId, schema] of Object.entries(inputSchemaMap)) {
        if (schema) lines.push(`Input Schema (port ${parsePortIndex(portId)}): ${formatSchema(schema)}`);
      }
    }
    const outputSchemaMap = outputSchemas[op.operatorID];
    if (outputSchemaMap) {
      const firstSchema = Object.values(outputSchemaMap).find(s => s !== undefined) as PortSchema | undefined;
      if (firstSchema) lines.push(`Output Schema: ${formatSchema(firstSchema)}`);
    }
    const compilationError = options.compilationResult!.operatorErrors?.[op.operatorID] as
      | WorkflowFatalError
      | undefined;
    if (compilationError) lines.push(`Compilation Error: ${compilationError.message}`);
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
  // the only data plane. Truncated to the per-cell char cap.
  if (info?.consoleLogs && info.consoleLogs.length > 0) {
    // Only actual print() output (ConsoleMessageType.PRINT). consoleLogs also
    // carries ERROR/COMMAND/DEBUGGER messages — the error traceback is already in
    // the Result block, so including it here would duplicate + mislabel it.
    let text = info.consoleLogs
      .filter(c => {
        const t = String(c.msgType ?? "").toUpperCase();
        return t === "PRINT" || t === "0";
      })
      // print() text is carried in `title` (message is empty); prefer whichever is set.
      .map(c => (typeof c.title === "string" && c.title.trim().length > 0 ? c.title : c.message))
      .filter(m => typeof m === "string" && m.trim().length > 0)
      .join("\n")
      .trimEnd();
    const cap = options.maxOperatorResultCellCharLimit;
    if (cap && cap > 0 && text.length > cap) text = text.slice(0, cap) + " …(truncated)";
    if (text) {
      lines.push(
        "Print output (your print(...) calls — for debugging only; NOT this operator's result and not passed downstream):"
      );
      for (const l of text.split("\n")) lines.push("  " + l);
    }
  }

  // Error-reflection FOLDED into the operator (LATEST). When this op has errored,
  // co-locate everything needed to fix it on its own block: the upstream INPUT
  // SCHEMA (fix against real columns), a loader remediation hint for failed loads,
  // and the attempt/error HISTORY (count, repeated-error → "blocked, change
  // strategy" verdict, and the code diff of the last vs previous attempt). The
  // history is derived from the path (errorReflectionMap, built in assembleContext);
  // the current error itself is already in the Result block above.
  if (options.errorReflection && isCurrent && info?.error) {
    const entry = options.errorReflectionMap?.get(op.operatorID);
    const threshold = options.errorReflectionThreshold ?? DEFAULT_REFLECTION_THRESHOLD;
    // Debugging aids shown on ANY execution error: the upstream input schema (fix
    // against real columns) and a loader-remediation hint.
    for (const l of upstreamInputSchema(op.operatorID, snapshot, allLinks)) lines.push(l);
    if (op.operatorType === "DataLoading") {
      const hint = formatLoaderHint(info.error);
      if (hint) for (const l of hint.split("\n")) lines.push(l);
    }
    // Attempt/error HISTORY (count, repeated-error verdict, last-attempt diff) only
    // once the model has gone >= N consecutive (re)fixes on this op (it's stuck).
    if (entry && entry.consecutive >= threshold) {
      for (const l of renderFoldedError(entry)) lines.push(l);
    }
  }

  // plan3: attempt reflection. On the CURRENT snapshot, when this operator has
  // been edited >= the threshold, surface its attempt history so the agent
  // stops re-deriving blind variants (the 38-edit thrash pattern). The current
  // code is otherwise stripped in CODE mode; an [ERROR] block already carries
  // it, so only re-add code when there's no error (avoid duplication).
  if (options.attemptReflection && isCurrent) {
    const editCount = options.editCountsByOp?.get(op.operatorID) ?? 0;
    if (editCount >= ATTEMPT_REFLECTION_THRESHOLD) {
      lines.push(
        `Attempt reflection: you have edited operator \`${op.operatorID}\` ${editCount} times; ` +
          `${editCount - 1} prior variant(s) did not converge.`
      );
      if (info?.error) {
        lines.push(`Latest result: [ERROR] ${info.error.split("\n")[0].slice(0, 200)}`);
      } else if (info) {
        lines.push("Latest result: produced output but the task is not yet solved.");
      }
      lines.push(
        "Do NOT submit another near-variant. Change strategy: inspect this operator's UPSTREAM " +
          "result/columns for a wrong assumption, try a DIFFERENT decomposition, or build the answer " +
          "from a different operator."
      );
      if (!info?.error) {
        const code = String((op.operatorProperties as Record<string, unknown> | undefined)?.code ?? "").trim();
        if (code) {
          lines.push("Current code:");
          for (const l of code.split("\n")) lines.push("  " + l);
        }
      }
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

/** Find the most-recent attached snapshot across the original (untruncated)
 *  path. Used so the trailing `# Current Dataflow` block survives even when
 *  the recent-events cap drops every visible task. */
function lastSnapshotOfPath(path: PathNode[]): SnapshotData | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].snapshot) return path[i].snapshot;
  }
  return undefined;
}

function formatSchema(schema: PortSchema): string {
  const attrs = schema.map(a => `${a.attributeName}: ${a.attributeType}`);
  return `[${attrs.join(", ")}]`;
}

function parsePortIndex(portId: string): string {
  const idx = portId.indexOf("_");
  return idx >= 0 ? portId.substring(0, idx) : portId;
}
