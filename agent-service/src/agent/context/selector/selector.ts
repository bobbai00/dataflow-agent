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
 * THE SELECTOR — a per-step policy `dossier → SummarizeParams`.
 *
 * This is the "context parameter tuner", initialized as the rule-based expert
 * policy that encodes the intuitions in docs/summarize-tuning-intuitions.md:
 *
 *   - Tier-1 (free): decay consumed sources → shape, omit blocked/deleted ops,
 *     settled interior → shape. (§3A, §3D)
 *   - Tier-2 (cheap insurance): schema always; cardinality/error/loader/join
 *     alarms on; stats on low-card categoricals; value-format + dtype-anomaly
 *     on numeric-as-text; structural hints on loads. (§3B, §3E)
 *   - Tier-3 (the trade-off surface): the frontier detail rows + the thrash
 *     code/result-history threshold. (§3C)
 *
 * `SelectorConfig` is the small, mostly-continuous action vector a trainer
 * optimizes against `reward = correct − λ·tokens`; the rule STRUCTURE is fixed
 * and config-parameterized, so learning is over ~10 scalars, not free-form
 * params. A future learned policy can replace `buildOverride` while reusing the
 * same features + config surface.
 *
 * Pure: `selectParams(dossier, config)` has no I/O. Feed the result to
 * `summarize(input, params)` (pass the same dossier via `input.dossier` to skip
 * a rebuild).
 */

import { z } from "zod";
import type { Dossier } from "../summarize/dossier";
import { SummarizeParamsSchema, type OperatorParamsOverride, type SummarizeParams } from "../summarize/params";
import { extractFeatures, type OperatorFeatures } from "./features";

/** The trainable action vector. Every field is a knob a tuner searches; the
 *  defaults are the hand-tuned expert policy (a strong baseline, not eval-fit). */
export const SelectorConfigSchema = z.object({
  /** Steps-since-edit before a CONSUMED source is downgraded sample→shape.
   *  0 ⇒ downgrade as soon as a healthy consumer exists. (§3A.3 — the big win) */
  sourceDecaySteps: z.number().int().min(0).default(1),
  /** Rows on the frontier operator (the one being inspected/debugged). */
  frontierSampleRows: z.number().int().min(0).default(12),
  /** Rows on a direct upstream of the frontier (read before the next edit). */
  nearFrontierSampleRows: z.number().int().min(0).default(6),
  /** Rows on the terminal/answer operator. */
  terminalSampleRows: z.number().int().min(0).default(30),
  /** Rows on an unsettled source still being parsed (needs raw bytes). */
  unsettledSourceRows: z.number().int().min(0).default(12),
  /** edit-count at which code+result HISTORY turns on for the stuck op (§3C.2). */
  thrashHistoryThreshold: z.number().int().min(1).default(3),
  /** how many prior code/result versions to show once history fires. */
  historyDepth: z.number().int().min(0).default(2),
  /** distinct ceiling for "low-cardinality categorical" (→ show stats). */
  categoricalMaxDistinct: z.number().int().min(1).default(12),
  /** column-count ceiling above which a table is "wide". */
  wideColumns: z.number().int().min(1).default(50),
  /** Tier-2 insurance alarms on (cardinality/error/loader/join). Ablatable. */
  insurance: z.boolean().default(true),
  /** `# Reasoning` replay depth (keeps the plan alive between steps, cheap). */
  reasoningReplayK: z.number().int().min(0).default(8),
  /** Show the CURRENT code block on the frontier/unsettled-source op. */
  frontierIncludeCode: z.boolean().default(true),
});
export type SelectorConfig = z.infer<typeof SelectorConfigSchema>;

export const DEFAULT_SELECTOR_CONFIG: SelectorConfig = SelectorConfigSchema.parse({});

export function parseSelectorConfig(raw: unknown): SelectorConfig {
  return SelectorConfigSchema.parse(raw ?? {});
}

/** Is a source still being parsed (keep raw sample) vs settled (decay to shape)? */
function sourceIsUnsettled(f: OperatorFeatures, cfg: SelectorConfig): boolean {
  return f.isErroring || !f.hasHealthyConsumer || f.stepsSinceEdit < cfg.sourceDecaySteps || f.dirtyLoad;
}

