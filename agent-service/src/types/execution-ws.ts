/*
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
 * TypeScript interfaces for the Texera workflow-websocket protocol.
 *
 * Mirrors:
 *   amber/src/main/scala/org/apache/texera/web/model/websocket/request/*.scala
 *   amber/src/main/scala/org/apache/texera/web/model/websocket/event/*.scala
 *
 * Wire format: Jackson polymorphic JSON with a top-level `type` discriminator
 * (see TexeraWebSocketRequest.scala / TexeraWebSocketEvent.scala for the
 * @JsonTypeInfo annotations).
 */

// ============================================================================
// Common shapes
// ============================================================================

export interface WorkflowSettings {
  dataTransferBatchSize?: number;
  outputPortsNeedingStorage?: string[];
}

export interface ReplayExecutionInfo {
  eid: number;
  interaction: string;
}

export interface LogicalPlanPojo {
  operators: any[];
  links: any[];
  opsToViewResult: string[];
  opsToReuseResult: string[];
}

// ============================================================================
// Outgoing requests (FE/agent → backend)
// ============================================================================

export type TexeraWebSocketRequest =
  | WorkflowExecuteRequest
  | WorkflowPauseRequest
  | WorkflowResumeRequest
  | WorkflowKillRequest
  | WorkflowCheckpointRequest
  | ResultPaginationRequest
  | PythonExpressionEvaluateRequest
  | ModifyLogicRequest
  | DebugCommandRequest
  | RetryRequest
  | HeartBeatRequest;

export interface WorkflowExecuteRequest {
  type: "WorkflowExecuteRequest";
  executionName: string;
  engineVersion: string;
  logicalPlan: LogicalPlanPojo;
  replayFromExecution: ReplayExecutionInfo | null;
  workflowSettings: WorkflowSettings;
  emailNotificationEnabled: boolean;
  computingUnitId: number;
}

export interface WorkflowPauseRequest {
  type: "WorkflowPauseRequest";
}

export interface WorkflowResumeRequest {
  type: "WorkflowResumeRequest";
}

export interface WorkflowKillRequest {
  type: "WorkflowKillRequest";
}

export interface WorkflowCheckpointRequest {
  type: "WorkflowCheckpointRequest";
}

export interface ResultPaginationRequest {
  type: "ResultPaginationRequest";
  requestID: string;
  operatorID: string;
  pageIndex: number;
  pageSize: number;
  columnOffset?: number;
  columnLimit?: number;
  columnSearch?: string | null;
}

export interface HeartBeatRequest {
  type: "HeartBeatRequest";
}

/**
 * Evaluate an arbitrary Python expression in a paused worker process.
 * NOTE: wire format carries no requestID — correlation is by `(operatorId, expression)`.
 * If multiple evals are dispatched concurrently for the same pair, responses
 * arrive in send order; queue accordingly on the agent side.
 */
export interface PythonExpressionEvaluateRequest {
  type: "PythonExpressionEvaluateRequest";
  expression: string;
  operatorId: string;
}

/**
 * Replace an operator's logic (typically code/properties) on a paused execution.
 * NOTE: wire format carries no requestID — correlation is by `opId` on the
 * `ModifyLogicResponse` (synchronous validation) and `ModifyLogicCompletedEvent`
 * (asynchronous "applied at next tuple" confirmation).
 *
 * `operator` is a `LogicalOperator`-shaped record: operator properties spread
 * with `operatorID` and `operatorType`. Mirrors the FE's `modifyOperatorLogic`.
 */
export interface ModifyLogicRequest {
  type: "ModifyLogicRequest";
  operator: { operatorID: string; operatorType: string; [k: string]: any };
}

/**
 * Send a single Python pdb command to a worker for line-by-line debugging
 * of a Python UDF (Udon-style). Worker pipes the command into its in-process
 * Pdb instance; output comes back as ConsoleUpdateEvent (level=DEBUGGER) on
 * the same operator/worker, not as a synchronous response.
 *
 * The command syntax is plain pdb — `n`, `s`, `c`, `b 5`, `p tuple_`, etc.
 * The worker auto-prefixes module name to `b LINE`, so callers just give the
 * line number relative to the UDF source.
 */
export interface DebugCommandRequest {
  type: "DebugCommandRequest";
  operatorId: string;
  workerId: string;
  cmd: string;
}

/**
 * Re-run the most recent in-flight tuple on the specified workers. Used after
 * `ModifyLogicRequest` to retry the row that triggered the failure with the
 * new operator code.
 */
export interface RetryRequest {
  type: "RetryRequest";
  workers: string[];
}

// ============================================================================
// Incoming events (backend → FE/agent)
// ============================================================================

export type TexeraWebSocketEvent =
  | WorkflowStateEvent
  | OperatorStatisticsUpdateEvent
  | ConsoleUpdateEvent
  | PaginatedResultEvent
  | WorkflowErrorEvent
  | WebResultUpdateEvent
  | CacheStatusUpdateEvent
  | WorkerAssignmentUpdateEvent
  | ExecutionDurationUpdateEvent
  | PythonExpressionEvaluateResponse
  | ModifyLogicResponse
  | ModifyLogicCompletedEvent
  | HeartBeatResponse
  | { type: string; [key: string]: any }; // catch-all for unknown event types

export type WorkflowState =
  | "Uninitialized"
  | "Initializing"
  | "Running"
  | "Pausing"
  | "Paused"
  | "Resuming"
  | "Completed"
  | "Failed"
  | "Killed"
  | "Terminated"
  | "Recovering";

