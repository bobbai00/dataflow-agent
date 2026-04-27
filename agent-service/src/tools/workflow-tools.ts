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
 * Common workflow tools for Texera Agent Service.
 * These tools are shared across both CODE and GENERAL agent modes.
 */

import { z } from "zod";
import { tool } from "ai";
import type { WorkflowState } from "../workflow/workflow-state";
import {
  createToolResult,
  createErrorResult,
  rejectIfExecutionAlive,
} from "./tools-utility";
import { buildPostMutationValidationWarning } from "./execution-tools";
import type { OperatorMetadataStore } from "./metadata-tools";
import type { ParallelCallCoordinator } from "./parallel-call-coordinator";

// ============================================================================
// Types for tool context
// ============================================================================

export interface ToolContext {
  metadataStore?: OperatorMetadataStore;
  settings?: {
    maxOperatorResultCharLimit?: number;
    toolTimeoutMs?: number;
    executionTimeoutMs?: number;
  };
  /** Coordinates parallel tool calls with inter-operator dependencies */
  parallelCoordinator?: ParallelCallCoordinator;
  /**
   * Drop cached results for operators whose stored output is now stale —
   * called by modifyOperator/createOrModifyOperator/deleteOperator on the
   * downstream closure of the affected operator. Without this, # Current
   * Workflow surfaces Result rows from prior runs after the underlying
   * code/properties have changed, and the agent treats them as authoritative.
   */
  invalidateResults?: (operatorIds: Iterable<string>) => void;
  /**
   * Drop the watcher's snapshot entries for these operators (per-op state,
   * worker IDs, current tuples, console buffers). Called by deleteOperator
   * so `# Active Execution` doesn't keep showing phantom operators that no
   * longer exist in the local workflow. Engine may still hold them in
   * memory until the next fresh logical plan is sent.
   */
  forgetOperatorsInSnapshot?: (operatorIds: Iterable<string>) => void;
  /**
   * Returns the current execution state info, or `null` if no execution
   * has ever been started this session. Used by DAG-mutating tools
   * (add/modify/createOrModify/delete) to refuse when an execution is
   * alive — local DAG diverging from engine state is confusing, matches
   * the FE's policy of disabling the canvas during runs. Agent must use
   * `liveModifyOperator` (paused, Python UDF only) or `killExecution`
   * first.
   */
  getExecutionState?: () => { state: string; isAlive: boolean } | null;
  /**
   * Called from DAG-mutating tools (add/modify/createOrModify/delete) to
   * signal that prior-execution observations are now stale: any operator
   * change conceptually invalidates the rendered runtime state. The agent
   * reads this to drop its "current execution" pointer so the assembler
   * filters out [execution] ReActSteps from now-meaningless prior runs.
   * Stale steps stay in stepsById for replay/audit.
   */
  onDagEdit?: () => void;
}

// ============================================================================
// Tool Name Constants
// ============================================================================

export const TOOL_NAME_DELETE_OPERATOR = "deleteOperator";

// ============================================================================
// Delete Operator Tool
// ============================================================================

export function createDeleteOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description: "Delete an operator from the workflow. This also deletes all connected links.",
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to delete"),
    }),
    execute: async (args: { operatorId: string }) => {
      try {
        const aliveRejection = rejectIfExecutionAlive("deleteOperator", context?.getExecutionState);
        if (aliveRejection) return aliveRejection;

        // Capture the downstream closure BEFORE deleting — once the operator
        // is gone, getDownstreamClosure can't trace through it anymore.
        const closure = context?.invalidateResults
          ? workflowState.getDownstreamClosure([args.operatorId])
          : null;
        const deleted = workflowState.deleteOperator(args.operatorId);
        if (!deleted) {
          return createErrorResult(`Operator ${args.operatorId} not found`);
        }
        if (closure && context?.invalidateResults) {
          context.invalidateResults(closure);
        }
        // Also drop the watcher's per-op snapshot entries so # Active
        // Execution doesn't render this operator any more.
        if (context?.forgetOperatorsInSnapshot) {
          context.forgetOperatorsInSnapshot([args.operatorId]);
        }
        // Invalidate prior-execution observations.
        context?.onDagEdit?.();
        let resultMsg = `Deleted operator: ${args.operatorId}`;
        // Exclude the just-deleted operator id from the warning — the agent
        // doesn't need a "no input link" message for an op it just deleted.
        const warning = buildPostMutationValidationWarning(workflowState, [args.operatorId]);
        if (warning) resultMsg += "\n" + warning;
        return createToolResult(resultMsg);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
