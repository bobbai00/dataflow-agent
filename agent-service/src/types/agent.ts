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

export type RetrievalView = "full" | "sample_stats";

export interface RetrievalSettings {
  /** Available native Retrieve views. Omitted: sample_stats and full. */
  retrievalViews?: RetrievalView[];
  /** Full-view display ceiling (default 5,000). Native transport independently retains up to 100,000 characters. */
  fullResultCharLimit?: number;
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
   *  out; the same failure repeating; a reply that computed nothing or was cut
   *  off at the output limit. */
  correction?: "step-budget" | "repeated-failure" | "missing-action" | "cut-off";
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

export type MultiRequestMode = "off" | "transcript";

export interface AgentSettings extends RetrievalSettings, ObservationFormatSettings {
  systemPrompt: string;
  maxOperatorResultCharLimit: number;
  executionTimeoutMs: number;
  maxSteps: number;
  /** Collect table profiles and operator counters in the engine, independently
   *  of model-facing exposure (`dataEvidence` / `flowEvidence`). Compiled into
   *  each operator, so it cannot change on an existing workflow. */
  nativeProfileCollection?: boolean;
  maxResultRows: number;
  /** Bounded, version-bound column/table facts on explicitly observed results. */
  dataEvidence: boolean;
  /** Version-matched input/output facts on explicitly observed results. */
  flowEvidence: boolean;
  /** Every operator carries a one-line `doc` saying what it does and why. The
   *  prompt asks for it and its examples show it; an edit that sets an operator
   *  without one gets a reminder in the tool result. Off by default. */
  operatorDoc: boolean;
  /** Instructions for this session, appended to the system prompt: rules of
   *  engagement beyond the standard prompt. Empty by default. */
  instructions: string;
  /**
   * Sessions that answer several requests. "off" (default): one request, as
   * before. "transcript": a later request follows the whole earlier transcript,
   * the prompt gains its working-across-requests section, and receipts name
   * each registered function's signature and note a column a Python step left
   * 0 or null in every row. Decided before the first request: the system
   * prompt depends on it.
   */
  multiRequest: MultiRequestMode;
}

export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  ...DEFAULT_OBSERVATION_FORMAT,
  maxOperatorResultCharLimit: 2000,
  fullResultCharLimit: 5000,
  retrievalViews: ["sample_stats", "full"],
  executionTimeoutMs: 240000,
  maxSteps: 100,
  // Results are read through a sample with full-table column statistics by
  // default (the matrix of 2026-10-10: equal accuracy at lower cost than the
  // full view); flow evidence stays opt-in.
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: false,
  operatorDoc: false,
  instructions: "",
  // Sample rows per `show result`: three keep a pattern or both ends in view
  // at about half the tokens of five (2026-10-11 cost study).
  maxResultRows: 3,
  multiRequest: "off",
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

export interface AgentSettingsApi extends RetrievalSettings, Partial<ObservationFormatSettings> {
  maxOperatorResultCharLimit?: number;
  executionTimeoutMinutes?: number;
  maxSteps?: number;
  /** The only context: each event replayed with the operators it changed. */
  contextMode?: "delta";
  nativeProfileCollection?: boolean;
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  operatorDoc?: boolean;
  instructions?: string;
  maxResultRows?: number;
  /** Sessions with several requests (see AgentSettings.multiRequest). */
  multiRequest?: MultiRequestMode;
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
  workflowId?: number;
  computingUnitId?: number;
  settings?: AgentSettingsApi;
}

export interface UpdateAgentSettingsRequest extends RetrievalSettings, Partial<ObservationFormatSettings> {
  maxOperatorResultCharLimit?: number;
  executionTimeoutMinutes?: number;
  maxSteps?: number;
  contextMode?: "delta";
  nativeProfileCollection?: boolean;
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  operatorDoc?: boolean;
  instructions?: string;
  maxResultRows?: number;
  /** Sessions with several requests (see AgentSettings.multiRequest). */
  multiRequest?: MultiRequestMode;
}
