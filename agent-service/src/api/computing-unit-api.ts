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

import { getBackendConfig } from "./backend-api";

interface ComputingUnitPojo {
  cuid: number;
  uid: number;
  name: string;
  type: string;
  uri?: string;
  resource?: string;
  creationTime?: number;
  terminateTime?: number | null;
}

export interface DashboardComputingUnit {
  computingUnit: ComputingUnitPojo;
  status: string;
  metrics: { cpuUsage: string; memoryUsage: string };
  isOwner: boolean;
  accessPrivilege: string;
  ownerGoogleAvatar?: string;
  ownerName?: string;
}

export interface CreateComputingUnitOptions {
  /** Defaults to `local` (single-node, no k8s pod). */
  unitType?: "local" | "kubernetes";
  /** Required for `local` — the workflow execution endpoint URI. */
  uri?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  gpuLimit?: string;
  jvmMemorySize?: string;
  shmSize?: string;
}

/**
 * Create a workflow computing unit. The execution endpoint requires a real
 * cuid for its FK constraint; without one, every run fails before scheduling.
 */
export async function createComputingUnit(
  token: string,
  name: string,
  options: CreateComputingUnitOptions = {}
): Promise<DashboardComputingUnit> {
  const { computingUnitEndpoint } = getBackendConfig();
  const unitType = options.unitType ?? "local";

  const body = {
    name,
    unitType,
    cpuLimit: options.cpuLimit ?? "NaN",
    memoryLimit: options.memoryLimit ?? "NaN",
    gpuLimit: options.gpuLimit ?? "NaN",
    jvmMemorySize: options.jvmMemorySize ?? "NaN",
    shmSize: options.shmSize ?? "NaN",
    uri: options.uri,
  };

  const response = await fetch(`${computingUnitEndpoint}/api/computing-unit/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create computing unit: ${response.status} ${response.statusText} - ${errorText}`);
  }
  return (await response.json()) as DashboardComputingUnit;
}

export async function terminateComputingUnit(token: string, cuid: number): Promise<void> {
  const { computingUnitEndpoint } = getBackendConfig();
  const response = await fetch(`${computingUnitEndpoint}/api/computing-unit/${cuid}/terminate`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to terminate computing unit ${cuid}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
}

/** The computing units this user can see (own and shared), as the dashboard lists them. */
export async function listComputingUnits(token: string): Promise<DashboardComputingUnit[]> {
  const { computingUnitEndpoint } = getBackendConfig();
  const response = await fetch(`${computingUnitEndpoint}/api/computing-unit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list computing units: ${response.status} ${response.statusText} - ${errorText}`);
  }
  return (await response.json()) as DashboardComputingUnit[];
}
