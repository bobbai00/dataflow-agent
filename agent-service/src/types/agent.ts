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

import type { SummarizeParamsPatch } from "../agent/context/summarize/params";
import type { SelectorConfig } from "../agent/context/selector/selector";
import type { FrontierDecayConfig } from "../agent/context/selector/frontier-decay";
import type { ProbeRetirementConfig } from "../agent/context/selector/probe-retirement";
import type { RolePolicyConfig } from "../agent/context/selector/role-policy";
import type { FoldResolvedRevisionsConfig } from "../agent/context/select/revision-folds";
import type { LearnedConfig } from "../agent/context/learned/score";
import type { TunerConfig } from "../agent/context/tuner/tuner";

export enum AgentState {
  UNAVAILABLE = "UNAVAILABLE",
  AVAILABLE = "AVAILABLE",
  GENERATING = "GENERATING",
  STOPPING = "STOPPING",
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // Per-class breakdown for accurate cost. `cachedInputTokens` is the subset of
  // input served from cache (cheap cache-read); `cacheCreationInputTokens` is the
  // Anthropic cache-WRITE count; `reasoningTokens` is the thinking subset of output.
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

export interface ReActStep {
  id: string;
  parentId?: string;
  messageId: string;
  stepId: number;
  timestamp: number;
  role: "user" | "agent";
  content: string;
  isBegin: boolean;
  isEnd: boolean;
  toolCalls?: Array<{
    toolName: string;
    toolCallId: string;
    input: any;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    output: any;
    isError?: boolean;
  }>;
  usage?: TokenUsage;
  inputMessages?: any[];
  messageSource?: "chat" | "feedback";
}

export enum OperatorResultSerializationMode {
  TSV = "tsv",
}

/**
 * Agent operating mode. CODE uses the unified `createOrModifyOperator` tool
 * (Python `def load()` / `def process(...)`); GENERAL uses typed
 * `addOperator`/`modifyOperator` tools and embeds operator schemas in the prompt.
 */
export enum AgentMode {
  CODE = "code",
  GENERAL = "general",
}

/**
 * Snapshot-selection policy for serializing the ReAct context (paper §5,
 * Phase 1). Trades trajectory fidelity for token cost; orthogonal to the
 * flow/data DECORATE levels (Phase 2).
 *
 * - DELTA — each event interleaved with its snapshot, rendering only the
 *   operators that event changed (unchanged operators are omitted; topology
 *   is embedded per-operator). Cost scales with distinct edits.
 * - LATEST — no per-event history; just the user task + the current snapshot.
 *   Cheapest. When flowLevel>0, a consolidated "Operators needing attention"
 *   flow section follows the snapshot — a targeted, lossy projection of the
 *   trajectory's failures/lineage (the middle ground between LATEST and DELTA).
 */
export enum ContextMode {
  DELTA = "delta",
  LATEST = "latest",
}

/**
 * DELTA compaction strategy — how the assembler shrinks the trajectory once the
 * raw delta would exceed `contextWindowTokens`:
 *   - "sliding": evict the oldest whole agent events until it fits.
 *   - "compress": fold the oldest events into a stats deck, then resume raw
 *     delta for the fresh suffix (rolling compaction).
 */
export type CompactionStrategy = "sliding" | "compress";

export interface AgentSettings {
  systemPrompt: string;
  disabledTools: Set<string>;
  maxOperatorResultCharLimit: number;
  maxOperatorResultCellCharLimit: number;
  operatorResultSerializationMode: OperatorResultSerializationMode;
  toolTimeoutMs: number;
  executionTimeoutMs: number;
  maxSteps: number;
  /**
   * Convergence guard (paper §C / goal.md lever C). The maximum number of
   * *consecutive* `createOrModifyOperator` calls that may target the SAME
   * operator before the next same-operator MODIFY is rejected. A call to a
   * different operator resets the run. `0` disables the guard entirely
   * (default — byte-identical to pre-guard behavior). When `> 0`, a rejected
   * edit returns an `[ERROR]` result and mutates nothing, so it triggers no
   * execution and does not grow the per-step context — this is what truncates
   * the L1 (semantic thrashing) × L2 (super-linear context) cost blow-up.
   */
  maxOperatorEdits: number;
  allowedOperatorTypes: string[];
  agentMode: AgentMode;
  contextMode: ContextMode;
  /**
   * When true, the model may emit multiple tool calls in a single assistant
   * turn (provider-side parallel tool calls). The agent still executes them
   * sequentially in topological order via `ToolCallScheduler` so an op that
   * references a sibling created in the same turn can't run before its
   * upstream. When false, the provider is asked to emit one tool call per
   * turn (the pre-batching behavior).
   */
  parallelToolCalls: boolean;
  /**
   * When true, each operator's `operatorProperties` are rendered as a
   * `Properties:` line in the assembled snapshot — EXCEPT the Python code
   * operators (PythonUDFV2 / DataLoading / DataProcessing), whose `code`
   * blob is large and already surfaced on error, so it is always stripped.
   * When false, no operator properties are rendered at all (the legacy
   * paper-§4.3 strip-everything behavior). Enabled by default.
   */
  includeOperatorProperties: boolean;
  /**
   * When true, an operator that has been edited repeatedly (≥ the reflection
   * threshold) gets an `Attempt reflection:` block in the current snapshot:
   * its edit count, its current code (otherwise stripped from context), and a
   * directive to change strategy instead of resubmitting near-variants. Targets
   * operator-level thrashing (lever C/D + the Lineage & Flow direction) by
   * giving the model the attempt history + code it cannot otherwise see.
   * Disabled by default (no-op).
   */
  attemptReflection: boolean;
  /**
   * Stage-aware loader-remediation hint (goal.md lever D / Direction-1). When
   * true, a load-stage operator (`DataLoading`, i.e. zero incoming links) that
   * has an `info.error` gets an indented `Loader hint:` line appended to its
   * Result block — a compact, GENERAL remediation directive keyed only on the
   * exception class parsed from the error string (UnicodeDecodeError → try a
   * non-UTF-8 encoding such as cp1252/latin-1; ParserError → sniff the
   * delimiter / skip preamble rows / on_bad_lines='skip'; FileNotFoundError →
   * use the exact provided path). The model already SEES the error + its code
   * but loops without acting; this injects the remediation knowledge it lacks.
   * No task/column/domain literals. Disabled by default (no-op).
   */
  /**
   * When true, each non-error operator result gets a `Format hints:` line
   * flagging string columns whose sample values look like currency `$1,234`,
   * percent, thousands-separated, parenthesized-negatives, or leading-zero
   * codes — with the cleaning to apply BEFORE numeric conversion. Targets the
   * silent `to_numeric(errors='coerce')` dataloss accuracy killer. Keyed only
   * on value shape (no task literals). Disabled by default (no-op).
   */
  /**
   * Thought-replay reinjection rung (LATEST only). When true, the assembled
   * context gains a `# Reasoning` block — the last `thoughtReplayK` agent events,
   * each as its thought + the compressed actions it produced — and each operator
   * carries a `Last edited: step N` back-pointer into it. Recovers the reasoning
   * trajectory LATEST folds away. On by default.
   */
  thoughtReplay: boolean;
  /** How many recent events the `# Reasoning` block shows (default 10). */
  thoughtReplayK: number;
  /** Agent-turns section (LATEST only). When true, the LATEST context gains a
   *  `# Agent Turns` section: the full Thought/Action/Observation trajectory
   *  rendered delta-style (the same serializer DELTA uses), on top of the
   *  latest-state core. A fuller alternative to thoughtReplay's last-K
   *  `# Reasoning`. Off by default. */
  agentTurns: boolean;
  /** DELTA context-window budget, in tokens (estimated chars/4). Bounds the
   *  assembled trajectory user-message — the true model window minus the
   *  ~constant system prompt + response headroom, which the caller folds into
   *  this number. `0` ⇒ unbounded (lossless delta — legacy behavior). When
   *  `> 0`, the assembler renders the "original" raw delta (schema-only, no
   *  stats) while it fits, then COMPACTS via `compactionStrategy` once it would
   *  overflow. Only meaningful in DELTA mode. Default 0. */
  contextWindowTokens: number;
  /** How DELTA compacts once the raw delta exceeds `contextWindowTokens`:
   *   - "sliding": drop the oldest whole agent events until it fits (an
   *     `(… N earlier events omitted …)` marker stands in their place).
   *   - "compress": fold the oldest events into a `# Dataflow (compacted)` deck
   *     — the boundary snapshot rendered per-operator as `Column Schema and
   *     stats:` + a ratio-sampled row peek — then resume raw delta for the
   *     fresh suffix (rolling compaction). Default "compress". */
  compactionStrategy: CompactionStrategy;
  /** compress-deck row sampling: fraction of each folded operator's output rows
   *  to keep as a peek alongside its stats, clamped to `[3, maxResultRows||20]`.
   *  Default 0.10. */
  deckSampleRatio: number;
  /** Error-reflection rung (LATEST only): show each churning operator's attempt
   *  count + distinct errors + a blocked→change-strategy verdict. Off by default. */
  errorReflection: boolean;
  /** N consecutive same-operator refixes before the folded error/attempt history shows. */
  errorReflectionThreshold: number;
  fewShotPrompt: boolean;
  maxResultRows: number;
  flowLevel: number;
  dataLevel: number;
  /** Standalone overlay (independent of `dataLevel`): when true, each operator
   *  result carries the full per-column `Column Schema and stats:` block the worker
   *  publishes (null/mean/min/max/distinct/top-N). Off by default. */
  columnStats: boolean;
  /** Standalone flag (data-derived annotation family, sibling of `columnStats`):
   *  append the `Format hints:` line for string columns that are numbers wearing
   *  punctuation (currency/percent/thousands). Independent of `dataLevel` (which
   *  can also enable it at L3). Off by default. */
  valueFormat: boolean;
  /** Standalone flag (data-derived annotation family, sibling of `columnStats`):
   *  append the `Output Table profile:` block (all-null rows/cols, duplicate rows,
   *  unnamed columns). Independent of `dataLevel` (which can also enable it
   *  at L2). Off by default. */
  dataHints: boolean;
  /**
   * Tool-call dialect for the local text-mode driver (`local-react`). Selects
   * the system prompt, the output parser, AND the context assembler so all
   * three agree (qwen-xml → CODE-mode prompt + SDK context; react-text →
   * `local-react.txt` + `# Event N` context). Ignored by the `vercel-tool-use`
   * driver (native tool calling). Default `qwen-xml`. See `LocalToolDialect`.
   */
  toolDialect: LocalToolDialect;
  /**
   * Deep-partial patch over the summarize() parameter space
   * (context/summarize/params.ts), applied on top of the params derived from
   * the settings above (contextMode → preset, flowLevel/dataLevel → rungs, …).
   * The door into every summarize knob the flat settings don't expose:
   * per-operator overrides, code/result history, detail levels, metric
   * subsets, sample-based tuple hints. Validated against
   * SummarizeParamsPatchSchema at the API boundary. Undefined ⇒ no patch.
   */
  summarizeParams?: SummarizeParamsPatch;
  /**
   * When set, the per-step SELECTOR policy (context/selector) chooses the
   * summarize() params from the live dossier — the "context tuner" running
   * end-to-end. Overrides the flat contextMode/knob surface. The value is the
   * trainable `SelectorConfig` action vector. Undefined ⇒ selector off (use the
   * legacy contextMode path). See docs/summarize-tuning-intuitions.md.
   */
  selectorConfig?: SelectorConfig;
  /** Conservative base-preserving decay for settled single-consumer results. */
  frontierDecayConfig?: FrontierDecayConfig;
  /** Rank-3 static rule (DELTA-only): fold resolved operator revisions into
   *  one-line resolution facts. */
  foldResolvedRevisionsConfig?: FoldResolvedRevisionsConfig;
  /** Rank-4 static rule (LATEST): retire superseded isolated probes to a
   *  compact extracted fact once their discovery is encoded downstream. */
  probeRetirementConfig?: ProbeRetirementConfig;
  /** RULE A: role-keyed render policy (rich source / lean interior). */
  rolePolicyConfig?: RolePolicyConfig;
  /**
   * When set, the LEARNED utility model (context/learned/model.json) scores each
   * operator and a budget knapsack assigns representation levels
   * (omit≺shape≺sample+stats) — the trained counterpart of selectorConfig.
   * Highest precedence in the assembler. The value is the `LearnedConfig`
   * (token budget + protect/stats flags). Undefined ⇒ off. Falls back to the
   * selector/legacy path if no model is bundled. See docs/learned-context-selection.md.
   */
  learnedConfig?: LearnedConfig;
  /**
   * Expose the read-only `inspectResult` PULL tool to the model (Direction B).
   * Lets the agent re-inspect an existing operator's cached result at more
   * detail on demand instead of re-loading. Off by default. Every call is also
   * a supervised label for training the push selector (pull-to-push).
   */
  enableInspectTool: boolean;
  /**
   * Write-time render prefs: `createOrModifyOperator` accepts optional
   * `outputSummary` ("minimal"|"standard") and `showOutputStatistics` (bool)
   * controlling how much of the op's result is RENDERED (view-only — the full
   * output is always computed and flows downstream). Gates the tool params,
   * the prompt section, and the render application. Off by default.
   */
  enableRenderPrefs: boolean;
  /**
   * Show each operator's CURRENT code as a `Code:` block in the LATEST snapshot,
   * and tell the agent (tool-def + prompt + example) to write SHORT summaries
   * since the code now carries the detail. LATEST-only (DELTA already renders
   * code inline in each event). Off by default; when off, prompt/tool/render are
   * byte-identical to legacy. Experiment: does seeing its own code help the agent?
   */
  enableCodeInSnapshot: boolean;
  /**
   * A4 arm: append the multi-file provenance principle to the code-mode system
   * prompt (loaders reading multiple files must add a `__source_file` column).
   * Off by default; when off the prompt is byte-identical to legacy.
   */
  sourceProvenanceHint: boolean;
  /**
   * Where the `# User Task` block goes.
   *
   * "top" (default, legacy) puts the newest request first. That is fine for a
   * single request but destroys prompt caching across turns in a multi-turn
   * session: the request is the FIRST thing in the message, so every new turn
   * changes byte 13 and invalidates the identical history below it. Measured on
   * a 42-turn LongDS task: consecutive turns shared only 13 leading characters
   * of a 233 KB prompt, and cache hits collapsed to the system prompt alone.
   *
   * "bottom" moves the request under the history, so the history is a stable
   * prefix across turns and only the (small) tail changes. Also puts the live
   * request closest to the generation point, which is where recency helps.
   */
  userTaskPlacement: "top" | "bottom";
  /**
   * How PRIOR turns of a multi-turn session are rendered (DELTA only; LATEST
   * never rendered prior turns at all).
   *
   * - "full" (default, legacy): every event of every turn, verbatim and forever.
   * - "index": prior turns collapse into a compact `# Prior Turns` catalogue —
   *   one line per turn with its request, the operators it touched and the answer
   *   it gave — while the CURRENT turn keeps its events raw. Details are then
   *   pulled on demand with `recallState` (see enableRecallTool). This is the
   *   turn-boundary reorganization: context is rebuilt once per turn (where the
   *   cache boundary already falls) instead of growing without bound.
   */
  turnHistory: "full" | "index";
  /**
   * Expose the read-only `recallState` tool: lets the model fetch specific
   * history it decides it needs for the current turn — a past turn's request and
   * answer, an operator's code as of a past turn, an operator's revision
   * history, or a result sample. Pairs with `turnHistory: "index"`: the index
   * says what exists, the tool fetches what matters. Off by default.
   */
  enableRecallTool: boolean;
  /** Per-operator ceiling for recallState's `includeOutputTableSample`
   *  (characters). Requests above it are clamped with a teaching message.
   *  The ceiling is an experiment knob; the existence of a clamp is not. */
  recallMaxResultChars: number;
  /** OPERATOR-LEVEL recall (v3): recallState takes `ref: "opId (turn N)"` —
   *  one version per pull, values on by default — instead of a whole turn.
   *  Pairs with versionedMode (the catalog prints those addresses). */
  recallOperatorLevel: boolean;
  /** FOUNDATION VERIFY: prompt-side, layout-agnostic. Dual derivation of
   *  quantities later turns consume (checked against zero-cost relations),
   *  read-the-rendered-row-counts discipline, and a named denominator for
   *  every reported share. Aimed at the measured failure mass: 93-94% of
   *  wrong turns inherit from an already-wrong upstream, median first error
   *  at turn 2-3, and the recurring first-error classes are population/
   *  denominator/scope choices at state creation. Off by default —
   *  byte-identical prompt when off. */
  foundationVerify: boolean;
  /** QUERY TOOL: expose `queryResult(operatorId, expr)` — one read-only pandas
   *  expression over an operator's materialized result rows, evaluated in a
   *  sandboxed python subprocess, output clamped. Replaces probe operators
   *  (14.8 s engine execution each, measured) and the clipped-render trap
   *  (answering from a truncated table as if complete). The fragment also
   *  carries the two answer-surface rules the flip census measured: never
   *  answer from a truncated render; report whole rows. Off by default —
   *  byte-parity when off. */
  enableQueryTool: boolean;
  /** UPSTREAM VALUE ECHO (versioned mode): when a write's `upstreams` names a
   *  cross-turn version whose values were not recalled this turn, attach that
   *  version's sample rows to the step's observation — attach, never reject.
   *  Trace-grounded: the nfl-t3 class wrote the same operator nine times over
   *  an unrecalled turn-2 table with the wrong denominator convention and lost
   *  ~30 dependent turns; the business campaign measured 17.5% of writes
   *  blind. Requires cacheAlignedContext (rides the per-step append channel).
   *  Off by default. */
  upstreamValueEcho: boolean;
  /** ANSWER SHAPE RULE (prompt-only): mirror the source table's column names,
   *  keep the structure flat, echo whole rows. Trace-grounded: byte-identical
   *  numbers scored 0 under renamed/nested fields (acea2 t1; nyc t4 in the
   *  business campaign). Off by default; byte-identical prompt when off. */
  answerShapeRule: boolean;
  /** v3.3 SPEC AUDIT: require a filled AUDIT checklist before the final answer
   *  — every requested quantity traced to an `opId (turn N)` + column, every
   *  binding clause of the task text quoted and answered. Prompt-side only, and
   *  layout-agnostic: the defect it targets (a 90%-correct answer that loses on
   *  one unchecked clause — scope, population, sign, denominator, scale) was
   *  measured at the same rate under `# Session` and `# Catalog`. */
  specAudit: boolean;
  /**
   * How many UPSTREAM operators of the current turn's work may render sample
   * rows, ranked most-recently-touched first; the rest stay a one-line index
   * entry and are a `recallState` call away. There is no matching cap on code:
   * the operators a turn is working on always render their code in full, because
   * a partial view of the turn's own definitions makes the model rebuild what it
   * already has.
   */
  indexRichTables: number;
  /**
   * How many operators keep a full index entry (summary + schema), beyond the
   * ones this turn is working on, which are never evicted. Admitted
   * most-recently-touched first; the rest collapse to a bare header line —
   * still named and recallable, but no longer re-sent in detail. The index
   * would otherwise grow with every operator ever created (737 by turn 30 on
   * one task, 360 KB of a 559 KB prompt).
   *
   * This is a COUNT and not an age. It replaced `indexRecentTurns`, which was
   * the same constant for a 31-operator task and a 381-operator one and so
   * failed in both directions at once: at 3 turns passnyc could see 4 result
   * tables out of ~23 live operators (63.3% -> 40.0%), and at 12 turns nfl and
   * uber flooded to 360-600 kB and spent whole 40-step budgets returning
   * nothing. A count bounds what the prompt actually pays for.
   */
  indexDetailedOperators: number;
  /**
   * Expose `resumeFrom(turn)`: the model names the turn it builds on and the
   * dataflow becomes that turn's state, instead of a recency rule choosing.
   * Off by default — control arms keep a byte-identical prompt and tool set.
   */
  enableResumeTool: boolean;
  /**
   * Check that a final answer's substantive numbers trace to a materialized
   * operator result or to state recalled this turn; on total failure, send one
   * feedback round. Leverages the dataflow property that results are
   * addressable tables — unverifiable in a plain transcript. Off by default.
   */
  enableAnswerGrounding: boolean;
  /**
   * Surface the worker's coerce-to-NaN dataloss diagnostics (count + sample of
   * dropped values) on operator results. The worker computes them
   * unconditionally by transparently wrapping pandas.to_numeric/to_datetime;
   * this only gates the render. Alarm-only, value-shape keyed, no task
   * literals. Off by default.
   */
  coercionTelemetry: boolean;
  /**
   * Append a `Lineage:` line to operator results — rows in vs rows out from the
   * engine's execution counts. A pure fact, no thresholds: silent row loss (a
   * join dropping keys) becomes visible at the step where it happens instead of
   * cascading. Off by default.
   */
  rowLineage: boolean;
  /**
   * VERSIONED MODE — the session as one immutable version DAG addressed by
   * (operatorId, turnId). Three coupled changes, one flag:
   *   render: the context is a single `# Catalog` — finished turns as
   *     Task / Dataflow delta / Answer entries, the turn in progress as the
   *     last entry (its steps carry full observations; recall output persists
   *     there as an ordinary observation). No `# Dataflow` section: state
   *     renders once, at creation, and the prompt is append-only.
   *   tools: `createOrModifyOperator` requires `upstreams` (def-arg → version
   *     turn) and `fromTurn` on revisions, validated against the version store
   *     with errors that list the valid turns.
   *   prompt: the versioned.md fragment replaces recall.md's layout section.
   * Off by default — byte-parity with legacy when off.
   */
  versionedMode: boolean;
  /** Versioned mode: render the Latest-versions pointer table (default true).
   *  Exposed for the A/B measuring what dropping it costs. */
  versionedHeads: boolean;
  /** SESSION LAYOUT (non-versioned multi-turn): group the context by turn —
   *  `# Session` with one `## Turn N` entry per turn (### Task, ### Steps in
   *  DELTA / ### Dataflow in LATEST, ### Final Answer), closed by a
   *  `# Your Task` directive pointing at the current turn. The ReAct render
   *  knobs apply unchanged inside each turn. Purely a re-grouping of the same
   *  information the flat event log carries — the fair baseline layout for
   *  comparisons against versionedMode. Ignored when versionedMode is on
   *  (the catalog is already turn-grouped). Off by default — byte-parity
   *  with the legacy flat layout when off. */
  sessionTurns: boolean;
  /**
   * QUESTION-ONLY LAYOUT: past turns render as their `### Task` (question)
   * text only — no steps, no dataflow, no answers. The agent solves every
   * turn from scratch against the raw sources; the question history exists
   * solely so cross-turn references stay resolvable. The stripped extreme of
   * the layout spectrum (question-only ← versioned catalog ← full session).
   * Takes precedence over sessionTurns (so a session-lineage arm can layer it
   * on); superseded by versionedMode. Prompt-affecting: the context-format
   * fragment switches to question-only.md.
   */
  questionOnlyTurns: boolean;
  /** Sample records per finished catalog entry (versioned mode): the given
   *  FRACTION (0..1) of the version's in-memory rows, split first-half/last-
   *  half like the ReAct result render, TSV, cell-clipped, whole block
   *  char-capped. 0 = off (byte-identical render). A version's rows are
   *  immutable, so entries stay byte-stable and cache-aligned. */
  catalogSampleRowsRatio: number;
  /** GRADUAL CATALOG: entries within the last K finished turns render full
   *  payload (thin stats + sample rows); older entries keep task, answer,
   *  summary, provenance, result shape and code. K>0 also drops the schema
   *  tail, numeric top_10 and Lineage lines everywhere. 0 = off. */
  catalogFreshTurns: number;
  /** LEAN latest-dataflow catalog (v40): finished entries carry only
   *  Task / Solution / Answer; workflow state renders once as the
   *  `# Dataflow (latest)` heads table; recallState resolves "opId (turn N)"
   *  as-of; the answer tool asks for `decisions`. Requires versionedMode. */
  catalogLatestDataflow: boolean;
  /** Terminal `answer` tool: the turn ends when the model calls answer(answer,
   *  conventions). Conventions are pinned, never aging, into the turn's
   *  catalog entry — the distilled interpretive commitments a session arm
   *  carries implicitly in its own transcript. Off by default. */
  enableAnswerTool: boolean;
  /**
   * Whether the step log drops each observation's result body, keeping only its
   * `- operator X updated` verb line. True (default) relies on the dataflow
   * render above being the authoritative state. Exposed because it is the leading
   * suspect for the accuracy gap against the flat prototype: with it on, the last
   * thing the model reads before answering is content-free verb lines.
   */
  indexThinObservations: boolean;
  /**
   * CACHE-ALIGNED CONTEXT: render the context ONCE per driver run (step 1) and
   * let the SDK's native message accumulation carry steps 2..N — assistant
   * tool-call messages and tool-result messages appended, earlier messages
   * byte-untouched.
   *
   * Exists because of a measured provider behavior: prompt caching engages
   * ONLY when a request extends a previously-sent request with appended
   * MESSAGES (probed: identical request → full cache hit; one char changed or
   * text appended inside a message → 0; append-only message array → everything
   * but the tail cached). The legacy path re-renders the whole context into a
   * fresh single user message every step, which is the one shape that can
   * never hit — measured cached-input stuck at ~5-7k tokens/step (the system
   * prompt + tools) across 411-turn campaigns on both layouts.
   *
   * Within a turn the tool outputs ARE the observation renders, so DELTA-shaped
   * layouts lose nothing; per-step curation (thought replay windows, in-turn
   * re-rendering) simply applies at turn boundaries instead. LATEST mode needs
   * its per-step snapshot rebuild, so the flag is ignored there (logged once).
   * Off by default — byte-parity with legacy when off.
   */
  cacheAlignedContext: boolean;
  /**
   * Per-operator detail of each finished `# Catalog` entry (versioned mode
   * only): "ids" (id + verb), "brief" (+ summary, upstream provenance, shape
   * and size), "schema" (+ column inventory — the historical render, default),
   * "code" (+ the version's code, once, in the entry that created it).
   *
   * "code" exists because the measured first-error class of the versioned
   * layout is convention re-derivation: a later turn rebuilds an inherited
   * metric's formula/filter/rounding from the operator's NAME, while session
   * arms read the defining code inline from their step history. Entries are
   * byte-stable, so under cacheAlignedContext the extra tokens are mostly
   * cached-priced.
   */
  catalogDetail: "ids" | "brief" | "schema" | "code" | "values";
  /**
   * Prompt rule: literals that must match data values (mapping dicts,
   * category filters, join keys) are copied from the actual values via one
   * queryResult call, never typed from memory. Trace-grounded (kaggle t23
   * salary-band dict, two independent reps). Only rendered when the
   * queryResult tool is enabled — the rule's check must be followable.
   */
  valueProbeRule: boolean;
  /**
   * Per-turn ceiling on `queryResult` calls. The model spends whatever ceiling
   * it is given — measured over four 5-task reps, the 31% of probing turns
   * that went past five calls issued 40% of all probes, mostly row-browsing —
   * and each probe costs a STEP, i.e. a whole re-send of the frozen context.
   * Lowering this trims that tail without removing the tool.
   */
  queryCallsPerTurn: number;
  /**
   * Expose the `compactContext` tool (agent-triggered compaction POC). When the
   * agent calls it, the DELTA assembler folds the trajectory up to that mark into
   * a compact snapshot deck + raw suffix. Requires contextMode DELTA (no-op in
   * LATEST — nothing to fold). Off by default. See docs/agent-triggered-compaction-plan.md.
   */
  enableCompactTool: boolean;
  /**
   * Static fold parameter (POC): how many of the most recent agent events to keep
   * raw BEFORE the compaction mark (in addition to everything after it). 0 ⇒ fold
   * everything through the mark. A constant, not model-chosen.
   */
  compactKeepLastSteps: number;
  /**
   * Static compaction rule (DELTA-only). When true, the assembler automatically
   * folds settled older events into the compact deck once the trajectory grows
   * past a static trigger, keeping the last K steps raw — a deterministic
   * demonstration that compaction pays off, with no agent involvement.
   */
  staticCompaction: boolean;
  /**
   * When set, an LLM "teacher" (context tuner) is consulted each step: it reads
   * a cheap pipeline manifest and returns per-operator context detail levels
   * (context/tuner). Overrides the selector/contextMode paths. The value names
   * the teacher model + render sizes. Undefined ⇒ tuner off. See
   * docs/selector-architecture.md.
   */
  tunerConfig?: TunerConfig;
}

export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  disabledTools: new Set(),
  maxOperatorResultCharLimit: 2000,
  maxOperatorResultCellCharLimit: 2000,
  operatorResultSerializationMode: OperatorResultSerializationMode.TSV,
  toolTimeoutMs: 240000,
  executionTimeoutMs: 240000,
  maxSteps: 100,
  maxOperatorEdits: 0,
  allowedOperatorTypes: [
    "CSVFileScan",
    "Filter",
    "Projection",
    "TypeCasting",
    "Sort",
    "Limit",
    "Distinct",
    "Union",
    "KeywordSearch",
    "HashJoin",
    "Aggregate",
    "LineChart",
    "BarChart",
    "PieChart",
    "Histogram",
    "Scatterplot",
    "WordCloud",
    "PythonUDFV2",
  ],
  agentMode: AgentMode.CODE,
  // DELTA + the observation channel below is the campaign-measured configuration
  // (see AGENTS.md "Default agent configuration"): the trajectory is replayed
  // per event, and every materialized result carries its schema, structural
  // profile and per-column statistics. The bare LATEST/level-0 defaults this
  // replaces rendered a snapshot with no value evidence, which is the failure
  // mode every context experiment traced back to.
  contextMode: ContextMode.DELTA,
  parallelToolCalls: false,
  includeOperatorProperties: true,
  attemptReflection: false,
  thoughtReplay: true,
  thoughtReplayK: 10,
  agentTurns: false,
  contextWindowTokens: 0,
  compactionStrategy: "compress",
  deckSampleRatio: 0.1,
  errorReflection: false,
  errorReflectionThreshold: 3,
  fewShotPrompt: false,
  maxResultRows: 0,
  // flow 1 = loader remediation + the "Operators needing attention" section;
  // data 2 = typed schema line + structural profile (grain/key candidates,
  // duplicates, empty rows/cols); columnStats layers per-column statistics
  // (nulls, min/max/mean, distinct/top-N) onto every non-error result.
  flowLevel: 1,
  dataLevel: 2,
  columnStats: true,
  valueFormat: false,
  dataHints: false,
  toolDialect: "qwen-xml",
  enableInspectTool: false,
  enableRenderPrefs: false,
  enableCodeInSnapshot: true,
  sourceProvenanceHint: false,
  enableCompactTool: false,
  compactKeepLastSteps: 0,
  staticCompaction: false,
  userTaskPlacement: "top",
  turnHistory: "full",
  enableRecallTool: false,
  recallMaxResultChars: 5000,
  recallOperatorLevel: false,
  foundationVerify: false,
  upstreamValueEcho: false,
  answerShapeRule: false,
  enableQueryTool: false,
  specAudit: false,
  indexRichTables: 12,
  // 0 = no cap. The count cap is off while the version-tree model is being
  // evaluated: resumeFrom bounds the DAG by choosing an earlier base, and the
  // two mechanisms need measuring apart before they are stacked.
  indexDetailedOperators: 0,
  enableResumeTool: false,
  enableAnswerGrounding: false,
  coercionTelemetry: false,
  rowLineage: false,
  versionedMode: false,
  // Default OFF: the A/B measured wrong-reference errors at 0.8%/write with
  // and without the table — it is derivable from the entries and buys nothing
  // at this scale. Kept as a flag for much longer sessions.
  versionedHeads: false,
  sessionTurns: false,
  questionOnlyTurns: false,
  catalogSampleRowsRatio: 0,
  catalogFreshTurns: 0,
  catalogLatestDataflow: false,
  enableAnswerTool: false,
  indexThinObservations: false,
  cacheAlignedContext: false,
  catalogDetail: "schema",
  valueProbeRule: false,
  queryCallsPerTurn: 15,
};

