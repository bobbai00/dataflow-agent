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

/**
 * SELECTOR feature extraction.
 *
 * The selector (selector.ts) is a policy `features → SummarizeParams`. This
 * module is the shared substrate both the rule-based policy AND any future
 * learned policy consume: it turns the pure `Dossier` (per-operator code/result
 * versions + the leaf DAG) into a per-operator feature vector — role, edit
 * state, and data-shape flags — plus a few trajectory-level features.
 *
 * Every feature is a function of already-computed state (no I/O, no LLM), so a
 * recorded trace can be re-featurized offline for training. The docstrings note
 * which intuition category (see docs/summarize-tuning-intuitions.md) each
 * feature serves.
 */

import type { OperatorInfo } from "../../../types/execution";
import type { Dossier, OperatorDossier } from "../summarize/dossier";

/** Operator role on the current snapshot — the primary allocation axis (§3A).
 *  Precedence when several could apply: deleted > blocked > frontier >
 *  near-frontier > terminal > source > interior. */
export type OperatorRole =
  | "deleted" // removed from the DAG and not re-created
  | "blocked" // no own result; an upstream errored
  | "frontier" // the op just edited this turn, or currently erroring
  | "near-frontier" // a direct upstream of the frontier (read before the next edit)
  | "terminal" // a DAG leaf with a result (often the answer op)
  | "source" // no incoming links (a load)
  | "interior"; // executed, settled, has a healthy consumer

export interface OperatorFeatures {
  operatorId: string;
  role: OperatorRole;
  /** # createOrModifyOperator calls to this op along the path (thrash signal, §3C). */
  editCount: number;
  /** currentEventIndex − last-edit event; 0 ⇒ edited this turn (§3A.2). */
  stepsSinceEdit: number;
  /** Latest result carries an error. */
  isErroring: boolean;
  /** Latest result exists and is non-error. */
  hasResult: boolean;
  /** Some downstream operator has a non-error result → this op's raw sample is
   *  now dead weight (§3A.3, the stale-source lever). */
  hasHealthyConsumer: boolean;
  isSource: boolean;
  isTerminalNode: boolean;
  /** Output column count of the latest result (0 when unknown). */
  columns: number;
  /** Wide table — column-cap / prefer-stats territory (§3B.4). */
  wide: boolean;
  /** Generic/`Unnamed` headers ⇒ the load is likely mis-parsed; the schema is a
   *  lie, keep raw bytes (§3B.1). */
  dirtyLoad: boolean;
  /** Has a low-cardinality string column (stats can show the exact value set the
   *  filter needs — cheaper than raw rows) (§3B.2). */
  categoricalLowCard: boolean;
  /** A text column whose sample values are mostly numeric — the dtype-anomaly
   *  signal; surface the contaminants (§3B, the str-typed-numeric intuition). */
  numericAsText: boolean;
  hasColumnStats: boolean;
}

export interface TrajectoryFeatures {
  currentEventIndex: number;
  frontierOpId?: string;
  /** Some operator has been edited ≥ `thrashThreshold` times. */
  anyThrashing: boolean;
  operatorCount: number;
}

export interface SelectorFeatures {
  operators: Map<string, OperatorFeatures>;
  trajectory: TrajectoryFeatures;
}

const HIDDEN_KEYS = new Set(["__row_index__", "__is_visualization__"]);

function latestResult(d: OperatorDossier): OperatorInfo | undefined {
  return d.resultVersions.length > 0 ? d.resultVersions[d.resultVersions.length - 1].info : undefined;
}

function lastEditEvent(d: OperatorDossier): number {
  let m = 0;
  for (const cv of d.codeVersions) if (cv.eventIndex > m) m = cv.eventIndex;
  return m;
}

function resultColumns(info: OperatorInfo | undefined): string[] {
  const r = info?.result;
  if (!Array.isArray(r) || r.length === 0 || typeof r[0] !== "object" || r[0] === null) return [];
  return Object.keys(r[0] as Record<string, unknown>).filter(k => !HIDDEN_KEYS.has(k));
}

/** Generic auto-generated column names (`Unnamed: 1`, bare `0`/`1`) mean the
 *  loader parsed the file wrong — the classic dirty-load tell. */
function looksDirtyLoad(cols: string[]): boolean {
  if (cols.length === 0) return false;
  const generic = cols.filter(c => /^Unnamed/i.test(c) || /^\d+$/.test(c)).length;
  return generic >= Math.max(1, Math.ceil(cols.length * 0.3));
}

/** Sample-based: a text column that is mostly-but-not-entirely numeric. A
 *  selector INPUT feature only — the corresponding rendered hint (dtypeAnomaly)
 *  was removed per the raw-facts-only decision. */
