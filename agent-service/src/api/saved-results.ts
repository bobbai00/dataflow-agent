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
import { getBackendConfig } from "./backend-api";
import { env } from "../config/env";
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";

export interface SavedOutputReference { executionId: string; operatorId: string; outputPort: number }
export interface SavedResultClientOptions { token: string; workflowId: number; computingUnitId?: number; signal?: AbortSignal }
interface ResultPage {
  materializationId: string; totalRows: number; schema: NonNullable<OperatorInfo["resultSchema"]>;
  rows: Record<string, unknown>[]; nextOffset: number; complete: boolean;
}

export function resultReference(op: OperatorPredicate, info: OperatorInfo | undefined): SavedOutputReference | undefined {
  const saved = op.savedResult;
  const executionId = saved?.executionId ?? info?.materialization?.executionId ?? info?.resultVersion?.executionId;
  const outputPort = saved?.outputPort ?? info?.materialization?.outputPort ?? info?.resultVersion?.outputPort;
  if (!executionId || !/^[1-9]\d*$/.test(executionId) || outputPort === null || outputPort === undefined || !Number.isSafeInteger(outputPort) || outputPort < 0) return;
  return { executionId, operatorId: saved?.operatorId ?? op.operatorID, outputPort };
}

async function request<T>(client: SavedResultClientOptions, action: "read" | "retain", body: unknown): Promise<T> {
  const endpoint = env.EXECUTION_ENDPOINT_TEMPLATE
    ? env.EXECUTION_ENDPOINT_TEMPLATE.replace("{cuid}", String(client.computingUnitId ?? 0))
    : getBackendConfig().executionEndpoint;
  const response = await fetch(`${endpoint}/api/execution/${client.workflowId}/results/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.token}` },
    body: JSON.stringify(body), signal: client.signal ? AbortSignal.any([client.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    // The engine returns 400 both for unavailable saved tables and invalid
    // projections. Only its explicit unavailable marker denotes lost state.
    const code = detail.includes("HISTORICAL_RESULT_UNAVAILABLE") ? "HISTORICAL_RESULT_UNAVAILABLE"
      : response.status === 400 ? "INVALID_RESULT_REQUEST" : "RESULT_SERVICE_ERROR";
    throw new Error(`${code}: result ${action} failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<T>;
}

/** Retain every completed, bound materialization at a task boundary. No rows
 * enter the prompt; aliases share storage and are released with the workflow. */
export async function retainSnapshotResults(
  client: SavedResultClientOptions, workflow: WorkflowContent, result: (id: string) => OperatorInfo | undefined
): Promise<void> {
  const references = new Map<string, SavedOutputReference>();
  for (const op of workflow.operators) {
    const info = result(op.operatorID);
    if (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)) continue;
    const ref = resultReference(op, info);
    if (ref) references.set(JSON.stringify(ref), ref);
  }
  const all = [...references.values()];
  for (let offset = 0; offset < all.length; offset += 1000)
    await request(client, "retain", { references: all.slice(offset, offset + 1000) });
}

/** Page one exact producer. The first response pins the materialization for
 * every later page, and row/byte ceilings bound runtime memory, not model context. */
export async function readMaterializedResult(
  client: SavedResultClientOptions, op: OperatorPredicate, info: OperatorInfo,
  options: { columns?: string[]; maxRows?: number; maxBytes?: number; requireComplete?: boolean } = {}
): Promise<OperatorInfo> {
  const reference = resultReference(op, info);
  if (!reference) throw new Error("HISTORICAL_RESULT_UNAVAILABLE: exact result identity is missing");
  const expectedRows = info.totalRowCount ?? info.outputTuples;
  const maxRows = options.maxRows ?? 50_000, maxBytes = options.maxBytes ?? 5_000_000;
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 0 || !Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid result pagination bounds or saved row count");
  if (options.requireComplete && expectedRows > maxRows)
    throw new Error(`Answer table has ${expectedRows} rows; sort and limit in the graph above the ${maxRows}-row pagination ceiling.`);
  const rows: Record<string, unknown>[] = [];
  let offset = 0, bytes = 0, identity: string | undefined, schema = info.resultSchema;
  do {
    const page = await request<ResultPage>(client, "read", {
      reference, offset, pageSize: Math.min(500, Math.max(1, maxRows - rows.length)), columns: options.columns ?? null,
      materializationId: identity ?? null, expectedRows,
    });
    if (!page.materializationId || (identity !== undefined && page.materializationId !== identity) ||
        page.totalRows !== expectedRows || page.nextOffset !== offset + page.rows.length ||
        (page.nextOffset <= offset && expectedRows !== 0) || page.nextOffset > expectedRows || page.complete !== (page.nextOffset >= expectedRows))
      throw new Error("HISTORICAL_RESULT_UNAVAILABLE: result pages do not match one complete saved materialization");
    identity = page.materializationId;
    schema = page.schema;
    let bounded = false;
    for (const row of page.rows) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rows.length >= maxRows || bytes + size > maxBytes) { bounded = true; break; }
      rows.push(row); bytes += size;
    }
    offset = page.nextOffset;
    if (bounded || rows.length >= maxRows || page.complete) break;
  } while (offset < expectedRows);
  if (options.requireComplete && rows.length !== expectedRows)
    throw new Error("Answer table exceeds the pagination byte budget; project fewer columns or sort and limit in the graph.");
  return { ...info, result: rows, resultSchema: schema, displayedRows: rows.length, truncated: rows.length < expectedRows };
}
