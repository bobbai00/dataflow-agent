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
 * DETERMINISTIC compaction-opportunity analysis over DELTA-mode traces.
 *
 * For each trace, at each step t, it re-renders the step-t state three ways with
 * the real summarize() renderer and records exact token counts:
 *   - deltaTok   : full append-only trajectory (events interleaved) — the baseline
 *                  that grows every step (what DELTA mode actually costs).
 *   - deckHeavy  : current-snapshot deck, no event log, all results at `sample`
 *                  (= "fold the trajectory into a LATEST-style deck at t").
 *   - deckLean   : deck + the STATIC FOLD RULE applied (consumed sources / settled
 *                  interior / dead ops → shape; deleted → omit) — "fold trajectory
 *                  AND trim settled operators".
 *
 * This separates the two compaction levers Bob named:
 *   (A) fold the event log     = deltaTok − deckHeavy
 *   (B) trim settled operators = deckHeavy − deckLean
 *
 * Compaction model: the deck is frozen once at boundary K (immutable prefix) and
 * new events append raw. So per-step savings after compacting at K is ≈ constant
 * (deltaTok(K) − deckX(K)), and cumulative savings ≈ that × (nSteps − K). We
 * report the optimal K and the "sources-consumed boundary" (Bob's heuristic:
 * every loader has a healthy consumer ⇒ its rows are foldable).
 *
 * Per-operator static foldability at the final step is also tallied (no-consumer
 * non-terminal / consumed-source / deleted) — the raw material for the rules.
 *
 * Usage: bun run .../compaction-analysis.ts [--traces <dir>] [--out <dir>] [--limit N]
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TexeraAgent } from "../../../src/agent/texera-agent";
import type { LLMDriver, ContextAssembler } from "../../../src/agent/llm-drivers/types";
import type { ReActStep } from "../../../src/types/agent";
import { buildDossier, type Dossier } from "../../../src/agent/context/summarize/dossier";
import { summarize } from "../../../src/agent/context/summarize/summarize";
import { deltaPreset, latestPreset, SummarizeParamsSchema, type OperatorParamsOverride } from "../../../src/agent/context/summarize/params";
import { extractFeatures } from "../../../src/agent/context/selector/features";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TRACES = path.resolve(HERE, "../../../../llm-training-set-v1-kramabench");
const DEFAULT_OUT = path.resolve(HERE, "../output/compaction-analysis");

const stubDriver: LLMDriver = {
  runTurn: async () => ({ text: "", messages: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
};
const stubAssembler: ContextAssembler = () => [{ role: "user", content: "" }];

function parseArgs(argv: string[]) {
  const a: { traces: string; out: string; limit?: number } = { traces: DEFAULT_TRACES, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--traces") a.traces = path.resolve(argv[++i]);
    else if (argv[i] === "--out") a.out = path.resolve(argv[++i]);
    else if (argv[i] === "--limit") a.limit = Number(argv[++i]);
  }
  return a;
}
async function readSteps(dir: string): Promise<ReActStep[] | null> {
  for (const name of ["react_steps.json", "react-steps.json"]) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8"));
      const steps = Array.isArray(raw) ? raw : raw.steps ?? raw.react_steps ?? [];
      if (Array.isArray(steps) && steps.length > 0) return steps as ReActStep[];
    } catch {
      /* next */
    }
  }
  return null;
}

/** The STATIC FOLD RULE: which ops are foldable at this step, and why. */
function foldableOps(dossier: Dossier): Map<string, "deleted" | "consumed-source" | "settled-interior" | "no-consumer"> {
  const feats = extractFeatures(dossier);
  const out = new Map<string, "deleted" | "consumed-source" | "settled-interior" | "no-consumer">();
  for (const [opId, f] of feats.operators) {
    if (f.role === "deleted") out.set(opId, "deleted");
    else if (f.isSource && f.hasHealthyConsumer) out.set(opId, "consumed-source");
    else if (f.role === "interior" && f.hasHealthyConsumer) out.set(opId, "settled-interior");
    else if (!f.isTerminalNode && f.role !== "frontier" && f.role !== "near-frontier" && !f.hasHealthyConsumer && f.hasResult)
      out.set(opId, "no-consumer");
  }
  return out;
}

