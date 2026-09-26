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
 * Shared tool context + the delete tool used by both CODE and GENERAL modes.
 * Mode-specific add/modify tools live in `general-op-tools.ts` and
 * `code-op-tools.ts`.
 */

import { z } from "zod";
import { tool } from "ai";
import { WorkflowState } from "../workflow-state";
import { createToolResult, createErrorResult } from "./tools-utility";
import { type WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import type { NativeValidationRepair } from "../native/validation-repair";

import type { TaskHistory } from "../native/task-history";

export interface ToolContext {
  /** Current branch/task identity; repeated reads can reference earlier visible responses. */
  activeTaskId?: () => string | undefined;
  /** The number of the task being worked, for declarations made during it. */
  activeTaskNumber?: () => number | undefined;
  visibleInspections?: () => string[];
  taskHistory?: TaskHistory;
  /** Versioned definitions over the graph (`supersede`, `bind`, `explain`). */
  definitionRegistry?: import("../native/definition-registry").DefinitionRegistry;
  metadataStore?: WorkflowSystemMetadata;
  nativeValidationRepair?: NativeValidationRepair;
  settings?: {
    maxOperatorResultCharLimit?: number;
    toolTimeoutMs?: number;
    executionTimeoutMs?: number;
    nativeProfileCollection?: boolean;
    /** The dataflow tool's `restore` step is offered (task history must be on). */
    nativeTaskRestore?: boolean;
    nativeAnalysisState?: boolean;
    nativeTaskEfficiency?: boolean;
    nativeDefinitionRegistry?: boolean;
    /** The `answer_from` field: the runtime composes the final answer from an observed table. */
    nativeAnswerFrom?: boolean;
    /** A `def` may be called by name as an operator. */
    nativeRegisteredOperators?: boolean;
    /** Contract flags on tables and the `expect` field. */
    nativeContractFlags?: boolean;
    /** Lean context: column projections in `observe`, slimmer entries. */
    nativeLeanContext?: boolean;
    contextWindowTokens?: number;
    staticCompaction?: boolean;
    enableCompactTool?: boolean;
    /** Native `dataflow` tool: require the `reasoning` argument. */
    dataflowReasoning?: boolean;
  };
}

export const TOOL_NAME_DELETE_OPERATOR = "deleteOperator";

export function createDeleteOperatorTool(workflowState: WorkflowState, _context?: ToolContext) {
  return tool({
    description: "Delete an operator from the workflow. This also deletes all connected links.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to delete"),
    }),
    execute: async (args: { operatorId: string }) => {
      try {
        const deleted = workflowState.deleteOperator(args.operatorId);
        if (!deleted) {
          return createErrorResult(`Operator ${args.operatorId} not found`);
        }
        return createToolResult(`Deleted operator: ${args.operatorId}`);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
