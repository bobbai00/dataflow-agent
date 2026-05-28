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

export enum OperatorResultRendering {
  ROWS = "rows",
  DIGEST = "digest",
  ADAPTIVE = "adaptive",
}

export enum OperatorContextScope {
  ALL = "all",
  ACTIVE_LINEAGE = "active-lineage",
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
  /**
   * Controls how successful operator results are rendered in assembled
   * context. `rows` preserves the legacy table preview; `digest` renders
   * shape/columns/stats without preview rows; `adaptive` keeps rows for the
   * latest frontier and digests stable operators.
   */
  resultRendering: OperatorResultRendering;
  /**
   * Controls which operators render in detail inside the current snapshot.
   * `all` preserves the legacy whole-DAG view; `active-lineage` keeps the
   * latest frontier and its upstream lineage detailed while compressing
   * unrelated branches to concise operator digests.
   */
  contextScope: OperatorContextScope;
  toolTimeoutMs: number;
  executionTimeoutMs: number;
  maxSteps: number;
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
   * Maximum consecutive accepted modifications to the same existing code
   * operator before the tool blocks another blind edit. 0 disables the guard.
   */
  maxOperatorEdits: number;
  /**
   * When the convergence guard blocks an edit, add a compact lineage/schema
   * hint to the next assembled context so LATEST mode still sees the stall
   * reason even though it omits event history.
   */
  lineageHintOnStall: boolean;
  /**
   * Maximum successful CODE-mode create/modify calls allowed after the last
   * explicit operator-result inspection before the tool blocks more code
   * edits and asks for `executeOperator`. 0 disables the guard. Off by
   * default for baseline reproducibility.
   */
  maxUnexecutedCodeEdits: number;
  /**
   * When true, append CODE-mode guidance that asks the agent to preserve
   * provenance keys through the DAG and make derived final metrics auditable
   * as ordinary output columns; the context assembler also repeats a compact
   * notice in LATEST mode. Off by default for baseline reproducibility.
   */
  metricEvidenceGuidance: boolean;
  /**
   * When true, render the compiler's current-snapshot input/output schema
   * lines in CODE mode too. GENERAL mode already renders schemas. Off by
   * default for baseline reproducibility.
   */
  schemaFirstCodeMode: boolean;
  /**
   * When true, append compact hints to suspicious DataLoading results whose
   * preview suggests metadata/header/footer rows are mixed into the table.
   * Off by default for baseline reproducibility.
   */
  tableStructureHints: boolean;
  /**
   * When true, append compact raw-source provenance for DataLoading operators
   * whose code reads literal relative file paths. Off by default for baseline
   * reproducibility.
   */
  rawLoaderProvenance: boolean;
  /**
   * When true, append CODE-mode guidance that asks the agent to validate
   * expensive row-wise, external-model, or broad-join operators on bounded
   * probes before scaling to full-table execution. Off by default for baseline
   * reproducibility.
   */
  boundedExecutionGuidance: boolean;
  /**
   * When true, render prompt/context hints when an operator's typed result
   * shape shows high-cardinality or wide intermediate data. The hint asks the
   * agent to reduce to the task-required row grain or add a bounded probe
   * before expensive downstream work. Off by default for baseline
   * reproducibility.
   */
  cardinalityPressureGuidance: boolean;
  /**
   * When true, render prompt/context hints for high-cardinality string columns
   * that may be used as entity keys in grouping, joining, deduplication, or
   * distinct counts. The hint asks the agent to create compact key-hygiene
   * evidence before finalizing on raw labels. Off by default for baseline
   * reproducibility.
   */
  entityKeyHygieneGuidance: boolean;
  /**
   * When true, render prompt/context hints for high-cardinality string labels
   * whose raw values may encode sub-entity components, measurement locations,
   * suffixes, prefixes, or other component grains. The hint asks the agent to
   * compare whole-label and component-derived keys before entity-level counts.
   * Off by default for baseline reproducibility.
   */
  componentGrainGuidance: boolean;
  /**
   * When true, render prompt/context hints for ambiguous entity-key grain in
   * high-cardinality string labels. The hint asks the agent to build a
   * candidate-key comparison table before finalizing entity-level grouping or
   * distinct counts. Off by default for baseline reproducibility.
   */
  keyGrainComparisonGuidance: boolean;
  /**
   * When true, LATEST context treats candidate key-grain comparison as an
   * explicit evidence contract. If ambiguous high-cardinality labels are
   * visible but no executed comparison table with the required schema is
   * visible, the compiler emits an unsatisfied contract notice. Off by
   * default for baseline reproducibility.
   */
  keyGrainEvidenceContract: boolean;
  /**
   * When true, LATEST context treats high-cardinality entity labels as
   * requiring an all-value component-profile evidence table before final key
   * selection. The profile is general over observed label structure
   * (delimiters, parentheticals, prefixes/suffixes), not tied to any task or
   * domain. Off by default for baseline reproducibility.
   */
  labelComponentProfileContract: boolean;
  /**
   * When true, LATEST context requires a data-driven inventory of observed
   * component/separator structure before component-profile or candidate-key
   * evidence is finalized. This asks the agent to enumerate observed label
   * patterns from typed data instead of guessing a fixed candidate list. Off by
   * default for baseline reproducibility.
   */
  observedComponentInventoryContract: boolean;
  /**
   * When true, LATEST context treats the selected entity key as provisional
   * until an executed impact table compares candidate keys against the
   * downstream entity-level predicate or final measure. This uses typed
   * dataflow evidence instead of task-specific delimiter rules. Off by default
   * for baseline reproducibility.
   */
  candidateSelectionImpactContract: boolean;
  /**
   * When true, LATEST evidence-contract artifacts are valid only when the DAG
   * links prove they consume their prerequisite typed artifacts. This turns
   * schema-only evidence detection into a dataflow dependency check over
   * observed inventory -> profile -> candidate key -> impact -> final
   * operators. Off by default for baseline reproducibility.
   */
  evidenceDependencyGate: boolean;
  /**
   * When true, CODE mode treats operator IDs as execution-safe logical IDs,
   * not only Python variable names. It asks for and enforces alphanumeric
   * Python identifiers without underscores because the current execution
   * persistence layer rejects logicalOpId values containing `_`. Off by
   * default for baseline reproducibility.
   */
  executionSafeOperatorIds: boolean;
  /**
   * When true, append CODE-mode guidance and context hints for dependency or
   * runtime-capability failures. The model must preserve the task's semantic
   * contract instead of answering from an unvalidated surrogate. Off by default
   * for baseline reproducibility.
   */
  fallbackContractGuidance: boolean;
}