/**
 * Selects how the agent talks to the LLM:
 *  - "vercel-tool-use" — the Vercel AI SDK drives the loop with native
 *    tool-calling frames (default; what every Anthropic / OpenAI-compatible
 *    model uses today).
 *  - "local-react" — text-mode driver for the in-house local LLM served via
 *    the dknet gateway. Tool descriptions live in the model's training prompt,
 *    not on the wire; the model emits tool calls as text that the driver
 *    parses. The exact wire syntax is the `toolDialect` setting (`qwen-xml`
 *    XML tool calls or `react-text` Thought/Action/Action Input) — see
 *    `LocalToolDialect`.
 *
 * Bound at agent construction (the driver and context-renderer pair travel
 * together) and not mutable via UpdateAgentSettings. (The `toolDialect`
 * sub-mode, by contrast, IS mutable.)
 */
export type AgentDriverKind = "vercel-tool-use" | "local-react";

/**
 * Tool-call dialect for the `local-react` text-mode driver — the wire syntax
 * the local LLM uses for tool calls. Unlike `AgentDriverKind` (which picks the
 * driver class / wire mechanics), this is a sub-mode WITHIN that driver: same
 * loop, no `tools` param. It swaps the three things that must agree for a
 * format — the system prompt, the output parser, and the context assembler:
 *
 *  - "qwen-xml"    — Qwen3-Coder XML: `<tool_call><function=…><parameter=…>…
 *    </function></tool_call>`. Prompt = CODE-mode body (`code-mode.md`) +
 *    `local-qwen-tools.txt`; parser `parseQwenToolCall`; context the SDK
 *    `assembleContext` (`# User Task` / `# Current Dataflow`). Default.
 *  - "react-text"  — DeepSeek-style ReAct text: `Thought:` / `Action:` /
 *    `Action Input:` (Python-dict payloads). Prompt `prompts/local-react.txt`;
 *    parser `parseReActText`; context `assembleLocalReactContext` (`# Event N`).
 *
 * A per-agent setting (default `qwen-xml`); changing it rebuilds the system
 * prompt and switches the parser + assembler on the next turn.
 */
