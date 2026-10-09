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
 * ML FEATURE VECTOR — the single source of truth for the learned context
 * selector's per-operator features. Used BOTH offline (dump-features.ts, over
 * imported recorded traces) and at runtime (score.ts, over the live dossier), so
 * train/serve feature parity is guaranteed by construction: one function, one
 * FEATURE_NAMES order.
 *
 * Design (grounded in the context-ml prototype's ablation, which found dataflow
 * structure ≫ recency and `data_log_rows` the single strongest feature):
 *   - reuse the committed `extractFeatures` for role / edit / result signals,
 *   - ADD the row-count and graph-lineage features the base set lacked,
 *   - ADD a task-conditioned lexical-overlap feature.
 *
 * LEAKAGE RULE (pipeline §9, §17.4): every feature reads state ≤ t only. The
 * dossier is built from the step-t prefix, so its leaf snapshot IS the DAG at t;
 * nothing here consults the final answer or future steps. The training LABEL
 * (future-use) is computed elsewhere (label.ts) and never enters this vector.
 */

import type { Dossier, OperatorDossier } from "../summarize/dossier";
import type { OperatorInfo } from "../../../types/execution";
import { extractFeatures, type OperatorFeatures, type SelectorFeatures } from "../selector/features";

const HIDDEN_KEYS = new Set(["__row_index__", "__is_visualization__"]);

/** Stable, ordered feature names. The Python trainer and the TS evaluator both
 *  key off this exact order — DO NOT reorder; append only. */
export const FEATURE_NAMES: readonly string[] = [
  // role one-hots
  "role_deleted",
  "role_blocked",
  "role_frontier",
  "role_near_frontier",
  "role_terminal",
  "role_source",
  "role_interior",
  // temporal / version
  "edit_count",
  "steps_since_edit",
  "norm_recency",
  "deleted",
  // execution / data-quality
  "is_erroring",
  "has_result",
  "has_healthy_consumer",
  "has_column_stats",
  "wide",
  "dirty_load",
  "categorical_low_card",
  "numeric_as_text",
  // data-summary scalars (log_rows is the prototype's #1 feature)
  "n_cols",
  "log_rows",
  // structural / lineage
  "is_source",
  "is_terminal",
  "n_upstream",
  "n_downstream",
  "n_ancestors",
  "n_descendants",
  "depth",
  "is_sink",
  "dist_to_frontier",
  // task-conditioned
  "task_sim",
] as const;

export interface OperatorMLFeatures {
  operatorId: string;
  /** Numeric vector in FEATURE_NAMES order. */
  vec: number[];
  /** Estimated token cost of rendering this op's latest result at `sample`
   *  detail (chars/4). NOT a model input — used only by the budget knapsack. */
  sampleTokenCost: number;
  /** Convenience copy of the raw per-op selector features (for callers/logging). */
  base: OperatorFeatures;
}

function latestResult(d: OperatorDossier): OperatorInfo | undefined {
  return d.resultVersions.length > 0 ? d.resultVersions[d.resultVersions.length - 1].info : undefined;
}

function resultRows(info: OperatorInfo | undefined): number {
  if (!info) return 0;
  const n = info.totalRowCount ?? info.outputTuples ?? (Array.isArray(info.result) ? info.result.length : 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resultCols(info: OperatorInfo | undefined): number {
  const r = info?.result;
  if (!Array.isArray(r) || r.length === 0 || typeof r[0] !== "object" || r[0] === null) {
    return info?.resultSchema?.length ?? 0;
  }
  return Object.keys(r[0] as Record<string, unknown>).filter(k => !HIDDEN_KEYS.has(k)).length;
}

/** chars/4 estimate of the full `sample` render (~header + up to 20 rows). Cheap
 *  proxy; the exact value only needs to be monotonic in real cost for the
 *  knapsack. Wide/tall tables cost more, matching where the render actually is. */
function estimateSampleTokens(info: OperatorInfo | undefined): number {
  if (!info) return 20;
  const rows = Math.min(resultRows(info), 20);
  const cols = Math.min(resultCols(info), 50);
  // ~8 chars/cell + schema line; /4 for tokens. Floor keeps omit/shape distinct.
  const chars = 40 + cols * 12 + rows * cols * 8;
  return Math.max(10, Math.round(chars / 4));
}

const TOKEN_RE = /[a-z0-9]+/gi;
function tokens(s: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  const m = s.toLowerCase().match(TOKEN_RE);
  if (m) for (const t of m) if (t.length > 2) out.add(t);
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

interface Graph {
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
}

function buildGraph(dossier: Dossier): Graph {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const links = dossier.leafSnapshot?.workflow?.links ?? [];
  for (const l of links) {
    const s = (l as any).source?.operatorID as string | undefined;
    const t = (l as any).target?.operatorID as string | undefined;
    if (!s || !t) continue;
    (children.get(s) ?? children.set(s, []).get(s)!).push(t);
    (parents.get(t) ?? parents.set(t, []).get(t)!).push(s);
  }
  return { parents, children };
}

/** Transitive closure size (ancestors or descendants) via BFS. */
function closureSize(start: string, adj: Map<string, string[]>): number {
  const seen = new Set<string>();
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) ?? []) if (!seen.has(m)) stack.push(m);
  }
  return seen.size;
}

