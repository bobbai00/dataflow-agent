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

import { DEFAULT_OBSERVATION_FORMAT, type ObservationFormatSettings } from "../agent/native/observation-format";

export type RetrievalView = "full" | "sample" | "sample_stats";

export interface RetrievalSettings {
  /** Available native Retrieve views. Omitted: sample_stats and full; sample can be enabled explicitly. */
  retrievalViews?: RetrievalView[];
  /** Full-view display ceiling (default 5,000). Native transport independently retains up to 100,000 characters. */
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

/** When an agent step was prepared and requested, and what each part of it took. */
export interface StepTiming {
  /** When the step's context began to be built. */
  preparedAt?: number;
  /** When the model request went out, once the context was built. */
  requestedAt?: number;
  /** Building the model's input. */
  contextMs?: number;
  /** The model request, to its full response. */
  modelMs?: number;
  /** Executing the step's actions and recording their results. */
  postStepMs?: number;
}

export interface ReActStep {
  id: string;
  parentId?: string;
  messageId: string;
  stepId: number;
  /** When the step was recorded (an agent step: when its model response arrived). */
  timestamp: number;
  role: "user" | "agent";
  content: string;
  /** Reasoning summary the provider returned for this step, when it exposes
   *  one (OpenAI reasoning models, Anthropic extended thinking). Kept out of
   *  `content` on purpose: `content` is replayed to the model as context,
   *  this is display-only — the chat's step list falls back to it when the
   *  model emitted tool calls with no visible text. */
  reasoningText?: string;
  isBegin: boolean;
  isEnd: boolean;
  /** Set on a last step that is not an answer: the turn failed, or the user stopped it. */
  endReason?: "error" | "stopped";
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
  /** An agent step's timings; the trace store keeps them with the step. */
  timing?: StepTiming;
  inputMessages?: any[];
  /** "action": the user edited or ran an operator on the canvas
   *  (`TexeraAgent.applyUserAction`); the step's `content` tells the model.
   *  "correction": the service's own note in a turn (a step budget, a
   *  repeated failure, a reply that computed nothing); the model reads it as
   *  feedback, and it is not the user's words. */
  messageSource?: "chat" | "feedback" | "action" | "correction";
  /** On a "correction" step: what the service noted. A step budget running
   *  out; the same failure repeating; a reply that computed nothing, was cut
   *  off at the output limit, or gave its answer as text instead of an answer
   *  statement. */
  correction?: "step-budget" | "repeated-failure" | "missing-action" | "cut-off" | "answer-statement";
  /** Per-tool-call operator access, derived from tool inputs/outputs at
   *  step-record time (see `computeOperatorAccess`). Absent on steps with
   *  no tool calls. */
  operatorAccess?: Record<number, ToolOperatorAccess>;
  /** Set on a user step recording a canvas action; display-only. */
  userAction?: UserActionInfo;
}

/** What a user did on the canvas, for the chat to show: edited or ran one
 * operator, or restored an earlier version of the dataflow. */
export interface UserActionInfo {
  kind: "edit" | "run" | "restore";
  /** The operator edited or run; for a restore, the one the restored version's edit changed. */
  operatorId?: string;
  /** The statement the user saved (edit). */
  statement?: string;
  /** The operator's statement before the edit. */
  previous?: string;
  /** An edit that also ran the operator. */
  run?: boolean;
  status: "running" | "ok" | "error";
  /** Rows of the operator's result, when it ran. */
  rows?: number;
  /** The dataflow version the edit made, or the version a restore brought back. */
  version?: number;
  error?: string;
}

export enum OperatorResultSerializationMode {
  TSV = "tsv",
}

/**
 * DELTA compaction strategy — how the assembler shrinks the trajectory once the
 * raw delta would exceed `contextWindowTokens`:
 *   - "sliding": evict the oldest whole agent events until it fits.
 *   - "compress": fold the oldest events into a stats deck, then resume raw
 *     delta for the fresh suffix (rolling compaction).
 */
export type CompactionStrategy = "sliding" | "compress";
export type MultiRequestMode = "off" | "transcript" | "catalog";
export type CatalogSource = "full" | "docstring";

export interface AgentSettings extends RetrievalSettings, ObservationFormatSettings {
  systemPrompt: string;
  disabledTools: Set<string>;
  maxOperatorResultCharLimit: number;
  operatorResultSerializationMode: OperatorResultSerializationMode;
  toolTimeoutMs: number;
  executionTimeoutMs: number;
  maxSteps: number;
  /** Collect table profiles and operator counters in the engine, independently
   *  of model-facing exposure (`dataEvidence` / `flowEvidence`). Compiled into
   *  each operator, so it cannot change on an existing workflow. */
  nativeProfileCollection?: boolean;
  /** With collection on: "prefix" profiles a bounded prefix of each result
   *  (row, cell and time budgets); "full" profiles every row exactly with
   *  vectorized passes. Compiled into each operator like collection. */
  nativeProfileScope?: "prefix" | "full";
  /** Whether the provider may emit several tool calls in one assistant turn.
   *  Native mode asks for one call per turn. */
  parallelToolCalls: boolean;
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
  maxResultRows: number;
  /** Bounded, version-bound column/table facts on explicitly observed results. */
  dataEvidence: boolean;
  /** Version-matched input/output facts on explicitly observed results. */
  flowEvidence: boolean;
  /** Native mode: every operator carries a one-line `doc` saying what it does
   *  and why. The prompt asks for it and its examples show it; an edit that
   *  sets an operator without one gets a reminder in the tool result. Off by default. */
  operatorDoc: boolean;
  /** When the user runs an operator from the canvas (Run, Save & run), the
   *  agent responds to the result in a turn of its own. On by default. */
  respondToCanvasRuns: boolean;
  /** Instructions for this session, appended to the system prompt: rules of
   *  engagement beyond the mode's prompt. Empty by default. */
  instructions: string;
  /** Native mode: the final answer is an `answer` statement, which renders
   *  named tables as the reply verbatim and ends the request. */
  answerStatement: boolean;
  /** Native mode: `check:` lines under every executed operator whose own
   *  assumptions the engine found violated on the full tables (records
   *  repeated across sources, row effects inside a process function). A
   *  scan's header findings are notes shown in every setting. Off by default. */
  nativeChecks: boolean;
  /**
   * Tool-call dialect for the local text-mode driver (`local-react`). Selects
   * the system prompt, the output parser, AND the context assembler so all
   * three agree (qwen-xml → `code-mode.md` prompt + SDK context; react-text →
   * `local-react.txt` + `# Event N` context). Ignored by the `vercel-tool-use`
   * driver (native tool calling). Default `qwen-xml`. See `LocalToolDialect`.
   */
  toolDialect: LocalToolDialect;
  /**
   * @deprecated Compatibility field; always false. The result-inspection tool
   * has been removed. Native batch mode retrieves results with `observe`.
   */
  enableInspectTool: boolean;
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
   * Sessions that answer several requests. "off" (default): one request, as
   * before. "transcript": a later request follows the whole earlier transcript.
   * "catalog": each earlier request appears as its request and one catalog
   * entry (`agent/request-catalog.ts`) in place of its calls. Both multi-request
   * values add the prompt's working-across-requests section, and their receipts
   * name each registered function's signature and note a column a Python step
   * left 0 or null in every row. Decided before the first request: the system
   * prompt depends on it, as on the two catalog settings below.
   */
  multiRequest: MultiRequestMode;
  /**
   * How a catalog entry shows the functions its request registered or changed.
   * "full" (default): signature, the docstring's first line, then the source.
   * "docstring": signature and docstring; the source only for a function with
   * no docstring, and `show function` reads any source on demand.
   */
  catalogSource: CatalogSource;
  /**
   * Earlier requests a catalog session keeps as their full transcript: the
   * most recent K to 2K-1. Older ones become entries K at a time, so the
   * cached prefix changes once every K requests rather than at every one.
   * 0 (default): every earlier request is an entry.
   */
  catalogRecent: number;
}

export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  ...DEFAULT_OBSERVATION_FORMAT,
  disabledTools: new Set(),
  maxOperatorResultCharLimit: 2000,
  fullResultCharLimit: 5000,
  retrievalViews: ["sample_stats", "full"],
  dataEvidenceCharLimit: 2000,
  flowEvidenceCharLimit: 2000,
  operatorResultSerializationMode: OperatorResultSerializationMode.TSV,
  toolTimeoutMs: 240000,
  executionTimeoutMs: 240000,
  maxSteps: 100,
  // Results are read through a sample with full-table column statistics by
  // default (the matrix of 2026-10-10: equal accuracy at lower cost than the
  // full view); flow evidence stays opt-in.
  nativeProfileCollection: true,
  nativeProfileScope: "full",
  dataEvidence: true,
  flowEvidence: false,
  operatorDoc: false,
  respondToCanvasRuns: true,
  instructions: "",
  answerStatement: false,
  nativeChecks: false,
  parallelToolCalls: true,
  contextWindowTokens: 0,
  compactionStrategy: "compress",
  deckSampleRatio: 0.1,
  // Sample rows per `show result`: three keep a pattern or both ends in view
  // at about half the tokens of five (2026-10-11 cost study).
  maxResultRows: 3,
  toolDialect: "qwen-xml",
  enableInspectTool: false,
  userTaskPlacement: "top",
  multiRequest: "off",
  catalogSource: "full",
  catalogRecent: 0,
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
 *    </function></tool_call>`. Prompt = `code-mode.md` +
 *    `local-qwen-tools.txt`; parser `parseQwenToolCall`; context the SDK
 *    `assembleContext` (`# Agent Events`). Default.
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

export interface AgentSettingsApi extends RetrievalSettings, Partial<ObservationFormatSettings> {
  maxOperatorResultCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  /** The only context: each event replayed with the operators it changed. */
  contextMode?: "delta";
  nativeProfileCollection?: boolean;
  nativeProfileScope?: "prefix" | "full";
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  operatorDoc?: boolean;
  respondToCanvasRuns?: boolean;
  instructions?: string;
  answerStatement?: boolean;
  nativeChecks?: boolean;
  parallelToolCalls?: boolean;
  contextWindowTokens?: number;
  compactionStrategy?: CompactionStrategy;
  deckSampleRatio?: number;
  maxResultRows?: number;
  toolDialect?: LocalToolDialect;
  /** @deprecated Ignored; the result-inspection tool cannot be enabled. */
  enableInspectTool?: boolean;
  /** Where the `# User Task` block goes (see AgentSettings.userTaskPlacement). */
  userTaskPlacement?: "top" | "bottom";
  /** Sessions with several requests (see AgentSettings.multiRequest). */
  multiRequest?: MultiRequestMode;
  /** Catalog entries' functions (see AgentSettings.catalogSource). */
  catalogSource?: CatalogSource;
  /** Recent requests kept as transcript (see AgentSettings.catalogRecent). */
  catalogRecent?: number;
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

export interface UpdateAgentSettingsRequest extends RetrievalSettings, Partial<ObservationFormatSettings> {
  maxOperatorResultCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  contextMode?: "delta";
  nativeProfileCollection?: boolean;
  nativeProfileScope?: "prefix" | "full";
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  operatorDoc?: boolean;
  respondToCanvasRuns?: boolean;
  instructions?: string;
  answerStatement?: boolean;
  nativeChecks?: boolean;
  parallelToolCalls?: boolean;
  contextWindowTokens?: number;
  compactionStrategy?: CompactionStrategy;
  deckSampleRatio?: number;
  maxResultRows?: number;
  toolDialect?: LocalToolDialect;
  /** @deprecated Ignored; the result-inspection tool cannot be enabled. */
  enableInspectTool?: boolean;
  /** Sessions with several requests (see AgentSettings.multiRequest). */
  multiRequest?: MultiRequestMode;
  /** Catalog entries' functions (see AgentSettings.catalogSource). */
  catalogSource?: CatalogSource;
  /** Recent requests kept as transcript (see AgentSettings.catalogRecent). */
  catalogRecent?: number;
}
