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

import type { NativeEvidenceFact, NativeObservation } from "./evidence";

/** Structured identities, not parsing of model-facing metric sentences. */
export interface NativeColumnCount {
  column: string;
  resultVersion: string;
  scope: string;
  rows: number;
  nulls: number;
  nonnull: number;
  distinct: number | null;
}

export interface NativeUpstreamIdentity {
  operatorId: string;
  resultVersion: string;
}

/** Compact only the already-selected facts. Do not spend the saved budget on
 * additional samples/facts. Historical frames are never passed through here. */
export function compactNativeObservation(
  observation: NativeObservation,
  facts: readonly NativeEvidenceFact[]
): NativeObservation {
  // Version 2 already packs counts, ranges and values into atomic table rows.
  if (observation.version === 2) return observation;
  const byId = new Map(facts.map(f => [f.id, f]));
  const countKey = (c: NativeColumnCount) =>
    JSON.stringify([c.resultVersion, c.column, c.scope, c.rows, c.nulls, c.nonnull, c.distinct]);
  // A count is redundant only when a displayed fact of the SAME family already
  // shows it: the data and flow families are orthogonal, so a flow line never
  // removes a data line (or the reverse), whatever the other switch is.
  const covered = new Set(
    observation.chunks.flatMap(c => {
      const fact = byId.get(c.id);
      return fact?.coveredCount ? [`${fact.family}:${countKey(fact.coveredCount)}`] : [];
    })
  );
  const omitted = [...observation.omitted];
  const chunks = observation.chunks.filter(c => {
    const fact = byId.get(c.id);
    const metric = fact?.columnCount;
    if (!metric || !covered.has(`${fact!.family}:${countKey(metric)}`)) return true;
    omitted.push({ id: c.id, reason: "redundant_displayed_fact" });
    return false;
  });
  const groups = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const count = byId.get(chunk.id)?.columnCount;
    if (!count) continue;
    const key = JSON.stringify([count.resultVersion, count.scope, count.rows]);
    const group = groups.get(key) ?? [];
    group.push(chunk);
    groups.set(key, group);
  }
  const replacements = new Map<string, (typeof chunks)[number]>();
  const merged = new Set<string>();
  for (const group of groups.values()) {
    const metrics = group.map(c => byId.get(c.id)!.columnCount!);
    const text = [
      `Data measurement: column counts (${metrics[0].scope})`,
      "column | null | nonnull | distinct(nonnull)",
      ...metrics.map(c => `${JSON.stringify(c.column)} | ${c.nulls} | ${c.nonnull} | ${c.distinct ?? "unknown"}`),
    ].join("\n");
    // A one-column sentence can be shorter than a table. Never expand a view.
    if (text.length >= group.map(c => c.text).join("\n").length) continue;
    replacements.set(group[0].id, { id: `data.counts.${group[0].id}`, text, members: group.map(c => c.id) });
    group.slice(1).forEach(c => merged.add(c.id));
  }
  const compact = chunks.flatMap(chunk => {
    if (merged.has(chunk.id)) return [];
    const replacement = replacements.get(chunk.id);
    if (replacement) return [replacement];
    const upstream = byId.get(chunk.id)?.upstream;
    return [{ ...chunk, ...(upstream ? { upstream: { ...upstream } } : {}) }];
  });
  return {
    ...observation,
    chunks: compact,
    selected: compact.flatMap(c => c.members ?? [c.id]),
    text: compact.map(c => c.text).join("\n"),
    omitted,
  };
}

/** The memo belongs to ONE rendered event/current snapshot. Register a fact
 * only after restriction has actually retained its complete text. A reference
 * can never point at an unobserved output, an omitted chunk, or another event.
 * Standalone stored observations remain self-contained for inspection/replay. */
export function shareNativeObservation(
  text: string,
  observation: NativeObservation,
  observerId: string,
  seen?: Map<string, string>
): string {
  if (!seen) return text;
  const candidates = new Map(observation.chunks.filter(c => c.upstream).map(c => [c.text, c.upstream!]));
  return text
    .split("\n")
    .map(line => {
      const origin = candidates.get(line);
      if (!origin) return line;
      const key = JSON.stringify([origin.operatorId, origin.resultVersion, line]);
      const earlier = seen.get(key);
      if (earlier && earlier !== observerId) {
        const reference = `${observation.version === 2 ? "- flow: see" : "Flow upstream: see"} ${JSON.stringify(earlier)} above for ${JSON.stringify(origin.operatorId)}.`;
        if (reference.length < line.length) return reference;
      }
      if (!earlier) seen.set(key, observerId);
      return line;
    })
    .join("\n");
}
