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
   * Hard cap on how many of the most-recent (non-init) ReActStep events are
   * rendered into the assembled context. Default is **2** — only the two
   * most recent ReActStep events render inline under `# Recent Agent
   * Events`; older ones are replaced with a `(... N earlier events
   * omitted ...)` notice. Combined with `# User Task` (always present)
   * and `# Current Dataflow` (always present), the agent retains the
   * question + the workflow state + the two most recent moves regardless
   * of how long the trace gets.
   *
   * To effectively disable the cap, set a very large number (e.g. 10_000).
   * Set to 0 to drop every event entirely (only the user task and the
   * current dataflow remain).
   */
  recentEventsCap: number;
  /**
   * When the cap is in effect, include the full `code` parameter of each
   * kept `createOrModifyOperator` action in the rendered context. Outside
   * the kept window, code is never rendered (events are dropped entirely).
   * Default: true — with a small cap, the agent should be able to read the
   * code of the most recent actions.
   */
  includeCodeInRecentEvents: boolean;
}

export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  disabledTools: new Set(),
  maxOperatorResultCharLimit: 2000,
  maxOperatorResultCellCharLimit: 2000,
  operatorResultSerializationMode: OperatorResultSerializationMode.TSV,
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
  parallelToolCalls: true,
  statsEnabled: true,
  recentEventsCap: 2,
  includeCodeInRecentEvents: true,
};

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
  allowedOperatorTypes?: string[];
  agentMode?: "code" | "general";
  contextMode?: "full" | "delta" | "latest";
  parallelToolCalls?: boolean;
  statsEnabled?: boolean;
  recentEventsCap?: number;
  includeCodeInRecentEvents?: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  modelType: string;
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
}

export interface UpdateAgentSettingsRequest {
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  operatorResultSerializationMode?: "tsv";
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  disabledTools?: string[];
  maxSteps?: number;
  allowedOperatorTypes?: string[];
  agentMode?: "code" | "general";
  contextMode?: "full" | "delta" | "latest";
  parallelToolCalls?: boolean;
  statsEnabled?: boolean;
  recentEventsCap?: number;
  includeCodeInRecentEvents?: boolean;
}
