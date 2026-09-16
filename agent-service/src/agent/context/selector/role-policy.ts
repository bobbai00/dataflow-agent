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

import { z } from "zod";
import type { Dossier } from "../summarize/dossier";
import { type OperatorParamsOverride, type SummarizeParams, applySummarizeParamsPatch } from "../summarize/params";
import { extractFeatures } from "./features";

/**
 * RULE A — role-keyed render policy ("rich source, lean interior").
 *
 * Motivation (measured): the sampling and stats levers are cap-bound/informative
 * on 64–68% SOURCE operators (depth-0, median file 81 KB); interior and sink
 * operators are touched by neither (~3–5%). Derived tables are small and clean,
 * so wide samples + per-column stats there are paid-for bytes that carry no
 * decision-relevant fact. This overlay spends the render budget at the RAW DATA
 * BOUNDARY and renders the analytical interior lean.
 *
 * Applies only to a snapshot-core context (LATEST): interleaved trajectories
 * already carry per-event results, so a per-operator policy would not bind.
 */
export const RolePolicyConfigSchema = z
  .object({
    /** Row budget retained on SOURCE operators (the rich side). */
    sourceSampleRows: z.number().int().min(0).default(12),
    /** Row budget retained on INTERIOR operators (the lean side). */
    interiorSampleRows: z.number().int().min(0).default(3),
    /** Render terminal/sink operators lean too (they hold the answer, usually 1x1). */
    leanTerminal: z.boolean().default(true),
    /**
     * CHAR-BUDGET mode (C9/C10). Per-operator `tuple.maxChars` keyed on the
     * raw-data boundary: sources get `sourceMaxChars`, every NON-source operator
     * gets `nonSourceMaxChars` and `nonSourceStats`. Unlike the rows/stats legs
     * above this deliberately covers frontier and near-frontier operators too —
     * the policy under test is "rich source, lean everything-downstream", not
     * "lean settled interior".
     *
     * Set both to 0 to leave char budgets alone (the default), in which case this
     * mode contributes nothing and the rows/stats legs behave as before.
     */
    sourceMaxChars: z.number().int().min(0).default(0),
    nonSourceMaxChars: z.number().int().min(0).default(0),
    /**
     * CODE-BUDGET mode (P-series). Per-operator `property.includeCode`, keyed on how
     * SETTLED an operator is rather than on the raw-data boundary.
     *
     * Why this leg exists — measured, not assumed. `Code:` blocks are 27-39% of every
     * rendered dataflow and NO existing knob touches them:
     * `max_operator_result_char_limit` clamps table ROWS only. Per-component shares of
     * the dataflow render (byte_accounting.py over ~100 traces/arm):
     *
     *     arm            code    rows   stats   schema
     *     D8  5k         39.4%   46.2%     -      7.1%
     *     D12 1k         33.9%   20.8%  27.7%     9.1%     <- code is the LARGEST here
     *
     * And the code is concentrated on already-settled operators: on D8, 73.4% of code
     * bytes (3,028 of 4,127 B/task, ~27% of the entire prompt) sit on operators other
     * than the last one — code the agent itself wrote, that already ran clean.
     *
     * This is why every char-budget arm underperformed: C9 67.5 / C10 67.1 / N3 68.4 /
     * N5 67.9 against uniform-5k's 70.1-71.3. On a C9 DataProcessing block the split is
     * code 1,302 B (67%) vs rows 356 B (18%) — the lean-downstream lever was aimed at
     * 18% of the block while the dominant 67% was never in scope.
     *
     * Erroring operators need no special case: `context-utils` already gates the block
     * on `!info?.error`, since an error carries its own code inline.
     */
    codeBudget: z.boolean().default(false),
    /** Roles that KEEP their `Code:` block. Anything else loses it. */
    codeKeepRoles: z
      .array(z.enum(["frontier", "near-frontier", "terminal", "source", "interior"]))
      .default(["frontier", "near-frontier"]),
    /**
     * Structural sources keep code regardless of role label. Separate from
     * `codeKeepRoles` for the same reason the rows leg keys on `feature.isSource`:
     * features.ts ranks frontier > near-frontier > terminal > source > interior, so on
     * these 2-5 operator pipelines a load feeding the frontier is labelled
     * "near-frontier" and `role === "source"` almost never matches. Load code is also
     * where the glob lives, which `Files read:` now reports independently — so whether
     * sources still need their code is a real question, and this is the knob for it.
     */
    codeKeepSources: z.boolean().default(true),
  })
  .strict();