export type LocalToolDialect = "qwen-xml" | "react-text";

export interface UserInfo {
  uid: number;
  name: string;
  email: string;
  role: string;
}

export interface AgentDelegateConfig {
  userToken: string;
  userInfo?: UserInfo;
  workflowId?: number;
  workflowName?: string;
  computingUnitId?: number;
}

export interface AgentSettingsApi {
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  maxOperatorEdits?: number;
  allowedOperatorTypes?: string[];
  agentMode?: "code" | "general";
  contextMode?: "delta" | "latest";
  parallelToolCalls?: boolean;
  includeOperatorProperties?: boolean;
  attemptReflection?: boolean;
  thoughtReplay?: boolean;
  thoughtReplayK?: number;
  agentTurns?: boolean;
  contextWindowTokens?: number;
  compactionStrategy?: CompactionStrategy;
  deckSampleRatio?: number;
  errorReflection?: boolean;
  errorReflectionThreshold?: number;
  fewShotPrompt?: boolean;
  maxResultRows?: number;
  flowLevel?: number;
  dataLevel?: number;
  columnStats?: boolean;
  valueFormat?: boolean;
  dataHints?: boolean;
  toolDialect?: LocalToolDialect;
  /** Deep-partial summarize-params patch (see AgentSettings.summarizeParams). */
  summarizeParams?: SummarizeParamsPatch;
  /** Trainable selector action vector (see AgentSettings.selectorConfig). */
  selectorConfig?: SelectorConfig;
  /** Settled-result decay overlay (see AgentSettings.frontierDecayConfig). */
  frontierDecayConfig?: FrontierDecayConfig;
  /** Fold resolved revisions (see AgentSettings.foldResolvedRevisionsConfig). */
  foldResolvedRevisionsConfig?: FoldResolvedRevisionsConfig;
  /** Probe retirement overlay (see AgentSettings.probeRetirementConfig). */
  probeRetirementConfig?: ProbeRetirementConfig;
  /** Role policy overlay (see AgentSettings.rolePolicyConfig). */
  rolePolicyConfig?: RolePolicyConfig;
  /** Learned utility-model selector config (see AgentSettings.learnedConfig). */
  learnedConfig?: LearnedConfig;
  /** Expose the read-only inspectResult pull tool (see AgentSettings.enableInspectTool). */
  enableInspectTool?: boolean;
  /** Write-time render prefs on createOrModifyOperator (see AgentSettings.enableRenderPrefs). */
  enableRenderPrefs?: boolean;
  /** Show operator code in the LATEST snapshot + short-summary tool/prompt (see AgentSettings.enableCodeInSnapshot). */
  enableCodeInSnapshot?: boolean;
  /** Append the multi-file provenance principle to the code-mode prompt (see AgentSettings.sourceProvenanceHint). */
  sourceProvenanceHint?: boolean;
  /** Expose the compactContext tool (see AgentSettings.enableCompactTool). */
  enableCompactTool?: boolean;
  /** Static fold param: raw events kept before the mark (see AgentSettings.compactKeepLastSteps). */
  compactKeepLastSteps?: number;
  /** Static compaction rule, DELTA-only (see AgentSettings.staticCompaction). */
  staticCompaction?: boolean;
  /** LLM context-tuner config (see AgentSettings.tunerConfig). */
  tunerConfig?: TunerConfig;
  /** Where the `# User Task` block goes (see AgentSettings.userTaskPlacement). */
  userTaskPlacement?: "top" | "bottom";
  /** Prior-turn rendering: verbatim vs compact catalogue (see AgentSettings.turnHistory). */
  turnHistory?: "full" | "index";
  /** Expose the read-only recallState tool (see AgentSettings.enableRecallTool). */
  enableRecallTool?: boolean;
  /** Service-side clamp on a recall pull's result chars (see AgentSettings.recallMaxResultChars). */
  recallMaxResultChars?: number;
  /** Upstream operators allowed to render sample rows (see AgentSettings.indexRichTables). */
  indexRichTables?: number;
  /** Operators keeping a full index entry (see AgentSettings.indexDetailedOperators). */
  indexDetailedOperators?: number;
  /** Turn-grouped session layout (see AgentSettings.sessionTurns). */
  sessionTurns?: boolean;
  /** Question-only layout (see AgentSettings.questionOnlyTurns). */
  questionOnlyTurns?: boolean;
  /** Sample rows per finished catalog entry (see AgentSettings.catalogSampleRowsRatio). */
  catalogSampleRowsRatio?: number;
  /** Gradual catalog window (see AgentSettings.catalogFreshTurns). */
  catalogFreshTurns?: number;
  /** Lean latest-dataflow catalog (see AgentSettings.catalogLatestDataflow). */
  catalogLatestDataflow?: boolean;
  /** Terminal answer tool (see AgentSettings.enableAnswerTool). */
  enableAnswerTool?: boolean;
  /** Render once per driver run, append natively after — the provider's
   *  cache-hit shape (see AgentSettings.cacheAlignedContext). */
  cacheAlignedContext?: boolean;
  /** Dual-derivation + named-denominator prompt discipline
   *  (see AgentSettings.foundationVerify). */
  foundationVerify?: boolean;
  /** Pandas queries over materialized results (see AgentSettings.enableQueryTool). */
  enableQueryTool?: boolean;
  /** Auto-attach unrecalled upstream values to writes (see AgentSettings.upstreamValueEcho). */
  upstreamValueEcho?: boolean;
  /** Mirror-source answer shape rule (see AgentSettings.answerShapeRule). */
  answerShapeRule?: boolean;
  /** Per-entry catalog detail, versioned mode (see AgentSettings.catalogDetail). */
  catalogDetail?: "ids" | "brief" | "schema" | "code" | "values";
  /** Copy value-matching literals from the data, checked via queryResult (see AgentSettings.valueProbeRule). */
  valueProbeRule?: boolean;
  /** Per-turn queryResult ceiling (see AgentSettings.queryCallsPerTurn). */
  queryCallsPerTurn?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  modelType: string;
  driver: AgentDriverKind;
  state: AgentState;
  createdAt: Date;
  delegate?: AgentDelegateConfig;
  settings?: AgentSettingsApi;
}

