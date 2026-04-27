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
 * Agent-related types for Texera Agent Service.
 */

import type { WorkflowContent } from "./workflow";
import type {
  ExecutionWatcherSnapshot,
  RecordedEvent,
  WakeSignal,
} from "../agent/execution-watcher";

// ============================================================================
// Execution diagnostics (logging-only, NOT sent to the LLM)
// ============================================================================

/**
 * Diagnostic record for one control-tool await OR one mailbox drain. Stored on
 * a ReActStep alongside before/afterWorkflowContent — same role: pure logging
 * for trace export, replay analysis, and post-hoc debugging. Never reaches the
 * model; the LLM-facing summary is composed by the tool's narrative renderer
 * (or the prepareStep mailbox renderer for execution-role steps).
 *
 * `contributingEvents` is the raw WebSocket event list — only events that
 * fired ≥1 wake rule are kept (routine OperatorStatistics ticks etc. are
 * absorbed silently into the snapshot and dropped here).
 */
export interface ExecutionDiagnostics {
  /** For tool-call diagnostics: the originating tool. Omitted for execution-role-step drains. */
  toolName?: string;
  /** For tool-call diagnostics: links back to the tool call. */
  toolCallId?: string;
  /** Snapshot just before the first contributing event in this window. */
  beforeSnapshot: ExecutionWatcherSnapshot;
  /** Snapshot at the end of the await / drain. */
  afterSnapshot: ExecutionWatcherSnapshot;
  /** Wake-firing events received during this window, in arrival order. */
  contributingEvents: RecordedEvent[];
  /** Wake signals emitted by the rules over the events above. */
  wakeSignals: WakeSignal[];
}

// ============================================================================
// Agent State
// ============================================================================

/**
 * Agent operational states
 */
export enum AgentState {
  UNAVAILABLE = "UNAVAILABLE",
  AVAILABLE = "AVAILABLE",
  GENERATING = "GENERATING",
  STOPPING = "STOPPING",
}

// ============================================================================
// ReAct Step Types (Agent reasoning trace + versioning)
// ============================================================================

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

/**
 * ReActStep - Represents a single reasoning and acting step in the agent's response.
 * Each step contains the agent's reasoning text, tool calls, results, and metadata.
 */
/** Sentinel ID for the initial step (before any real steps). */
export const INITIAL_STEP_ID = "step-initial";

export interface ReActStep {
  /** Unique step ID string for tree references */
  id: string;
  /** Parent step ID — forms the version tree. undefined for the initial step. */
  parentId?: string;
  messageId: string;
  stepId: number;
  timestamp: number;
  /**
   * Author of this step.
   * - "user": real human message.
   * - "agent": assistant's reasoning/tool-call step.
   * - "execution": synthetic message authored by the ExecutionWatcher,
   *   surfacing wake events between agent steps. Rendered as a `[execution]`
   *   user-role message in the assembled context.
   */
  role: "user" | "agent" | "execution";
  content: string;
  /** For user messages: the actual content sent to the model (may include prepended context) */
  actualContent?: string;
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
  /** Messages array sent to the LLM for this step (only when context optimization is active) */
  inputMessages?: any[];
  /** Source of the user message: "chat" or "feedback" (only for user steps) */
  messageSource?: "chat" | "feedback";
  /** Workflow state before this step executed */
  beforeWorkflowContent?: WorkflowContent;
  /** Workflow state after this step executed */
  afterWorkflowContent?: WorkflowContent;
  /**
   * For `role: "execution"` steps only: the executionName that was active
   * when the watcher mailbox was drained. Used by the assembler to filter
   * out [execution] observations that belong to a stale execution — when
   * the agent does a DAG edit (which conceptually invalidates prior runs),
   * we clear the "current" pointer and any [execution] step whose
   * executionName doesn't match the current pointer is omitted from the
   * rendered context. They stay in `stepsById` for replay/audit.
   */
  executionName?: string;
  /**
   * Per-step execution diagnostics (NOT sent to the LLM). Populated when:
   *   - the agent step called one or more execution-control tools (one entry
   *     per call: start/pause/resume/kill);
   *   - this is a `role:"execution"` step from a prepareStep mailbox drain
   *     (single entry, no toolName/toolCallId).
   * Same role as before/afterWorkflowContent: trace export, time-travel
   * inspection, post-hoc debugging.
   */
  executionDiagnostics?: ExecutionDiagnostics[];
}

/**
 * Statistics for a single message request
 */
export interface AgentMessageStats {
  messageId: string;
  userMessage: string;
  startTime: number;
  endTime?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  stepCount: number;
  status: "running" | "completed" | "error" | "stopped";
  errorMessage?: string;
}

// ============================================================================
// Agent Settings
// ============================================================================

/**
 * Serialization mode for operator results
 */
