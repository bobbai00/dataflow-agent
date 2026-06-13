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

import type { WorkflowContent } from "../../../../types/workflow";
import type { SnapshotData } from "../../../workflow-snapshot-storage";
import type { OperatorDecorator, OperatorDecorateCtx } from "../decorator";

/**
 * Flow-L2 (#28, post-hoc). On an errored NON-loader operator, surface its
 * DIRECT upstream inputs' schema + a few sample rows — the real data this
 * operator's process() consumes — so the model fixes against actual columns/
 * values instead of guessing (the wrong-column / KeyError re-derivation loop).
 * Dataflow-native: the typed DAG gives the exact inputs the process() reads.
 * Current snapshot only.
 */

const MAX_ROWS = 3;

/** Build the `Inputs (...)` block for an errored op, or "" when nothing useful.
 *  Exported for direct unit testing of the lineage walk. */
export function buildLineageErrorContext(
  opId: string,
  snapshot: SnapshotData,
  allLinks: WorkflowContent["links"]
): string {
  const parents: string[] = [];
  const seen = new Set<string>();
  for (const link of allLinks) {
    if (link.target.operatorID !== opId) continue;
    const p = link.source.operatorID;
    if (!seen.has(p)) {
      seen.add(p);
      parents.push(p);
    }
  }
  const blocks: string[] = [];
  for (const pid of parents) {
    const pInfo = snapshot.results.get(pid)?.info;
    if (!pInfo || pInfo.error || !Array.isArray(pInfo.result) || pInfo.result.length === 0) continue;
    const rows = pInfo.result as Record<string, unknown>[];
    const cols = Object.keys(rows[0]).filter(k => k !== "__row_index__" && k !== "__is_visualization__");
    if (cols.length === 0) continue;
    const header = cols.join("\t");
    const body = rows
      .slice(0, MAX_ROWS)
      .map(r => cols.map(c => String(r[c] ?? "")).join("\t"))
      .join("\n");
    blocks.push(`Input \`${pid}\` (${cols.length} cols, ${rows.length} rows): ${cols.join(", ")}\n${header}\n${body}`);
  }
  if (blocks.length === 0) return "";
  return (
    "Inputs (the actual data this operator consumes — fix against these real columns/values, do not guess):\n" +
    blocks.join("\n")
  );
}

/**
 * LATEST-mode variant of the error-context rung. In LATEST every operator's full
 * Result (schema + sample rows) is already rendered in the snapshot, so
 * re-dumping the upstream input (as `buildLineageErrorContext` does) is pure
 * duplication. Instead, name the direct upstream(s) that produced a usable result
 * and point the model at the Result already on screen — single source of truth,
 * no re-printed schema/rows. Returns "" when no upstream has a usable result
 * (nothing to reference; the upstream's own entry / the blocked-upstream note
 * covers it).
 */
export function lineageErrorPointer(opId: string, snapshot: SnapshotData, allLinks: WorkflowContent["links"]): string {
  const seen = new Set<string>();
  const usable: string[] = [];
  for (const link of allLinks) {
    if (link.target.operatorID !== opId) continue;
    const p = link.source.operatorID;
    if (seen.has(p)) continue;
    seen.add(p);
    const pInfo = snapshot.results.get(p)?.info;
    if (pInfo && !pInfo.error && Array.isArray(pInfo.result) && pInfo.result.length > 0) {
      usable.push(p);
    }
  }
  if (usable.length === 0) return "";
  const ids = usable.map(p => `\`${p}\``).join(", ");
  const poss = usable.length > 1 ? "their" : "its";
  return `fix against the real columns/values of input ${ids} (see ${poss} Result above); don't guess column names.`;
}

/**
 * Compact input-schema lines for an errored op — the direct upstream(s)' columns
 * (name + light type from the first row), so a fix targets real columns. Used by
 * the folded error-into-operator rung. Returns [] when no upstream has a result.
 */
export function upstreamInputSchema(
  opId: string,
  snapshot: SnapshotData,
  allLinks: WorkflowContent["links"]
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const link of allLinks) {
    if (link.target.operatorID !== opId) continue;
    const pid = link.source.operatorID;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const pInfo = snapshot.results.get(pid)?.info;
    if (!pInfo || pInfo.error || !Array.isArray(pInfo.result) || pInfo.result.length === 0) continue;
    const row0 = pInfo.result[0] as Record<string, unknown>;
    const cols = Object.keys(row0).filter(k => k !== "__row_index__" && k !== "__is_visualization__");
    if (cols.length === 0) continue;
    const typed = cols.map(c => {
      const v = row0[c];
      const t = v === null || v === undefined ? "?" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : "str";
      return `${c} (${t})`;
    });
    lines.push(`Input schema \`${pid}\`: ${typed.join(", ")}`);
  }
  return lines;
}

export const errorContext: OperatorDecorator = {
  id: "flow.error_context",
  facet: "flow",
  level: 2,
  mode: "posthoc",
  placement: "in-result",
  applies(ctx: OperatorDecorateCtx): boolean {
    return ctx.isCurrent && !!ctx.info?.error && ctx.op.operatorType !== "DataLoading";
  },
  render(ctx: OperatorDecorateCtx): string[] {
    const block = buildLineageErrorContext(ctx.op.operatorID, ctx.snapshot, ctx.allLinks);
    return block ? block.split("\n") : [];
  },
};
