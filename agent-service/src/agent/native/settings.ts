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

import { AgentMode, DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import type { NativeCatalogVersion } from "./catalog";

/** A rejected catalog configuration is a client error, not a server failure. */
export class NativeCatalogSettingsError extends Error {}

/** Deliberate breaking change: never silently reinterpret old experiments. */
export function validateEvidenceSettings(settings: object): void {
  const removed = [
    "flowLevel",
    "dataLevel",
    "columnStats",
    "valueFormat",
    "dataHints",
    "statScopes",
    "coercionTelemetry",
    "rowLineage",
    "loaderHint",
    "lineageErrorContext",
    "graphAudit",
    "valueFormatFlags",
    "tableStructureHint",
    "fileIoFacts",
    "nativeFlowEvidence",
  ];
  for (const key of removed) {
    if (Object.hasOwn(settings, key))
      throw new NativeCatalogSettingsError(`${key} was removed; use dataEvidence and flowEvidence booleans`);
  }
  for (const key of ["dataEvidence", "flowEvidence"] as const) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeCatalogSettingsError(`${key} must be a boolean`);
  }
}

/** Shared by creation (before allocating an agent) and atomic settings updates. */
export function validateNativeCatalogSettings(
  settings: {
    nativeCatalogVersion?: string;
    agentMode?: string;
    nativeToolMode?: string;
    nativeProfileCollection?: boolean;
    nativeTaskHistory?: boolean;
    nativeTaskContext?: boolean;
    nativeTaskCache?: boolean;
    nativeTaskReuse?: boolean;
    nativeTaskReceipts?: boolean;
    nativeCompactIndex?: boolean;
    nativeDemandExecution?: boolean;
    nativeDirectReturn?: boolean;
    nativeCompactPrompt?: boolean;
    dataEvidence?: boolean;
    flowEvidence?: boolean;
  } = {}
): NativeCatalogVersion {
  validateEvidenceSettings(settings);
  if (settings.nativeTaskCache !== undefined && typeof settings.nativeTaskCache !== "boolean")
    throw new NativeCatalogSettingsError("nativeTaskCache must be a boolean");
  const version = settings.nativeCatalogVersion ?? DEFAULT_AGENT_SETTINGS.nativeCatalogVersion ?? "v1";
  if (version !== "v1" && version !== "v2") {
    throw new NativeCatalogSettingsError("Unknown native catalog version");
  }
  if (settings.nativeProfileCollection !== undefined && typeof settings.nativeProfileCollection !== "boolean") {
    throw new NativeCatalogSettingsError("nativeProfileCollection must be a boolean");
  }
  if (settings.nativeProfileCollection && version !== "v2") {
    throw new NativeCatalogSettingsError("Native profile collection requires catalog v2");
  }
  if (
    version === "v2" &&
    ((settings.agentMode ?? DEFAULT_AGENT_SETTINGS.agentMode) !== AgentMode.NATIVE ||
      (settings.nativeToolMode ?? DEFAULT_AGENT_SETTINGS.nativeToolMode) !== "batch")
  ) {
    throw new NativeCatalogSettingsError("Native catalog v2 requires agentMode:native and nativeToolMode:batch");
  }
  for (const name of [
    "nativeTaskHistory",
    "nativeTaskContext",
    "nativeDirectReturn",
    "nativeCompactPrompt",
    "nativeTaskReuse",
    "nativeTaskReceipts",
    "nativeCompactIndex",
    "nativeDemandExecution",
  ] as const) {
    if (settings[name] !== undefined && typeof settings[name] !== "boolean")
      throw new NativeCatalogSettingsError(`${name} must be a boolean`);
    if (settings[name] && version !== "v2") throw new NativeCatalogSettingsError(`${name} requires native catalog v2`);
  }
  if (settings.nativeTaskReuse && (!settings.nativeTaskContext || !settings.nativeCompactPrompt))
    throw new NativeCatalogSettingsError("nativeTaskReuse requires nativeTaskContext and nativeCompactPrompt");
  // Receipts and the compact index are renderings of the task context; demand
  // execution reads what a task demanded from the same batches. None has a
  // meaning outside that context.
  for (const name of ["nativeTaskReceipts", "nativeCompactIndex", "nativeDemandExecution"] as const)
    if (settings[name] && !settings.nativeTaskContext)
      throw new NativeCatalogSettingsError(`${name} requires nativeTaskContext`);
  if (settings.nativeTaskReceipts && !settings.nativeTaskHistory)
    throw new NativeCatalogSettingsError("nativeTaskReceipts requires nativeTaskHistory");
  return version;
}
