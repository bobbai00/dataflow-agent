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
 * Context-parameter sweep: run ONE simple agent task under several context
 * configurations (LATEST / DELTA, compaction budgets, deck sampling, index
 * caps, turn-history indexing) and assert each configuration still produces
 * a working workflow + a non-empty final answer.
 *
 * This is a smoke matrix for the context assembler, not an accuracy
 * benchmark: pass = the agent completed the turn, built >=1 operator, the
 * head snapshot has executed results, and the answer text is non-empty.
 */

import { createAgent, deleteAgent, getSnapshot, runAgentTurn } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { AgentMode, ContextMode } from "../../src/types/agent";
import type { AgentSettingsApi } from "../../src/types/agent";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const MODEL_TYPE = process.env.TEXERA_AGENT_MODEL ?? "claude-haiku-4.5";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? "420000");
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

const EMPTY_WORKFLOW = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400 },
};

const TASK_PROMPT = [
  "Create a small dataflow that answers this question:",
  "generate a table of the integers 1..20 with columns `n` (the integer) and `sq` (its square),",
  "then compute the sum of `sq` over all 20 rows and answer with that single number.",
  "Use Python code operators. Keep the DAG to at most 2 operators.",
].join(" ");
const EXPECTED_ANSWER = "2870";

interface Variant {
  name: string;
  settings: Partial<AgentSettingsApi>;
}

const VARIANTS: Variant[] = [
  { name: "latest-default", settings: { contextMode: ContextMode.LATEST } },
  {
    name: "latest-columnStats-thoughtReplayK3",
    settings: { contextMode: ContextMode.LATEST, thoughtReplay: true, thoughtReplayK: 3 },
  },
  { name: "delta-unbounded", settings: { contextMode: ContextMode.DELTA } },
  {
    name: "delta-compress-8k-deck25",
    settings: {
      contextMode: ContextMode.DELTA,
      contextWindowTokens: 8000,
      compactionStrategy: "compress",
      deckSampleRatio: 0.25,
    },
  },
  {
    name: "delta-sliding-6k",
    settings: { contextMode: ContextMode.DELTA, contextWindowTokens: 6000, compactionStrategy: "sliding" },
  },
  {
    name: "delta-index-history-caps",
    settings: {
      contextMode: ContextMode.DELTA,
      turnHistory: "index",
      indexDetailedOperators: 6,
      indexRichTables: 2,
    },
  },
];

const log = (...a: unknown[]) => console.log("[ctx-tune]", ...a);

interface VariantResult {
  ok: boolean;
  steps: number;
  operators: number;
  answerHasExpected: boolean;
  durationMs: number;
  failure?: string;
}

async function runVariant(v: Variant, ctx: { token: string; cuid: number; runId: string }): Promise<VariantResult> {
  log(`▶ ${v.name}`);
  const wid = await createWorkflow(ctx.token, `ctx-tune-${v.name}-${ctx.runId}`, EMPTY_WORKFLOW, v.name);
  let agentId: string | null = null;
  const t0 = Date.now();
  try {
    const info = await createAgent({
      modelType: MODEL_TYPE,
      name: `ctx-tune-${v.name}`,
      userToken: ctx.token,
      workflowId: wid,
      computingUnitId: ctx.cuid,
      settings: { agentMode: AgentMode.CODE, ...v.settings } as AgentSettingsApi,
    });
    agentId = info.id;
    const turn = await runAgentTurn(agentId, TASK_PROMPT, { timeoutMs: TURN_TIMEOUT_MS });
    const durationMs = Date.now() - t0;
    for (const e of turn.errors) log(`  turn-error: ${e}`);

    const snapshot = await getSnapshot(agentId, "head");
    const operators = snapshot.workflow?.operators?.length ?? 0;
    const answerHasExpected = turn.finalAnswer.replace(/[,\s]/g, "").includes(EXPECTED_ANSWER);
    const ok = turn.completed && operators >= 1 && turn.finalAnswer.trim().length > 0;
    log(
      `  ${ok ? "✓" : "✗"} steps=${turn.steps.length} ops=${operators} ` +
        `answer≈${EXPECTED_ANSWER}? ${answerHasExpected} (${Math.round(durationMs / 1000)}s)`
    );
    if (!ok) log(`  finalState=${turn.finalState} answer="${turn.finalAnswer.slice(0, 200)}"`);
    return { ok, steps: turn.steps.length, operators, answerHasExpected, durationMs };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    log(`  ✗ ${failure}`);
    return { ok: false, steps: 0, operators: 0, answerHasExpected: false, durationMs: Date.now() - t0, failure };
  } finally {
    if (agentId) await deleteAgent(agentId).catch(() => {});
    await deleteWorkflow(ctx.token, wid).catch(() => {});
  }
}

async function main(): Promise<void> {
  const runId = String(Date.now());
  log(`model=${MODEL_TYPE} timeout=${TURN_TIMEOUT_MS}ms`);
  const token = await login(USERNAME, PASSWORD);
  const cu = await createComputingUnit(token, `ctx-tune-cu-${runId}`, { unitType: "local", uri: LOCAL_CU_URI });
  const cuid = cu.computingUnit.cuid;
  log(`cuid=${cuid}`);

  const filter = process.env.CTX_TUNE_FILTER;
  const variants = filter ? VARIANTS.filter(v => v.name.includes(filter)) : VARIANTS;

  const results: Array<{ name: string; r: VariantResult }> = [];
  try {
    for (const v of variants) {
      results.push({ name: v.name, r: await runVariant(v, { token, cuid, runId }) });
    }
  } finally {
    await terminateComputingUnit(token, cuid).catch(() => {});
  }

  log("=== summary ===");
  let allOk = true;
  for (const { name, r } of results) {
    if (!r.ok) allOk = false;
    log(
      `${r.ok ? "PASS" : "FAIL"}  ${name.padEnd(36)} steps=${String(r.steps).padStart(2)} ` +
        `ops=${r.operators} answer=${r.answerHasExpected} ${Math.round(r.durationMs / 1000)}s` +
        (r.failure ? `  (${r.failure})` : "")
    );
  }
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error("[ctx-tune] fatal:", err);
  process.exit(1);
});