/** Deck params: latest snapshot (no events) with foldable ops → shape / omit. */
function leanDeckParams(dossier: Dossier) {
  const fold = foldableOps(dossier);
  const overrides: Record<string, OperatorParamsOverride> = {};
  for (const [opId, reason] of fold) {
    overrides[opId] = {
      result: { latest: { detail: reason === "deleted" ? "omit" : "shape", column: { schema: true } } },
    } as OperatorParamsOverride;
  }
  return SummarizeParamsSchema.parse({
    trajectory: { events: "none" },
    currentSnapshot: true,
    operators: { defaults: { result: { latest: { detail: "sample", column: { schema: true } } } }, overrides },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });
  const delta = deltaPreset();
  const heavy = latestPreset();

  let dirs = (await fs.readdir(args.traces, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
  if (args.limit) dirs = dirs.slice(0, args.limit);

  const agg: any[] = [];
  for (const traceId of dirs) {
    const dir = path.join(args.traces, traceId);
    const steps = await readSteps(dir);
    if (!steps) continue;
    let agent: TexeraAgent;
    try {
      agent = new TexeraAgent({ driver: stubDriver, contextAssembler: stubAssembler, modelType: "offline", agentId: `cmp-${traceId}` });
      await agent.importReActSteps(steps as any);
    } catch {
      continue;
    }
    const ws = agent.getWorkflowState();
    const storage = agent.getSnapshotStorage();
    const path0 = agent.getVisibleReActSteps();

    const perStep: any[] = [];
    let sourcesConsumedAt = -1;
    for (let i = 0; i < path0.length; i++) {
      const step = path0[i];
      if (step.role !== "agent" || !(step.toolCalls && step.toolCalls.length > 0)) continue;
      const prefix = path0.slice(0, i + 1);
      const dossier = buildDossier(prefix, storage);
      const base = { visibleSteps: prefix, workflowState: ws, snapshotStorage: storage, compilationResult: null, dossier };
      let deltaTok = 0, deckHeavy = 0, deckLean = 0;
      try {
        deltaTok = summarize(base, delta).breakdown.totalTokens;
        deckHeavy = summarize(base, heavy).breakdown.totalTokens;
        deckLean = summarize(base, leanDeckParams(dossier)).breakdown.totalTokens;
      } catch {
        continue;
      }
      const fold = foldableOps(dossier);
      const feats = extractFeatures(dossier);
      // sources-consumed boundary: all source ops have a healthy consumer.
      const sources = [...feats.operators.values()].filter(f => f.isSource);
      const allSourcesConsumed = sources.length > 0 && sources.every(f => f.hasHealthyConsumer);
      if (allSourcesConsumed && sourcesConsumedAt < 0) sourcesConsumedAt = perStep.length;

      perStep.push({
        stepIndex: i,
        deltaTok,
        deckHeavy,
        deckLean,
        foldEventLog: deltaTok - deckHeavy, // lever A
        trimSettled: deckHeavy - deckLean, // lever B
        nOps: feats.operators.size,
        nFoldable: fold.size,
        foldReasons: [...fold.values()].reduce((m: any, r) => ((m[r] = (m[r] || 0) + 1), m), {}),
        allSourcesConsumed,
      });
    }
    if (perStep.length === 0) continue;
    const N = perStep.length;

    // cumulative savings if compacted (lean) at step-index k: foldSavingsLean(k) × (N - k)
    let best = { k: -1, perStep: 0, cumulative: 0 };
    perStep.forEach((s, k) => {
      const perStepSaving = s.deltaTok - s.deckLean; // fold event log + trim settled
      const cum = perStepSaving * (N - 1 - k);
      if (cum > best.cumulative) best = { k, perStep: perStepSaving, cumulative: cum };
    });

    const last = perStep[N - 1];
    const boundary =
      sourcesConsumedAt >= 0
        ? { k: sourcesConsumedAt, perStep: perStep[sourcesConsumedAt].deltaTok - perStep[sourcesConsumedAt].deckLean, cumulative: (perStep[sourcesConsumedAt].deltaTok - perStep[sourcesConsumedAt].deckLean) * (N - 1 - sourcesConsumedAt) }
        : null;

    const rec = {
      traceId,
      domain: traceId.split("-")[0],
      nSteps: N,
      finalDeltaTok: last.deltaTok,
      finalDeckHeavy: last.deckHeavy,
      finalDeckLean: last.deckLean,
      finalFoldEventLogPct: last.deltaTok ? +((last.foldEventLog / last.deltaTok) * 100).toFixed(1) : 0,
      finalTrimSettledPct: last.deltaTok ? +((last.trimSettled / last.deltaTok) * 100).toFixed(1) : 0,
      finalFoldable: last.foldReasons,
      optimalCompaction: best, // maximize cumulative token-savings
      sourcesConsumedBoundary: boundary,
      perStep,
    };
    await fs.writeFile(path.join(args.out, `${traceId}.json`), JSON.stringify(rec, null, 2));
    agg.push({ ...rec, perStep: undefined });
  }

  await fs.writeFile(path.join(args.out, "AGGREGATE.json"), JSON.stringify(agg, null, 2));

  // Console summary
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  console.log(`\n=== compaction analysis: ${agg.length} DELTA traces ===\n`);
  console.log(`mean final trajectory (deltaTok)      : ${mean(agg.map(a => a.finalDeltaTok)).toFixed(0)}`);
  console.log(`mean fold-event-log savings @ final   : ${mean(agg.map(a => a.finalFoldEventLogPct)).toFixed(1)}% (lever A)`);
  console.log(`mean trim-settled savings @ final     : ${mean(agg.map(a => a.finalTrimSettledPct)).toFixed(1)}% (lever B)`);
  const optCum = agg.map(a => a.optimalCompaction.cumulative);
  console.log(`mean optimal cumulative token savings : ${mean(optCum).toFixed(0)} tok/trace`);
  const withBoundary = agg.filter(a => a.sourcesConsumedBoundary);
  console.log(`traces with a sources-consumed boundary: ${withBoundary.length}/${agg.length}`);
  console.log(`  mean boundary cumulative savings     : ${mean(withBoundary.map(a => a.sourcesConsumedBoundary.cumulative)).toFixed(0)} tok/trace`);
  console.log(`  boundary vs optimal step gap (mean)  : ${mean(withBoundary.map(a => a.optimalCompaction.k - a.sourcesConsumedBoundary.k)).toFixed(1)} steps`);
  // top savers
  agg.sort((a, b) => b.optimalCompaction.cumulative - a.optimalCompaction.cumulative);
  console.log(`\ntop 10 traces by optimal cumulative savings:`);
  console.log(`${"trace".padEnd(22)}${"steps".padStart(6)}${"finalDelta".padStart(11)}${"foldA%".padStart(8)}${"trimB%".padStart(8)}${"optK".padStart(6)}${"cumSave".padStart(9)}`);
  for (const a of agg.slice(0, 10)) {
    console.log(`${a.traceId.padEnd(22)}${String(a.nSteps).padStart(6)}${String(a.finalDeltaTok).padStart(11)}${String(a.finalFoldEventLogPct).padStart(8)}${String(a.finalTrimSettledPct).padStart(8)}${String(a.optimalCompaction.k).padStart(6)}${String(a.optimalCompaction.cumulative).padStart(9)}`);
  }
  console.log(`\nper-trace JSON + AGGREGATE.json written to ${args.out}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
