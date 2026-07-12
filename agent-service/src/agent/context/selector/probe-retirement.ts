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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Retire superseded isolated probes (the rank-4 static rule from the
 * Delta-vs-Latest cost audit).
 *
 * Agents create ORPHAN discovery operators — a sheet lister, a raw-line
 * delimiter sniff, a head-N file preview — whose entire purpose is one
 * discovery (which sheet / file / delimiter / encoding / key). Once a later
 * CONNECTED operator demonstrably encodes that discovery (the probe's output
 * values appear inside a quoted literal of the downstream operator's code, and
 * that operator has executed healthily), the probe's rendered table is dead
 * weight on every turn. This overlay replaces it with a compact extracted
 * FACT naming the discovery and where it is now encoded — never with silence.
 *
 * Safety guards (audit §Rank 4): age + disconnection alone are NEVER
 * sufficient — the discovery must be provably encoded downstream, so the only
 * evidence for a still-open source-selection decision is never removed
 * (`biomedical-hard-5` is the canonical negative control). The latest healthy
 * output, frontier operators, errored / dirty-load / deleted states are all
 * protected. The encoding predicate is a function of historical code versions
 * and result events, so a retirement latches while the probe stays settled;
 * re-editing the probe re-activates it (frontier) and un-retires it.
 */

import { z } from "zod";
import type { OperatorInfo } from "../../../types/execution";
import type { Dossier } from "../summarize/dossier";
import { applySummarizeParamsPatch, type OperatorParamsOverride, type SummarizeParams } from "../summarize/params";
import { extractFeatures } from "./features";

export const ProbeRetirementConfigSchema = z.object({
  /** Grace period (events) after the probe's latest edit. */
  minStepsSinceEdit: z.number().int().min(0).default(2),
  /** Minimum length of a probe output value for the encoded-downstream match
   *  (short strings like "id" would false-positive against any code). */
  minValueLength: z.number().int().min(2).default(4),
});

export type ProbeRetirementConfig = z.infer<typeof ProbeRetirementConfigSchema>;

export function parseProbeRetirementConfig(raw: unknown): ProbeRetirementConfig {
  return ProbeRetirementConfigSchema.parse(raw ?? {});
}

const HIDDEN_KEYS = new Set(["__row_index__", "__is_visualization__"]);
const MAX_PROBE_VALUES = 300;
const MAX_FACT_VALUES = 3;

/** Distinct string cell values of the probe's latest result — the discovery
 *  candidates. Numeric-ish strings are skipped (sheet/file/delimiter/encoding
 *  /key choices are worded, not measured). */
export function extractProbeValues(info: OperatorInfo, minValueLength: number): string[] {
  const rows = Array.isArray(info.result) ? info.result : [];
  const values = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    for (const [key, cell] of Object.entries(row as Record<string, unknown>)) {
      if (HIDDEN_KEYS.has(key)) continue;
      if (typeof cell !== "string") continue;
      const value = cell.trim();
      if (value.length < minValueLength || value.length > 200) continue;
      if (/^[\d\s.,:+\-eE]+$/.test(value)) continue;
      values.add(value);
      if (values.size >= MAX_PROBE_VALUES) return [...values];
    }
  }
  return [...values];
}

/** Quoted string literals of a code body — where an encoded discovery lives
 *  (sheet_name="B-APM", encoding="cp1252", pd.read_csv("…/beaches.csv")). */
function quotedLiterals(code: string): string[] {
  const literals: string[] = [];
  const re = /"([^"\n]{2,400})"|'([^'\n]{2,400})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    literals.push(m[1] ?? m[2]);
  }
  return literals;
}

interface Encoding {
  consumerId: string;
  eventIndex: number;
  matched: string[];
}