/** Longest path from any source to `op` (0 for a source). */
function depthOf(op: string, parents: Map<string, string[]>, memo: Map<string, number>): number {
  if (memo.has(op)) return memo.get(op)!;
  memo.set(op, 0); // cycle guard
  const ps = parents.get(op) ?? [];
  let d = 0;
  for (const p of ps) d = Math.max(d, 1 + depthOf(p, parents, memo));
  memo.set(op, d);
  return d;
}

/** Undirected BFS distance from `op` to `frontier` (large default if none/unreachable). */
function distToFrontier(op: string, frontier: string | undefined, g: Graph): number {
  const FAR = 10;
  if (!frontier) return FAR;
  if (op === frontier) return 0;
  const seen = new Set<string>([op]);
  let frontierLayer = [op];
  for (let d = 1; d <= FAR; d++) {
    const next: string[] = [];
    for (const n of frontierLayer) {
      for (const m of [...(g.parents.get(n) ?? []), ...(g.children.get(n) ?? [])]) {
        if (seen.has(m)) continue;
        if (m === frontier) return d;
        seen.add(m);
        next.push(m);
      }
    }
    if (next.length === 0) break;
    frontierLayer = next;
  }
  return FAR;
}

export interface MLFeatureOptions {
  categoricalMaxDistinct?: number;
  wideColumns?: number;
  thrashThreshold?: number;
}

/**
 * Compute per-operator ML feature vectors for every operator in the dossier.
 * `taskText` is the natural-language task (for the lexical-overlap feature).
 * Pass a precomputed `selectorFeatures` to avoid a redundant extractFeatures.
 */
export function perOperatorMLFeatures(
  dossier: Dossier,
  taskText: string,
  opts: MLFeatureOptions = {},
  selectorFeatures?: SelectorFeatures
): Map<string, OperatorMLFeatures> {
  const sel =
    selectorFeatures ??
    extractFeatures(dossier, {
      categoricalMaxDistinct: opts.categoricalMaxDistinct,
      wideColumns: opts.wideColumns,
      thrashThreshold: opts.thrashThreshold,
    });
  const g = buildGraph(dossier);
  const depthMemo = new Map<string, number>();
  const taskTokens = tokens(taskText);
  const currentEventIndex = Math.max(1, sel.trajectory.currentEventIndex);
  const frontier = sel.trajectory.frontierOpId;

  const out = new Map<string, OperatorMLFeatures>();
  for (const [opId, f] of sel.operators) {
    const d = dossier.operators.get(opId);
    const info = d ? latestResult(d) : undefined;
    const rows = resultRows(info);
    const summary = d?.codeVersions.length ? d.codeVersions[d.codeVersions.length - 1].summary : undefined;

    const nUp = (g.parents.get(opId) ?? []).length;
    const nDown = (g.children.get(opId) ?? []).length;
    const nAnc = closureSize(opId, g.parents);
    const nDesc = closureSize(opId, g.children);
    const depth = depthOf(opId, g.parents, depthMemo);
    const isSink = nDown === 0 ? 1 : 0;

    const vec: number[] = [
      f.role === "deleted" ? 1 : 0,
      f.role === "blocked" ? 1 : 0,
      f.role === "frontier" ? 1 : 0,
      f.role === "near-frontier" ? 1 : 0,
      f.role === "terminal" ? 1 : 0,
      f.role === "source" ? 1 : 0,
      f.role === "interior" ? 1 : 0,
      f.editCount,
      f.stepsSinceEdit,
      f.stepsSinceEdit / currentEventIndex,
      d?.deleted ? 1 : 0,
      f.isErroring ? 1 : 0,
      f.hasResult ? 1 : 0,
      f.hasHealthyConsumer ? 1 : 0,
      f.hasColumnStats ? 1 : 0,
      f.wide ? 1 : 0,
      f.dirtyLoad ? 1 : 0,
      f.categoricalLowCard ? 1 : 0,
      f.numericAsText ? 1 : 0,
      f.columns,
      Math.log1p(rows),
      f.isSource ? 1 : 0,
      f.isTerminalNode ? 1 : 0,
      nUp,
      nDown,
      nAnc,
      nDesc,
      depth,
      isSink,
      distToFrontier(opId, frontier, g),
      jaccard(tokens(summary), taskTokens),
    ];

    out.set(opId, { operatorId: opId, vec, sampleTokenCost: estimateSampleTokens(info), base: f });
  }
  return out;
}
