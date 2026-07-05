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
 * DIRECTION A — config search for the context selector.
 *
 * Runs a grid of (task × SelectorConfig) cells end-to-end on a real model,
 * records per-cell {passed, token-proxy, steps}, and reports the accuracy/token
 * Pareto frontier + the reward-maximizing config for a range of λ. This is the
 * "train the selector without ML" route: the SelectorConfig vector is the
 * hyperparameter, the KramaBench scorer + rendered-context size is the reward.
 *
 * Resumable: appends each finished cell to results.jsonl and skips cells already
 * present, so a timeout/kill loses nothing — re-run the same command to continue.
 *
 * Usage:
 *   bun run benchmark/llm-training-data-generation/scripts/selector-search.ts \
 *     [--tasks a,b,c] [--model gpt-5.2] [--out DIR]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgent,
  createComputingUnit,
  createWorkflow,
  deleteAgent,
  deleteWorkflow,
  extractUserFromToken,
  login,
  runAgentTurn,
  terminateComputingUnit,
} from "../../../src/api";
import type { ReActStep } from "../../../src/types/agent";
import type { WorkflowContent } from "../../../src/types/workflow";
import { KramabenchAdapter } from "../adapters/kramabench";
import { parseFinalAnswer, type Task } from "../protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const KRAMA_ROOT = path.join(REPO_ROOT, "llm-training-set-v1-kramabench");
const DEFAULT_OUT = path.resolve(__dirname, "..", "output", "selector-search");

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? `${12 * 60 * 1000}`);
const LOCAL_CU_URI = process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";
const log = (...a: unknown[]) => console.log("[search]", ...a);

/** Named configs to sweep. `null` = selector OFF (LATEST-default reference). */
const CONFIGS: Record<string, Record<string, unknown> | null> = {
  baseline: null,
  expert: {}, // the hand-tuned rule policy (all defaults)
  trim: { sourceDecaySteps: 0, frontierSampleRows: 6, nearFrontierSampleRows: 4, unsettledSourceRows: 8 },
  frugal: { insurance: false, frontierIncludeCode: false, sourceDecaySteps: 0, frontierSampleRows: 6 },
  rich: { frontierSampleRows: 20, historyDepth: 3, thrashHistoryThreshold: 2, nearFrontierSampleRows: 10 },
};

const DEFAULT_TASKS = [
  "environment-easy-1", // easy, single clean file
  "archeology-easy-3", // easy, value-format quirk
  "wildfire-easy-1", // dirty load (skiprows)
  "legal-easy-10", // dirty load + numclean + list_exact
  "environment-hard-14", // 7-file multi-source (where source-decay bites)
];

function emptyWf(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}
function contextCharSum(steps: ReActStep[]): number {
  let s = 0;
  for (const st of steps) {
    if (st.role !== "agent") continue;
    const c = (st.inputMessages?.[0] as { content?: unknown })?.content;
    if (typeof c === "string") s += c.length;
  }
  return s;
}
async function stage(task: Task): Promise<void> {
  const dir = path.join(REPO_ROOT, "kramabench", "data", task.id);
  await fs.mkdir(dir, { recursive: true });
  for (const f of task.dataFiles) await fs.copyFile(f.localPath, path.join(dir, path.basename(f.localPath)));
}

interface Cell {
  task: string;
  config: string;
  passed: boolean;
  completed: boolean;
  tokensProxy: number; // Σ rendered-context chars (÷4 ≈ input tokens)
  steps: number;
  answer: string;
  error?: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let model = process.env.TEXERA_AGENT_MODEL ?? "gpt-5.2";
  let tasks = DEFAULT_TASKS;
  let outDir = DEFAULT_OUT;
  let only: Set<string> | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--tasks") tasks = argv[++i].split(",").map(s => s.trim());
    else if (argv[i] === "--configs") only = new Set(argv[++i].split(",").map(s => s.trim()));
    else if (argv[i] === "--out") outDir = argv[++i];
  }
  await fs.mkdir(outDir, { recursive: true });
  const resultsPath = path.join(outDir, "results.jsonl");

  // Resume: load already-finished cells.
  const done = new Set<string>();
  const cells: Cell[] = [];
  try {
    const prior = await fs.readFile(resultsPath, "utf-8");
    for (const line of prior.split("\n")) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as Cell;
      done.add(`${c.task}::${c.config}`);
      cells.push(c);
    }
    if (done.size) log(`resuming — ${done.size} cell(s) already done`);
  } catch {
    /* fresh run */
  }

  const configNames = Object.keys(CONFIGS).filter(c => !only || only.has(c));
  const total = tasks.length * configNames.length;
  log(`grid: ${tasks.length} tasks × ${configNames.length} configs = ${total} cells; model=${model}`);

  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`uid=${user.uid}`);

  // Pre-load + stage all tasks.
  const taskObjs = new Map<string, Task>();
  for (const tid of tasks) {
    process.env.KRAMABENCH_TASKS = tid;
    let t: Task | undefined;
    for await (const x of new KramabenchAdapter().load({ rootDir: KRAMA_ROOT })) t = x;
    if (!t) {
      log(`WARN task ${tid} not found — skipping`);
      continue;
    }
    await stage(t);
    taskObjs.set(tid, t);
  }

  const cu = await createComputingUnit(token, `search-${Date.now()}`, { unitType: "local", uri: LOCAL_CU_URI });
  const cuid = cu.computingUnit.cuid;

  try {
    for (const tid of tasks) {
      const task = taskObjs.get(tid);
      if (!task) continue;
      const adapter = new KramabenchAdapter();
      const prompt = adapter.buildPrompt(task, { datasetPathPrefix: "" });
      for (const cfgName of configNames) {
        const key = `${tid}::${cfgName}`;
        if (done.has(key)) continue;
        const cfg = CONFIGS[cfgName];
        let wid: number | null = null;
        let agentId: string | null = null;
        let cell: Cell;
        try {
          wid = await createWorkflow(token, `search-${tid}-${cfgName}-${Date.now()}`, emptyWf(), "");
          const agent = await createAgent({
            modelType: model,
            name: `search-${tid}-${cfgName}`,
            userToken: token,
            workflowId: wid,
            computingUnitId: cuid,
            settings: { ...(adapter.defaultAgentSettings?.() ?? {}), ...(cfg ? { selectorConfig: cfg } : {}) } as any,
          });
          agentId = agent.id;
          const turn = await runAgentTurn(agentId, prompt, { timeoutMs: TURN_TIMEOUT_MS });
          const answer = parseFinalAnswer(turn.finalAnswer);
          const score = adapter.evaluate ? adapter.evaluate(task, answer) : undefined;
          cell = {
            task: tid,
            config: cfgName,
            passed: !!(score as any)?.passed,
            completed: turn.completed,
            tokensProxy: Math.round(contextCharSum(turn.steps) / 4),
            steps: turn.steps.filter(s => s.role === "agent").length,
            answer,
          };
        } catch (e) {
          cell = {
            task: tid,
            config: cfgName,
            passed: false,
            completed: false,
            tokensProxy: 0,
            steps: 0,
            answer: "",
            error: e instanceof Error ? e.message : String(e),
          };
        } finally {
          if (agentId) await deleteAgent(agentId).catch(() => {});
          if (wid !== null) await deleteWorkflow(token, wid).catch(() => {});
        }
        cells.push(cell);
        await fs.appendFile(resultsPath, JSON.stringify(cell) + "\n");
        log(
          `${cell.passed ? "✓" : "✗"} ${tid}/${cfgName}: passed=${cell.passed} steps=${cell.steps} ` +
            `tok≈${(cell.tokensProxy / 1000).toFixed(1)}k answer=${JSON.stringify(cell.answer.slice(0, 40))}${cell.error ? ` ERR=${cell.error.slice(0, 60)}` : ""}`
        );
      }
    }
  } finally {
    await terminateComputingUnit(token, cuid).catch(() => {});
  }

  report(cells, configNames, tasks, outDir);
}

