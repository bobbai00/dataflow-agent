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

/** A rejected setting is a client error, not a server failure. */
export class NativeCatalogSettingsError extends Error {}

/** Settings that no longer exist. They are refused rather than mapped so an
 * old experiment configuration never silently becomes a new arm. */
const REMOVED_SETTINGS = [
  "nativeToolMode",
  "nativeCatalogVersion",
  "allowedOperatorTypes",
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

/** Deliberate breaking change: never silently reinterpret old experiments. */
export function validateEvidenceSettings(settings: object): void {
  for (const key of REMOVED_SETTINGS) {
    if (Object.hasOwn(settings, key))
      throw new NativeCatalogSettingsError(
        key === "nativeToolMode" || key === "nativeCatalogVersion"
          ? `${key} was removed; native mode is the expression program with the single catalog`
          : key === "allowedOperatorTypes"
            ? "allowedOperatorTypes was removed with the general mode; the modes are native and code"
            : `${key} was removed; use dataEvidence and flowEvidence booleans`
      );
  }
  for (const key of ["dataEvidence", "flowEvidence", "nativeProfileCollection", "dataflowReasoning"] as const) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeCatalogSettingsError(`${key} must be a boolean`);
  }
}

/** Shared by creation (before allocating an agent) and atomic settings updates. */
export function validateNativeSettings(
  settings: {
    agentMode?: string;
    nativeTaskHistory?: unknown;
    nativeTaskContext?: unknown;
    nativeTaskCache?: unknown;
    nativeTaskRestore?: unknown;
    nativeAnalysisState?: unknown;
    nativeTaskEfficiency?: unknown;
    nativeDefinitionRegistry?: unknown;
    nativeDefinitionSignatures?: unknown;
    nativeTaskMemoryChars?: unknown;
  } = {}
): void {
  validateEvidenceSettings(settings);
  validateRetiredTaskSettings(settings);
  if (settings.agentMode !== undefined && settings.agentMode !== "native" && settings.agentMode !== "code") {
    throw new NativeCatalogSettingsError(
      `Unknown agentMode ${JSON.stringify(settings.agentMode)}; use "native" or "code"`
    );
  }
  // History and task context change how completed work is retained and shown.
  // Analysis state also enables shared definitions and dependency forks. These
  // settings apply only to the native expression program.
  for (const name of [
    "nativeTaskHistory",
    "nativeTaskContext",
    "nativeAnalysisState",
    "nativeTaskEfficiency",
    "nativeDefinitionRegistry",
    "nativeDefinitionSignatures",
  ] as const) {
    const value = settings[name];
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeCatalogSettingsError(`${name} must be a boolean`);
    if (value === true && settings.agentMode === "code")
      throw new NativeCatalogSettingsError(`${name} requires agentMode "native"`);
  }
  if (
    settings.nativeTaskEfficiency === true &&
    (!settings.nativeTaskHistory || !settings.nativeTaskContext || !settings.nativeAnalysisState)
  )
    throw new NativeCatalogSettingsError(
      "nativeTaskEfficiency requires nativeTaskHistory, nativeTaskContext and nativeAnalysisState"
    );
  // The registry reads versions from task history and the shared-function
  // graph, and renders the compact entries; it is a layer over efficiency.
  if (settings.nativeDefinitionRegistry === true && !settings.nativeTaskEfficiency)
    throw new NativeCatalogSettingsError("nativeDefinitionRegistry requires nativeTaskEfficiency");
  if (settings.nativeDefinitionSignatures === true && !settings.nativeDefinitionRegistry)
    throw new NativeCatalogSettingsError("nativeDefinitionSignatures requires nativeDefinitionRegistry");
  if (
    settings.nativeTaskMemoryChars !== undefined &&
    (typeof settings.nativeTaskMemoryChars !== "number" ||
      !Number.isSafeInteger(settings.nativeTaskMemoryChars) ||
      settings.nativeTaskMemoryChars < 4000 ||
      settings.nativeTaskMemoryChars > 200000)
  )
    throw new NativeCatalogSettingsError("nativeTaskMemoryChars must be an integer from 4000 to 200000");
  // Cache boundaries and restore modify task history and do nothing without it,
  // so their defaults are harmless in either mode.
  for (const name of ["nativeTaskCache", "nativeTaskRestore"] as const) {
    const value = settings[name];
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeCatalogSettingsError(`${name} must be a boolean`);
  }
}

/** Old benchmark arms must run their recorded revisions, never a remapped arm. */
export function validateRetiredTaskSettings(settings: object): void {
  for (const name of [
    "nativeTaskReuse",
    "nativeTaskReceipts",
    "nativeCompactIndex",
    "nativeDemandExecution",
    "nativeKeptFrames",
    "nativeDirectReturn",
    "nativeCompactPrompt",
  ]) {
    if (Object.hasOwn(settings, name))
      throw new NativeCatalogSettingsError(
        `${name} is retired; use the shared ReAct loop with nativeTaskContext/nativeTaskHistory`
      );
  }
}
