/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { SyncExecutionResult } from "../../types/execution";
import type { LogicalPlan } from "../../types/workflow";
import { executionFingerprints, producingExecution } from "./result-versions";

/** V2 must not silently consume legacy NULL strings or rounded int64 numbers.
 * This negotiation concerns data correctness. Missing optional profiles are
 * handled separately and never turn a valid table into an execution failure. */
export function prepareStructuredExecutionResult(
  response: SyncExecutionResult,
  workflowId: number,
  plan?: LogicalPlan
): SyncExecutionResult {
  if (!response.success && !Object.values(response.operators).some(info => info.result != null)) return response;
  if (
    !Array.isArray(response.capabilities) ||
    !response.capabilities.includes("typed-scalar-v1") ||
    !response.capabilities.includes("schema-fields-only-v1") ||
    typeof response.executionId !== "string" ||
    !/^\d{1,20}$/.test(response.executionId)
  ) {
    const error =
      "V2 requires a backend with typed-scalar-v1, schema-fields-only-v1 and execution identity support; deploy the matching engine/API before retrying.";
    return {
      ...response,
      success: false,
      state: "CapabilityMissing",
      errors: [...(response.errors ?? []), error],
      operators: Object.fromEntries(
        Object.entries(response.operators).map(([id, info]) => [
          id,
          {
            ...info,
            result: undefined,
            resultMode: "error",
            error: info.error || error,
          },
        ])
      ),
    };
  }
  const executionContext = { workflowId, executionId: response.executionId };
  const fingerprints = plan ? executionFingerprints(plan) : undefined;
  return {
    ...response,
    operators: Object.fromEntries(
      Object.entries(response.operators).map(([id, info]) => [
        id,
        {
          ...info,
          executionContext: {
            ...executionContext,
            ...fingerprints?.get(id),
            ...(plan
              ? {
                  inputs: plan.links
                    .filter(link => link.toOpId === id)
                    .map(link => ({
                      operatorId: link.fromOpId,
                      inputPort: link.toPortId.id,
                      outputPort: link.fromPortId.id,
                      executionId: producingExecution({
                        materialization:
                          response.operators[link.fromOpId]?.materialization ??
                          response.inputMaterializations?.[link.fromOpId],
                      }),
                    })),
                }
              : {}),
          },
        },
      ])
    ),
  };
}
