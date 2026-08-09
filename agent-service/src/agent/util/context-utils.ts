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
import type { CompactionStrategy, ReActStep } from "../../types/agent";
import { AgentMode, ContextMode } from "../../types/agent";
import type { WorkflowCompilationResponse, WorkflowFatalError } from "../../api/compile-api";
import type { SnapshotData, WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { OperatorInfo } from "../../types/execution";
import { formatFileIo } from "../context/decorate/data/structural-profile";
import { extractOperatorInputPortSchemaMap } from "./workflow-utils";
import { formatOperatorResult, formatSchemaLine, clampCodeChars} from "../tools/result-formatting";
import { levelsToFlags } from "../context/decorate/registry";
import type { DecorateLevel } from "../context/decorate/types";
import { formatLoaderHint } from "../context/decorate/flow/loader-remediation";
import {
  buildLineageErrorContext,
  lineageErrorPointer,
  upstreamInputSchema,
} from "../context/decorate/flow/error-context";
import { buildReasoning, renderReasoning, type Reasoning } from "../context/select/reinjection/reasoning";
import {
  buildErrorReflection,
  renderFoldedError,
  DEFAULT_REFLECTION_THRESHOLD,
  type ErrorReflectionEntry,
} from "../context/select/reinjection/error-reflection";
// summarize() is the centralized renderer; assembleContext delegates to it.
// The import is circular (summarize calls back into renderContextCore below)
// but strictly call-time — both modules only reference each other inside
// function bodies, so ESM hoisting resolves it.
import { applySummarizeParamsPatch, mapLegacyToParams, type SummarizeParamsPatch } from "../context/summarize/params";
import { computeRevisionFolds, hasNoFolds, type RevisionFolds } from "../context/select/revision-folds";
import { buildRenderPrefRanges, renderPrefsAt, type RenderPrefRange } from "../context/selector/render-prefs";
import { buildDossier, type Dossier } from "../context/summarize/dossier";
import { summarize, type OperatorRenderExtras } from "../context/summarize/summarize";
import type { FormatOperatorResultOptions } from "../tools/result-formatting";
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
  /** DELTA context-window budget, in *tokens* (estimated via `estimateTokens`).
   *  Bounds the assembled trajectory user-message — the true model window minus
   *  the ~constant system prompt + response headroom, which the caller folds
   *  into this number. Unset / ≤ 0 ⇒ unbounded (lossless raw delta — legacy).
   *  When > 0, the assembler renders the "original" raw delta (schema-only, no
   *  stats) while it fits, then COMPACTS via `compactionStrategy` once it would
   *  overflow. DELTA mode only (LATEST is already single-snapshot). */
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
  /** Agent-triggered compaction (POC): raw agent events to keep BEFORE the newest
   *  `compactContext` mark (in addition to everything after it). 0 ⇒ fold through
   *  the mark. Only consulted when a mark is present in the visible path. */
  compactKeepLastSteps?: number;
  /** Show the context-budget meter line at the top of DELTA context (the
   *  observable signal that lets the agent decide when to call compactContext).
   *  Enabled when the compact tool is on. */
  showCompactMeter?: boolean;
  /** Static compaction rule (DELTA-only). When true, the assembler AUTOMATICALLY
   *  folds older events into the compact deck once the trajectory grows past a
   *  static trigger, keeping the last K steps raw — no agent involvement, no
   *  token window. Deterministic on trajectory shape (see staticCompactionFoldMark).
   *  Ignored in LATEST mode and when an agent `compactContext` mark is present. */
  staticCompaction?: boolean;
  /** Which static rule when `staticCompaction` is on. "editConvergence" (default)
   *  folds at the frontier operator's active-edit-run boundary (monotone, cache-
   *  friendly); "token" is the older size-triggered rule (kept for A/B). */
  compactionRule?: "editConvergence" | "token";
  /** Monotone high-water clamp for the edit-convergence fold boundary — it never
   *  retreats below this. 0/undefined ⇒ rely on the pure formula (monotone for the
   *  append-only single-op-per-event case). */
  compactBoundaryFloor?: number;
  /** Override the compacted-deck header (settled-framed wording); generic default. */
  compactDeckHeader?: string;
  /** Override the raw-suffix header; generic default. */
  compactSuffixHeader?: string;
  /** Fold resolved operator revisions (DELTA-only; the rank-3 static rule from
   *  the Delta-vs-Latest cost audit). Once a later revision of an operator has
   *  executed successfully and its sole consumer has consumed it healthily
   *  (+ `foldGraceEvents`), the prior revisions' Action `code:` blocks and
   *  Observation result payloads render as one-line resolution facts. Latching
   *  (historical-facts predicate) — folds never un-fold. */
  foldResolvedRevisions?: boolean;
  /** Internal (computed): the `# Inspections` section re-rendering the agent's
   *  inspectResult pulls so they persist across steps. Undefined ⇒ no pulls. */
  inspectionsRendered?: string;
  /** Grace (events) after the resolution before prior revisions fold. Default 1. */
  foldGraceEvents?: number;
  /** Internal (computed): per-event per-operator revision-fold facts. */
  revisionFolds?: RevisionFolds;
  /** Agent-declared result-view prefs (write-time render knobs). Enables the
   *  DELTA event-scoped application; the LATEST path applies them as
   *  summarize() overrides in the server assembler. */
  renderPrefsEnabled?: boolean;
  /** Internal (computed): per-operator pref ranges for DELTA event scoping. */
  renderPrefRanges?: Map<string, RenderPrefRange[]>;
  /** Internal (computed by the truncation/compaction pass): keep only agent events whose
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
  /** Per-operator TSV char budget (summarize `tuple.maxChars`). */
  maxResultChars?: number;
  /** A7: render the `Files read:` fact (independent of tableStructureHint). */
  fileIoFacts?: boolean;
  /** Stats-block density forwarded to the result formatter ("full" default /
   *  "anomaly" = only facts the visible sample does not already prove). */
  statsDensity?: "full" | "anomaly";
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
  /** #28: on an errored (non-loader) operator, render its direct upstream inputs'
   *  schema + a few sample rows so the model fixes against real consumed data,
   *  not guessed columns. Render-time only. Default false. */
  lineageErrorContext?: boolean;
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
  /** DELTA `Inputs:` line (structure-consistent with LATEST). The leaf snapshot
   *  supplies the current DAG adjacency (single source of truth via
   *  formatOperatorAdjacency); the map gives each op's last-edit eventIndex so the
   *  line renders once, on the op's most-recent edit, reflecting the latest wiring.
   *  Set by renderAgentEvents; read in the DELTA observation. */
  deltaInputsLeaf?: SnapshotData;
  deltaLastEditByOp?: Map<string, number>;
  /** DECORATE ordinal levels (claude/CONTEXT-DESIGN.md §5). When set (>=0), the
   *  flow/data facet level expands — via the rung catalog (context/decorate/
   *  registry.levelsToFlags) — into the individual render flags above, OR-ing
   *  them on. This is the new ordinal knob replacing the per-lever booleans;
   *  the booleans remain valid and any explicitly-set boolean is preserved
   *  (the level only turns rungs ON, never off). Undefined ⇒ legacy boolean
   *  behavior, no expansion. */
  flowLevel?: number;
  dataLevel?: number;
  /** Internal (summarize): resolver of per-operator render extras — detail
   *  level, per-op column/tuple params, code + result history. Present only
   *  when the summarize params use a capability beyond the legacy surface;
   *  absent ⇒ pure legacy rendering (parity path). Not honored inside the
   *  window-compaction phase profiles (deck/suffix), which own their render
   *  economics. */
  opExtras?: (opId: string) => OperatorRenderExtras | undefined;
  /** Internal (summarize): render interleaved events Thought/Action-only
   *  (no per-event delta Observations). */
  omitObservations?: boolean;
  /** Internal (summarize): append a `# Current Dataflow` section after an
   *  interleaved trajectory (a combination the legacy modes never had). */
  appendCurrentSnapshot?: boolean;
  /** Internal (summarize): skip the `# Current Dataflow` section in the
   *  no-events layout. */
  omitCurrentSnapshot?: boolean;
  /** Deep-partial summarize-params patch (the agent's `summarizeParams`
   *  setting), applied on top of the settings-derived params. This is the
   *  API-reachable door into the full summarize parameter space. */
  summarizePatch?: SummarizeParamsPatch;
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
  // The legacy entry point is now a thin preset shim over summarize(): the
  // (mode, options) pair maps to a point in the summarize parameter space
  // (LATEST / DELTA are just two presets), and summarize() calls back into
  // renderContextCore below. Byte-parity with the pre-refactor renderer is
  // enforced by the golden characterization tests.
  const params = mapLegacyToParams(mode, options);
  const effective = options.summarizePatch ? applySummarizeParamsPatch(params, options.summarizePatch) : params;
  const result = summarize(
    {
      visibleSteps,
      workflowState,
      snapshotStorage,
      compilationResult: options.compilationResult ?? null,
    },
    effective
  );
  return result.messages;
}

