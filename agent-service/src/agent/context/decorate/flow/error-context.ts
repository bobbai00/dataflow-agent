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
    const body = rows.slice(0, MAX_ROWS).map(r => cols.map(c => String(r[c] ?? "")).join("\t")).join("\n");
    blocks.push(`Input \`${pid}\` (${cols.length} cols, ${rows.length} rows): ${cols.join(", ")}\n${header}\n${body}`);
  }
  if (blocks.length === 0) return "";
  return (
    "Inputs (the actual data this operator consumes — fix against these real columns/values, do not guess):\n" +
    blocks.join("\n")
  );
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