export function applyProbeRetirement(
  base: SummarizeParams,
  dossier: Dossier,
  config: ProbeRetirementConfig
): SummarizeParams {
  if (base.trajectory.events !== "none" || !base.currentSnapshot) return base;

  const features = extractFeatures(dossier);
  const overrides: Record<string, OperatorParamsOverride> = {};
  const operatorIds = new Set(dossier.leafSnapshot.workflow.operators.map(operator => operator.operatorID));
  const degree = new Map<string, number>();
  const childCount = new Map<string, number>();
  for (const operatorId of operatorIds) {
    degree.set(operatorId, 0);
    childCount.set(operatorId, 0);
  }
  for (const link of dossier.leafSnapshot.workflow.links) {
    const sourceId = link.source.operatorID;
    const targetId = link.target.operatorID;
    if (!operatorIds.has(sourceId) || !operatorIds.has(targetId)) continue;
    degree.set(sourceId, (degree.get(sourceId) ?? 0) + 1);
    degree.set(targetId, (degree.get(targetId) ?? 0) + 1);
    childCount.set(sourceId, (childCount.get(sourceId) ?? 0) + 1);
  }

  const currentEventIndex = features.trajectory.currentEventIndex;
  const lastEditEvent = (operatorId: string): number => {
    const operator = dossier.operators.get(operatorId);
    return operator ? Math.max(0, ...operator.codeVersions.map(version => version.eventIndex)) : 0;
  };
  const lastResultEvent = (operatorId: string): number => {
    const operator = dossier.operators.get(operatorId);
    return operator ? Math.max(0, ...operator.resultVersions.map(version => version.eventIndex)) : 0;
  };

  // Frontier: the most recently edited op(s) + anything currently erroring.
  const latestFrontierEdit = Math.max(0, ...[...operatorIds].map(lastEditEvent));
  const frontier = new Set<string>();
  for (const operatorId of operatorIds) {
    const currentInfo = dossier.leafSnapshot.results.get(operatorId)?.info;
    if (lastEditEvent(operatorId) === latestFrontierEdit || currentInfo?.error) frontier.add(operatorId);
  }

  // The most recently produced healthy output is the live answer candidate —
  // never a retirement target.
  let latestHealthyResultEvent = 0;
  for (const operatorId of operatorIds) {
    const currentInfo = dossier.leafSnapshot.results.get(operatorId)?.info;
    if (currentInfo && !currentInfo.error) {
      latestHealthyResultEvent = Math.max(latestHealthyResultEvent, lastResultEvent(operatorId));
    }
  }

  for (const [operatorId, feature] of features.operators) {
    if (!operatorIds.has(operatorId)) continue;
    if ((childCount.get(operatorId) ?? 0) !== 0) continue; // only orphans (no consumers)
    if (frontier.has(operatorId)) continue;
    if (feature.role === "deleted" || feature.role === "blocked") continue;
    const currentInfo = dossier.leafSnapshot.results.get(operatorId)?.info;
    if (!currentInfo || currentInfo.error) continue;
    if (feature.dirtyLoad) continue;
    if (feature.stepsSinceEdit < config.minStepsSinceEdit) continue;
    if (lastResultEvent(operatorId) >= latestHealthyResultEvent) continue;

    const values = extractProbeValues(currentInfo, config.minValueLength);
    if (values.length === 0) continue;

    // Encoded-downstream: some CONNECTED operator, edited after this probe,
    // carries one of the probe's output values inside a quoted code literal
    // and has since executed healthily.
    let encoding: Encoding | undefined;
    for (const consumerId of operatorIds) {
      if (consumerId === operatorId || (degree.get(consumerId) ?? 0) === 0) continue;
      const consumer = dossier.operators.get(consumerId);
      if (!consumer) continue;
      for (const version of consumer.codeVersions) {
        if (version.status !== "ok" || version.eventIndex <= lastEditEvent(operatorId)) continue;
        const literals = quotedLiterals(version.code);
        if (literals.length === 0) continue;
        const matched = values.filter(value => literals.some(literal => literal.includes(value)));
        if (matched.length === 0) continue;
        const healthyAfter = consumer.resultVersions.some(
          result => result.eventIndex >= version.eventIndex && !result.info.error
        );
        if (!healthyAfter) continue;
        encoding = { consumerId, eventIndex: version.eventIndex, matched };
        break;
      }
      if (encoding) break;
    }
    if (!encoding) continue;

    const columns = Array.isArray(currentInfo.result)
      ? Object.keys((currentInfo.result[0] as Record<string, unknown> | undefined) ?? {}).filter(
          key => !HIDDEN_KEYS.has(key)
        ).length
      : 0;
    const rows = currentInfo.totalRowCount ?? currentInfo.outputTuples;
    const shownValues = encoding.matched
      .slice(0, MAX_FACT_VALUES)
      .map(value => `"${value.length > 60 ? `${value.slice(0, 60)}…` : value}"`)
      .join(", ");
    const fact =
      `(probe retired — its ${rows} rows × ${columns} cols output is omitted: the discovery is already ` +
      `encoded downstream — ${shownValues} used by \`${encoding.consumerId}\` (Event ${encoding.eventIndex}).)`;

    overrides[operatorId] = { result: { latest: { retirementFact: fact } } };
  }

  return applySummarizeParamsPatch(base, { operators: { overrides } });
}