export interface CreateAgentRequest {
  modelType: string;
  name?: string;
  workflowId?: number;
  computingUnitId?: number;
  settings?: AgentSettingsApi;
  /** Optional explicit driver. When omitted, the server derives the driver
   *  from `modelType` (`local-llm` → `local-react`, everything else →
   *  `vercel-tool-use`). */
  driver?: AgentDriverKind;
}

export interface UpdateAgentSettingsRequest {
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  maxOperatorEdits?: number;
  allowedOperatorTypes?: string[];
  agentMode?: "code" | "general";
  contextMode?: "delta" | "latest";
  parallelToolCalls?: boolean;
  includeOperatorProperties?: boolean;
  attemptReflection?: boolean;
  thoughtReplay?: boolean;
  thoughtReplayK?: number;
  agentTurns?: boolean;
  contextWindowTokens?: number;
  compactionStrategy?: CompactionStrategy;
  deckSampleRatio?: number;
  errorReflection?: boolean;
  errorReflectionThreshold?: number;
  fewShotPrompt?: boolean;
  maxResultRows?: number;
  flowLevel?: number;
  dataLevel?: number;
  columnStats?: boolean;
  valueFormat?: boolean;
  dataHints?: boolean;
  toolDialect?: LocalToolDialect;
  /** Deep-partial summarize-params patch (see AgentSettings.summarizeParams). */
  summarizeParams?: SummarizeParamsPatch;
  /** Trainable selector action vector (see AgentSettings.selectorConfig). */
  selectorConfig?: SelectorConfig;
  /** Settled-result decay overlay (see AgentSettings.frontierDecayConfig). */
  frontierDecayConfig?: FrontierDecayConfig | null;
  /** Fold resolved revisions (see AgentSettings.foldResolvedRevisionsConfig). */
  foldResolvedRevisionsConfig?: FoldResolvedRevisionsConfig | null;
  /** Probe retirement overlay (see AgentSettings.probeRetirementConfig). */
  probeRetirementConfig?: ProbeRetirementConfig | null;
  /** Role policy overlay (see AgentSettings.rolePolicyConfig). */
  rolePolicyConfig?: RolePolicyConfig | null;
  /** Learned utility-model selector config (see AgentSettings.learnedConfig). */
  learnedConfig?: LearnedConfig;
  /** Expose the read-only inspectResult pull tool (see AgentSettings.enableInspectTool). */
  enableInspectTool?: boolean;
  /** Write-time render prefs on createOrModifyOperator (see AgentSettings.enableRenderPrefs). */
  enableRenderPrefs?: boolean;
  /** Show operator code in the LATEST snapshot + short-summary tool/prompt (see AgentSettings.enableCodeInSnapshot). */
  enableCodeInSnapshot?: boolean;
  /** Expose the compactContext tool (see AgentSettings.enableCompactTool). */
  enableCompactTool?: boolean;
  /** Static fold param: raw events kept before the mark (see AgentSettings.compactKeepLastSteps). */
  compactKeepLastSteps?: number;
  /** Static compaction rule, DELTA-only (see AgentSettings.staticCompaction). */
  staticCompaction?: boolean;
  /** LLM context-tuner config (see AgentSettings.tunerConfig). */
  tunerConfig?: TunerConfig;
  /** Render once per driver run, append natively after (see AgentSettings.cacheAlignedContext). */
  cacheAlignedContext?: boolean;
  /** Dual-derivation + named-denominator prompt discipline (see AgentSettings.foundationVerify). */
  foundationVerify?: boolean;
  /** Pandas queries over materialized results (see AgentSettings.enableQueryTool). */
  enableQueryTool?: boolean;
  /** Auto-attach unrecalled upstream values to writes (see AgentSettings.upstreamValueEcho). */
  upstreamValueEcho?: boolean;
  /** Mirror-source answer shape rule (see AgentSettings.answerShapeRule). */
  answerShapeRule?: boolean;
  /** Per-entry catalog detail, versioned mode (see AgentSettings.catalogDetail). */
  catalogDetail?: "ids" | "brief" | "schema" | "code" | "values";
  /** Copy value-matching literals from the data, checked via queryResult (see AgentSettings.valueProbeRule). */
  valueProbeRule?: boolean;
  /** Per-turn queryResult ceiling (see AgentSettings.queryCallsPerTurn). */
  queryCallsPerTurn?: number;
  /** Question-only layout (see AgentSettings.questionOnlyTurns). */
  questionOnlyTurns?: boolean;
  /** Sample rows per finished catalog entry (see AgentSettings.catalogSampleRowsRatio). */
  catalogSampleRowsRatio?: number;
  /** Gradual catalog window (see AgentSettings.catalogFreshTurns). */
  catalogFreshTurns?: number;
  /** Lean latest-dataflow catalog (see AgentSettings.catalogLatestDataflow). */
  catalogLatestDataflow?: boolean;
  /** Terminal answer tool (see AgentSettings.enableAnswerTool). */
  enableAnswerTool?: boolean;
}
