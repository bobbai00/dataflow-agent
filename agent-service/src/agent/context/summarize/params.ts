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
 * THE SUMMARIZE PARAMETER SPACE.
 *
 * `summarize(input, params)` is the single centralized context renderer; this
 * module defines its tunable parameter schema. The legacy LATEST / DELTA
 * context modes are nothing special here — they are two named PRESETS (two
 * points in this space), produced by `mapLegacyToParams` from the agent's
 * settings. A future tuner emits a `SummarizeParams` object instead of
 * choosing between hardcoded modes.
 *
 * Design invariants:
 *  - ORTHOGONALITY: every combination of parameters is valid and renderable.
 *    Where two knobs would duplicate the same bytes (e.g. an interleaved
 *    trajectory already carries per-event results, and per-operator result
 *    HISTORY would repeat them), the renderer resolves it with a documented
 *    precedence rule instead of making the combination illegal:
 *      * `operators.*.result.history` and `operators.*.property.codeHistory`
 *        render ONLY when `trajectory.events === "none"` — an interleaved
 *        trajectory is itself the history.
 *  - Per-operator granularity: `operators.defaults` applies to every operator;
 *    `operators.overrides[opId]` deep-merges on top for that operator.
 *  - The schema is zod: it validates knob values coming over the API and is
 *    the future tool `inputSchema` for a model-driven summarize() call.
 */

import { observationFormat } from "../../native/observation-format";
import { z } from "zod";
import { AgentMode, ContextMode } from "../../../types/agent";
import type { AssembleContextOptions } from "../../util/context-utils";

/* ============================================================================
 *  Column-level (result → per-column annotations)
 * ========================================================================= */

export const ColumnParamsSchema = z
  .object({
    /** Compact `Schema:` line — full column inventory (name [+ type]). */
    schema: z.boolean().default(false),
    /** Include the `(type)` tag on the Schema line's columns. */
    schemaTypes: z.boolean().default(true),
  })
  .strict();
export type ColumnParams = z.infer<typeof ColumnParamsSchema>;

/* ============================================================================
 *  Tuple-level (result → row-sample shaping + sample-derived hints)
 * ========================================================================= */

export const TupleParamsSchema = z.object({
  /** Cap the TSV sample at first ⌈n/2⌉ + last ⌊n/2⌋ rows. 0 ⇒ uncapped. */
  sampleRows: z.number().int().min(0).default(0),
  /**
   * PER-OPERATOR char budget for the rendered TSV body (first ⌈n/2⌉ + last ⌊n/2⌋
   * rows that fit). 0 ⇒ no per-operator cap.
   *
   * Distinct from the agent-level `maxOperatorResultCharLimit`, which is a
   * single number sent to the JVM inside the execute request (it bounds what the
   * engine RETURNS, for every operator at once) and re-applied client-side as a
   * fetch-time safety net. That knob cannot differ per operator, which made a
   * "5k on sources, 1k on processing" policy inexpressible. This one is
   * render-time and per-operator, so it composes with the override map and binds
   * in BOTH context modes (`opExtras` is installed regardless of mode; in DELTA
   * it caps each event's render of that operator rather than one snapshot block).
   *
   * Can only reduce below the engine-side budget — the render never has bytes the
   * fetch did not return.
   */
  maxChars: z.number().int().min(0).default(0),
  /** Sample-based duplicate row / duplicate column detection (service-side). */
  duplicates: z.boolean().default(false),
  /** Sample-based candidate functional dependencies between columns. */
  fdHints: z.boolean().default(false),
});
export type TupleParams = z.infer<typeof TupleParamsSchema>;

/* ============================================================================
 *  Result rendering (one version of one operator's result)
 * ========================================================================= */

export const ResultRenderSchema = z.object({
  /** omit ⇒ no Result block; shape ⇒ row/col counts only; sample ⇒ TSV table. */
  detail: z.enum(["omit", "shape", "sample"]).default("sample"),
  tuple: TupleParamsSchema.default({}),
  column: ColumnParamsSchema.default({}),
  /** Rank-4 probe retirement: when set, the Result body renders as this
   *  compact extracted fact (plus the Schema line when on) instead of the
   *  table/stats — set per-operator by applyProbeRetirement. */
  retirementFact: z.string().optional(),
});
export type ResultRender = z.infer<typeof ResultRenderSchema>;

/* ============================================================================
 *  Per-operator params (defaults + overrides)
 * ========================================================================= */

