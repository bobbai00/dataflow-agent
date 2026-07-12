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
   * When true, each operator result carries a `Lineage:` line — input→output
   * row counts (kept % of largest input) plus a conservative alarm on
   * empty-output / fan-out-explosion transitions. Derived from row counts
   * already carried in OperatorInfo (topology-level, no column/task literal).
   * Targets the dominant silent-cardinality wrong-answer and the cost spiral
   * tail. Disabled by default (no-op).
   */
  /**
   * When true, a degenerate merge (near-zero key match, with an unmatched-key
   * sample, or a many-to-many fan-out) flagged by the worker's transparent join
   * instrumentation surfaces as a `Join check ⚠` line. Alarm-only; off by default.
   */
  /**
   * When true, a DataLoading operator whose output reaches no downstream
   * operator (a dead/forgotten load — typed-DAG reachability) gets a
   * `Graph check ⚠` line. Off by default.
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
  contextMode: ContextMode.LATEST,
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
  flowLevel: 0,
  dataLevel: 0,
  columnStats: false,
  valueFormat: false,
  dataHints: false,
  toolDialect: "qwen-xml",
  enableInspectTool: false,
  enableRenderPrefs: false,
  enableCompactTool: false,
  compactKeepLastSteps: 0,
  staticCompaction: false,
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
  /** Learned utility-model selector config (see AgentSettings.learnedConfig). */
  learnedConfig?: LearnedConfig;
  /** Expose the read-only inspectResult pull tool (see AgentSettings.enableInspectTool). */
  enableInspectTool?: boolean;
  /** Write-time render prefs on createOrModifyOperator (see AgentSettings.enableRenderPrefs). */
  enableRenderPrefs?: boolean;
  /** Expose the compactContext tool (see AgentSettings.enableCompactTool). */
  enableCompactTool?: boolean;
  /** Static fold param: raw events kept before the mark (see AgentSettings.compactKeepLastSteps). */
  compactKeepLastSteps?: number;
  /** Static compaction rule, DELTA-only (see AgentSettings.staticCompaction). */
  staticCompaction?: boolean;
  /** LLM context-tuner config (see AgentSettings.tunerConfig). */
  tunerConfig?: TunerConfig;
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
  /** Learned utility-model selector config (see AgentSettings.learnedConfig). */
  learnedConfig?: LearnedConfig;
  /** Expose the read-only inspectResult pull tool (see AgentSettings.enableInspectTool). */
  enableInspectTool?: boolean;
  /** Write-time render prefs on createOrModifyOperator (see AgentSettings.enableRenderPrefs). */
  enableRenderPrefs?: boolean;
  /** Expose the compactContext tool (see AgentSettings.enableCompactTool). */
  enableCompactTool?: boolean;
  /** Static fold param: raw events kept before the mark (see AgentSettings.compactKeepLastSteps). */
  compactKeepLastSteps?: number;
  /** Static compaction rule, DELTA-only (see AgentSettings.staticCompaction). */
  staticCompaction?: boolean;
  /** LLM context-tuner config (see AgentSettings.tunerConfig). */
  tunerConfig?: TunerConfig;
}
