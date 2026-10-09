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

export interface LogicalLink {
  fromOpId: string;
  fromPortId: { id: number; internal: boolean };
  toOpId: string;
  toPortId: { id: number; internal: boolean };
}

interface LogicalOperator {
  operatorID: string;
  operatorType: string;
  [key: string]: any;
}

export interface LogicalPlan {
  operators: LogicalOperator[];
  links: LogicalLink[];
  opsToViewResult?: string[];
  opsToReuseResult?: string[];
  savedOutputs?: Record<string, { executionId: string; operatorId: string; outputPort: number }>;
}

import { getBackendConfig } from "./backend-api";
import { env } from "../config/env";
import type { SyncExecutionResult } from "../types/execution";

export interface ExecuteWorkflowOptions {
  executionName?: string;
  computingUnitId?: number;
  timeoutSeconds?: number;
  maxOperatorResultCharLimit?: number;
  maxOperatorResultCellCharLimit?: number;
  abortSignal?: AbortSignal;
}

/**
 * POST the logical plan to the sync execution endpoint. Returns the
 * SyncExecutionResult once execution finishes (success, error, or timeout).
 *
 * Does not throw on backend errors — surfaces them via `success: false` so
 * callers can keep batch processing other workflows.
 */
export async function executeWorkflowSync(
  token: string,
  workflowId: number,
  logicalPlan: LogicalPlan,
  options: ExecuteWorkflowOptions = {}
): Promise<SyncExecutionResult> {
  const backendConfig = getBackendConfig();
  const computingUnitId = options.computingUnitId ?? 0;
  const executionEndpoint = env.EXECUTION_ENDPOINT_TEMPLATE
    ? env.EXECUTION_ENDPOINT_TEMPLATE.replace("{cuid}", String(computingUnitId))
    : backendConfig.executionEndpoint;

  const url = `${executionEndpoint}/api/execution/${workflowId}/${computingUnitId}/run`;

  const opsToViewResult = logicalPlan.opsToViewResult || [];
  const request = {
    executionName: options.executionName ?? "e2e-execution",
    logicalPlan: {
      operators: logicalPlan.operators,
      links: logicalPlan.links,
      opsToViewResult,
      opsToReuseResult: [],
    },
    targetOperatorIds: opsToViewResult,
    timeoutSeconds: options.timeoutSeconds ?? 300,
    maxOperatorResultCharLimit: options.maxOperatorResultCharLimit ?? 4000,
    maxOperatorResultCellCharLimit: options.maxOperatorResultCellCharLimit ?? 2000,
    ...(logicalPlan.savedOutputs && Object.keys(logicalPlan.savedOutputs).length
      ? { workflowSettings: { savedOutputs: logicalPlan.savedOutputs } } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(request),
    signal: options.abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      state: "Error",
      operators: {},
      errors: [`HTTP ${response.status} ${response.statusText} - ${errorText}`],
    };
  }
  return (await response.json()) as SyncExecutionResult;
}