function hasNumericAsText(info: OperatorInfo | undefined): boolean {
  const rows = info?.result;
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const cols = resultColumns(info);
  for (const c of cols) {
    const vals = rows
      .map(r => (r as Record<string, unknown>)[c])
      .filter(v => v !== null && v !== undefined && v !== "");
    if (vals.length < 2) continue;
    const strs = vals.filter(v => typeof v === "string") as string[];
    if (strs.length < vals.length * 0.8) continue;
    const numeric = strs.filter(s => {
      const cleaned = s
        .trim()
        .replace(/^\((.*)\)$/, "-$1")
        .replace(/[$,%\s]/g, "");
      return cleaned !== "" && cleaned !== "-" && Number.isFinite(Number(cleaned));
    }).length;
    const frac = numeric / strs.length;
    if (frac >= 0.6 && frac < 1) return true;
  }
  return false;
}

export interface FeatureOptions {
  /** distinct-count ceiling for "low-cardinality categorical". */
  categoricalMaxDistinct?: number;
  /** column-count ceiling above which a table is "wide". */
  wideColumns?: number;
  /** edit-count at which an operator counts as thrashing. */
  thrashThreshold?: number;
}

/**
 * Featurize a dossier. Pure; O(operators + links).
 */
export function extractFeatures(dossier: Dossier, opts: FeatureOptions = {}): SelectorFeatures {
  const categoricalMaxDistinct = opts.categoricalMaxDistinct ?? 12;
  const wideColumns = opts.wideColumns ?? 50;
  const thrashThreshold = opts.thrashThreshold ?? 3;

  const wf = dossier.leafSnapshot.workflow;
  const inLeaf = new Set(wf.operators.map(o => o.operatorID));

  // Adjacency on the leaf DAG.
  const parents = new Map<string, string[]>(); // op → upstream ids
  const children = new Map<string, string[]>(); // op → downstream ids
  for (const id of inLeaf) {
    parents.set(id, []);
    children.set(id, []);
  }
  for (const link of wf.links) {
    const s = link.source.operatorID;
    const t = link.target.operatorID;
    if (!inLeaf.has(s) || !inLeaf.has(t)) continue;
    children.get(s)!.push(t);
    parents.get(t)!.push(s);
  }

  // currentEventIndex + frontier (most-recently-edited op; erroring breaks ties).
  let currentEventIndex = 0;
  for (const d of dossier.operators.values()) {
    const e = Math.max(lastEditEvent(d), ...d.resultVersions.map(r => r.eventIndex), 0);
    if (e > currentEventIndex) currentEventIndex = e;
  }
  let frontierOpId: string | undefined;
  let frontierEvent = -1;
  for (const d of dossier.operators.values()) {
    if (!inLeaf.has(d.operatorId)) continue;
    const e = lastEditEvent(d);
    const erroring = !!latestResult(d)?.error;
    if (e > frontierEvent || (e === frontierEvent && erroring)) {
      frontierEvent = e;
      frontierOpId = d.operatorId;
    }
  }
  const frontierUpstreams = new Set(frontierOpId ? (parents.get(frontierOpId) ?? []) : []);

  const errorReachesFrom = (opId: string): boolean => {
    // Any upstream (transitive) with an error, when this op has no own result.
    const seen = new Set<string>();
    const stack = [...(parents.get(opId) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const info = latestResult(dossier.operators.get(cur)!);
      if (info?.error) return true;
      if (info) continue; // ran OK — not the blocker on this branch
      for (const p of parents.get(cur) ?? []) stack.push(p);
    }
    return false;
  };

  const ops = new Map<string, OperatorFeatures>();
  let anyThrashing = false;

  for (const [opId, d] of dossier.operators) {
    const info = latestResult(d);
    const isErroring = !!info?.error;
    const hasResult = !!info && !info.error;
    const editCount = d.codeVersions.length;
    if (editCount >= thrashThreshold) anyThrashing = true;
    const stepsSinceEdit = currentEventIndex - lastEditEvent(d);
    const present = inLeaf.has(opId);
    const isSource = present && (parents.get(opId)?.length ?? 0) === 0;
    const isTerminalNode = present && (children.get(opId)?.length ?? 0) === 0;
    const hasHealthyConsumer = (children.get(opId) ?? []).some(c => {
      const ci = latestResult(dossier.operators.get(c)!);
      return !!ci && !ci.error;
    });

    let role: OperatorRole;
    if (d.deleted || !present) role = "deleted";
    else if (!info && errorReachesFrom(opId)) role = "blocked";
    else if (opId === frontierOpId || isErroring) role = "frontier";
    else if (frontierUpstreams.has(opId)) role = "near-frontier";
    else if (isTerminalNode && hasResult) role = "terminal";
    else if (isSource) role = "source";
    else role = "interior";

    const cols = resultColumns(info);
    ops.set(opId, {
      operatorId: opId,
      role,
      editCount,
      stepsSinceEdit,
      isErroring,
      hasResult,
      hasHealthyConsumer,
      isSource,
      isTerminalNode,
      columns: cols.length,
      wide: cols.length > wideColumns,
      dirtyLoad: looksDirtyLoad(cols),
      // Retired learned-model feature positions remain zero, not fed by old stats.
      categoricalLowCard: false,
      numericAsText: hasNumericAsText(info),
      hasColumnStats: false,
    });
  }

  return {
    operators: ops,
    trajectory: { currentEventIndex, frontierOpId, anyThrashing, operatorCount: inLeaf.size },
  };
}
