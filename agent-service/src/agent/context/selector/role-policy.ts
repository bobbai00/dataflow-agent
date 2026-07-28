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
export const RolePolicyConfigSchema = z.object({
  /** Row budget retained on SOURCE operators (the rich side). */
  sourceSampleRows: z.number().int().min(0).default(12),
  /** Per-column stats block on SOURCE operators. */
  sourceStats: z.boolean().default(true),
  /** Load-quality facts (dup rows, unnamed headers, all-null cols) on sources. */
  sourceStructuralHints: z.boolean().default(true),
  /** Row budget retained on INTERIOR operators (the lean side). */
  interiorSampleRows: z.number().int().min(0).default(3),
  /** Per-column stats block on interior operators. */
  interiorStats: z.boolean().default(false),
  /** Render terminal/sink operators lean too (they hold the answer, usually 1x1). */
  leanTerminal: z.boolean().default(true),
});

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
export function applyRolePolicy(
  base: SummarizeParams,
  dossier: Dossier,
  config: RolePolicyConfig
): SummarizeParams {
  // Per-operator policy only binds on a snapshot core.
  if (base.trajectory.events !== "none" || !base.currentSnapshot) return base;

  const features = extractFeatures(dossier);
  const overrides: Record<string, OperatorParamsOverride> = {};

  for (const feature of features.operators.values()) {
    const isLeanRole =
      feature.role === "interior" || (config.leanTerminal && feature.role === "terminal");

    // Key the rich side on the STRUCTURAL `isSource` flag, not on role === "source".
    // features.ts assigns roles by priority (frontier > near-frontier > terminal >
    // source > interior), so a load feeding the frontier is labelled
    // "near-frontier" and would never match role === "source". On this benchmark's
    // short 2-5 operator pipelines that is the common case, which made an
    // earlier role-keyed version a silent no-op. The raw-data boundary is a
    // structural property; classify it structurally.
    if (feature.isSource) {
      overrides[feature.operatorId] = {
        result: {
          latest: {
            detail: "sample",
            tuple: { sampleRows: config.sourceSampleRows },
            column: {
              stats: config.sourceStats,
              structuralHints: config.sourceStructuralHints,
            },
          },
        },
      };
    } else if (isLeanRole && feature.role !== "frontier") {
      overrides[feature.operatorId] = {
        result: {
          latest: {
            detail: config.interiorSampleRows > 0 ? "sample" : "shape",
            tuple: { sampleRows: config.interiorSampleRows },
            column: { stats: config.interiorStats },
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
