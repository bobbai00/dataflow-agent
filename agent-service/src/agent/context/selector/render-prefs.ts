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
 * Agent-declared result-view preferences (write-time render knobs).
 *
 * `createOrModifyOperator` accepts optional `outputSummary` ("minimal" |
 * "standard"). They are VIEW-ONLY: the
 * operator always computes its full output and downstream operators always
 * receive the complete data. A preference binds to the submitted VERSION and
 * lasts until the next landed edit (an edit that omits it resets to the
 * default) — so re-choosing costs zero additional cache breaks: the edit was
 * already rewriting that operator's block.
 *
 * This module maps the latest landed version's preferences onto per-operator
 * summarize() overrides for the LATEST (current-snapshot) render. Preferences
 * only ever LOWER detail relative to the arm's base (never raise) — the knobs
 * are a savings lever; raising detail is inspectResult's job.
 */

import type { Dossier } from "../summarize/dossier";
import {
  applySummarizeParamsPatch,
  resolveOperatorParams,
  type OperatorParamsOverride,
  type SummarizeParams,
} from "../summarize/params";

/** Rows rendered for `outputSummary: "minimal"` (first 2 + last 1). */
export const MINIMAL_SAMPLE_ROWS = 3;

/** The latest LANDED version's prefs for an operator (absent ⇒ defaults). */
export function latestRenderPrefs(dossier: Dossier, operatorId: string): { outputSummary?: "minimal" | "standard" } {
  const d = dossier.operators.get(operatorId);
  if (!d) return {};
  for (let i = d.codeVersions.length - 1; i >= 0; i--) {
    const v = d.codeVersions[i];
    if (v.status !== "ok") continue; // rejected submissions never landed
    return { outputSummary: v.outputSummary };
  }
  return {};
}

export function applyRenderPrefs(base: SummarizeParams, dossier: Dossier): SummarizeParams {
  if (base.trajectory.events !== "none" || !base.currentSnapshot) return base;

  const overrides: Record<string, OperatorParamsOverride> = {};
  for (const operator of dossier.leafSnapshot.workflow.operators) {
    const operatorId = operator.operatorID;
    const prefs = latestRenderPrefs(dossier, operatorId);
    if (prefs.outputSummary === undefined) continue;

    const baseOperator = resolveOperatorParams(base, operatorId);
    const override: OperatorParamsOverride = { result: { latest: {} } };
    let changed = false;

    if (prefs.outputSummary === "minimal" && baseOperator.result.latest.detail === "sample") {
      const baseRows = baseOperator.result.latest.tuple.sampleRows;
      // Never raise: an existing tighter cap wins.
      const sampleRows = baseRows > 0 ? Math.min(baseRows, MINIMAL_SAMPLE_ROWS) : MINIMAL_SAMPLE_ROWS;
      if (sampleRows !== baseRows) {
        override.result!.latest!.tuple = { sampleRows };
        changed = true;
      }
    }

    if (changed) overrides[operatorId] = override;
  }

  if (Object.keys(overrides).length === 0) return base;
  return applySummarizeParamsPatch(base, { operators: { overrides } });
}

/* ============================================================================
 *  DELTA event-scoping — a version's prefs govern the observations rendered
 *  while that version was active: [its landed event, next landed event).
 *  Historical facts only ⇒ append-only (an old event's render never changes).
 * ========================================================================= */

export interface RenderPrefRange {
  from: number;
  to: number; // exclusive; Infinity for the current version
  outputSummary?: "minimal" | "standard";
}

export function buildRenderPrefRanges(dossier: Dossier): Map<string, RenderPrefRange[]> {
  const ranges = new Map<string, RenderPrefRange[]>();
  for (const [operatorId, d] of dossier.operators) {
    const landed = d.codeVersions.filter(v => v.status === "ok");
    const opRanges: RenderPrefRange[] = [];
    for (let i = 0; i < landed.length; i++) {
      const v = landed[i];
      if (v.outputSummary === undefined) continue;
      opRanges.push({
        from: v.eventIndex,
        to: i + 1 < landed.length ? landed[i + 1].eventIndex : Infinity,
        outputSummary: v.outputSummary,
      });
    }
    if (opRanges.length > 0) ranges.set(operatorId, opRanges);
  }
  return ranges;
}

export function renderPrefsAt(
  ranges: Map<string, RenderPrefRange[]> | undefined,
  operatorId: string,
  eventIndex: number
): RenderPrefRange | undefined {
  const opRanges = ranges?.get(operatorId);
  if (!opRanges) return undefined;
  for (const range of opRanges) {
    if (eventIndex >= range.from && eventIndex < range.to) return range;
  }
  return undefined;
}
