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
  cachedInputTokens?: number;
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
 * Snapshot-selection policy for serializing the ReAct context (paper §5).
 * Each mode trades fidelity for token cost.
 *
 * - FULL — every snapshot on the path rendered in full; events and snapshots
 *   are interleaved. Highest cost, highest fidelity.
 * - DELTA — every snapshot on the path interleaved with its event, but only
 *   the operators changed by that step's actions are rendered in full; the
 *   rest are id+description placeholders. Cost scales with distinct edits.
 * - LATEST — events without per-turn snapshots, plus one trailing block
 *   containing only the current snapshot. Cheapest; loses trajectory.
 */
export enum ContextMode {
  FULL = "full",
  DELTA = "delta",
  LATEST = "latest",
}

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
   * When true, each non-error operator result that the backend annotated
   * with `columnStats` is followed by a `Column stats:` section in
   * the assembled context (one line per column: `name: stat1; stat2; ...`).
   * Helps the model reason about column semantics (numeric vs categorical,
   * cardinality, null counts) without re-issuing inspection operators.
   * Enabled by default — the type+summary line per column carries enough
   * signal to noticeably shift the model's decisions on the next turn at
   * relatively low token cost.
   */
  statsEnabled: boolean;
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
   * When true, each non-error operator result is preceded by a compact
   * `Schema:` line — `col (type), col (type), …` for every output column,
   * derived from the engine's `columnStats` (type tag) or, failing that, the
   * result-row headers (names only). Unlike the verbose `Column stats:` block
   * it lists ALL columns (it's compact enough not to truncate) and carries only
   * name+type, not value distributions. Intended as a cheaper substitute for
   * full stats in CODE mode (schema-first, lever E): explicit column+type
   * inventory so a downstream `def process(upstream)` writes against real
   * columns. Disabled by default (no-op).
   */
  schemaInResult: boolean;
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
  loaderHint: boolean;
  /**
   * Global loader-proliferation budget (goal.md lever F / generalizes C). The
   * maximum number of distinct `DataLoading` operator ids that may read the
   * SAME source path before a NEW loader for that path is rejected (the agent
   * is told to reuse the existing loader). Targets the dominant cost driver
   * plan1's per-op cap missed: re-loading one file under many fresh ids
   * (baseline: 22 redundant loaders on one task), which a per-operator cap
   * cannot see. Source path is parsed from the load() `code`. `0` disables the
   * budget entirely (default — baseline reproduces). The rejected create
   * returns an `[ERROR]` and mutates nothing, so it adds no execution/context
   * cost. Robust to the new-id evasion.
   */
  maxLoadersPerSource: number;
  /**
   * When true, each non-error operator result gets a `Format hints:` line
   * flagging string columns whose sample values look like currency `$1,234`,
   * percent, thousands-separated, parenthesized-negatives, or leading-zero
   * codes — with the cleaning to apply BEFORE numeric conversion. Targets the
   * silent `to_numeric(errors='coerce')` dataloss accuracy killer. Keyed only
   * on value shape (no task literals). Disabled by default (no-op).
   */
  valueFormatFlags: boolean;
  /**
   * When true, each operator result carries a `Lineage:` line — input→output
   * row counts (kept % of largest input) plus a conservative alarm on
   * empty-output / fan-out-explosion transitions. Derived from row counts
   * already carried in OperatorInfo (topology-level, no column/task literal).
   * Targets the dominant silent-cardinality wrong-answer and the cost spiral
   * tail. Disabled by default (no-op).
   */
  lineageStats: boolean;
  /**
   * When true, a degenerate merge (near-zero key match, with an unmatched-key
   * sample, or a many-to-many fan-out) flagged by the worker's transparent join
   * instrumentation surfaces as a `Join check ⚠` line. Alarm-only; off by default.
   */
  joinTelemetry: boolean;
  /**
   * When true, a DataLoading operator whose output reaches no downstream
   * operator (a dead/forgotten load — typed-DAG reachability) gets a
   * `Graph check ⚠` line. Off by default.
   */
  graphAudit: boolean;
  /**
   * When true, a `to_numeric/to_datetime(errors="coerce")` that silently nulled
   * a material block of values surfaces as a coercion-dataloss line (with a
   * sample of the dropped values). Off by default.
   */
  coercionTelemetry: boolean;
  compactStats: boolean;
  lineageTimeline: boolean;
  fewShotPrompt: boolean;
  tableStructureHint: boolean;
  loaderEscalation: boolean;
  maxResultRows: number;
  frontierDepth: number;
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
  statsEnabled: true,
  includeOperatorProperties: true,
  schemaInResult: false,
  attemptReflection: false,
  loaderHint: false,
  maxLoadersPerSource: 0,
  valueFormatFlags: false,
  lineageStats: false,
  joinTelemetry: false,
  graphAudit: false,
  coercionTelemetry: false,
  compactStats: false,
  lineageTimeline: false,
  fewShotPrompt: false,
  tableStructureHint: false,
  loaderEscalation: false,
  maxResultRows: 0,
  frontierDepth: 0,
};

/**
 * Selects how the agent talks to the LLM:
 *  - "vercel-tool-use" — the Vercel AI SDK drives the loop with native
 *    tool-calling frames (default; what every Anthropic / OpenAI-compatible
 *    model uses today).
 *  - "local-react" — text-mode ReAct. The model emits `Thought:` /
 *    `Action:` / `Action Input:` blocks; tool descriptions live in the
 *    model's training, not on the wire. Used for the in-house local LLM
 *    served via the dknet gateway.
 *
 * Bound at agent construction (the driver and context-renderer pair travel
 * together) and not mutable via UpdateAgentSettings.
 */
export type AgentDriverKind = "vercel-tool-use" | "local-react";

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
  contextMode?: "full" | "delta" | "latest";
  parallelToolCalls?: boolean;
  statsEnabled?: boolean;
  includeOperatorProperties?: boolean;
  schemaInResult?: boolean;
  attemptReflection?: boolean;
  loaderHint?: boolean;
  maxLoadersPerSource?: number;
  valueFormatFlags?: boolean;
  lineageStats?: boolean;
  joinTelemetry?: boolean;
  graphAudit?: boolean;
  coercionTelemetry?: boolean;
  compactStats?: boolean;
  lineageTimeline?: boolean;
  fewShotPrompt?: boolean;
  tableStructureHint?: boolean;
  loaderEscalation?: boolean;
  maxResultRows?: number;
  frontierDepth?: number;
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
  userToken?: string;
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
  contextMode?: "full" | "delta" | "latest";
  parallelToolCalls?: boolean;
  statsEnabled?: boolean;
  includeOperatorProperties?: boolean;
  schemaInResult?: boolean;
  attemptReflection?: boolean;
  loaderHint?: boolean;
  maxLoadersPerSource?: number;
  valueFormatFlags?: boolean;
  lineageStats?: boolean;
  joinTelemetry?: boolean;
  graphAudit?: boolean;
  coercionTelemetry?: boolean;
  compactStats?: boolean;
  lineageTimeline?: boolean;
  fewShotPrompt?: boolean;
  tableStructureHint?: boolean;
  loaderEscalation?: boolean;
  maxResultRows?: number;
  frontierDepth?: number;
}