export interface WorkflowStateEvent {
  type: "WorkflowStateEvent";
  state: WorkflowState;
}

export type OperatorState =
  | "Uninitialized"
  | "Ready"
  | "Running"
  | "Pausing"
  | "Paused"
  | "Completed"
  | "Failed";

export interface OperatorAggregatedMetrics {
  operatorState: OperatorState;
  aggregatedInputRowCount: number;
  aggregatedInputSize: number;
  inputPortMetrics: Record<string, number>;
  aggregatedOutputRowCount: number;
  aggregatedOutputSize: number;
  outputPortMetrics: Record<string, number>;
  numWorkers: number;
  aggregatedDataProcessingTime: number;
  aggregatedControlProcessingTime: number;
  aggregatedIdleTime: number;
}

export interface OperatorStatisticsUpdateEvent {
  type: "OperatorStatisticsUpdateEvent";
  operatorStatistics: Record<string, OperatorAggregatedMetrics>;
}

export type ConsoleMessageType = "PRINT" | "ERROR" | "COMMAND" | "DEBUGGER";

export interface ConsoleMessage {
  workerId: string;
  timestamp: { seconds: number; nanos: number };
  msgType: { name: ConsoleMessageType } | ConsoleMessageType;
  source: string;
  title: string;
  message: string;
}

export interface ConsoleUpdateEvent {
  type: "ConsoleUpdateEvent";
  operatorId: string;
  messages: ConsoleMessage[];
}

export interface PaginatedResultEvent {
  type: "PaginatedResultEvent";
  requestID: string;
  operatorID: string;
  pageIndex: number;
  table: any[];
  schema: Array<{ attributeName: string; attributeType: string }>;
}

export interface WorkflowFatalError {
  type: string;
  timestamp?: { seconds: number; nanos: number };
  message: string;
  details?: string;
  operatorId?: string;
  workerId?: string;
}

export interface WorkflowErrorEvent {
  type: "WorkflowErrorEvent";
  fatalErrors: WorkflowFatalError[];
}

export interface WebResultUpdateEvent {
  type: "WebResultUpdateEvent";
  updates: Record<string, any>;
}

export interface CacheStatusUpdateEvent {
  type: "CacheStatusUpdateEvent";
  cacheStatusMap: Record<string, string>;
}

export interface WorkerAssignmentUpdateEvent {
  type: "WorkerAssignmentUpdateEvent";
  operatorId: string;
  workerIds: string[];
}

export interface ExecutionDurationUpdateEvent {
  type: "ExecutionDurationUpdateEvent";
  duration: number;
  isRunning: boolean;
}

export interface HeartBeatResponse {
  type: "HeartBeatResponse";
}

/**
 * One stringified Python value, plus optional sub-attributes (e.g. dict items,
 * object fields). `valueRef` is an engine-side handle for expanding deeper —
 * we don't currently use it.
 */
export interface TypedValue {
  expression: string;
  valueRef: string;
  valueStr: string;
  valueType: string;
  expandable: boolean;
}

export interface EvaluatedValue {
  value: TypedValue;
  attributes: TypedValue[];
}

export interface PythonExpressionEvaluateResponse {
  type: "PythonExpressionEvaluateResponse";
  expression: string;
  values: EvaluatedValue[];
}

/**
 * Synchronous validation result for a `ModifyLogicRequest`. `isValid=false`
 * means the engine rejected the new logic (schema mismatch, syntactic error,
 * etc.) and the prior logic is still in effect. Correlation key: `opId`.
 */
export interface ModifyLogicResponse {
  type: "ModifyLogicResponse";
  opId: string;
  isValid: boolean;
  errorMessage: string;
}

/**
 * Asynchronous confirmation that the engine has applied the modified logic.
 * Fires after `ModifyLogicResponse(isValid=true)`, when the operator's next
 * tuple gets handled by the new code. Carries the affected operator IDs.
 */
export interface ModifyLogicCompletedEvent {
  type: "ModifyLogicCompletedEvent";
  opIds: string[];
}

// ============================================================================
// Type guards
// ============================================================================

export function isWorkflowStateEvent(e: TexeraWebSocketEvent): e is WorkflowStateEvent {
  return e.type === "WorkflowStateEvent";
}

export function isOperatorStatisticsUpdateEvent(
  e: TexeraWebSocketEvent
): e is OperatorStatisticsUpdateEvent {
  return e.type === "OperatorStatisticsUpdateEvent";
}

export function isConsoleUpdateEvent(e: TexeraWebSocketEvent): e is ConsoleUpdateEvent {
  return e.type === "ConsoleUpdateEvent";
}

export function isPaginatedResultEvent(e: TexeraWebSocketEvent): e is PaginatedResultEvent {
  return e.type === "PaginatedResultEvent";
}

export function isWorkflowErrorEvent(e: TexeraWebSocketEvent): e is WorkflowErrorEvent {
  return e.type === "WorkflowErrorEvent";
}

/**
 * Returns the message type for a ConsoleMessage, normalizing the two
 * shapes we see on the wire ({name: "ERROR"} vs "ERROR").
 */
export function getConsoleMessageType(msg: ConsoleMessage): ConsoleMessageType {
  if (typeof msg.msgType === "string") return msg.msgType;
  return msg.msgType.name;
}
