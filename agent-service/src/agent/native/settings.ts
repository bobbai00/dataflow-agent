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

/** Refuse a key that is not one of the settings, by name, so a client's
 * removed or misspelled setting fails instead of being ignored. */
export function refuseUnknownSettings(settings: unknown, keys: ReadonlySet<string>): void {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
  for (const key of Object.keys(settings))
    if (!keys.has(key)) throw new NativeCatalogSettingsError(`${key} is not a setting`);
}

/** Refuse an invalid value or combination of settings rather than coerce it.
 * Shared by creation (before allocating an agent) and atomic settings updates. */
export function validateNativeSettings(settings: object = {}): void {
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
  const limit = supplied.fullResultCharLimit;
  if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 128 || Number(limit) > 100000))
    throw new NativeCatalogSettingsError("fullResultCharLimit must be an integer between 128 and 100000");
  if (supplied.tableFormat !== undefined && !["markdown", "tsv"].includes(String(supplied.tableFormat)))
    throw new NativeCatalogSettingsError("tableFormat must be markdown or tsv");
  for (const key of ["keyValueColumns", "fullPreviewRows"]) {
    const value = supplied[key];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100000))
      throw new NativeCatalogSettingsError(`${key} must be an integer between 0 and 100000`);
  }
  for (const key of [
    "optionalPython",
    "dataHygiene",
    "pandasRound",
    "compactRecords",
    "answerOnlyReply",
    "dataEvidence",
    "flowEvidence",
    "operatorDoc",
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
  const { catalogSource, catalogRecent } = settings as Record<string, unknown>;
  if (catalogSource !== undefined && catalogSource !== "full" && catalogSource !== "docstring")
    throw new NativeCatalogSettingsError('catalogSource must be "full" or "docstring"');
  if (
    catalogRecent !== undefined &&
    (!Number.isInteger(catalogRecent) || Number(catalogRecent) < 0 || Number(catalogRecent) > 50)
  )
    throw new NativeCatalogSettingsError("catalogRecent must be an integer between 0 and 50");
}
