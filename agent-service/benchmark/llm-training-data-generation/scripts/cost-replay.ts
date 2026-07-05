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
 * DETERMINISTIC cost replay. For every recorded trace, re-render each step's
 * context under LATEST vs the LEARNED selector and sum summarize()'s own token
 * counts. No LLM, no trajectory variance — the context is a pure function of
 * (dossier, params), so this isolates the render-policy token delta exactly,
 * decoupled from the noisy live A/B. The learned selector holds the SAME
 * trajectory fixed (replay), so this answers "for these actions, how much
 * cheaper is the learned render?" — a faithful lower bound on the cost win.
 *
 * Usage: bun run .../cost-replay.ts [--traces <dir>] [--budget 4000] [--limit N]
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TexeraAgent } from "../../../src/agent/texera-agent";
import type { LLMDriver, ContextAssembler } from "../../../src/agent/llm-drivers/types";
import type { ReActStep } from "../../../src/types/agent";
import { buildDossier } from "../../../src/agent/context/summarize/dossier";
import { summarize } from "../../../src/agent/context/summarize/summarize";
import { latestPreset } from "../../../src/agent/context/summarize/params";
import { learnedSelectParams } from "../../../src/agent/context/learned/score";
import { buildUtilityModel } from "../../../src/agent/context/learned/model";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TRACES = path.resolve(HERE, "../../../../llm-training-set-v1-kramabench");
const MODEL_PATH = path.resolve(HERE, "../../../src/agent/context/learned/model.json");

const stubDriver: LLMDriver = {
  runTurn: async () => ({ text: "", messages: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
};
const stubAssembler: ContextAssembler = () => [{ role: "user", content: "" }];

function parseArgs(argv: string[]) {
  const a: { traces: string; budget: number; limit?: number; addStats: boolean } = {
    traces: DEFAULT_TRACES,
    budget: 4000,
    addStats: true,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--traces") a.traces = path.resolve(argv[++i]);
    else if (argv[i] === "--budget") a.budget = Number(argv[++i]);
    else if (argv[i] === "--limit") a.limit = Number(argv[++i]);
    else if (argv[i] === "--no-stats") a.addStats = false;
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
async function readTaskText(dir: string): Promise<string> {
  try {
    const gt = JSON.parse(await fs.readFile(path.join(dir, "ground_truth.json"), "utf-8"));
    return String(gt.query ?? gt.question ?? "");
  } catch {
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = buildUtilityModel(JSON.parse(await fs.readFile(MODEL_PATH, "utf-8")));
  const latest = latestPreset();

  let dirs = (await fs.readdir(args.traces, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  if (args.limit) dirs = dirs.slice(0, args.limit);

  let totLatest = 0;
  let totLearned = 0;
  let nTraces = 0;
  const perTrace: Array<{ id: string; latest: number; learned: number; red: number }> = [];

  for (const traceId of dirs) {
    const dir = path.join(args.traces, traceId);
    const steps = await readSteps(dir);
    if (!steps) continue;
    const taskText = await readTaskText(dir);
    let agent: TexeraAgent;
    try {
      agent = new TexeraAgent({ driver: stubDriver, contextAssembler: stubAssembler, modelType: "offline", agentId: `cost-${traceId}` });
      await agent.importReActSteps(steps as any);
    } catch {
      continue;
    }
    const ws = agent.getWorkflowState();
    const storage = agent.getSnapshotStorage();
    const path0 = agent.getVisibleReActSteps();

    let tLatest = 0;
    let tLearned = 0;
    for (let i = 0; i < path0.length; i++) {
      const step = path0[i];
      if (step.role !== "agent" || !(step.toolCalls && step.toolCalls.length > 0)) continue;
      const prefix = path0.slice(0, i + 1);
      const dossier = buildDossier(prefix, storage);
      const base = { visibleSteps: prefix, workflowState: ws, snapshotStorage: storage, compilationResult: null, dossier };
      try {
        tLatest += summarize(base, latest).breakdown.totalTokens;
        tLearned += summarize(
          base,
          learnedSelectParams(dossier, model, taskText, { budgetTokens: args.budget, addStats: args.addStats })
        ).breakdown.totalTokens;
      } catch {
        /* skip a bad step */
      }
    }
    totLatest += tLatest;
    totLearned += tLearned;
    perTrace.push({ id: traceId, latest: tLatest, learned: tLearned, red: tLatest ? 1 - tLearned / tLatest : 0 });
    nTraces++;
  }

  perTrace.sort((a, b) => b.red - a.red);
  console.log(`\n=== deterministic cost replay (budget=${args.budget}, ${nTraces} traces) ===\n`);
  console.log(`${"trace".padEnd(22)}${"latest tok".padStart(12)}${"learned tok".padStart(13)}${"reduction".padStart(11)}`);
  for (const t of perTrace) {
    console.log(`${t.id.padEnd(22)}${t.latest.toString().padStart(12)}${t.learned.toString().padStart(13)}${(t.red * 100).toFixed(1).padStart(10)}%`);
  }
  console.log(`\nTOTAL latest tokens  : ${totLatest}`);
  console.log(`TOTAL learned tokens : ${totLearned}`);
  console.log(`OVERALL reduction    : ${((1 - totLearned / totLatest) * 100).toFixed(1)}%`);
  const meanRed = perTrace.reduce((a, b) => a + b.red, 0) / (perTrace.length || 1);
  console.log(`MEAN per-trace reduction: ${(meanRed * 100).toFixed(1)}%`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
