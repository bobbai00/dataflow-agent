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
  const supplied = settings as Record<string, unknown>;
  if (supplied.nativeFormat !== undefined && !["expression", "json"].includes(String(supplied.nativeFormat)))
    throw new NativeCatalogSettingsError("nativeFormat must be expression or json");
  if (supplied.nativePromptDetail !== undefined && !["full", "on_demand"].includes(String(supplied.nativePromptDetail)))
    throw new NativeCatalogSettingsError("nativePromptDetail must be full or on_demand");
  if (supplied.taskContext !== undefined && !["trajectory", "dependencies"].includes(String(supplied.taskContext)))
    throw new NativeCatalogSettingsError("taskContext must be trajectory or dependencies");
  if (supplied.retrievalViews !== undefined) {
    const views = supplied.retrievalViews;
    if (
      !Array.isArray(views) ||
      views.length === 0 ||
      new Set(views).size !== views.length ||
      views.some(v => !["full", "sample", "sample_stats"].includes(v))
    )
      throw new NativeCatalogSettingsError(
        "retrievalViews must be a nonempty list of unique full, sample, or sample_stats views"
      );
  }
  for (const key of ["fullResultCharLimit", "dataEvidenceCharLimit", "flowEvidenceCharLimit"]) {
    const value = supplied[key];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 128 || Number(value) > 100000))
      throw new NativeCatalogSettingsError(`${key} must be an integer between 128 and 100000`);
  }
  if (supplied.tableFormat !== undefined && !["markdown", "tsv"].includes(String(supplied.tableFormat)))
    throw new NativeCatalogSettingsError("tableFormat must be markdown or tsv");
  for (const key of [
    "keyValueColumns",
    "columnsShown",
    "definitionChars",
    "cellChars",
    "topValues",
    "catalogRecords",
  ]) {
    const value = supplied[key];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100000))
      throw new NativeCatalogSettingsError(`${key} must be an integer between 0 and 100000`);
  }
  for (const key of REMOVED_SETTINGS) {
    if (Object.hasOwn(settings, key))
      throw new NativeCatalogSettingsError(
        key === "nativeToolMode" || key === "nativeCatalogVersion"
          ? `${key} was removed; native mode uses explicit graph commands with the single catalog`
          : key === "allowedOperatorTypes"
            ? "allowedOperatorTypes was removed with the general mode; the modes are native and code"
            : `${key} was removed; use dataEvidence and flowEvidence booleans`
      );
  }
  for (const key of [
    "multiTask",
    "answerEcho",
    "dataEvidence",
    "flowEvidence",
    "nativeProfileCollection",
    "dataflowReasoning",
    "nativeChecks",
    "stateHistory",
    "stateLedger",
  ] as const) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeCatalogSettingsError(`${key} must be a boolean`);
  }
  const scope = (settings as Record<string, unknown>).nativeProfileScope;
  if (scope !== undefined && scope !== "prefix" && scope !== "full")
    throw new NativeCatalogSettingsError('nativeProfileScope must be "prefix" or "full"');
}

/** A distinct context policy must not silently override another experiment. */
export function validateTaskContextSettings(input: object): void {
  const settings = input as Record<string, unknown>;
  if (settings.taskContext !== "dependencies") return;
  if (
    settings.agentMode !== "native" ||
    settings.contextMode !== "delta" ||
    !settings.stateHistory ||
    (settings.messageLayout !== undefined && settings.messageLayout !== "native")
  )
    throw new NativeCatalogSettingsError(
      "taskContext dependencies requires native DELTA context, stateHistory and native message layout"
    );
  if (
    settings.turnHistory === "index" ||
    settings.stateLedger ||
    settings.versionedMode ||
    settings.sessionTurns ||
    settings.contextWindowTokens ||
    settings.enableCompactTool ||
    settings.staticCompaction ||
    settings.summarizeParams ||
    settings.selectorConfig ||
    settings.learnedConfig ||
    settings.tunerConfig ||
    settings.frontierDecayConfig ||
    settings.probeRetirementConfig ||
    settings.rolePolicyConfig ||
    settings.foldResolvedRevisionsConfig ||
    settings.enableRenderPrefs
  )
    throw new NativeCatalogSettingsError(
      "taskContext dependencies cannot be combined with another context policy or ledger"
    );
}

/** Shared by creation (before allocating an agent) and atomic settings updates. */
export function validateNativeSettings(settings: { agentMode?: string } = {}): void {
  validateEvidenceSettings(settings);
  if (settings.agentMode !== undefined && settings.agentMode !== "native" && settings.agentMode !== "code") {
    throw new NativeCatalogSettingsError(
      `Unknown agentMode ${JSON.stringify(settings.agentMode)}; use "native" or "code"`
    );
  }
}
