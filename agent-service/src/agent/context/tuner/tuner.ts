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
 * The LLM CONTEXT TUNER ("teacher").
 *
 * A separate, stronger model consulted each step: it reads a cheap pipeline
 * manifest (manifest.ts) + the general efficiency principles (principles.ts)
 * and returns a per-operator DETAIL LEVEL, which this module translates into a
 * `SummarizeParams` object for the same `summarize()` renderer the rule
 * selector and legacy presets use. So the tuner is just a third policy over the
 * one action space — the teacher-driven counterpart of the rule selector.
 *
 * Self-contained + robust: a failed/slow/malformed teacher call falls back to
 * the rule selector's params, so the agent never breaks because the teacher
 * hiccuped. Token usage of each teacher call is surfaced (teacher overhead is
 * reported separately from the agent's context cost).
 */

import { z } from "zod";
import { generateObject, type LanguageModel } from "ai";
import type { Dossier } from "../summarize/dossier";
import { SummarizeParamsSchema, type OperatorParamsOverride, type SummarizeParams } from "../summarize/params";
import { selectParams, DEFAULT_SELECTOR_CONFIG } from "../selector/selector";
import { buildTunerManifest } from "./manifest";
import { TUNER_SYSTEM_PROMPT } from "./principles";
import { createLogger } from "../../../logger";

const log = createLogger("ContextTuner");

export const DETAIL_LEVELS = ["omit", "shape", "sample", "rich"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** The teacher's structured output. */
export const TunerOutputSchema = z.object({
  operators: z
    .array(
      z.object({
        operatorId: z.string(),
        detail: z.enum(DETAIL_LEVELS),
      })
    )
    .describe("Detail level for each operator in the manifest."),
  reasoningReplayK: z.number().int().min(0).max(20).default(8),
  notes: z.string().optional().describe("One sentence of reasoning (for logging)."),
});
export type TunerOutput = z.infer<typeof TunerOutputSchema>;

export interface TunerConfig {
  /** Teacher model id (e.g. "gpt-5.4"). */
  model: string;
  /** Rows to render at "sample" detail. Default 8. */
  sampleRows?: number;
  /** Rows to render at "rich" detail. Default 12. */
  richRows?: number;
  /** Mechanical guardrail: an operator whose result has ≥ this many columns is
   *  WIDE, where `rich`/`sample` blow up cost (the per-column stats + wide TSV
   *  dominate). Wide operators are clamped to at most `shape` (schema lists all
   *  columns cheaply) — regardless of the teacher's choice, `omit` still wins.
   *  Default 40. Set 0 to disable the clamp. */
  wideClampColumns?: number;
}

export interface TuneResult {
  params: SummarizeParams;
  /** True when the teacher call succeeded; false ⇒ rule-selector fallback used. */
  fromTeacher: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  notes?: string;
}

/** Map one detail level → a per-operator override for summarize(). */
function detailToOverride(
  detail: DetailLevel,
  cfg: Required<Pick<TunerConfig, "sampleRows" | "richRows">>
): OperatorParamsOverride {
  switch (detail) {
    case "omit":
      return { result: { latest: { detail: "omit" } } };
    case "shape":
      return { result: { latest: { detail: "shape", column: { schema: true } } } };
    case "sample":
      return {
        result: { latest: { detail: "sample", tuple: { sampleRows: cfg.sampleRows }, column: { schema: true } } },
      };
    case "rich":
      return {
        property: { includeCode: true },
        result: {
          latest: {
            detail: "sample",
            tuple: { sampleRows: cfg.richRows },
            column: { schema: true },
          },
        },
      };
  }
}

/** The wide-table guardrail: `rich`/`sample` on a very wide table blow up cost
 *  (per-column stats + wide TSV), so cap wide operators at `shape` (which still
 *  lists every column via the schema line). `omit` is respected. */
function clampWide(detail: DetailLevel, isWide: boolean): DetailLevel {
  if (!isWide || detail === "omit" || detail === "shape") return detail;
  return "shape";
}

/**
 * Translate the teacher's per-operator decisions into a validated
 * `SummarizeParams`. Operators the teacher didn't mention default to "shape"
 * (cheap, keeps schema). Flow insurance stays on (renders nothing when the
 * pipeline is clean, so it is ~free). `wideOps` (operators with ≥
 * `wideClampColumns` columns) are clamped to at most `shape` — the mechanical
 * guardrail against the wide-table cost blow-up.
 */
export function translateTunerOutput(
  output: TunerOutput,
  cfg: TunerConfig,
  wideOps: ReadonlySet<string> = new Set()
): SummarizeParams {
  const rows = { sampleRows: cfg.sampleRows ?? 8, richRows: cfg.richRows ?? 12 };
  const overrides: Record<string, OperatorParamsOverride> = {};
  for (const o of output.operators) {
    overrides[o.operatorId] = detailToOverride(clampWide(o.detail, wideOps.has(o.operatorId)), rows);
  }
  return SummarizeParamsSchema.parse({
    trajectory: { events: "none", reasoningReplayK: output.reasoningReplayK ?? 8 },
    currentSnapshot: true,
    compiledSchemas: false,
    flow: {},
    operators: {
      defaults: { result: { latest: { detail: "shape", column: { schema: true } } } },
      overrides,
    },
  });
}

export class LLMContextTuner {
  private readonly model: LanguageModel;
  private readonly cfg: TunerConfig;
  private teacherTokens = 0;
  private calls = 0;

  constructor(model: LanguageModel, cfg: TunerConfig) {
    this.model = model;
    this.cfg = cfg;
  }

  /** Cumulative teacher token usage across this agent's life (reported as
   *  overhead, separate from the agent's own context cost). */
  getTeacherUsage(): { calls: number; totalTokens: number } {
    return { calls: this.calls, totalTokens: this.teacherTokens };
  }

  /**
   * Ask the teacher how to render the current pipeline. On any failure, fall
   * back to the rule selector so a hiccup never breaks the agent.
   */
  async tune(dossier: Dossier, taskText: string): Promise<TuneResult> {
    // Nothing to shape yet → cheap rule-selector params, no teacher call.
    if (dossier.leafSnapshot.workflow.operators.length === 0) {
      return { params: selectParams(dossier, DEFAULT_SELECTOR_CONFIG), fromTeacher: false };
    }
    const manifest = buildTunerManifest(dossier, taskText);
    try {
      const result = await generateObject({
        model: this.model,
        schema: TunerOutputSchema,
        system: TUNER_SYSTEM_PROMPT,
        prompt: manifest.text,
      });
      this.calls += 1;
      const u = (result as any).usage;
      if (u) this.teacherTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      // Wide-table guardrail: clamp operators with too many columns to `shape`.
      const wideThreshold = this.cfg.wideClampColumns ?? 40;
      const wideOps = new Set<string>();
      if (wideThreshold > 0) {
        for (const [opId, f] of manifest.features.operators) {
          if (f.columns >= wideThreshold) wideOps.add(opId);
        }
      }
      const params = translateTunerOutput(result.object, this.cfg, wideOps);
      log.info(
        {
          ops: manifest.operatorIds.length,
          decided: result.object.operators.length,
          teacherTokens: u?.totalTokens,
          cumTeacherTokens: this.teacherTokens,
          plan: result.object.operators.map(o => `${o.operatorId}:${o.detail}`).join(","),
        },
        "tuner plan"
      );
      return {
        params,
        fromTeacher: true,
        usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens } : undefined,
        notes: result.object.notes,
      };
    } catch (e: any) {
      log.warn({ err: e?.message || String(e) }, "tuner call failed — falling back to rule selector");
      return { params: selectParams(dossier, DEFAULT_SELECTOR_CONFIG), fromTeacher: false };
    }
  }
}