export enum OperatorResultSerializationMode {
  /** JSON array of objects */
  JSON = "json",
  /** Table format: header\nrow\nrow\n (CSV-like) */
  TABLE = "table",
  /** TOON format: Token-Oriented Object Notation (most compact for LLMs) */
  TOON = "toon",
}

/**
 * Agent operating mode - determines which tools and prompts are used
 */
export enum AgentMode {
  /** Code mode: Uses code operator tools (addCodeOperator, modifyCodeOperator), no operator schemas in prompt */
  CODE = "code",
  /** General mode: Uses workflow tools (addOperator, modifyOperator), includes operator schemas in prompt */
  GENERAL = "general",
}

/**
 * Execution backend - determines where workflows are executed
 */
export enum ExecutionBackend {
  /** Texera backend (Scala service, default) */
  TEXERA = "texera",
  /** Hamilton sidecar (Python FastAPI service) */
  HAMILTON = "hamilton",
  /** Dagster sidecar (Python FastAPI service) */
  DAGSTER = "dagster",
}

/**
 * Configurable settings for an agent instance
 */
export interface AgentSettings {
  /** System prompt for the agent */
  systemPrompt: string;
  /** Set of disabled tool names */
  disabledTools: Set<string>;
  /** Maximum character limit for operator results (uses symmetric truncation: first half + notice + last half) */
  maxOperatorResultCharLimit: number;
  /** Maximum character limit per cell (truncates individual cell values beyond this limit) */
  maxOperatorResultCellCharLimit: number;
  /** Serialization mode for operator results (json, table, or toon) */
  operatorResultSerializationMode: OperatorResultSerializationMode;
  /** Tool execution timeout in milliseconds */
  toolTimeoutMs: number;
  /** Workflow execution timeout in milliseconds */
  executionTimeoutMs: number;
  /** Maximum number of steps per message */
  maxSteps: number;
  /** Agent operating mode (code or general) */
  agentMode: AgentMode;
  /** Use fine-grained prompts with atomic operation constraints (one line = one operation) */
  fineGrainedPrompt: boolean;
  /** Enable context optimization to condense message history between steps */
  enableContextOptimization: boolean;
  /** Number of BFS levels backward from leaf operators for frontier computation */
  frontierDepth: number;
  /** Minimum characters to keep from execution results after log-fallback decay (frontier uses maxOperatorResultCharLimit, each deeper depth halves) */
  minimumResultCharLimit: number;
  /** Whether to enable operator result caching (when disabled, every execution runs fresh) */
  cacheEnabled: boolean;
  /** Execution backend: "texera", "hamilton", or "dagster" */
  executionBackend: ExecutionBackend;
  /** Keep only the latest tool call/result for each operator still in the workflow */
  latestOnly: boolean;
  /** Automatically compute frontier depth as ceil(average source-to-sink path length) */
  dynamicDepthEnabled: boolean;
  /** Allow the model to issue multiple tool calls in a single response */
  parallelToolCalls: boolean;
  /** When true, retrieveResult becomes an optional parameter the LLM can set per call; when false, results are always retrieved */
  optionalResultRetrieval: boolean;
  /** When true, execution metadata (shape, upstream IDs, row counts) is omitted from tool results */
  noExecutionMetadata: boolean;
  /** When true, getCurrentWorkflow tool is not registered (simplified tool set) */
  simplifiedTools: boolean;
  /** When true, code/properties details in definition tool calls are replaced with a placeholder in message history */
  noActionDetail: boolean;
  /** When true, non-frontier operators use minimumResultCharLimit directly instead of log-fallback decay */
  noLogFallback: boolean;
  /** When true, per-column statistics are included in the execution metadata section */
  carryMetadata: boolean;
  /** List of allowed operator types for general mode (when empty, all operators are allowed) */
  allowedOperatorTypes: string[];
  /**
   * High-level toggle between two coherent execution UXes:
   *
   * `true` (default, new mode): the agent gets the WS toolkit
   *   (startExecution, pauseExecution, resumeExecution, killExecution,
   *   getOperatorResult, debugPython, getConsoleLogs, retryCurrentTuple).
   *   Control tools BLOCK on the watcher until a wake rule fires; passive
   *   monitoring happens via `[execution]` messages drained between steps.
   *   No silent auto-execute on edit. Python UDF exceptions auto-pause the
   *   worker so debugPython works directly on the failing row.
   *
   * `false` (legacy mode): the agent gets the synchronous `executeOperator`
   *   tool plus the silent auto-execute hook on every addOperator /
   *   modifyOperator / createOrModifyOperator. Build-and-observe UX —
   *   results "just appear" after each edit. No runtime introspection.
   *
   * Use this for A/B testing the same task across both UXes. The two
   * modes have different toolsets AND different prompts.
   */
  executionControl: boolean;
}