function report(cells: Cell[], configNames: string[], tasks: string[], outDir: string): void {
  // Per-config aggregates over the tasks that have a baseline AND all configs
  // (so accuracy/tokens are comparable across configs).
  const byKey = new Map(cells.map(c => [`${c.task}::${c.config}`, c]));
  const completeTasks = tasks.filter(t => configNames.every(c => byKey.has(`${t}::${c}`)));

  interface Agg {
    config: string;
    passes: number;
    n: number;
    tokens: number;
    steps: number;
  }
  const aggs: Agg[] = configNames.map(cfg => {
    let passes = 0,
      tokens = 0,
      steps = 0;
    for (const t of completeTasks) {
      const c = byKey.get(`${t}::${cfg}`)!;
      if (c.passed) passes++;
      tokens += c.tokensProxy;
      steps += c.steps;
    }
    return { config: cfg, passes, n: completeTasks.length, tokens, steps };
  });

  log("");
  log(`=== RESULTS over ${completeTasks.length} fully-swept task(s): ${completeTasks.join(", ")} ===`);
  log(`config        acc      Σtokens   Σsteps`);
  for (const a of aggs) {
    log(`${a.config.padEnd(12)}  ${a.passes}/${a.n}     ${(a.tokens / 1000).toFixed(1)}k    ${a.steps}`);
  }

  // Pareto frontier: a config dominates another if acc ≥ and tokens ≤ (strictly better on one).
  const pareto = aggs.filter(
    a =>
      !aggs.some(
        b => b !== a && b.passes >= a.passes && b.tokens <= a.tokens && (b.passes > a.passes || b.tokens < a.tokens)
      )
  );
  log("");
  log(`Pareto-optimal configs (no other config is ≥acc AND ≤tokens):`);
  for (const a of pareto.sort((x, y) => y.passes - x.passes)) {
    log(`  ${a.config.padEnd(12)} acc=${a.passes}/${a.n} tokens=${(a.tokens / 1000).toFixed(1)}k`);
  }

  // Reward = accuracy − λ·tokens, for a few λ (tokens in millions to scale).
  log("");
  log(`Reward = Σcorrect − λ·(Σtokens):`);
  for (const lambda of [0, 5e-6, 2e-5, 1e-4]) {
    const ranked = aggs
      .map(a => ({ config: a.config, reward: a.passes - lambda * a.tokens }))
      .sort((x, y) => y.reward - x.reward);
    log(`  λ=${lambda}: ` + ranked.map(r => `${r.config}(${r.reward.toFixed(2)})`).join("  "));
  }

  // relative to baseline
  const base = aggs.find(a => a.config === "baseline");
  if (base && base.tokens > 0) {
    log("");
    log(`vs baseline (${base.passes}/${base.n}, ${(base.tokens / 1000).toFixed(1)}k tokens):`);
    for (const a of aggs) {
      if (a.config === "baseline") continue;
      const dtok = (1 - a.tokens / base.tokens) * 100;
      log(
        `  ${a.config.padEnd(12)} acc ${a.passes - base.passes >= 0 ? "+" : ""}${a.passes - base.passes}  tokens ${dtok >= 0 ? "-" : "+"}${Math.abs(dtok).toFixed(0)}%`
      );
    }
  }

  fs.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify({ completeTasks, aggs, pareto: pareto.map(p => p.config) }, null, 2)
  ).catch(() => {});
}

main().catch(e => {
  console.error("[search] fatal:", e);
  process.exit(1);
});
