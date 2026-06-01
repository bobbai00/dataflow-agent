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
import type { OperatorDecorator, OperatorDecorateCtx } from "./decorator";
import { loaderRemediation } from "./flow/loader-remediation";
import { errorContext } from "./flow/error-context";
import { graphAudit } from "./flow/graph-audit";

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
  // Flow ladder (decorate the typed DAG / lineage). Schema is a DATA-facet rung
  // (it describes the table payload), so flow L1 starts at loader remediation —
  // the proven pre-emptive flow rung that the converge stack ships.
  {
    id: "flow.loader_remediation",
    facet: "flow",
    level: 1,
    mode: "preemptive",
    flag: "loaderHint",
    note: "on a failed DataLoading op, remediation keyed on the exception class (converge)",
  },
  {
    id: "flow.cardinality",
    facet: "flow",
    level: 2,
    mode: "posthoc",
    flag: "lineageStats",
    note: "per-op rows in→out, kept %, + empty/fan-out alarm",
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
 * Expand the two ordinal facet levels into the set of internal render flags the
 * assembler consumes (via AssembleContextOptions). Returns a partial map of
 * `{ flagName: true }` for every rung enabled at the given levels. These flags
 * are NOT a public knob surface — `flowLevel`/`dataLevel` are the public knobs;
 * the per-rung flags are the internal expansion target.
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

/* ============================================================================
 *  Operator-attached decorators (runtime). These implement the Decorator
 *  contract (render bodies migrated out of context-utils.serializeOperatorFull).
 *  Registration ORDER is the render order within a placement — preserved from
 *  the original inline gate order so output is byte-identical post-migration.
 * ========================================================================= */

/** All operator decorators, in render order. */
export const OPERATOR_DECORATORS: readonly OperatorDecorator[] = [
  loaderRemediation, // in-result, flow L2
  errorContext, // in-result, flow L2
  graphAudit, // post-block, flow L3
] as const;

/**
 * Run every enabled operator decorator with the given placement whose `applies`
 * is true, in registration order, and return the appended lines (un-indented;
 * the caller owns indentation). A decorator is "enabled" when an
 * `isFlagEnabled(flag)` predicate says its catalog flag is on — the assembler
 * passes a predicate backed by the resolved options, so this stays decoupled
 * from AssembleContextOptions.
 */
export function runOperatorDecorators(
  placement: OperatorDecorator["placement"],
  ctx: OperatorDecorateCtx,
  isFlagEnabled: (flag: string) => boolean
): string[] {
  const out: string[] = [];
  for (const d of OPERATOR_DECORATORS) {
    if (d.placement !== placement) continue;
    const descriptor = RUNGS.find(r => r.id === d.id);
    const flag = descriptor?.flag ?? d.id;
    if (!isFlagEnabled(flag)) continue;
    if (!d.applies(ctx)) continue;
    out.push(...d.render(ctx));
  }
  return out;
}
