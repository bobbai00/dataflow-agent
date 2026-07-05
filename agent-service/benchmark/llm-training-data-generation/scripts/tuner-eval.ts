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
 * END-TO-END comparison: LLM context-TUNER (agent gpt-5.2 + teacher gpt-5.4)
 * vs static LATEST baseline (agent gpt-5.2, no tuner). Per (task × arm × rep)
 * records accuracy + the agent's Σ rendered-context tokens (the target metric)
 * + steps. Resumable (appends to results.jsonl; skips done cells).
 *
 * Teacher token overhead is measured separately (reported as a caveat, not in
 * the primary cost metric — per the design decision).
 *
 * Usage:
 *   bun run .../tuner-eval.ts [--tasks a,b] [--reps 1] [--agent gpt-5.2] [--teacher gpt-5.4] [--out DIR]
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
const DEFAULT_OUT = path.resolve(__dirname, "..", "output", "tuner-eval");

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? `${15 * 60 * 1000}`);
const LOCAL_CU_URI = process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";
const log = (...a: unknown[]) => console.log("[tuner-eval]", ...a);

const DEFAULT_TASKS = [
  "environment-easy-1",
  "archeology-easy-3",
  "wildfire-easy-1",
  "legal-easy-10",
  "environment-hard-14",
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
function ctxTokens(steps: ReActStep[]): number {
  let s = 0;
  for (const st of steps) {
    if (st.role !== "agent") continue;
    const c = (st.inputMessages?.[0] as { content?: unknown })?.content;
    if (typeof c === "string") s += c.length;
  }
  return Math.round(s / 4);
}
async function stage(task: Task): Promise<void> {
  const dir = path.join(REPO_ROOT, "kramabench", "data", task.id);
  await fs.mkdir(dir, { recursive: true });
  for (const f of task.dataFiles) await fs.copyFile(f.localPath, path.join(dir, path.basename(f.localPath)));
}

interface Cell {
  task: string;
  arm: string;
  rep: number;
  passed: boolean;
  completed: boolean;
  ctxTokens: number;
  steps: number;
  answer: string;
  error?: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let agentModel = "gpt-5.2",
    teacherModel = "gpt-5.4",
    reps = 1,
    tasks = DEFAULT_TASKS,
    outDir = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") agentModel = argv[++i];
    else if (argv[i] === "--teacher") teacherModel = argv[++i];
    else if (argv[i] === "--reps") reps = Number(argv[++i]);
    else if (argv[i] === "--tasks") tasks = argv[++i].split(",").map(s => s.trim());
    else if (argv[i] === "--out") outDir = argv[++i];
  }
  await fs.mkdir(outDir, { recursive: true });
  const resultsPath = path.join(outDir, "results.jsonl");

  const done = new Set<string>();
  const cells: Cell[] = [];
  try {
    for (const line of (await fs.readFile(resultsPath, "utf-8")).split("\n")) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as Cell;
      done.add(`${c.task}::${c.arm}::${c.rep}`);
      cells.push(c);
    }
    if (done.size) log(`resuming — ${done.size} done`);
  } catch {
    /* fresh */
  }

  const arms: { name: string; settings: Record<string, unknown> }[] = [
    { name: "baseline", settings: {} },
    { name: "tuner", settings: { tunerConfig: { model: teacherModel } } },
  ];

  const token = await login(USERNAME, PASSWORD);
  log(
    `agent=${agentModel} teacher=${teacherModel} reps=${reps} tasks=${tasks.length}; uid=${extractUserFromToken(token).uid}`
  );

  const taskObjs = new Map<string, Task>();
  for (const tid of tasks) {
    process.env.KRAMABENCH_TASKS = tid;
    let t: Task | undefined;
    for await (const x of new KramabenchAdapter().load({ rootDir: KRAMA_ROOT })) t = x;
    if (!t) {
      log(`WARN ${tid} not found`);
      continue;
    }
    await stage(t);
    taskObjs.set(tid, t);
  }

  const cu = await createComputingUnit(token, `tuner-eval-${Date.now()}`, { unitType: "local", uri: LOCAL_CU_URI });
  const cuid = cu.computingUnit.cuid;
  try {
    for (const tid of tasks) {
      const task = taskObjs.get(tid);
      if (!task) continue;
      const adapter = new KramabenchAdapter();
      const prompt = adapter.buildPrompt(task, { datasetPathPrefix: "" });
      for (let rep = 0; rep < reps; rep++) {
        for (const arm of arms) {
          const key = `${tid}::${arm.name}::${rep}`;
          if (done.has(key)) continue;
          let wid: number | null = null,
            agentId: string | null = null;
          let cell: Cell;
          try {
            wid = await createWorkflow(token, `te-${tid}-${arm.name}-${rep}-${Date.now()}`, emptyWf(), "");
            const agent = await createAgent({
              modelType: agentModel,
              name: `te-${tid}-${arm.name}`,
              userToken: token,
              workflowId: wid,
              computingUnitId: cuid,
              settings: { ...(adapter.defaultAgentSettings?.() ?? {}), ...arm.settings } as any,
            });
            agentId = agent.id;
            const turn = await runAgentTurn(agentId, prompt, { timeoutMs: TURN_TIMEOUT_MS });
            const answer = parseFinalAnswer(turn.finalAnswer);
            const score = adapter.evaluate ? adapter.evaluate(task, answer) : undefined;
            cell = {
              task: tid,
              arm: arm.name,
              rep,
              passed: !!(score as any)?.passed,
              completed: turn.completed,
              ctxTokens: ctxTokens(turn.steps),
              steps: turn.steps.filter(s => s.role === "agent").length,
              answer,
            };
          } catch (e) {
            cell = {
              task: tid,
              arm: arm.name,
              rep,
              passed: false,
              completed: false,
              ctxTokens: 0,
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
            `${cell.passed ? "✓" : "✗"} ${tid}/${arm.name}#${rep}: passed=${cell.passed} steps=${cell.steps} ctx≈${(cell.ctxTokens / 1000).toFixed(1)}k answer=${JSON.stringify(cell.answer.slice(0, 40))}${cell.error ? ` ERR=${cell.error.slice(0, 50)}` : ""}`
          );
        }
      }
    }
  } finally {
    await terminateComputingUnit(token, cuid).catch(() => {});
  }
  report(
    cells,
    tasks,
    arms.map(a => a.name),
    outDir
  );
}