/**
 * The mode-dispatched render core shared by every caller. Only summarize()
 * should call this — external callers go through assembleContext (legacy
 * signature) or summarize() (parameterized).
 */
export function renderContextCore(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  mode: ContextMode,
  options: AssembleContextOptions
): string {
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
  let content: string;
  switch (mode) {
    case ContextMode.DELTA: {
      // On-demand pulls persist in DELTA too (appended by renderInterleaved;
      // the interleaved events carry the CALL but drop the tool output).
      options.inspectionsRendered = buildInspectionsSection(path);
      // Write-time render prefs (DELTA): a landed version's prefs govern the
      // observations rendered while it was active — historical ranges, so an
      // old event's render never changes (append-only).
      if (options.renderPrefsEnabled) {
        const prefDossier = buildDossier(visibleSteps, snapshotStorage);
        const ranges = buildRenderPrefRanges(prefDossier);
        options.renderPrefRanges = ranges.size > 0 ? ranges : undefined;
      }
      // Fold resolved operator revisions (rank-3 static rule). Computed once
      // per render from the dossier; consumed by serializeTurn (Action `code:`
      // blocks) and the Observation loop in serializeTaskBody. Applies in every
      // DELTA render path below (lossless, budgeted, and compacted suffixes).
      if (options.foldResolvedRevisions) {
        const dossier = buildDossier(visibleSteps, snapshotStorage);
        const folds = computeRevisionFolds(dossier, { graceEvents: options.foldGraceEvents ?? 1 });
        options.revisionFolds = hasNoFolds(folds) ? undefined : folds;
      }
      // Agent-triggered compaction (POC): if the agent called `compactContext`,
      // fold the trajectory up to the newest such mark into a compress deck +
      // raw suffix, using STATIC params (compactKeepLastSteps). This takes
      // precedence over the token-window rolling compaction.
      const markEventIndex = newestCompactMarkEventIndex(tasks);
      if (markEventIndex !== undefined) {
        content = renderAgentCompacted(
          tasks,
          workflowState,
          options,
          initSnapshot,
          latestUserContent,
          latestUserStepId,
          createFlagsByStep,
          markEventIndex,
          Math.max(0, options.compactKeepLastSteps ?? 0)
        );
        break;
      }
      // Static compaction rule (DELTA-only, behind the staticCompaction flag).
      // Two rules selectable via options.compactionRule (default editConvergence):
      //  - "editConvergence" (default): fold at the boundary of the frontier
      //    operator's active edit run — settled operators (edit run ended) fold
      //    into the deck, the operator you are still correcting stays raw. The
      //    boundary is monotone (stable while you edit one op → cache-friendly).
      //  - "token": the older size trigger (kept for A/B; see staticCompactionFoldMark).
      if (options.staticCompaction) {
        const lossless = renderInterleaved(
          tasks,
          workflowState,
          options,
          initSnapshot,
          latestUserContent,
          latestUserStepId,
          createFlagsByStep
        );
        const est = estimateTokens(lossless);
        const useToken = options.compactionRule === "token";
        let foldMark: number | undefined;
        let keepLast = STATIC_COMPACT_KEEP_LAST;
        let compactOptions = options;
        if (useToken) {
          foldMark = staticCompactionFoldMark(tasks, est);
        } else {
          const dossier = buildDossier(visibleSteps, snapshotStorage);
          foldMark = editConvergenceFoldMark(dossier, est, { boundaryFloor: options.compactBoundaryFloor });
          keepLast = 0; // the boundary already excludes the active frontier run
          // Settled-framed headers: the deck is the CURRENT state of finished
          // operators, not stale/partial history.
          compactOptions = {
            ...options,
            compactDeckHeader:
              "# Current Dataflow (settled operators — finished work at its current, final state; results shown as statistics + sampled rows)",
            compactSuffixHeader: "# Agent Events (your in-progress work since the settled snapshot above)",
          };
        }
        content =
          foldMark === undefined
            ? lossless
            : renderAgentCompacted(
                tasks,
                workflowState,
                compactOptions,
                initSnapshot,
                latestUserContent,
                latestUserStepId,
                createFlagsByStep,
                foldMark,
                keepLast
              );
        break;
      }
      const windowTokens =
        options.contextWindowTokens && options.contextWindowTokens > 0 ? options.contextWindowTokens : undefined;
      // Unbounded window (0/unset) ⇒ legacy lossless delta (respects the data
      // ladder / standalone flags as before). A positive window switches to the
      // budgeted path: "original" raw delta (schema-only) while it fits, then
      // compaction (sliding | compress) once it would overflow.
      content =
        windowTokens === undefined
          ? renderInterleaved(
              tasks,
              workflowState,
              options,
              initSnapshot,
              latestUserContent,
              latestUserStepId,
              createFlagsByStep
            )
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
      break;
    }
    case ContextMode.LATEST: {
      // On-demand pulls persist across steps via the tail `# Inspections`
      // section (undefined when the agent never called inspectResult).
      options.inspectionsRendered = buildInspectionsSection(path);
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

  // Context-budget meter (POC): the observable signal that lets the agent decide
  // when to call compactContext. Prepended to DELTA context only (LATEST has no
  // growing trajectory to fold). Static soft target.
  if (mode === ContextMode.DELTA && options.showCompactMeter) {
    const used = estimateTokens(content);
    const target = COMPACT_SOFT_TARGET_TOKENS;
    const over = used > target;
    const meter = over
      ? `> Context budget: ~${Math.round(used / 1000)}k tokens used / soft target ${Math.round(target / 1000)}k — OVER. If earlier steps are settled (sources loaded and consumed, or a fix has landed) and you are NOT mid-debugging an erroring operator, call compactContext at your next natural boundary to fold earlier history.`
      : `> Context budget: ~${Math.round(used / 1000)}k tokens used / soft target ${Math.round(target / 1000)}k — within target.`;
    content = `${meter}\n\n${content}`;
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

export interface BuiltPath {
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

export function buildPath(visibleSteps: ReActStep[], storage: WorkflowSnapshotStorage): BuiltPath {
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
/** Soft context-budget target (POC) shown by the compaction meter. Static
 *  constant; chosen so multi-source / multi-step DELTA runs cross it mid-trajectory
 *  (traces run 10-40k), giving the agent a signal to compact at a natural boundary. */
const COMPACT_SOFT_TARGET_TOKENS = 4000;

// ── Static compaction rule (DELTA-only) ────────────────────────────────────
// Ad-hoc-but-deterministic trigger derived from the Latest-vs-Delta 5K trace
// analysis (docs/compaction-static-rule.md). The decisive signal is the RENDERED
// DELTA event-log size, not step count: the analysis found a clean gap — traces
// that must NOT fold peak at ~2.18k tokens; genuine savers start at ~3.55k — and
// that a step-count trigger both misfires (biomedical-hard-7: 6 steps / ~1.1k
// tokens, where folding its single-column stats flips 16→15) and misses 5-step
// savers (environment-hard-8 ~9.4k, environment-hard-15 ~6k). So the trigger is a
// token floor at 3,500, which also self-guards short fast-converging traces.
//
//   TRIGGER : rendered lossless event log ≥ STATIC_COMPACT_TRIGGER_TOKENS.
//   KEEP    : keep the last STATIC_COMPACT_KEEP_LAST steps raw (recent working
//             set), fold everything older into the `# Dataflow (compacted)` deck.
//   GUARD   : do NOT compact while mid-error-recovery — if the newest agent
//             step left an operator in an errored state, the agent is actively
//             debugging it and needs the recent raw attempts, so we hold off.
const STATIC_COMPACT_TRIGGER_TOKENS = 3500;
const STATIC_COMPACT_KEEP_LAST = 2;

/** Fold boundary for the static compaction rule, or undefined when the rule
 *  says "don't compact yet" (event log below the token floor, too few events, or
 *  mid-error-recovery). `estTokens` is the estimate of the lossless DELTA render.
 *  Returns the newest snapshot-bearing event index so `renderAgentCompacted`
 *  folds all but the last STATIC_COMPACT_KEEP_LAST steps. */
function staticCompactionFoldMark(tasks: TaskGroup[], estTokens: number): number | undefined {
  // Trigger: the rendered event log must be large enough to be worth folding.
  if (estTokens < STATIC_COMPACT_TRIGGER_TOKENS) return undefined;
  const snapEvents: { idx: number; snap: SnapshotData }[] = [];
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role === "agent" && node.snapshot) snapEvents.push({ idx: node.eventIndex, snap: node.snapshot });
    }
  }
  // Need more events than we keep raw, else there is nothing to fold.
  if (snapEvents.length <= STATIC_COMPACT_KEEP_LAST + 1) return undefined;
  // Safety guard: skip while mid-error-recovery (newest snapshot has an errored
  // operator) — the agent needs its recent raw attempts to debug.
  const newest = snapEvents[snapEvents.length - 1].snap;
  if (snapshotHasErroredOperator(newest)) return undefined;
  return snapEvents[snapEvents.length - 1].idx;
}

// Edit-convergence rule: fold at the boundary of the frontier operator's active
// consecutive edit run. Settled operators (edit run ended — you built them, moved
// on, and have not edited them since) fold into the deck at their final state;
// the operator you are still correcting, and its whole current run, stay raw.
// The boundary = runStart − 1 (runStart = where the frontier op's trailing run
// began) is MONOTONE on the append-only trajectory: stable while you keep editing
// one op (deck byte-identical → prompt cache hits), advancing by exactly one
// operator's history only when you switch operators. This is the fix for the
// token rule's per-turn boundary slide that busted the cache (v3, +22% cost).
const EDIT_CONV_MIN_SETTLED = 1;
const EDIT_CONV_MIN_TOKENS = 3500;

/** Fold boundary (an eventIndex) for the edit-convergence rule, or undefined when
 *  the rule says "don't compact" (too small, too few settled ops, or nothing
 *  before the active run). Pure function of the dossier + a token floor. */
function editConvergenceFoldMark(
  dossier: Dossier,
  estTokens: number,
  opts: { minSettled?: number; minTokens?: number; boundaryFloor?: number } = {}
): number | undefined {
  const minSettled = opts.minSettled ?? EDIT_CONV_MIN_SETTLED;
  const minTokens = opts.minTokens ?? EDIT_CONV_MIN_TOKENS;
  if (estTokens < minTokens) return undefined; // floor: not worth deck overhead

  // STEP 1 — global edit list: every code submission (create + modify, incl.
  // rejected — a rejected edit still means the op is being actively worked).
  const eventOps = new Map<number, Set<string>>();
  for (const [opId, d] of dossier.operators) {
    for (const cv of d.codeVersions) {
      let s = eventOps.get(cv.eventIndex);
      if (!s) eventOps.set(cv.eventIndex, (s = new Set()));
      s.add(opId);
    }
  }
  if (eventOps.size === 0) return undefined;
  const evIdx = [...eventOps.keys()].sort((a, b) => a - b);

  // STEP 2 — frontier op (the single actively-worked op = whoever was edited at
  // the last edit-event; tie-break to the errored op, else stable last id).
  const maxE = evIdx[evIdx.length - 1];
  const atMax = [...(eventOps.get(maxE) as Set<string>)].sort();
  const leaf = dossier.leafSnapshot;
  const frontierOp = atMax.find(op => leaf.results.get(op)?.info?.error) ?? atMax[atMax.length - 1];

  // STEP 3 — the frontier op's TRAILING consecutive edit run: walk edit-events
  // backward while they still touch the frontier op; stop at the first that
  // doesn't (an earlier, now-settled operator).
  let runStart = maxE;
  for (let i = evIdx.length - 2; i >= 0; i--) {
    if (eventOps.get(evIdx[i])?.has(frontierOp)) runStart = evIdx[i];
    else break;
  }

  // STEP 4 — boundary: everything strictly before the active run folds.
  let boundary = runStart - 1;
  if (boundary < 1) return undefined;

  // STEP 5 — guard: enough operators have actually settled to be worth a deck.
  let settled = 0;
  for (const d of dossier.operators.values()) {
    const lastEdit = d.codeVersions.reduce((m, cv) => Math.max(m, cv.eventIndex), 0);
    if (d.currentPredicate && lastEdit < runStart) settled++;
  }
  if (settled < minSettled) return undefined;

  // STEP 6 — monotone clamp (never retreat below the session high-water mark).
  return Math.max(boundary, opts.boundaryFloor ?? 0);
}

/** True if any operator in the snapshot is currently in an errored state. */
function snapshotHasErroredOperator(snap: SnapshotData): boolean {
  for (const [, rv] of snap.results) {
    if (rv?.info?.error) return true;
  }
  return false;
}

/** The eventIndex of the newest `compactContext` tool call in the visible path,
 *  or undefined if the agent never compacted. That mark is the fold boundary. */
function newestCompactMarkEventIndex(tasks: TaskGroup[]): number | undefined {
  let mark: number | undefined;
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role !== "agent") continue;
      const calls = node.step.toolCalls ?? [];
      if (calls.some(c => (c as any).toolName === "compactContext")) {
        if (mark === undefined || node.eventIndex > mark) mark = node.eventIndex;
      }
    }
  }
  return mark;
}

