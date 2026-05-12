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
}
