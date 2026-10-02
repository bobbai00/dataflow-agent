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
import type { ResponseDiagnostics } from "../agent/llm-drivers/response-diagnostics";

export type RetrievalView = "full" | "sample" | "sample_stats";

export interface RetrievalSettings {
  /** Available native Retrieve views. Omitted: full/sample, plus sample_stats when dataEvidence is enabled. */
  retrievalViews?: RetrievalView[];
  /** Record transport and full-view ceiling (engine maximum: 100,000 characters). */
  fullResultCharLimit?: number;
  /** Separate per-retrieval evidence ceilings; records keep their own budget. */
  dataEvidenceCharLimit?: number;
  flowEvidenceCharLimit?: number;
}

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

/**
 * Which operators one tool call touched. Keyed by tool-call index on the
 * owning step (`operatorAccess[i]` describes `toolCalls[i]`). The frontend
 * uses it to highlight operators on the canvas when a step is hovered and to
 * answer "which steps touched operator X".
 */
export interface ToolOperatorAccess {
  viewedOperatorIds: string[];
  addedOperatorIds: string[];
  modifiedOperatorIds: string[];
}

export interface ReActStep {
  id: string;
  parentId?: string;
  messageId: string;
  stepId: number;
  timestamp: number;
  role: "user" | "agent";
  content: string;
  /** Reasoning summary the provider returned for this step, when it exposes
   *  one (OpenAI reasoning models, Anthropic extended thinking). Kept out of
   *  `content` on purpose: `content` is replayed to the model as context,
   *  this is display-only — the chat's step list falls back to it when the
   *  model emitted tool calls with no visible text. */
  reasoningText?: string;
  /** Bounded provider/parsed argument provenance, excluded from model context. */
  responseDiagnostics?: ResponseDiagnostics;
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
  /** Per-tool-call operator access, derived from tool inputs/outputs at
   *  step-record time (see `computeOperatorAccess`). Absent on steps with
   *  no tool calls. */
  operatorAccess?: Record<number, ToolOperatorAccess>;
  /** Set on steps the service performed itself, with no model request behind
   *  them. `"seed"`: the seeded source roots recorded before the first model
   *  call of a turn (see `seedSources`). Usage is zero by construction. */
  synthetic?: "seed";
}

export enum OperatorResultSerializationMode {
  TSV = "tsv",
}

/**
 * Agent operating mode.
 *  - NATIVE (default): the model writes a program of `name = operator(...)`
 *    expressions over the fixed operator catalog (`native/catalog.ts`), with
 *    three custom operators that carry Python (filter, map, process). The
 *    service compiles every operator to Python for the engine.
 *  - CODE: the previous script-based approach — every operator is one free
 *    Python `def load()` / `def process(...)` function written through
 *    `createOrModifyOperator`.
 */
export enum AgentMode {
  CODE = "code",
  NATIVE = "native",
}

/**
 * Which operator results the LATEST snapshot ships, and at what fidelity.
 *  - "all":  every executed operator renders its full result block (legacy).
 *  - "rule": ship only what the data decided (native mode): full blocks for
 *            Scan/Aggregate/Join/UDF outputs, for the input of any
 *            Aggregate/Join/UDF, and for frontier operators; a row-count line
 *            for Filter/Distinct/Union/Limit; header only for Project/Sort and
 *            for Compute whose columns' null/distinct counts did not move.
 *  - "scoped": the rule, plus HOW MUCH of a shipped table: statistics and
 *            sample values only for the columns the operator's parameters (and
 *            its consumers') name, sample rows per type (scan 8, compute 3,
 *            filter 0, aggregate all up to 20), and — in DELTA — an
 *            upstream-caused re-execution as a one-line diff, not a table.
 */
export type ResultSelection = "all" | "rule" | "scoped";

/** Context layout and result sampling are independent of data/flow evidence. */
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