/**
 * Agent-triggered compaction render (POC). Fold every snapshot-bearing event up
 * to the compaction mark (minus `keepLastSteps` recent ones) into a compress
 * deck, keep the rest raw. Reuses the exact boundary/keepFrom selection as the
 * token-window compaction, so the deck is byte-identical to what the rolling
 * compressor produces at the same boundary — only the TRIGGER differs (agent
 * action vs token overflow).
 */
function renderAgentCompacted(
  tasks: TaskGroup[],
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  markEventIndex: number,
  keepLastSteps: number
): string {
  // The raw suffix is the ACTIVE working set (the operator the agent is still
  // deciding on) — render it at the SAME data fidelity as lossless DELTA, so the
  // stats that drive decisions (distinct / duplicate_values / Output Table
  // profile) are present on the op being acted upon. Only the folded DECK is
  // summarized; stripping stats from the live suffix was hiding exactly the
  // dedup/grain signal the agent needs (legal-hard-1 diagnosis).
  const suffixOptions: AssembleContextOptions = {
    ...options,
    schemaInResult: true,
    keepFromEventIndex: undefined,
    omittedEventsCount: 0,
    opExtras: undefined,
  };

  // Snapshot-bearing agent events, oldest→newest (the fold candidates).
  const evs: { idx: number; snap: SnapshotData }[] = [];
  for (const task of tasks) {
    for (const node of task.nodes) {
      if (node.step.role === "agent" && node.snapshot) evs.push({ idx: node.eventIndex, snap: node.snapshot });
    }
  }
  // Fold count d = snapshot-events at/before the mark, minus the kept recent ones.
  const atOrBeforeMark = evs.filter(e => e.idx <= markEventIndex).length;
  const d = Math.min(evs.length, Math.max(1, atOrBeforeMark - keepLastSteps));
  if (evs.length <= 1 || d <= 0) {
    // Nothing meaningful to fold → lossless delta.
    return renderInterleaved(
      tasks,
      workflowState,
      suffixOptions,
      initSnapshot,
      latestUserContent,
      latestUserStepId,
      createFlagsByStep
    );
  }
  const boundarySnap = evs[d - 1].snap;
  const keepFrom = d < evs.length ? evs[d].idx : evs[d - 1].idx + 1;
  return renderCompressed(
    tasks,
    workflowState,
    options,
    suffixOptions,
    boundarySnap,
    keepFrom,
    latestUserContent,
    latestUserStepId,
    createFlagsByStep
  );
}

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
    columnStats: false,
    tableStructureHint: false,
    valueFormatFlags: false,
    coercionTelemetry: false,
    keepFromEventIndex: undefined,
    omittedEventsCount: 0,
    // Compaction phase profiles own the render economics — per-op extras
    // (detail levels, history, metric filters) apply to unbudgeted paths only.
    opExtras: undefined,
  };

  // Phase A: lossless raw delta. If it fits the window, send it untouched (the
  // append-only prefix keeps the prompt cache warm).
  const lossless = renderInterleaved(
    tasks,
    workflowState,
    suffixOptions,
    initSnapshot,
    latestUserContent,
    latestUserStepId,
    createFlagsByStep
  );
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
    return renderDeltaTruncated(
      tasks,
      workflowState,
      suffixOptions,
      initSnapshot,
      latestUserContent,
      latestUserStepId,
      createFlagsByStep,
      windowTokens
    );
  }

  // compress: fold the oldest d events into a stats deck (the boundary snapshot),
  // keep the rest as raw-delta suffix. Advance the fold forward until it fits;
  // larger folds shrink the raw suffix faster than the stats deck grows. When
  // d === evs.length everything folds into the deck (empty suffix = LATEST-like).
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
      createFlagsByStep
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
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const sections: string[] = [];

  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }

  // Deck: the folded prefix, as statistics + sampled rows (deckOptions turns the
  // stats family ON — the inverse of the schema-only suffix). Per-op extras are
  // stripped: the compaction phases own their render economics.
  const deckOptions: AssembleContextOptions = {
    ...options,
    columnStats: true,
    schemaInResult: true,
    thoughtReplay: false,
    errorReflection: false,
    attemptReflection: false,
    opExtras: undefined,
  };
  const deck = serializeSnapshotCompact(boundarySnap, workflowState, deckOptions, /*sectionLevel=*/ 2);
  if (deck) {
    sections.push(
      options.compactDeckHeader ??
        "# Dataflow (compacted — earlier events folded into this snapshot; results shown as statistics + sampled rows)"
    );
    sections.push(deck);
    sections.push("");
  }

  // Suffix: raw-delta agent events at/after the boundary. Reseed the rolling
  // prev-snapshot to the boundary so the first surviving event diffs against the
  // deck (not the empty init). No omitted-marker — the deck stands in its place.
  const suffix: AssembleContextOptions = { ...suffixOptions, keepFromEventIndex: keepFrom, omittedEventsCount: 0 };
  const events = renderAgentEvents(
    tasks,
    workflowState,
    suffix,
    boundarySnap,
    latestUserStepId,
    createFlagsByStep,
    options.omitObservations === true
  );
  if (events && events !== "(no agent actions yet)") {
    sections.push(options.compactSuffixHeader ?? "# Agent Events (since the compacted snapshot above)");
    sections.push("");
    sections.push(events);
    sections.push("");
  }

  const leaf = lastSnapshotOf(tasks);
  if (leaf) {
    const flow = buildFlowSection(leaf, workflowState, suffixOptions, /*isLatest=*/ false);
    if (flow) {
      sections.push("");
      sections.push(flow);
    }
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
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>,
  windowTokens: number
): string {
  const renderKeeping = (cutoff: number | undefined, reseed: SnapshotData | undefined, omitted: number): string => {
    options.keepFromEventIndex = cutoff;
    options.omittedEventsCount = omitted;
    return renderInterleaved(
      tasks,
      workflowState,
      options,
      reseed,
      latestUserContent,
      latestUserStepId,
      createFlagsByStep
    );
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
  // DELTA `Inputs:` line: the leaf snapshot is the single source of DAG
  // adjacency (matches LATEST); each op's last-edit event is where the line
  // renders (once, on its most-recent edit, so it sits with the op's latest
  // code and reflects the current wiring). Only the observation path (DELTA)
  // consumes these; LATEST's # Agent Turns uses omitObservation.
  if (!omitObservation) {
    options.deltaInputsLeaf = lastSnapshotOf(tasks);
    const lastEdit = new Map<string, number>();
    for (const task of tasks) {
      for (const node of task.nodes) {
        if (node.step.role !== "agent") continue;
        for (const tc of node.step.toolCalls ?? []) {
          const opId = (tc.input as Record<string, unknown> | undefined)?.operatorId;
          if (typeof opId === "string" && opId && tc.toolName !== "deleteOperator") {
            lastEdit.set(opId, node.eventIndex);
          }
        }
      }
    }
    options.deltaLastEditByOp = lastEdit;
  }
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
  sections.push(
    renderAgentEvents(
      tasks,
      workflowState,
      options,
      initSnapshot,
      latestUserStepId,
      createFlagsByStep,
      options.omitObservations === true
    )
  );
  sections.push("");

  const leaf = lastSnapshotOf(tasks);

  // summarize(): an interleaved trajectory may additionally carry the full
  // current-snapshot section (a combination the legacy modes never had).
  if (options.appendCurrentSnapshot && leaf) {
    const dag = serializeSnapshotFull(leaf, workflowState, options, /*isCurrent=*/ true, /*sectionLevel=*/ 2);
    if (dag) {
      sections.push("# Current Dataflow");
      sections.push(dag);
      sections.push("");
    }
  }

  // FLOW section over the leaf snapshot (composable with delta too — placed
  // last, after the event/snapshot trajectory). Empty ⇒ omitted.
  if (leaf) {
    const flow = buildFlowSection(leaf, workflowState, options, /*isLatest=*/ false);
    if (flow) {
      sections.push("");
      sections.push(flow);
    }
  }

  // Inspections tail (see renderLatest): the interleaved events show the
  // inspectResult CALLS but not their outputs — this re-renders the pulls.
  if (options.inspectionsRendered) {
    sections.push("");
    sections.push(options.inspectionsRendered);
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
  //    are rendered above this. summarize() can omit it (currentSnapshot
  //    param) — e.g. a pure-trajectory context.
  if (!options.omitCurrentSnapshot) {
    const dag = serializeSnapshotFull(leafSnapshot, workflowState, options, /*isCurrent=*/ true, /*sectionLevel=*/ 2);
    if (dag) {
      sections.push("# Current Dataflow");
      sections.push(dag);
    }
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

  // 4. # Inspections — the agent's on-demand inspectResult pulls, re-rendered
  //    verbatim so a pull stays visible on later steps (prepareStep REPLACES
  //    the wire messages each step; without this the tool's output would
  //    vanish after one step). Tail position: the section only ever appends /
  //    trims at the prompt's suffix, where cache invalidation is cheapest.
  //    Absent when the agent never pulled — byte-parity for tool-less arms.
  if (options.inspectionsRendered) {
    sections.push("");
    sections.push(options.inspectionsRendered);
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
 *   L3 graphAudit            — dead/disconnected loaders
 */
function buildFlowSection(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isLatest: boolean
): string | undefined {
  const anyFlow =
    options.loaderHint ||
    options.lineageErrorContext ||
    options.graphAudit ||
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

    lines.push(serializeTurn(node, options.revisionFolds?.actions.get(node.eventIndex)));
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
        // `Inputs:` line — structure-consistent with LATEST. Rendered once, on
        // the op's most-recent edit, from the LEAF snapshot's DAG (current
        // wiring), via the same formatOperatorAdjacency LATEST uses. Skipped for
        // ops no longer in the leaf (deleted/never-landed).
        const leaf = options.deltaInputsLeaf;
        if (leaf && options.deltaLastEditByOp?.get(op.operatorID) === node.eventIndex) {
          const leafOp = leaf.workflow.operators.find(o => o.operatorID === op.operatorID);
          if (leafOp) {
            const leafInfo = leaf.results.get(op.operatorID)?.info;
            for (const l of formatOperatorAdjacency(leafOp, leaf.workflow.links, leafInfo, leaf)) obs.push(`  ${l}`);
          }
        }
        // Revision fold (rank-3): a result earned under a superseded revision
        // renders as its one-line resolution fact instead of the payload.
        const foldFact = options.revisionFolds?.observations.get(node.eventIndex)?.get(op.operatorID);
        if (foldFact) {
          obs.push(`  result: ${foldFact}`);
          continue;
        }
        // summarize(): per-op extras apply to the observation render too —
        // detail "omit" keeps the verb line but drops the result body.
        const ex = options.opExtras?.(op.operatorID);
        if (ex?.detail === "omit") continue;
        // Write-time render prefs (DELTA event scoping): lower this event's
        // render per the version active at the event. Legacy formatter path
        // only (`!ex`), never-raise semantics.
        let renderOptions = options;
        if (!ex && options.renderPrefRanges) {
          const pref = renderPrefsAt(options.renderPrefRanges, op.operatorID, node.eventIndex);
          if (pref) {
            renderOptions = { ...options };
            if (pref.outputSummary === "minimal") {
              const baseRows = options.maxResultRows ?? 0;
              renderOptions.maxResultRows = baseRows > 0 ? Math.min(baseRows, 3) : 3;
            }
            if (pref.showOutputStatistics === false) renderOptions.columnStats = false;
          }
        }
        const info = node.snapshot.results.get(op.operatorID)?.info;
        // A7: `Files read:` is a CONSUMED fact — for a DataLoading operator it
        // IS the input, since loaders have no `Inputs:` line. `23a5325fc` moved
        // it out of the `Result:` body so consumed and produced facts stop
        // mixing, but only added the new render to serializeOperatorFull, which
        // is the LATEST per-operator block. DELTA lost its render and never got
        // a replacement — formatOperatorResult still computes the line and
        // discards it. This is that missing half: emitted at the observation's
        // own indent, PARALLEL to `result:` rather than inside it, which is the
        // same relationship it has to `Result:` in LATEST.
        const fileIoFact = renderOptions.fileIoFacts && info ? formatFileIo(info) : undefined;
        if (fileIoFact) {
          for (const l of fileIoFact.split("\n")) obs.push(`  ${l}`);
        }
        const resultText = info
          ? renderRawResult(
              op.operatorID,
              info,
              workflowState,
              renderOptions,
              (id: string) => outputColsFromSnapshot(node.snapshot, id),
              ex
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

/** How many inspectResult pulls stay rendered verbatim; older ones collapse
 *  to a one-line note. Tail-of-prompt section, so trimming is cache-cheap. */
const INSPECTIONS_KEEP_LAST = 8;

/**
 * Build the `# Inspections` section from the path: every inspectResult tool
 * call paired with its output, event-ordered. The wire messages are REPLACED
 * each step (prepareStep), so without this re-render a pull's output would be
 * visible for a single step only. Returns undefined when the agent never
 * pulled — tool-less arms render byte-identically.
 */
function buildInspectionsSection(path: PathNode[]): string | undefined {
  interface Pull {
    eventIndex: number;
    operatorId: string;
    argsSummary: string;
    output: string;
  }
  const pulls: Pull[] = [];
  for (const node of path) {
    const step = node.step;
    if (step.role !== "agent") continue;
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    calls.forEach((tc, i) => {
      if (tc.toolName !== "inspectResult") return;
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof inp.maxRows === "number") parts.push(`maxRows=${inp.maxRows}`);
      if (Array.isArray(inp.columns) && inp.columns.length > 0) parts.push(`columns=[${inp.columns.join(", ")}]`);
      if (inp.stats === true) parts.push("stats");
      if (typeof inp.where === "string" && inp.where) parts.push(`where=${inp.where}`);
      pulls.push({
        eventIndex: node.eventIndex,
        operatorId: typeof inp.operatorId === "string" ? inp.operatorId : "?",
        argsSummary: parts.join(", "),
        output: stringifyOutput(results[i]?.output).trimEnd(),
      });
    });
  }
  if (pulls.length === 0) return undefined;

  const lines: string[] = ["# Inspections (your on-demand inspectResult pulls)", ""];
  const omitted = Math.max(0, pulls.length - INSPECTIONS_KEEP_LAST);
  if (omitted > 0) {
    lines.push(`(… ${omitted} earlier inspection${omitted === 1 ? "" : "s"} omitted …)`);
    lines.push("");
  }
  for (const pull of pulls.slice(-INSPECTIONS_KEEP_LAST)) {
    lines.push(`## Inspection @ Event ${pull.eventIndex} — \`${pull.operatorId}\`${pull.argsSummary ? ` (${pull.argsSummary})` : ""}`);
    lines.push("");
    lines.push(pull.output.length > 0 ? pull.output : "(empty output)");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

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
function serializeTurn(node: PathNode, revisionFolds?: Map<string, string>): string {
  const step = node.step;
  const lines: string[] = [];
  lines.push(`## Agent Event ${node.eventIndex}`);
  lines.push("");
  if (step.content) {
    lines.push(`Thought: ${step.content}`);
    lines.push("");
  }

  // Action: the tool call(s) the model issued, in standard tool-call form via
  // renderToolCall (tool name + `key: value` params + `code` block). Lossless —
  // except a createOrModifyOperator whose revision was later RESOLVED (rank-3
  // fold): its `code:` block renders as the one-line resolution fact instead.
  if (step.toolCalls && step.toolCalls.length > 0) {
    lines.push("Action:");
    for (const tc of step.toolCalls) {
      const inp = tc.input as Record<string, unknown> | undefined;
      const opId = typeof inp?.operatorId === "string" ? (inp.operatorId as string) : "";
      const foldFact = opId && tc.toolName === "createOrModifyOperator" ? revisionFolds?.get(opId) : undefined;
      for (const l of renderToolCall(tc, foldFact)) lines.push(l);
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
function renderToolCall(tc: { toolName: string; input?: unknown }, codeFoldFact?: string): string[] {
  const inp = (tc.input ?? {}) as Record<string, unknown>;
  const lines: string[] = [`- ${tc.toolName}`];
  for (const [k, v] of Object.entries(inp)) {
    if (k === "code") continue; // rendered last as a block
    const val = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : JSON.stringify(v);
    lines.push(`    ${k}: ${val}`);
  }
  if (typeof inp.code === "string" && inp.code.length > 0) {
    // Rank-3 fold: a superseded revision's code body renders as its one-line
    // resolution fact (the summary param above still names what it tried).
    if (codeFoldFact) {
      lines.push(`    code: ${codeFoldFact}`);
    } else {
      lines.push("    code:");
      for (const l of inp.code.split("\n")) lines.push(`      ${l}`);
    }
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
  resolveInputColumns?: (upstreamOpId: string) => number | undefined,
  ex?: OperatorRenderExtras
): string {
  const raw = formatOperatorResult(operatorId, info, workflowState, {
    ...(ex ? extrasFormatOptions(ex, options) : legacyFormatOptions(options)),
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
 * Compact ("deck") snapshot render for the compress compaction. Same per-operator
 * blocks as `serializeSnapshotFull`, but each operator's Result is rendered as
 * statistics (Column Schema and stats) plus a `deckSampleRatio` row peek instead
 * of its full table — the folded prefix's raw trajectory collapses to a few stat
 * lines per operator. `isCurrent=false`: this is a historical fold, so no live
 * compilation schemas. Per-operator `maxResultRows` is the ratio-sampled cap.
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
    };
    lines.push(
      serializeOperatorFull(op, snapshot, workflowState, perOpOptions, /*isCurrent=*/ false, allLinks, operatorLevel)
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

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

/** The legacy (global-flag) result-format options — shared by the LATEST
 *  operator block and the DELTA observation render. */
function legacyFormatOptions(options: AssembleContextOptions): FormatOperatorResultOptions {
  return {
    schemaInResult: options.schemaInResult,
    columnStats: options.columnStats,
    valueFormatFlags: options.valueFormatFlags,
    coercionTelemetry: options.coercionTelemetry,
    maxResultRows: options.maxResultRows,
    tableStructureHint: options.tableStructureHint,
    // A7: the legacy (no per-operator extras) path serves DELTA arms and any
    // arm without overrides. Omitting this dropped the `Files read:` fact for
    // every such arm even when stats implied it.
    fileIoFacts: options.fileIoFacts,
  };
}

/**
 * summarize(): map one operator's resolved render extras onto the
 * result-format options. The effective row cap is the tighter of the per-op
 * sample size and any global cap (the global one exists so compaction decks
 * stay a compression even under per-op params).
 */
function extrasFormatOptions(ex: OperatorRenderExtras, options: AssembleContextOptions): FormatOperatorResultOptions {
  const exRows = ex.tuple.sampleRows;
  const globalRows = options.maxResultRows ?? 0;
  const sampleRows = exRows > 0 && globalRows > 0 ? Math.min(exRows, globalRows) : exRows || globalRows;
  return {
    detail: ex.detail === "shape" ? "shape" : undefined,
    schemaInResult: ex.column.schema,
    schemaTypes: ex.column.schemaTypes,
    columnStats: ex.column.stats,
    statsMetrics: ex.column.statsMetrics,
    statsDensity: ex.column.statsDensity,
    valueFormatFlags: ex.column.valueFormatHints,
    coercionTelemetry: ex.column.coercionAlerts,
    tableStructureHint: ex.column.structuralHints,
    fileIoFacts: ex.column.fileIoFacts,
    maxResultRows: sampleRows,
    maxResultChars: ex.tuple.maxChars,
    sampleDuplicates: ex.tuple.duplicates,
    sampleFdHints: ex.tuple.fdHints,
  };
}

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
  // summarize(): per-operator render extras (defaults ⊕ overrides + dossier
  // history). Absent on the legacy path — rendering is then byte-identical to
  // the pre-summarize assembler.
  const ex = options.opExtras?.(op.operatorID);
  let execText: string | undefined;
  if (info && !info.error && ex?.retirementFact) {
    // Rank-4 probe retirement: the Result body is the compact extracted fact
    // (plus the Schema line when on) — the table/stats are omitted.
    const schemaLine = ex.column.schema ? formatSchemaLine(info, ex.column.schemaTypes !== false) : undefined;
    execText = [schemaLine, ex.retirementFact].filter(Boolean).join("\n");
  } else if (info && ex?.detail !== "omit") {
    execText = formatOperatorResult(op.operatorID, info, workflowState, {
      ...(ex ? extrasFormatOptions(ex, options) : legacyFormatOptions(options)),
      // LATEST renders a single consolidated `Inputs:` (with counts) at the
      // operator-block level (formatOperatorAdjacency), so skip the in-Result one.
      inputsInResult: false,
    });
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
  const includeProps = ex ? ex.includeProperties : options.includeOperatorProperties !== false;
  if (
    includeProps &&
    !CODE_OPERATOR_TYPES.has(op.operatorType) &&
    op.operatorProperties &&
    Object.keys(op.operatorProperties).length > 0
  ) {
    lines.push(`Properties: ${JSON.stringify(op.operatorProperties)}`);
  }

  // A7: `Files read:` is a CONSUMED fact — for a DataLoading operator it IS the
  // input, since loaders have no `Inputs:` line. Emitted here so both consumed
  // facts sit TOGETHER, above `Code:` and above `Result:`; everything indented
  // under `Result:` describes the output.
  if (options.fileIoFacts && info) {
    const fio = formatFileIo(info);
    if (fio) lines.push(fio);
  }

  // summarize(): opt-in current-code block. Errors already embed the code in
  // the [ERROR] result render, so only healthy operators get it here.
  if (ex?.includeCode && !info?.error) {
    const code = String((op.operatorProperties as Record<string, unknown> | undefined)?.code ?? "").trim();
    if (code) {
      lines.push("Code:");
      for (const l of clampCodeChars(code, ex.codeMaxChars ?? 0).split("\n")) lines.push("  " + l);
    }
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

  // summarize(): per-operator HISTORY sections (only without an interleaved
  // trajectory — see the precedence rule in params.ts). Code versions carry
  // the event index each was submitted at; result versions render per their
  // (typically cheaper) history render profile. Historical ERROR versions
  // render first-line-only: echoing the current code under an old error would
  // misattribute it (the code that produced it is in the code history).
  if (ex && (ex.codeHistory.length > 0 || ex.resultHistory.length > 0)) {
    for (const cv of ex.codeHistory) {
      lines.push(`Code @ step ${cv.eventIndex}${cv.status === "rejected" ? " (rejected)" : ""}:`);
      for (const l of cv.code.split("\n")) lines.push("  " + l);
    }
    for (const rv of ex.resultHistory) {
      lines.push(`Result @ step ${rv.version.eventIndex}:`);
      if (rv.version.info.error) {
        lines.push(`  [ERROR] ${rv.version.info.error.split("\n")[0]}`);
      } else {
        const t = formatOperatorResult(op.operatorID, rv.version.info, workflowState, {
          detail: rv.render.detail === "shape" ? "shape" : undefined,
          maxResultRows: rv.render.tuple.sampleRows,
          maxResultChars: rv.render.tuple.maxChars,
          sampleDuplicates: rv.render.tuple.duplicates,
          sampleFdHints: rv.render.tuple.fdHints,
          schemaInResult: rv.render.column.schema,
          schemaTypes: rv.render.column.schemaTypes,
          columnStats: rv.render.column.stats,
          statsMetrics: rv.render.column.statsMetrics,
          statsDensity: rv.render.column.statsDensity,
          valueFormatFlags: rv.render.column.valueFormatHints,
          coercionTelemetry: rv.render.column.coercionAlerts,
          tableStructureHint: rv.render.column.structuralHints,
          fileIoFacts: rv.render.column.fileIoFacts,
          inputsInResult: false,
        });
        for (const l of t.split("\n")) lines.push("  " + l);
      }
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
