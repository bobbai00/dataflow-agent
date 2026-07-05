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
 * OFFLINE feature-dump for the learned context selector (training set v1).
 *
 * For every recorded KramaBench trace: replay it into a stub TexeraAgent
 * (importReActSteps — pure, no network), then for each decision-point step t
 * build the step-t dossier and emit one row per operator:
 *   trace_id, domain, step_index, op_id, <FEATURE_NAMES...>, sample_token_cost,
 *   label (future_use: op ∈ ancestor-closure of the final answer sink).
 *
 * The features come from the SAME TS code the runtime serves (features-ml.ts),
 * so there is no train/serve skew beyond result fidelity (regex-reconstructed
 * here vs live results at serve time — the capture-v2 upgrade closes that).
 *
 * Usage: bun run benchmark/llm-training-data-generation/scripts/dump-features.ts \
 *          [--traces <dir>] [--out <csv>] [--limit N]
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TexeraAgent } from "../../../src/agent/texera-agent";
import type { LLMDriver, ContextAssembler } from "../../../src/agent/llm-drivers/types";
import type { ReActStep } from "../../../src/types/agent";
import { buildDossier } from "../../../src/agent/context/summarize/dossier";
import { FEATURE_NAMES, perOperatorMLFeatures } from "../../../src/agent/context/learned/features-ml";
import { loadBearingOps } from "../../../src/agent/context/learned/label";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TRACES = path.resolve(HERE, "../../../../llm-training-set-v1-kramabench");
const DEFAULT_OUT = path.resolve(HERE, "../output/learned/features.csv");

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

function domainOf(traceId: string): string {
  return traceId.split("-")[0] ?? "unknown";
}

async function readSteps(dir: string): Promise<ReActStep[] | null> {
  for (const name of ["react_steps.json", "react-steps.json"]) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8"));
      const steps = Array.isArray(raw) ? raw : raw.steps ?? raw.react_steps ?? [];
      if (Array.isArray(steps) && steps.length > 0) return steps as ReActStep[];
    } catch {
      /* try next */
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

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(path.dirname(args.out), { recursive: true });

  let dirs = (await fs.readdir(args.traces, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  if (args.limit) dirs = dirs.slice(0, args.limit);

  const header = ["trace_id", "domain", "step_index", "op_id", ...FEATURE_NAMES, "sample_token_cost", "label"];
  const lines: string[] = [header.join(",")];
  let nTraces = 0;
  let nRows = 0;
  let nPos = 0;
  const skipped: string[] = [];

  for (const traceId of dirs) {
    const dir = path.join(args.traces, traceId);
    const steps = await readSteps(dir);
    if (!steps) {
      skipped.push(`${traceId} (no steps)`);
      continue;
    }
    const taskText = await readTaskText(dir);

    let agent: TexeraAgent;
    try {
      agent = new TexeraAgent({ driver: stubDriver, contextAssembler: stubAssembler, modelType: "offline", agentId: `dump-${traceId}` });
      await agent.importReActSteps(steps as any);
    } catch (err) {
      skipped.push(`${traceId} (import failed: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const storage = agent.getSnapshotStorage();
    const path0 = agent.getVisibleReActSteps();
    const finalWf = agent.getWorkflowState().getWorkflowContent();
    const bearing = loadBearingOps(finalWf);

    // Decision points = agent steps that carry tool calls.
    for (let i = 0; i < path0.length; i++) {
      const step = path0[i];
      if (step.role !== "agent" || !(step.toolCalls && step.toolCalls.length > 0)) continue;
      const prefix = path0.slice(0, i + 1);
      let feats;
      try {
        const dossier = buildDossier(prefix, storage);
        feats = perOperatorMLFeatures(dossier, taskText);
      } catch {
        continue;
      }
      for (const [opId, mf] of feats) {
        const label = bearing.has(opId) ? 1 : 0;
        nPos += label;
        nRows++;
        lines.push(
          [traceId, domainOf(traceId), i, opId, ...mf.vec.map(x => (Number.isFinite(x) ? +x.toFixed(6) : 0)), mf.sampleTokenCost, label]
            .map(csvEscape)
            .join(",")
        );
      }
    }
    nTraces++;
  }

  await fs.writeFile(args.out, lines.join("\n") + "\n");
  console.log(`traces processed : ${nTraces}`);
  console.log(`rows             : ${nRows}`);
  console.log(`positive rate    : ${nRows ? (nPos / nRows).toFixed(3) : "n/a"} (${nPos}/${nRows})`);
  console.log(`features          : ${FEATURE_NAMES.length}`);
  console.log(`written          : ${args.out}`);
  if (skipped.length) console.log(`skipped (${skipped.length}): ${skipped.slice(0, 8).join("; ")}${skipped.length > 8 ? " …" : ""}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