export type RolePolicyConfig = z.infer<typeof RolePolicyConfigSchema>;

export function parseRolePolicyConfig(raw: unknown): RolePolicyConfig {
  return RolePolicyConfigSchema.parse(raw ?? {});
}

/**
 * Emit per-operator overrides:
 *  - structural SOURCES (features.isSource) -> rich, regardless of their
 *    frontier-relative role label;
 *  - settled interior/terminal operators -> lean;
 *  - everything else (the non-source active working set) -> untouched.
 */
export function applyRolePolicy(base: SummarizeParams, dossier: Dossier, config: RolePolicyConfig): SummarizeParams {
  // The rows/stats/hints legs shape a snapshot core and cannot bind on an
  // interleaved trajectory. The CHAR-BUDGET leg can: `opExtras` is installed
  // regardless of context mode and the DELTA observation renderer routes through
  // `extrasFormatOptions`, so a per-operator `tuple.maxChars` caps each event's
  // render of that operator. C10 is exactly that arm, so let it through.
  const charBudgetMode = config.sourceMaxChars > 0 || config.nonSourceMaxChars > 0;
  if (!charBudgetMode && (base.trajectory.events !== "none" || !base.currentSnapshot)) return base;

  const features = extractFeatures(dossier);
  const overrides: Record<string, OperatorParamsOverride> = {};

  // CODE-BUDGET is an EXCLUSIVE leg, deliberately — same discipline as `hintsOnly`.
  // If it merely added to the rows/stats legs, those legs' defaults are not neutral
  // (`sourceSampleRows: 12`, `sourceStats: true`), so an arm meant to isolate code
  // would silently also be a rows+stats arm. A1 was described as a rows/stats policy
  // while also flipping structuralHints, and that ambiguity cost a full re-run to
  // untangle. One leg per arm.
  if (config.codeBudget) {
    const keep = new Set<string>(config.codeKeepRoles);
    for (const feature of features.operators.values()) {
      const keepCode = keep.has(feature.role) || (config.codeKeepSources && feature.isSource);
      if (!keepCode) {
        overrides[feature.operatorId] = { property: { includeCode: false } };
      }
    }
    if (Object.keys(overrides).length === 0) return base;
    return applySummarizeParamsPatch(base, { operators: { overrides } });
  }

  for (const feature of features.operators.values()) {
    if (charBudgetMode) {
      // One override per operator, keyed only on isSource — deliberately
      // covering frontier/near-frontier too ("rich source, lean everything
      // downstream", not "lean settled interior").
      overrides[feature.operatorId] = feature.isSource
        ? {
            result: {
              latest: {
                detail: "sample",
                tuple: { maxChars: config.sourceMaxChars },
                column: {},
              },
            },
          }
        : {
            result: {
              latest: {
                detail: "sample",
                tuple: { maxChars: config.nonSourceMaxChars },
                column: {},
              },
            },
          };
      continue;
    }
    const isLeanRole = feature.role === "interior" || (config.leanTerminal && feature.role === "terminal");
    if (feature.isSource) {
      overrides[feature.operatorId] = {
        result: {
          latest: {
            detail: "sample",
            tuple: { sampleRows: config.sourceSampleRows },
            column: {},
          },
        },
      };
    } else if (isLeanRole && feature.role !== "frontier") {
      overrides[feature.operatorId] = {
        result: {
          latest: {
            detail: config.interiorSampleRows > 0 ? "sample" : "shape",
            tuple: { sampleRows: config.interiorSampleRows },
            column: {},
          },
        },
      };
    }
    // non-source frontier / near-frontier: untouched (the agent's active working set;
    // the decay + retirement rules already own that region).
  }

  if (Object.keys(overrides).length === 0) return base;
  return applySummarizeParamsPatch(base, { operators: { overrides } });
}
