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
 * THE LEARNED SELECTOR — `dossier → SummarizeParams`, driven by a trained
 * utility model instead of hand-tuned rules.
 *
 * This is the runtime counterpart of the rule-based `selectParams`. It answers
 * the context-ml prototype's #1 open recommendation: represent-don't-drop.
 * Rather than binary keep/drop, each operator is assigned a REPRESENTATION LEVEL
 * (omit ≺ shape ≺ sample [+stats]) by a budget knapsack over the model's utility
 * score — so a high-utility-but-large table gets COMPRESSED to shape, never
 * silently dropped, and the cheap ops that carry the answer chain stay full.
 *
 * Guarantees:
 *  - The core is never removed (task, DAG skeleton, per-op schema line). Every
 *    op keeps at least `shape` + schema; only deleted ops are omitted.
 *  - The frontier / near-frontier / terminal ops are protected at `sample`
 *    regardless of budget (active work + the answer op must stay legible).
 *  - Cheap accuracy insurance: stats on low-card categoricals / numeric-as-text
 *    (the wildfire/environment accuracy levers) — mirrors the rule selector.
 *
 * Pure and synchronous; feed the result straight to summarize().
 */

import { z } from "zod";
import type { Dossier } from "../summarize/dossier";
import { SummarizeParamsSchema, type OperatorParamsOverride, type SummarizeParams } from "../summarize/params";
import { extractFeatures } from "../selector/features";
import { perOperatorMLFeatures, type MLFeatureOptions } from "./features-ml";
import type { UtilityModel } from "./model";

/** API-validated learned-selector config. */
export const LearnedConfigSchema = z.object({
  /** Token budget for operator RESULT rendering (the knapsack capacity). The
   *  mandatory core — task, skeleton, schema lines — is not charged here. */
  budgetTokens: z.number().int().min(0).default(4000),
  /** Protect frontier / near-frontier / terminal ops at `sample` regardless of
   *  budget. Default true (active work + answer op must stay legible). */
  protectActive: z.boolean().optional(),
  /** Add column.stats on decision-critical columns (low-card categoricals /
   *  numeric-as-text) — cheap accuracy insurance. Default true. */
  addStats: z.boolean().optional(),
  /** Add safety flow-alarms (loader hints / cardinality / error context) — extra
   *  insurance LATEST omits. Off by default so v1 is a pure cost play (these can
   *  make small tables larger than they save). */
  flowAlarms: z.boolean().optional(),
  /** Utility below which a (non-protected) op is dropped to `omit` rather than
   *  `shape`. Default 0 (never omit live ops — shape is the floor). */
  omitBelowUtility: z.number().optional(),
  featureOptions: z
    .object({
      categoricalMaxDistinct: z.number().optional(),
      wideColumns: z.number().optional(),
      thrashThreshold: z.number().optional(),
    })
    .optional(),
});

export type LearnedConfig = z.infer<typeof LearnedConfigSchema>;

export const DEFAULT_LEARNED_CONFIG: LearnedConfig = {
  budgetTokens: 4000,
  protectActive: true,
  addStats: true,
  omitBelowUtility: 0,
};

export interface LearnedDecision {
  operatorId: string;
  utility: number;
  detail: "omit" | "shape" | "sample";
  sampleTokenCost: number;
  protectedActive: boolean;
  statsAdded: boolean;
}

/** The scoring + knapsack, exposed for logging / offline analysis. */
export function decideLearned(
  dossier: Dossier,
  model: UtilityModel,
  taskText: string,
  config: LearnedConfig = DEFAULT_LEARNED_CONFIG
): LearnedDecision[] {
  const sel = extractFeatures(dossier, {
    categoricalMaxDistinct: config.featureOptions?.categoricalMaxDistinct,
    wideColumns: config.featureOptions?.wideColumns,
    thrashThreshold: config.featureOptions?.thrashThreshold,
  });
  const feats = perOperatorMLFeatures(dossier, taskText, config.featureOptions, sel);

  const protectActive = config.protectActive !== false;
  const decisions: LearnedDecision[] = [];
  for (const [opId, mf] of feats) {
    const util = model.score(mf.vec);
    const role = mf.base.role;
    const isActive = role === "frontier" || role === "near-frontier" || role === "terminal";
    decisions.push({
      operatorId: opId,
      utility: util,
      detail: "shape", // provisional; set below
      sampleTokenCost: mf.sampleTokenCost,
      protectedActive: protectActive && isActive,
      statsAdded: false,
    });
  }

  // 1) deleted ops → omit. 2) protected-active → sample (free of budget).
  //    3) everyone else competes for the budget by utility density.
  let spent = 0;
  for (const dcn of decisions) {
    const d = dossier.operators.get(dcn.operatorId);
    if (d?.deleted) {
      dcn.detail = "omit";
      continue;
    }
    if (dcn.protectedActive) {
      dcn.detail = "sample";
      spent += dcn.sampleTokenCost;
    }
  }

  // Greedy knapsack: remaining ops, highest utility-per-token first, promoted
  // shape → sample while budget allows. Ties broken by utility.
  const contenders = decisions
    .filter(dcn => !dcn.protectedActive && dcn.detail !== "omit")
    .sort((a, b) => b.utility / Math.max(1, b.sampleTokenCost) - a.utility / Math.max(1, a.sampleTokenCost));
  for (const dcn of contenders) {
    if (spent + dcn.sampleTokenCost <= config.budgetTokens) {
      dcn.detail = "sample";
      spent += dcn.sampleTokenCost;
    } else {
      dcn.detail = "shape";
      // Very low utility + already consumed by a healthy downstream → omit rows
      // (still cheaper than shape's schema? no — shape keeps schema, the floor).
      if ((config.omitBelowUtility ?? 0) > 0 && dcn.utility < (config.omitBelowUtility ?? 0)) {
        dcn.detail = "omit";
      }
    }
  }

  // Accuracy insurance: stats on decision-critical columns.
  if (config.addStats !== false) {
    for (const dcn of decisions) {
      if (dcn.detail === "omit") continue;
      const f = feats.get(dcn.operatorId)?.base;
      if (f && (f.categoricalLowCard || f.numericAsText)) dcn.statsAdded = true;
    }
  }

  return decisions;
}

/** Build the SummarizeParams the runtime assembler feeds to summarize(). */
export function learnedSelectParams(
  dossier: Dossier,
  model: UtilityModel,
  taskText: string,
  config: LearnedConfig = DEFAULT_LEARNED_CONFIG
): SummarizeParams {
  const decisions = decideLearned(dossier, model, taskText, config);

  const overrides: Record<string, OperatorParamsOverride> = {};
  for (const dcn of decisions) {
    const column: Record<string, unknown> = { schema: true };
    overrides[dcn.operatorId] = {
      result: { latest: { detail: dcn.detail, column } },
    } as OperatorParamsOverride;
  }

  return SummarizeParamsSchema.parse({
    trajectory: { events: "none" },
    currentSnapshot: true,
    compiledSchemas: false,
    // Safety flow-alarms are opt-in (config.flowAlarms) — on small tables they can
    // cost more than the rows the knapsack saves. v1 default = pure cost play.
    flow: config.flowAlarms ? {} : {},
    operators: {
      // Default = cheapest legible: shape + schema. Overrides lift chosen ops.
      defaults: { result: { latest: { detail: "shape", column: { schema: true } } } },
      overrides,
    },
  });
}
