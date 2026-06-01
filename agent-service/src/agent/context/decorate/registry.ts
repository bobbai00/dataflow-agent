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

import type { DecorateFacet, DecorateLevel, RungDescriptor } from "./types";

/**
 * THE DECORATE CATALOG — single source of truth for the facet ladders
 * (claude/CONTEXT-DESIGN.md §5). Each rung names the legacy option flag that
 * currently drives its render; `levelsToFlags()` expands an ordinal level into
 * that flag set so the existing assembler path is driven by the new config
 * with zero behavior change (the migration shim).
 *
 * FLOW ladder (decorate the DAG — a part-decomposition presented as a ladder):
 *   L1  I/O schema + cardinality
 *   L2  error / remediation context at the failing op
 *   L3  topology / graph anomalies
 *
 * DATA ladder (decorate the result table — a true depth ladder, cheap→rich):
 *   L1  schema (col + type)
 *   L2  structural / semantic profile (grain, partitions, dirty-load)  ← the win
 *   L3  value-level (format/coercion hints)
 *
 * Substrate (sampling/serialization: maxResultRows, TSV) and the static prior
 * (fewShotPrompt) are deliberately NOT rungs — see CONTEXT-DESIGN §5.3.
 */
export const RUNGS: readonly RungDescriptor[] = [
  // ---- FLOW facet ----
  {
    id: "flow.schema",
    facet: "flow",
    level: 1,
    mode: "preemptive",
    flag: "schemaInResult",
    note: "compact Schema: (col+type) line per result — load-bearing for accuracy, kept in converge",
  },
  {
    id: "flow.cardinality",
    facet: "flow",
    level: 1,
    mode: "posthoc",
    flag: "lineageStats",
    note: "per-op rows in→out, kept %, + empty/fan-out alarm",
  },
  {
    id: "flow.loader_remediation",
    facet: "flow",
    level: 2,
    mode: "preemptive",
    flag: "loaderHint",
    note: "on a failed DataLoading op, remediation keyed on the exception class",
  },
  {
    id: "flow.error_context",
    facet: "flow",
    level: 2,
    mode: "posthoc",
    flag: "lineageErrorContext",
    note: "#28: on an errored process op, direct-upstream input schema + sample rows",
  },
  {
    id: "flow.graph_audit",
    facet: "flow",
    level: 3,
    mode: "posthoc",
    flag: "graphAudit",
    note: "dead/disconnected DataLoading op via typed-DAG reachability",
  },
  {
    id: "flow.join_telemetry",
    facet: "flow",
    level: 3,
    mode: "posthoc",
    flag: "joinTelemetry",
    note: "degenerate-join detection (near-zero key match / m:n fan-out)",
  },

  // ---- DATA facet ----
  {
    id: "data.schema",
    facet: "data",
    level: 1,
    mode: "preemptive",
    flag: "schemaInResult",
    note: "schema (col + type) — the cheapest data profile; load-bearing, kept",
  },
  {
    id: "data.structural_profile",
    facet: "data",
    level: 2,
    mode: "preemptive",
    flag: "tableStructureHint",
    note: "#25/26/27: grain/key, partition/gate cols, dirty-load (empty/dup) — the accuracy win",
  },
  {
    id: "data.value_format",
    facet: "data",
    level: 3,
    mode: "preemptive",
    flag: "valueFormatFlags",
    note: "currency/percent/thousands cleaning hints before numeric conversion",
  },
  {
    id: "data.coercion",
    facet: "data",
    level: 3,
    mode: "posthoc",
    flag: "coercionTelemetry",
    note: "to_numeric/to_datetime(coerce) NaN-dataloss + dropped-value sample",
  },
] as const;

/** All rungs for a facet at-or-below `level` (the cumulative preset). */
export function rungsForLevel(facet: DecorateFacet, level: DecorateLevel): RungDescriptor[] {
  return RUNGS.filter(r => r.facet === facet && r.level <= level);
}

/**
 * Migration shim: expand the two ordinal facet levels into the set of legacy
 * option flags the current assembler reads. Returns a partial map of
 * `{ flagName: true }` for every rung enabled at the given levels.
 *
 * `schemaInResult` is backed by BOTH facets' L1 (it is the schema line, which
 * is simultaneously the cheapest flow-I/O view and the cheapest data view); the
 * set naturally de-duplicates it.
 */
export function levelsToFlags(flowLevel: DecorateLevel, dataLevel: DecorateLevel): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of rungsForLevel("flow", flowLevel)) out[r.flag] = true;
  for (const r of rungsForLevel("data", dataLevel)) out[r.flag] = true;
  return out;
}

/** Inverse helper for tests/back-compat: the lowest level at which `flag` is enabled. */
export function flagToLevel(facet: DecorateFacet, flag: string): DecorateLevel | undefined {
  const hit = RUNGS.filter(r => r.facet === facet && r.flag === flag).map(r => r.level);
  return hit.length ? (Math.min(...hit) as DecorateLevel) : undefined;
}
