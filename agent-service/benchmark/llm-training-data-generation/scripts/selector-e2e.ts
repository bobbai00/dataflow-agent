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
 * A/B the SELECTOR policy against the LATEST baseline on a KramaBench task,
 * end-to-end with a real model. Reports per-arm: completion, answer/score,
 * agent steps, and the token proxy (sum of each agent step's rendered-context
 * chars — the thing the selector shrinks). This is the smallest possible
 * "does the trained-selector idea pay off" measurement harness.
 *
 * Usage:
 *   bun run benchmark/llm-training-data-generation/scripts/selector-e2e.ts \
 *     [--task environment-easy-1] [--model gpt-5.2] [--config '{"frontierSampleRows":8}']
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

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? `${12 * 60 * 1000}`);
const LOCAL_CU_URI = process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";
const log = (...a: unknown[]) => console.log("[selector-e2e]", ...a);

function emptyWf(): WorkflowContent {
  return { operators: [], operatorPositions: {}, links: [], commentBoxes: [], settings: { dataTransferBatchSize: 400 } };
}
/** Token proxy: total rendered-context chars the model was fed across the run
 *  (Σ over agent steps of inputMessages[0].content length). This is exactly
 *  what the selector shrinks; ÷4 ≈ input tokens. */
function contextCharSum(steps: ReActStep[]): number {
  let sum = 0;
  for (const s of steps) {
    if (s.role !== "agent") continue;
    const c = (s.inputMessages?.[0] as { content?: unknown })?.content;
    if (typeof c === "string") sum += c.length;
  }
  return sum;
}
function peakContext(steps: ReActStep[]): number {
  let m = 0;
  for (const s of steps) {
    if (s.role !== "agent") continue;
    const c = (s.inputMessages?.[0] as { content?: unknown })?.content;
    if (typeof c === "string") m = Math.max(m, c.length);
  }
  return m;
}

async function stage(task: Task): Promise<void> {
  const dir = path.join(REPO_ROOT, "kramabench", "data", task.id);
  await fs.mkdir(dir, { recursive: true });
  for (const f of task.dataFiles) await fs.copyFile(f.localPath, path.join(dir, path.basename(f.localPath)));
}

interface Arm {
  name: string;
  settings: Record<string, unknown>;
}

async function runArm(
  arm: Arm,
  task: Task,
  prompt: string,
  model: string,
  token: string,
  cuid: number
): Promise<Record<string, unknown>> {
  const wid = await createWorkflow(token, `selector-${arm.name}-${Date.now()}`, emptyWf(), "");
  let agentId: string | null = null;
  const adapter = new KramabenchAdapter();
  try {
    const agent = await createAgent({
      modelType: model,
      name: `selector-${arm.name}`,
      userToken: token,
      workflowId: wid,
      computingUnitId: cuid,
      settings: { ...(adapter.defaultAgentSettings?.() ?? {}), ...arm.settings } as any,
    });
    agentId = agent.id;
    const turn = await runAgentTurn(agentId, prompt, { timeoutMs: TURN_TIMEOUT_MS });
    const parsed = parseFinalAnswer(turn.finalAnswer);
    const score = adapter.evaluate ? adapter.evaluate(task, parsed) : undefined;
    return {
      arm: arm.name,
      completed: turn.completed,
      agentSteps: turn.steps.filter(s => s.role === "agent").length,
      contextCharSum: contextCharSum(turn.steps),
      peakContextChars: peakContext(turn.steps),
      answer: parsed,
      passed: (score as any)?.passed,
    };
  } finally {
    if (agentId) await deleteAgent(agentId).catch(() => {});
    await deleteWorkflow(token, wid).catch(() => {});
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let taskId = "environment-easy-1";
  let model = process.env.TEXERA_AGENT_MODEL ?? "gpt-5.2";
  let configRaw = "{}";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") taskId = argv[++i];
    else if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--config") configRaw = argv[++i];
  }
  const selectorConfig = JSON.parse(configRaw);

  process.env.KRAMABENCH_TASKS = taskId;
  const adapter = new KramabenchAdapter();
  let task: Task | undefined;
  for await (const t of adapter.load({ rootDir: KRAMA_ROOT })) task = t;
  if (!task) throw new Error(`task ${taskId} not found`);
  await stage(task);
  const prompt = adapter.buildPrompt(task, { datasetPathPrefix: "" });

  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`task=${taskId} model=${model} uid=${user.uid}`);
  const cu = await createComputingUnit(token, `selector-e2e-${Date.now()}`, { unitType: "local", uri: LOCAL_CU_URI });
  const cuid = cu.computingUnit.cuid;

  const arms: Arm[] = [
    { name: "latest-baseline", settings: {} },
    { name: "selector", settings: { selectorConfig } },
  ];

  const results: Record<string, unknown>[] = [];
  try {
    for (const arm of arms) {
      log(`── running ${arm.name} …`);
      const r = await runArm(arm, task, prompt, model, token, cuid);
      results.push(r);
      log(
        `   ${arm.name}: completed=${r.completed} passed=${r.passed} steps=${r.agentSteps} ` +
          `Σctx=${(Number(r.contextCharSum) / 1024).toFixed(1)}kB peak=${(Number(r.peakContextChars) / 1024).toFixed(1)}kB answer=${JSON.stringify(r.answer)}`
      );
    }
  } finally {
    await terminateComputingUnit(token, cuid).catch(() => {});
  }

  const base = results.find(r => r.arm === "latest-baseline");
  const sel = results.find(r => r.arm === "selector");
  if (base && sel) {
    const saved = 1 - Number(sel.contextCharSum) / Math.max(1, Number(base.contextCharSum));
    log("");
    log(`=== ${taskId} (${model}) ===`);
    log(`baseline: passed=${base.passed} steps=${base.agentSteps} Σctx=${(Number(base.contextCharSum) / 1024).toFixed(1)}kB`);
    log(`selector: passed=${sel.passed} steps=${sel.agentSteps} Σctx=${(Number(sel.contextCharSum) / 1024).toFixed(1)}kB`);
    log(`context Σ change: ${(saved * 100).toFixed(1)}% ${saved >= 0 ? "saved" : "MORE"}  | accuracy: base=${base.passed} selector=${sel.passed}`);
  }
}

main().catch(e => {
  console.error("[selector-e2e] fatal:", e);
  process.exit(1);
});
