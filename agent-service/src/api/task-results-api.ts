/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { getBackendConfig } from "./backend-api";
import { env } from "../config/env";
import type { RetainedResult } from "../agent/task-dataflows";

export async function retainTaskResult(
  token: string,
  workflowId: number,
  computingUnitId: number,
  operator: string,
  execution: string
): Promise<RetainedResult> {
  const endpoint = env.EXECUTION_ENDPOINT_TEMPLATE
    ? env.EXECUTION_ENDPOINT_TEMPLATE.replace("{cuid}", String(computingUnitId))
    : getBackendConfig().executionEndpoint;
  const response = await fetch(
    `${endpoint}/api/execution/${workflowId}/retain/${encodeURIComponent(execution)}/${encodeURIComponent(operator)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!response.ok) throw new Error(`Full-table retention failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as RetainedResult;
}