/**
 * Default agent settings
 */
export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, "systemPrompt"> = {
  disabledTools: new Set(),
  maxOperatorResultCharLimit: 2000, // 20,000 characters (matches smolagents)
  maxOperatorResultCellCharLimit: 2000, // 4,000 characters per cell
  operatorResultSerializationMode: OperatorResultSerializationMode.TABLE,
  toolTimeoutMs: 240000, // 4 minutes
  executionTimeoutMs: 240000, // 4 minutes
  maxSteps: 100,
  agentMode: AgentMode.GENERAL, // Default to CODE mode
  fineGrainedPrompt: false, // Default to standard prompts
  enableContextOptimization: false,
  frontierDepth: 1,
  minimumResultCharLimit: 0,
  cacheEnabled: true,
  executionBackend: ExecutionBackend.TEXERA,
  latestOnly: false,
  dynamicDepthEnabled: false,
  parallelToolCalls: false,
  optionalResultRetrieval: false,
  noExecutionMetadata: false,
  simplifiedTools: false,
  noActionDetail: false,
  noLogFallback: false,
  carryMetadata: true,
  allowedOperatorTypes: [
    // Sources
    "CSVFileScan",
    "JSONLFileScan",
    // Filter / shape
    "Filter",
    "Projection",
    "TypeCasting",
    "Distinct",
    "Limit",
    "Regex",
    // Aggregate / join / sort
    "Aggregate",
    "HashJoin",
    "Sort",
    // UDFs
    "PythonUDFV2",
    "PythonLambdaFunction",
    // Set ops
    "Union",
    // Visualizations
    "BarChart",
    "LineChart",
    "PieChart",
    "HTMLVisualizer",
    "WordCloud",
    "Histogram",
  ],
  executionControl: true,
};

// ============================================================================
// User Delegate Configuration
// ============================================================================

/**
 * User information extracted from JWT token
 */
export interface UserInfo {
  uid: number;
  name: string;
  email: string;
  role: string;
}

/**
 * Configuration for an agent acting as a user delegate
 */
export interface AgentDelegateConfig {
  /** JWT token for authenticated API calls */
  userToken: string;
  /** User information extracted from token */
  userInfo?: UserInfo;
  /** Associated workflow ID (wid) */
  workflowId?: number;
  /** Workflow name */
  workflowName?: string;
  /** Computing unit ID (cuid) for workflow execution */
  computingUnitId?: number;
}

/**
 * Agent settings for API (serializable version without Set)
 */
export interface AgentSettingsApi {
  /** Maximum character limit for operator results (uses symmetric truncation) */
  maxOperatorResultCharLimit?: number;
  /** Maximum character limit per cell (truncates individual cell values beyond this limit) */
  maxOperatorResultCellCharLimit?: number;
  /** Serialization mode for operator results: "json", "table", or "toon" */
  operatorResultSerializationMode?: "json" | "table" | "toon";
  /** Tool execution timeout in seconds */
  toolTimeoutSeconds?: number;
  /** Workflow execution timeout in minutes */
  executionTimeoutMinutes?: number;
  /** List of disabled tool names */
  disabledTools?: string[];
  /** Maximum number of steps per message */
  maxSteps?: number;
  /** Agent operating mode: "code" or "general" */
  agentMode?: "code" | "general";
  /** Use fine-grained prompts with atomic operation constraints */
  fineGrainedPrompt?: boolean;
  /** Enable context optimization to condense message history between steps */
  enableContextOptimization?: boolean;
  /** Number of BFS levels backward from leaf operators for frontier computation */
  frontierDepth?: number;
  /** Minimum characters to keep from execution results after log-fallback decay */
  minimumResultCharLimit?: number;
  /** Whether to enable operator result caching (when disabled, every execution runs fresh) */
  cacheEnabled?: boolean;
  /** Execution backend: "texera", "hamilton", or "dagster" */
  executionBackend?: "texera" | "hamilton" | "dagster";
  /** Keep only the latest tool call/result for each operator still in the workflow */
  latestOnly?: boolean;
  /** Automatically compute frontier depth as ceil(average source-to-sink path length) */
  dynamicDepthEnabled?: boolean;
  /** Allow the model to issue multiple tool calls in a single response */
  parallelToolCalls?: boolean;
  /** When true, retrieveResult becomes an optional parameter the LLM can set per call */
  optionalResultRetrieval?: boolean;
  /** When true, execution metadata is omitted from tool results */
  noExecutionMetadata?: boolean;
  /** When true, getCurrentWorkflow tool is not registered (simplified tool set) */
  simplifiedTools?: boolean;
  /** When true, code/properties details in definition tool calls are replaced with a placeholder in message history */
  noActionDetail?: boolean;
  /** When true, non-frontier operators use minimumResultCharLimit directly instead of log-fallback decay */
  noLogFallback?: boolean;
  /** When true, per-column statistics are included in the execution metadata section */
  carryMetadata?: boolean;
  /** List of allowed operator types for general mode (empty = all operators allowed) */
  allowedOperatorTypes?: string[];
  /** High-level toggle: WS toolkit + no auto-hook (true) vs sync executeOperator + auto-hook (false). */
  executionControl?: boolean;
}

