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
 * Type-only re-exports of the agent service's wire types. We pull straight
 * from the server's source so renames/additions there fail the dashboard
 * typecheck rather than silently going stale.
 *
 * Using `import type` exclusively keeps the bundle out of the agent /
 * workflow-state graph — only erased types come across, never runtime code.
 * The handful of enum *values* the UI actually needs (`AgentState.GENERATING`,
 * etc.) live in `enums.ts` and are imported as plain JS.
 */
export type { ReActStep, TokenUsage, AgentInfo, AgentDriverKind, AgentSettingsApi } from "../../types/agent";
export type {
  WorkflowContent,
  OperatorPredicate,
  OperatorLink,
  PortDescription,
} from "../../types/workflow";
export type { OperatorInfo } from "../../types/execution";

/** Wire shape of `GET /api/agents/:id/snapshot-tree`. Built server-side
 *  from `WorkflowSnapshotStorage.getSnapshotTreeNodes()`. */
export interface SnapshotTreeNode {
  id: string;
  parentId: string | undefined;
  reactStepId: string | undefined;
  operatorCount: number;
  resultCount: number;
}
export interface SnapshotTreeResponse {
  rootId: string;
  nodes: SnapshotTreeNode[];
}

/** Server-built `OperatorResultSummaryWs` (see `server.ts`). Mirrors the
 *  one we get over the WS `operatorResults` field and the
 *  `/snapshots/:stepId` response. Populated by the agent service from
 *  `WorkflowSnapshotStorage.results` — for imported traces, the import
 *  pass in `texera-agent.ts` parses each step's `inputMessages` and
 *  writes the recovered `OperatorInfo` into the snapshot, so this is
 *  the single source of truth regardless of how the agent got its data. */
export interface OperatorResultSummary {
  state: string;
  inputTuples: number;
  outputTuples: number;
  outputColumns?: number;
  error?: string;
  warnings?: string[];
  totalRowCount?: number;
  sampleRecords?: Record<string, unknown>[];
  columnStats?: Record<string, string>;
}