export const PropertyParamsSchema = z.object({
  /** Render non-code `operatorProperties` as a `Properties:` line. (Python
   *  code operators always strip the code blob from Properties.) */
  includeProperties: z.boolean().default(true),
  /** Render the operator's CURRENT code as a `Code:` block. Off by default —
   *  errors already carry the code inline; this is the opt-in for healthy ops. */
  includeCode: z.boolean().default(false),
  /** How many PRIOR code versions to render (newest-first), with the event
   *  index each was submitted at. 0 ⇒ none. Ignored when the trajectory is
   *  interleaved (events already carry submissions). */
  codeHistory: z.number().int().min(0).default(0),
  /**
   * Character budget for the `Code:` block. 0 ⇒ unlimited (the legacy render).
   *
   * The counterpart to `tuple.maxChars` for tables. It exists because code was the
   * one large render component under no budget at all: byte accounting over ~100
   * traces/arm puts `Code:` at 27-39% of the rendered dataflow — the LARGEST single
   * component at a 1k row budget — while `max_operator_result_char_limit` clamps
   * table rows only.
   *
   * A CAP rather than a drop, because the size distribution is extremely
   * long-tailed: per-operator blocks run p50 286 B, p90 2,014 B, p99 6,081 B, max
   * 16,400 B. An 800 B cap removes ~49% of all code bytes while leaving 76.5% of
   * blocks untouched. Dropping code by operator ROLE was tried first and barely
   * binds — on these 2-5 operator pipelines `frontier` + `near-frontier` already
   * covers nearly every operator, and a role-keyed drop left 4 of 5 blocks intact.
   *
   * Clamping keeps the HEAD and the TAIL and elides the middle: the head carries the
   * signature and the loads, the tail carries the return value.
   */
  codeMaxChars: z.number().int().min(0).default(0),
});
export type PropertyParams = z.infer<typeof PropertyParamsSchema>;

export const ResultHistorySchema = z.object({
  /** How many PRIOR result versions to render (newest-first). 0 ⇒ none.
   *  Ignored when the trajectory is interleaved. */
  lastK: z.number().int().min(0).default(0),
  /** Render profile for each historical version (typically cheaper than
   *  `latest` — e.g. detail:"shape" or a small sample + stats). */
  render: ResultRenderSchema.default({ detail: "shape" }),
});
export type ResultHistory = z.infer<typeof ResultHistorySchema>;

export const OperatorParamsSchema = z.object({
  property: PropertyParamsSchema.default({}),
  result: z
    .object({
      latest: ResultRenderSchema.default({}),
      history: ResultHistorySchema.default({}),
    })
    .default({}),
});
export type OperatorParams = z.infer<typeof OperatorParamsSchema>;

/** Deep-partial override for one operator (explicit, not z.deepPartial —
 *  keeps the shape reviewable and avoids the deprecated helper). */