/**
 * Extended agent info including delegate configuration
 */
export interface AgentInfo {
  id: string;
  name: string;
  modelType: string;
  state: AgentState;
  createdAt: Date;
  /** Delegate configuration (if acting on behalf of a user) */
  delegate?: AgentDelegateConfig;
  /** Current agent settings (serializable format) */
  settings?: AgentSettingsApi;
}

/**
 * Request to create a new agent
 */
export interface CreateAgentRequest {
  modelType: string;
  name?: string;
  /** JWT token for delegate mode */
  userToken?: string;
  /** Workflow ID to associate with */
  workflowId?: number;
  /** Computing unit ID for workflow execution */
  computingUnitId?: number;
  /** Optional initial settings */
  settings?: AgentSettingsApi;
}

/**
 * Request to update agent settings
 */
export interface UpdateAgentSettingsRequest {
  /** Maximum character limit for operator results (uses symmetric truncation) */
  maxOperatorResultCharLimit?: number;
  /** Maximum character limit per cell (truncates individual cell values beyond this limit) */
  maxOperatorResultCellCharLimit?: number;
  /** Serialization mode for operator results: "json", "table", or "toon" */
  operatorResultSerializationMode?: "json" | "table" | "toon";
  /** Tool execution timeout in seconds */
  toolTimeoutSeconds?: number;
  /** Workflow execution timeout in minutes */
  executionTimeoutMinutes?: number;
  /** List of disabled tool names */
  disabledTools?: string[];
  /** Maximum number of steps per message */
  maxSteps?: number;
  /** Agent operating mode: "code" or "general" */
  agentMode?: "code" | "general";
  /** Use fine-grained prompts with atomic operation constraints */
  fineGrainedPrompt?: boolean;
  /** Enable context optimization to condense message history between steps */
  enableContextOptimization?: boolean;
  /** Number of BFS levels backward from leaf operators for frontier computation */
  frontierDepth?: number;
  /** Minimum characters to keep from execution results after log-fallback decay */
  minimumResultCharLimit?: number;
  /** Whether to enable operator result caching (when disabled, every execution runs fresh) */
  cacheEnabled?: boolean;
  /** Execution backend: "texera", "hamilton", or "dagster" */
  executionBackend?: "texera" | "hamilton" | "dagster";
  /** Keep only the latest tool call/result for each operator still in the workflow */
  latestOnly?: boolean;
  /** Automatically compute frontier depth as ceil(average source-to-sink path length) */
  dynamicDepthEnabled?: boolean;
  /** Allow the model to issue multiple tool calls in a single response */
  parallelToolCalls?: boolean;
  /** When true, retrieveResult becomes an optional parameter the LLM can set per call */
  optionalResultRetrieval?: boolean;
  /** When true, execution metadata is omitted from tool results */
  noExecutionMetadata?: boolean;
  /** When true, getCurrentWorkflow tool is not registered (simplified tool set) */
  simplifiedTools?: boolean;
  /** When true, code/properties details in definition tool calls are replaced with a placeholder in message history */
  noActionDetail?: boolean;
  /** When true, non-frontier operators use minimumResultCharLimit directly instead of log-fallback decay */
  noLogFallback?: boolean;
  /** When true, per-column statistics are included in the execution metadata section */
  carryMetadata?: boolean;
  /** List of allowed operator types for general mode (empty = all operators allowed) */
  allowedOperatorTypes?: string[];
  /** High-level toggle: WS toolkit + no auto-hook (true) vs sync executeOperator + auto-hook (false). */
  executionControl?: boolean;
}

// ============================================================================
// Trace Replay Types
// ============================================================================

/**
 * Content structure of a trace file (exported from agent conversation)
 */
export interface TraceContent {
  /** Final response text from the agent */
  response: string;
  /** Full conversation messages in Vercel AI SDK ModelMessage format */
  messages: any[];
}

/**
 * WebSocket message for replaying a trace
 */
export interface ReplayTraceMessage {
  type: "replay";
  trace: TraceContent;
}

/**
 * Tools that should be skipped during replay (execution-related tools)
 */
export const REPLAY_SKIP_TOOLS = new Set([
  "executeOperator",
  "getExecutionState",
  "killWorkflow",
  "getExecutionResult",
  "getOperatorResult",
]);