export interface AgentSettings extends RetrievalSettings {
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
  agentMode: AgentMode;
  /** Collect table profiles and operator counters in the engine, independently
   *  of model-facing exposure (`dataEvidence` / `flowEvidence`). Compiled into
   *  each operator, so it cannot change on an existing workflow. */
  nativeProfileCollection?: boolean;
  /** Which operator results the snapshot ships (see ResultSelection). */
  resultSelection: ResultSelection;
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
  /** Bounded, version-bound column/table facts on explicitly observed results. */
  dataEvidence: boolean;
  /** Version-matched input/output facts on explicitly observed results. */
  flowEvidence: boolean;
  /** Retained for archived configurations. Native action calls always require
   *  reasoning; native settings normalize this field to true. */
  dataflowReasoning: boolean;
  /** Native mode: `check:` lines under every executed operator whose own
   *  assumptions the engine found violated on the full tables (header rows,
   *  records repeated across sources, join fan-out, row effects inside a
   *  process function). Off by default. */
  nativeChecks: boolean;
  /**
   * Tool-call dialect for the local text-mode driver (`local-react`). Selects
   * the system prompt, the output parser, AND the context assembler so all
   * three agree (qwen-xml → CODE-mode prompt + SDK context; react-text →
   * `local-react.txt` + `# Event N` context). Ignored by the `vercel-tool-use`
   * driver (native tool calling). Default `qwen-xml`. See `LocalToolDialect`.
   */
  toolDialect: LocalToolDialect;
  /** Context layout and result sampling are independent of data/flow evidence. */
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
   * @deprecated Compatibility field; always false. The result-inspection tool
   * has been removed. Native batch mode retrieves results with `observe`.
   */
  enableInspectTool: boolean;
  /**
   * Write-time render prefs: `createOrModifyOperator` accepts optional
   * `outputSummary` ("minimal"|"standard")
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
   * SEEDED SOURCE ROOTS — when a message arrives with `sources`, scan every
   * listed file and observe it BEFORE the first model call, recorded as an
   * ordinary `dataflow` step with zero usage. A dataflow's roots are the one
   * part of the graph the model cannot decide differently, so materializing
   * them up front removes the scan-only opening step(s) every layout renders
   * anyway. Off by default — control arms keep a byte-identical protocol.
   */
  seedSources: boolean;
  /** Context layout and result sampling are independent of data/flow evidence. */
  /** Context layout and result sampling are independent of data/flow evidence. */
  messageLayout?: "block" | "blockSplit" | "native" | "opBlock" | "opSplit" | "turnSplit";
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
   * Whether the step log drops each observation's result body, keeping only its
   * `- operator X updated` verb line. True (default) relies on the dataflow
   * render above being the authoritative state. Exposed because it is the leading
   * suspect for the accuracy gap against the flat prototype: with it on, the last
   * thing the model reads before answering is content-free verb lines.
   */
  indexThinObservations: boolean;
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
  fullResultCharLimit: 100000,
  dataEvidenceCharLimit: 2000,
  flowEvidenceCharLimit: 2000,
  operatorResultSerializationMode: OperatorResultSerializationMode.TSV,
  toolTimeoutMs: 240000,
  executionTimeoutMs: 240000,
  maxSteps: 100,
  maxOperatorEdits: 0,
  agentMode: AgentMode.NATIVE,
  // Collected by default so evidence can be switched on without rebuilding
  // the workflow; exposure stays opt-in below.
  nativeProfileCollection: true,
  dataEvidence: false,
  flowEvidence: false,
  dataflowReasoning: true,
  nativeChecks: false,
  resultSelection: "all",
  // Replay event-owned observations; evidence exposure is explicitly opt-in.
  contextMode: ContextMode.DELTA,
  parallelToolCalls: true,
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
  specAudit: false,
  indexRichTables: 12,
  // 0 = no cap. The count cap is off while the version-tree model is being
  // evaluated: resumeFrom bounds the DAG by choosing an earlier base, and the
  // two mechanisms need measuring apart before they are stacked.
  indexDetailedOperators: 0,
  enableResumeTool: false,
  enableAnswerGrounding: false,
  seedSources: false,
  versionedMode: false,
  // Default OFF: the A/B measured wrong-reference errors at 0.8%/write with
  // and without the table — it is derivable from the entries and buys nothing
  // at this scale. Kept as a flag for much longer sessions.
  versionedHeads: false,
  sessionTurns: false,
  indexThinObservations: false,
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

export interface AgentSettingsApi extends RetrievalSettings {
  messageLayout?: AgentSettings["messageLayout"];
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  maxOperatorEdits?: number;
  agentMode?: "code" | "native";
  contextMode?: "delta" | "latest";
  nativeProfileCollection?: boolean;
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  dataflowReasoning?: boolean;
  nativeChecks?: boolean;
  parallelToolCalls?: boolean;
  includeOperatorProperties?: boolean;
  /** Native mode result selection: "all" (default), "rule" or "scoped". */
  resultSelection?: "all" | "rule" | "scoped";
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
  /** @deprecated Ignored; the result-inspection tool cannot be enabled. */
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

export interface UpdateAgentSettingsRequest extends RetrievalSettings {
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  maxOperatorEdits?: number;
  agentMode?: "code" | "native";
  contextMode?: "delta" | "latest";
  nativeProfileCollection?: boolean;
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  dataflowReasoning?: boolean;
  nativeChecks?: boolean;
  parallelToolCalls?: boolean;
  includeOperatorProperties?: boolean;
  /** Native mode result selection: "all" (default), "rule" or "scoped". */
  resultSelection?: "all" | "rule" | "scoped";
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
  /** @deprecated Ignored; the result-inspection tool cannot be enabled. */
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
}