export const OperatorParamsOverrideSchema = z.object({
  property: PropertyParamsSchema.partial().optional(),
  result: z
    .object({
      latest: z
        .object({
          detail: z.enum(["omit", "shape", "sample"]).optional(),
          tuple: TupleParamsSchema.partial().optional(),
          column: ColumnParamsSchema.partial().optional(),
          retirementFact: z.string().optional(),
        })
        .optional(),
      history: z
        .object({
          lastK: z.number().int().min(0).optional(),
          render: z
            .object({
              detail: z.enum(["omit", "shape", "sample"]).optional(),
              tuple: TupleParamsSchema.partial().optional(),
              column: ColumnParamsSchema.partial().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
export type OperatorParamsOverride = z.infer<typeof OperatorParamsOverrideSchema>;

/* ============================================================================
 *  Trajectory / flow / top-level
 * ========================================================================= */

export const TrajectoryParamsSchema = z.object({
  /** "none" ⇒ no events section (the legacy LATEST shape); "interleaved" ⇒
   *  every event as Thought/Action[/Observation] in order (the legacy DELTA
   *  shape). */
  events: z.enum(["none", "interleaved"]).default("none"),
  /** Per-event delta Observations under each interleaved event. "none" keeps
   *  Thought/Action only. */
  observations: z.enum(["delta", "none"]).default("delta"),
  /** Thought-replay block: the last K agent events as thought + compressed
   *  actions (`# Reasoning`), plus per-operator `Last edited:` back-pointers.
   *  0 ⇒ off. Renders only when events === "none" (interleaved events already
   *  show thoughts inline). */
  reasoningReplayK: z.number().int().min(0).default(0),
  /** `# Agent Turns`: the full Thought/Action trajectory section on top of the
   *  current-snapshot core (fuller alternative to reasoningReplayK). Renders
   *  only when events === "none". */
  agentTurns: z.boolean().default(false),
  /** Token budget for the assembled context. 0 ⇒ unbounded. When exceeded and
   *  events are interleaved, compaction fires per `compaction`. */
  windowTokens: z.number().int().min(0).default(0),
  /** sliding: evict oldest whole events; compress: fold oldest events into a
   *  `# Dataflow (compacted)` stats deck, raw delta resumes after it. */
  compaction: z.enum(["sliding", "compress"]).default("compress"),
  /** compress-deck row-sample fraction (clamped to [3, sampleRows||20]/op). */
  deckSampleRatio: z.number().min(0).max(1).default(0.1),
  /** Agent-triggered compaction (POC): raw agent events kept before the newest
   *  compactContext mark. 0 ⇒ fold through the mark. */
  compactKeepLastSteps: z.number().int().min(0).default(0),
  /** Show the context-budget meter atop DELTA context (the observable signal for
   *  the agent's compactContext decision). */
  showCompactMeter: z.boolean().default(false),
  /** Static compaction rule (DELTA-only): auto-fold settled older events into the
   *  deck once the trajectory passes a static trigger, keeping the last K raw. */
  staticCompaction: z.boolean().default(false),
  /** Which static rule: "editConvergence" (default) or "token". */
  compactionRule: z.enum(["editConvergence", "token"]).default("editConvergence"),
  /** Monotone fold-boundary high-water clamp for editConvergence. */
  compactBoundaryFloor: z.number().int().min(0).default(0),
  /** Fold resolved operator revisions (DELTA-only; rank-3 static rule): once a
   *  later revision has executed successfully and been consumed healthily
   *  (+ grace), prior revisions' code/result payloads render as one-line
   *  resolution facts. */
  foldResolvedRevisions: z.boolean().default(false),
  /** Write-time render prefs (agent-declared outputSummary
   *  on createOrModifyOperator). Enables the event-scoped DELTA application. */
  renderPrefs: z.boolean().default(false),
  /** Grace (events) after the resolution before prior revisions fold. */
  foldGraceEvents: z.number().int().min(0).default(1),
  /** Where the `# User Task` block goes. "bottom" keeps the history a
   *  byte-stable prefix across turns, which is what prompt caching matches on;
   *  "top" is the legacy placement. */
  userTaskPlacement: z.enum(["top", "bottom"]).default("top"),
  /** Prior turns of a multi-turn session: "full" replays every event forever,
   *  "index" collapses them into the `# Prior Turns` catalogue and keeps only the
   *  current turn raw (details then pulled with `recallState`). */
  priorTurns: z.enum(["full", "index"]).default("full"),
  /** Versioned mode: the whole context is one catalog over the version DAG
   *  (supersedes priorTurns entirely). */
  versionedCatalog: z.boolean().default(false),
  versionedHeads: z.boolean().default(true),
  /** Session layout: the flat event log re-grouped by turn (# Session +
   *  # Your Task). Superseded by versionedCatalog. */
  sessionTurns: z.boolean().default(false),
  /** v3: catalog header teaches operator-level recall addressing. */
  recallOperatorLevel: z.boolean().default(false),
  /** v3.3: the `# Your Task` directive restates the AUDIT requirement. */
  specAudit: z.boolean().default(false),
});
export type TrajectoryParams = z.infer<typeof TrajectoryParamsSchema>;

export const FlowParamsSchema = z
  .object({
    /** Fold per-operator attempt/error history into errored operators' blocks. */
    errorReflection: z.boolean().default(false),
    /** Consecutive same-op edits before the folded history shows. */
    errorReflectionThreshold: z.number().int().min(1).default(3),
    /** `Attempt reflection:` block on heavily-edited operators. */
    attemptReflection: z.boolean().default(false),
  })
  .strict();
export type FlowParams = z.infer<typeof FlowParamsSchema>;

export const SummarizeParamsSchema = z.object({
  /** The two evidence controls and their shared result budget. */
  nativeEvidence: z
    .object({
      data: z.boolean(),
      flow: z.boolean(),
      maxChars: z.number().int().min(0),
      checks: z.boolean().optional(),
      tableFormat: z.enum(["markdown", "tsv"]).optional(),
      ...Object.fromEntries(
        [
          "keyValueColumns",
          "columnsShown",
          "definitionChars",
          "cellChars",
          "topValues",
          "catalogRecords",
          "dataMaxChars",
          "flowMaxChars",
        ].map(key => [key, z.number().int().min(0).optional()])
      ),
      answerEcho: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  trajectory: TrajectoryParamsSchema.default({}),
  /** Render the `# Current Dataflow` snapshot section (every operator's block).
   *  The legacy DELTA shape sets this false — state lives inline in the
   *  interleaved observations. */
  currentSnapshot: z.boolean().default(true),
  /** Attach compiler-derived input/output schemas + compilation errors to the
   *  current snapshot's operator blocks (needs a compilationResult input;
   *  legacy: GENERAL mode only). */
  compiledSchemas: z.boolean().default(false),
  /** Native-mode result selection for the current snapshot (see
   *  AgentSettings.resultSelection): "all" renders every result block,
   *  "rule" ships only what the data decided. */
  resultSelection: z.enum(["all", "rule", "scoped"]).default("all"),
  flow: FlowParamsSchema.default({}),
  operators: z
    .object({
      defaults: OperatorParamsSchema.default({}),
      overrides: z.record(z.string(), OperatorParamsOverrideSchema).default({}),
    })
    .default({}),
  /** Per-cell char cap reused for the surfaced print-output block. 0 ⇒ none. */
  maxCellChars: z.number().int().min(0).default(0),
  /** Wire framing: one user block (legacy) or a native tool-calling transcript. */
  messageLayout: z.enum(["markdown", "block", "blockSplit", "native", "opBlock", "opSplit", "turnSplit"]).optional(),
});
export type SummarizeParams = z.infer<typeof SummarizeParamsSchema>;

/** Parse/validate an untyped params object (e.g. from the API), filling
 *  defaults. Throws ZodError on invalid values. */
export function parseSummarizeParams(raw: unknown): SummarizeParams {
  return SummarizeParamsSchema.parse(raw ?? {});
}

/** A deep-partial of SummarizeParams, for API callers that tweak a few knobs
 *  on top of the agent's settings-derived params. */
export const SummarizeParamsPatchSchema = z.object({
  trajectory: TrajectoryParamsSchema.partial().optional(),
  currentSnapshot: z.boolean().optional(),
  compiledSchemas: z.boolean().optional(),
  flow: FlowParamsSchema.partial().optional(),
  operators: z
    .object({
      defaults: OperatorParamsOverrideSchema.optional(),
      overrides: z.record(z.string(), OperatorParamsOverrideSchema).optional(),
    })
    .optional(),
  maxCellChars: z.number().int().min(0).optional(),
});
export type SummarizeParamsPatch = z.infer<typeof SummarizeParamsPatchSchema>;

/**
 * Apply a deep-partial patch (e.g. the agent's `summarizeParams` setting) on
 * top of fully-resolved params, re-validating the result. This is how the API
 * / a tuner tweaks individual knobs without restating the whole object.
 */
export function applySummarizeParamsPatch(base: SummarizeParams, patch: SummarizeParamsPatch): SummarizeParams {
  return SummarizeParamsSchema.parse(deepMerge(base, patch));
}

/* ============================================================================
 *  Deep-merge (defaults ⊕ override) — the per-operator resolution
 * ========================================================================= */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural deep-merge: `patch` wins; objects merge recursively; arrays and
 *  scalars replace. Never mutates its inputs. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T)) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Resolve the effective per-operator params: defaults ⊕ overrides[opId]. */
export function resolveOperatorParams(params: SummarizeParams, opId: string): OperatorParams {
  const override = params.operators.overrides[opId];
  if (!override) return params.operators.defaults;
  return deepMerge(params.operators.defaults, override);
}

/* ============================================================================
 *  Legacy mapping — the two presets as points in the space
 * ========================================================================= */

/**
 * Map the legacy `(ContextMode, AssembleContextOptions)` pair into the
 * summarize parameter space. This is the single source of truth for what the
 * legacy knobs MEAN: LATEST and DELTA come out as two presets; every other
 * legacy flag lands on exactly one parameter. Round-trip guarantee: rendering
 * with the mapped params is byte-identical to the legacy render (enforced by
 * the golden characterization tests).
 */
export function mapLegacyToParams(mode: ContextMode, options: AssembleContextOptions): SummarizeParams {
  const isLatest = mode === ContextMode.LATEST;

  return SummarizeParamsSchema.parse({
    nativeEvidence: options.nativeEvidence ?? {
      ...observationFormat(options),
      data: options.dataEvidence === true,
      flow: options.flowEvidence === true,
      maxChars: options.maxOperatorResultCharLimit ?? 2000,
      ...(options.nativeChecks === true ? { checks: true } : {}),
    },
    trajectory: {
      events: isLatest ? "none" : "interleaved",
      observations: "delta",
      reasoningReplayK: options.thoughtReplay ? (options.thoughtReplayK ?? 10) : 0,
      agentTurns: options.agentTurns ?? false,
      windowTokens: options.contextWindowTokens && options.contextWindowTokens > 0 ? options.contextWindowTokens : 0,
      compaction: options.compactionStrategy ?? "compress",
      deckSampleRatio: options.deckSampleRatio ?? 0.1,
      compactKeepLastSteps: options.compactKeepLastSteps ?? 0,
      showCompactMeter: options.showCompactMeter ?? false,
      staticCompaction: options.staticCompaction ?? false,
      compactionRule: options.compactionRule ?? "editConvergence",
      compactBoundaryFloor: options.compactBoundaryFloor ?? 0,
      foldResolvedRevisions: options.foldResolvedRevisions ?? false,
      foldGraceEvents: options.foldGraceEvents ?? 1,
      userTaskPlacement: options.userTaskPlacement ?? "top",
      priorTurns: options.turnHistoryIndex ? "index" : "full",
      versionedCatalog: options.versionedCatalog === true,
      versionedHeads: options.versionedHeads !== false,
      sessionTurns: options.sessionTurns === true,
      recallOperatorLevel: options.recallOperatorLevel === true,
      specAudit: options.specAudit === true,
      renderPrefs: options.renderPrefsEnabled ?? false,
    },
    // DELTA normally has no `# Current Dataflow` section because state lives
    // inline in the events' observations. Cataloguing prior turns removes those
    // observations, so without this the model loses every schema and result it
    // ever computed — measured: a 13 KB turn-20 prompt with zero result data, and
    // accuracy 33.3% -> 11.1% concentrated entirely in the Initial/Update turns
    // that need the CURRENT state (Rollback/Counterfactual were unaffected,
    // because recallState covers old definitions). Cataloguing has to REPLACE the
    // event log with the live snapshot, not delete state.
    currentSnapshot: isLatest || options.turnHistoryIndex === true,
    compiledSchemas: false,
    resultSelection: options.resultSelection ?? "all",
    messageLayout: options.messageLayout,
    flow: {
      errorReflection: options.errorReflection ?? false,
      errorReflectionThreshold: options.errorReflectionThreshold ?? 3,
      attemptReflection: options.attemptReflection ?? false,
    },
    operators: {
      defaults: {
        property: {
          includeProperties: options.includeOperatorProperties !== false,
          // Same reasoning as `currentSnapshot` above: DELTA's event log is where
          // an operator's code lives (79 `def process/load` blocks in a measured
          // baseline prompt, versus ZERO once prior turns were catalogued), so
          // cataloguing has to put the code in the snapshot or the agent goes
          // code-blind about its own pipeline and has to recall it back one
          // operator at a time.
          includeCode: options.turnHistoryIndex === true,
          codeHistory: 0,
        },
        result: {
          latest: {
            detail: "sample",
            tuple: { sampleRows: options.maxResultRows ?? 0, duplicates: false, fdHints: false },
            column: {
              schema: options.schemaInResult === true,
              schemaTypes: true,
            },
          },
          history: { lastK: 0, render: { detail: "shape" } },
        },
      },
      overrides: {},
    },
    maxCellChars: options.maxOperatorResultCellCharLimit ?? 0,
  });
}

/** The legacy LATEST context mode as a point in the parameter space, at the
 *  server's default agent settings (thoughtReplay on, K=10, properties on,
 *  2000-char print cap). */
export function latestPreset(): SummarizeParams {
  return mapLegacyToParams(ContextMode.LATEST, {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    includeOperatorProperties: true,
    thoughtReplay: true,
    thoughtReplayK: 10,
    maxOperatorResultCellCharLimit: 2000,
  });
}

/** The legacy DELTA context mode as a point in the parameter space, at the
 *  server's default agent settings. */
export function deltaPreset(): SummarizeParams {
  return mapLegacyToParams(ContextMode.DELTA, {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    includeOperatorProperties: true,
    maxOperatorResultCellCharLimit: 2000,
  });
}