export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  disabledTools: new Set(),
  maxOperatorResultCharLimit: 2000,
  maxOperatorResultCellCharLimit: 2000,
  operatorResultSerializationMode: OperatorResultSerializationMode.TSV,
  resultRendering: OperatorResultRendering.ROWS,
  contextScope: OperatorContextScope.ALL,
  toolTimeoutMs: 240000,
  executionTimeoutMs: 240000,
  maxSteps: 100,
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
  maxOperatorEdits: 0,
  lineageHintOnStall: false,
  maxUnexecutedCodeEdits: 0,
  metricEvidenceGuidance: false,
  schemaFirstCodeMode: false,
  tableStructureHints: false,
  rawLoaderProvenance: false,
  boundedExecutionGuidance: false,
  cardinalityPressureGuidance: false,
  entityKeyHygieneGuidance: false,
  componentGrainGuidance: false,
  keyGrainComparisonGuidance: false,
  keyGrainEvidenceContract: false,
  labelComponentProfileContract: false,
  observedComponentInventoryContract: false,
  candidateSelectionImpactContract: false,
  evidenceDependencyGate: false,
  executionSafeOperatorIds: false,
  fallbackContractGuidance: false,
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
  resultRendering?: "rows" | "digest" | "adaptive";
  contextScope?: "all" | "active-lineage";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  allowedOperatorTypes?: string[];
  agentMode?: "code" | "general";
  contextMode?: "full" | "delta" | "latest";
  parallelToolCalls?: boolean;
  statsEnabled?: boolean;
  includeOperatorProperties?: boolean;
  maxOperatorEdits?: number;
  lineageHintOnStall?: boolean;
  maxUnexecutedCodeEdits?: number;
  metricEvidenceGuidance?: boolean;
  schemaFirstCodeMode?: boolean;
  tableStructureHints?: boolean;
  rawLoaderProvenance?: boolean;
  boundedExecutionGuidance?: boolean;
  cardinalityPressureGuidance?: boolean;
  entityKeyHygieneGuidance?: boolean;
  componentGrainGuidance?: boolean;
  keyGrainComparisonGuidance?: boolean;
  keyGrainEvidenceContract?: boolean;
  labelComponentProfileContract?: boolean;
  observedComponentInventoryContract?: boolean;
  candidateSelectionImpactContract?: boolean;
  evidenceDependencyGate?: boolean;
  executionSafeOperatorIds?: boolean;
  fallbackContractGuidance?: boolean;
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
  resultRendering?: "rows" | "digest" | "adaptive";
  contextScope?: "all" | "active-lineage";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  allowedOperatorTypes?: string[];
  agentMode?: "code" | "general";
  contextMode?: "full" | "delta" | "latest";
  parallelToolCalls?: boolean;
  statsEnabled?: boolean;
  includeOperatorProperties?: boolean;
  maxOperatorEdits?: number;
  lineageHintOnStall?: boolean;
  maxUnexecutedCodeEdits?: number;
  metricEvidenceGuidance?: boolean;
  schemaFirstCodeMode?: boolean;
  tableStructureHints?: boolean;
  rawLoaderProvenance?: boolean;
  boundedExecutionGuidance?: boolean;
  cardinalityPressureGuidance?: boolean;
  entityKeyHygieneGuidance?: boolean;
  componentGrainGuidance?: boolean;
  keyGrainComparisonGuidance?: boolean;
  keyGrainEvidenceContract?: boolean;
  labelComponentProfileContract?: boolean;
  observedComponentInventoryContract?: boolean;
  candidateSelectionImpactContract?: boolean;
  evidenceDependencyGate?: boolean;
  executionSafeOperatorIds?: boolean;
  fallbackContractGuidance?: boolean;
}