function report(cells: Cell[], tasks: string[], armNames: string[], outDir: string): void {
  const get = (t: string, a: string) => cells.filter(c => c.task === t && c.arm === a);
  // per-arm aggregates over tasks where BOTH arms have >=1 rep
  const bothTasks = tasks.filter(t => armNames.every(a => get(t, a).length > 0));
  log("");
  log(`=== TUNER vs BASELINE over ${bothTasks.length} task(s), agent context tokens ===`);
  log(`${"arm".padEnd(10)} acc        Σtokens   mean-steps`);
  const agg: Record<string, { pass: number; n: number; tok: number; steps: number }> = {};
  for (const a of armNames) {
    let pass = 0,
      n = 0,
      tok = 0,
      steps = 0;
    for (const t of bothTasks) {
      const cs = get(t, a);
      for (const c of cs) {
        if (c.passed) pass++;
        tok += c.ctxTokens;
        steps += c.steps;
        n++;
      }
    }
    agg[a] = { pass, n, tok, steps };
    log(`${a.padEnd(10)} ${pass}/${n}      ${(tok / 1000).toFixed(1)}k    ${(steps / Math.max(1, n)).toFixed(1)}`);
  }
  const b = agg["baseline"],
    tn = agg["tuner"];
  if (b && tn) {
    const dtok = (1 - tn.tok / Math.max(1, b.tok)) * 100;
    log("");
    log(
      `tuner vs baseline: accuracy ${tn.pass}/${tn.n} vs ${b.pass}/${b.n}  |  context tokens ${dtok >= 0 ? "-" : "+"}${Math.abs(dtok).toFixed(0)}%`
    );
    log(`per-task:`);
    for (const t of bothTasks) {
      const bc = get(t, "baseline"),
        tc = get(t, "tuner");
      const bp = bc.filter(c => c.passed).length,
        tp = tc.filter(c => c.passed).length;
      const bt = bc.reduce((s, c) => s + c.ctxTokens, 0) / Math.max(1, bc.length);
      const tt = tc.reduce((s, c) => s + c.ctxTokens, 0) / Math.max(1, tc.length);
      log(
        `  ${t.padEnd(22)} acc base ${bp}/${bc.length} tuner ${tp}/${tc.length}  ctx base ${(bt / 1000).toFixed(1)}k tuner ${(tt / 1000).toFixed(1)}k (${((1 - tt / Math.max(1, bt)) * 100).toFixed(0)}%)`
      );
    }
  }
  fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ bothTasks, agg }, null, 2)).catch(() => {});
}

main().catch(e => {
  console.error("[tuner-eval] fatal:", e);
  process.exit(1);
});