/** Data-shape column overlays for any op rendered at `sample` detail: expose the
 *  exact signals the data demands (categorical value set, numeric-as-text
 *  contaminants), cheaply. Mutates and returns `col`. */
function overlayDataShape(col: Record<string, unknown>, f: OperatorFeatures): Record<string, unknown> {
  col.schema = true;
  return col;
}

/**
 * Build the per-operator override for one operator from its features. Returns
 * `undefined` for an operator that should use the defaults (settled interior:
 * shape + schema). This function IS the expert policy — a learned policy would
 * replace this body.
 */
export function buildOverride(f: OperatorFeatures, cfg: SelectorConfig): OperatorParamsOverride | undefined {
  const thrashing = f.editCount >= cfg.thrashHistoryThreshold;
  const history =
    thrashing && cfg.historyDepth > 0
      ? { property: { codeHistory: cfg.historyDepth }, resultHist: cfg.historyDepth }
      : undefined;

  switch (f.role) {
    case "deleted":
    case "blocked":
      // Dead / meaningless result → no Result block. The flow section still
      // points at the root-cause error for blocked ops.
      return { result: { latest: { detail: "omit" } } };

    case "terminal":
      return {
        result: {
          latest: { detail: "sample", tuple: { sampleRows: cfg.terminalSampleRows }, column: { schema: true } },
        },
      };

    case "frontier": {
      const col = overlayDataShape({}, f);
      const ov: OperatorParamsOverride = {
        property: { includeCode: cfg.frontierIncludeCode, ...(history?.property ?? {}) },
        result: {
          latest: { detail: "sample", tuple: { sampleRows: cfg.frontierSampleRows }, column: col as never },
          ...(history ? { history: { lastK: history.resultHist, render: { detail: "shape" } } } : {}),
        },
      };
      return ov;
    }

    case "near-frontier": {
      const col: Record<string, unknown> = { schema: true };
      return {
        result: {
          latest: { detail: "sample", tuple: { sampleRows: cfg.nearFrontierSampleRows }, column: col as never },
        },
      };
    }

    case "source": {
      if (sourceIsUnsettled(f, cfg)) {
        const col = overlayDataShape({}, f);
        return {
          property: { includeCode: cfg.frontierIncludeCode, ...(history?.property ?? {}) },
          result: {
            latest: { detail: "sample", tuple: { sampleRows: cfg.unsettledSourceRows }, column: col as never },
            ...(history ? { history: { lastK: history.resultHist, render: { detail: "shape" } } } : {}),
          },
        };
      }
      // Settled, consumed source → the biggest safe cut: keep schema, drop rows.
      return { result: { latest: { detail: "shape", column: { schema: true } } } };
    }

    case "interior":
    default:
      return undefined; // use defaults (shape + schema)
  }
}

/**
 * The policy. Featurize the dossier, then emit a validated `SummarizeParams`:
 * a lean LATEST base + Tier-2 flow insurance + per-operator overrides.
 */
export function selectParams(dossier: Dossier, config: SelectorConfig = DEFAULT_SELECTOR_CONFIG): SummarizeParams {
  const feats = extractFeatures(dossier, {
    categoricalMaxDistinct: config.categoricalMaxDistinct,
    wideColumns: config.wideColumns,
    thrashThreshold: config.thrashHistoryThreshold,
  });

  const overrides: Record<string, OperatorParamsOverride> = {};
  for (const [opId, f] of feats.operators) {
    const ov = buildOverride(f, config);
    if (ov) overrides[opId] = ov;
  }

  const flow = config.insurance
    ? {
        errorReflection: feats.trajectory.anyThrashing,
      }
    : { errorReflection: feats.trajectory.anyThrashing };

  return SummarizeParamsSchema.parse({
    trajectory: { events: "none", reasoningReplayK: config.reasoningReplayK },
    currentSnapshot: true,
    compiledSchemas: false,
    flow,
    operators: {
      // Default profile = settled interior: cheap shape + schema. Frontier /
      // source / terminal are lifted back up by their overrides.
      defaults: { result: { latest: { detail: "shape", column: { schema: true } } } },
      overrides,
    },
  });
}
