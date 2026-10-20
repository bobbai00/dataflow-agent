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

/** Removed with the JSON action tool, the text transport and LongDS support:
 * native mode has one protocol, the dataflow(python, statements) tool. */
const REMOVED_PROTOCOL_SETTINGS = [
  "nativeTransport",
  "dataflowReasoning",
  "nativePromptDetail",
  "enableAnswerGrounding",
  "seedSources",
  "taskContext",
  "multiTask",
  "stateHistory",
  "stateLedger",
  "turnHistory",
  "enableRecallTool",
  "recallMaxResultChars",
  "recallOperatorLevel",
  "specAudit",
  "indexRichTables",
  "indexDetailedOperators",
  "indexThinObservations",
  "enableResumeTool",
  "versionedMode",
  "versionedHeads",
  "sessionTurns",
  "enableCompactTool",
  "compactKeepLastSteps",
];

/** Deliberate breaking change: never silently reinterpret old experiments. */
export function validateEvidenceSettings(settings: object): void {
  const supplied = settings as Record<string, unknown>;
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
  for (const key of REMOVED_PROTOCOL_SETTINGS) {
    if (Object.hasOwn(settings, key))
      throw new NativeCatalogSettingsError(
        `${key} was removed; native mode has one protocol, the dataflow(python, statements) tool, and multiRequest for a session with several requests`
      );
  }
  for (const key of [
    "answerEcho",
    "dataEvidence",
    "flowEvidence",
    "answerStatement",
    "nativeProfileCollection",
    "nativeChecks",
  ] as const) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeCatalogSettingsError(`${key} must be a boolean`);
  }
  const scope = (settings as Record<string, unknown>).nativeProfileScope;
  if (scope !== undefined && scope !== "prefix" && scope !== "full")
    throw new NativeCatalogSettingsError('nativeProfileScope must be "prefix" or "full"');
  const multiRequest = (settings as Record<string, unknown>).multiRequest;
  if (multiRequest !== undefined && !["off", "transcript", "catalog"].includes(String(multiRequest)))
    throw new NativeCatalogSettingsError('multiRequest must be "off", "transcript" or "catalog"');
  // Catalog entries replace earlier requests in the replayed transcript, which
  // only the delta context with the native message layout has.
  const { contextMode, messageLayout } = settings as Record<string, unknown>;
  if (multiRequest === "catalog" && ((contextMode ?? "delta") !== "delta" || (messageLayout ?? "native") !== "native"))
    throw new NativeCatalogSettingsError('multiRequest "catalog" needs contextMode "delta" and messageLayout "native"');
  const { catalogSource, catalogRecent } = settings as Record<string, unknown>;
  if (catalogSource !== undefined && catalogSource !== "full" && catalogSource !== "docstring")
    throw new NativeCatalogSettingsError('catalogSource must be "full" or "docstring"');
  if (
    catalogRecent !== undefined &&
    (!Number.isInteger(catalogRecent) || Number(catalogRecent) < 0 || Number(catalogRecent) > 50)
  )
    throw new NativeCatalogSettingsError("catalogRecent must be an integer between 0 and 50");
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
