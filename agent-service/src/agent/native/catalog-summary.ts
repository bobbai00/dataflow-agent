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

import type { OperatorInfo } from "../../types/execution";
import type { NativeOpView } from "./catalog";
import { columnType, formatCount, shapeText } from "./observation-format";
import type { ProfileScalar } from "./profiles";

const brief = (value: string, limit = 48) => {
  const text = value.replace(/\s+/g, " ");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};
const rangeValue = (value: ProfileScalar | null | undefined) =>
  value?.type === "int64" ? value.value : value?.type === "float64" ? Number(value.value.toPrecision(4)) : null;

/** Task-time metadata only: no rows, frequency values, new profiling or execution.
 * A profile describes this saved output only when its result identity matches. */
export function catalogResultSummary(op: NativeOpView | undefined, info: OperatorInfo): string {
  if (info.error || !["Completed", "CompletedFromCache"].includes(info.state)) return "unavailable";
  const profile =
    info.resultVersion?.complete &&
    info.resultVersion.operatorRevision === op?.revision &&
    info.tableProfile?.resultVersion === info.resultVersion.id &&
    info.tableProfile.status !== "unavailable"
      ? info.tableProfile
      : undefined;
  const schema = info.resultSchema ?? profile?.schema ?? [];
  const count = info.resultSchema?.length ?? profile?.columnCount;
  const parts = [shapeText(info.totalRowCount, count)];
  if (profile)
    parts.push(
      profile.coverage.complete
        ? "stats full"
        : `stats partial ${formatCount(profile.coverage.rowsProcessed)}/${formatCount(info.totalRowCount)} rows`
    );
  // The block's columns field already carries the schema. Repeat a name here
  // only to identify actual statistics for that column.
  const fieldsWithStats = schema.flatMap(field => {
    const stats = profile?.columns[field.name];
    return stats ? [{ field, stats }] : [];
  });
  for (const { field, stats } of fieldsWithStats.slice(0, 3)) {
    const details = [
      `null=${formatCount(stats.nullCount)}/${formatCount(stats.rowsProcessed)}`,
      `distinct=${formatCount(stats.distinctCount)}`,
    ];
    const min = rangeValue(stats.min);
    const max = rangeValue(stats.max);
    if (min !== null && max !== null) details.push(`range=${min}..${max}`);
    parts.push(`${brief(field.name)}:${columnType(field.type)}(${details.join(", ")})`);
  }
  if (fieldsWithStats.length > 3) parts.push(`+${fieldsWithStats.length - 3} column stats`);
  const scan = profile?.native?.operations?.scan as
    | { sources?: Array<{ path?: unknown }>; selectedFiles?: number; resolvedFiles?: number; omittedFiles?: number }
    | undefined;
  if (
    scan &&
    [scan.selectedFiles, scan.resolvedFiles, scan.omittedFiles].every(v => Number.isSafeInteger(v) && v! >= 0) &&
    scan.selectedFiles! + scan.omittedFiles! === scan.resolvedFiles
  ) {
    parts.push(`files selected=${scan.selectedFiles}/${scan.resolvedFiles}, omitted=${scan.omittedFiles}`);
  }
  const read = scan?.sources?.flatMap(source => (typeof source.path === "string" ? [source.path] : [])) ?? [];
  const declared = op?.type === "Scan" ? op.properties.files : undefined;
  const paths = read.length
    ? read
    : typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((v): v is string => typeof v === "string")
        : [];
  if (paths.length) {
    // Keep the filename when an absolute path is long; exact definitions remain inspectable.
    const shown = paths.slice(0, 3).map(path => brief(path.length > 80 ? `…${path.slice(-80)}` : path, 81));
    parts.push(
      `${read.length ? "files read" : "source paths"}: ${shown.join(", ")}${paths.length > 3 ? `, +${paths.length - 3} files` : ""}`
    );
  }
  return parts.join("; ");
}
