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
 * END-TO-END verification of the summarize() parameter space on a real
 * KramaBench task: runs the SAME task under several distinct summarize-params
 * variants and verifies, from the context the model ACTUALLY received
 * (each agent step's recorded inputMessages), that every variant rendered as
 * configured — and that the agent still completes the task.
 *
 * Usage:
 *   bun run benchmark/llm-training-data-generation/scripts/summarize-params-e2e.ts \
 *     [--task environment-easy-1] [--model gpt-5.2] [--variants name1,name2] [--out DIR]
 *
 * Prereqs: full JVM stack + agent-service + LiteLLM (:4000) up, copilot enabled.
 * Data: stages the task's files at <repo>/kramabench/data/<taskId>/ — the
 * relative paths the KramabenchAdapter prompt tells the agent to load.
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
  getCurrentWorkflow,
  login,
  runAgentTurn,
  terminateComputingUnit,
} from "../../../src/api";
import type { WorkflowContent } from "../../../src/types/workflow";
import type { ReActStep } from "../../../src/types/agent";
import { KramabenchAdapter } from "../adapters/kramabench";
import { parseFinalAnswer, type Task } from "../protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const KRAMA_ROOT = path.join(REPO_ROOT, "llm-training-set-v1-kramabench");
const DEFAULT_OUT = path.resolve(__dirname, "..", "output", "summarize-params-e2e");

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? `${12 * 60 * 1000}`);
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

const log = (...a: unknown[]) => console.log("[params-e2e]", ...a);
const logErr = (...a: unknown[]) => console.error("[params-e2e]", ...a);

/* ---------------------------- variants ---------------------------- */

interface ContextCheck {
  kind: "contains" | "absent" | "regex-absent";
  needle: string;
  label: string;
}

interface Variant {
  name: string;
  /** Extra agent settings (on top of the adapter defaults). */
  settings: Record<string, unknown>;
  /** What this variant is exercising, for the report. */
  exercises: string;
  /** Hard assertions on the rendered context (the last agent step's input). */
  require: ContextCheck[];
  /** Soft markers: reported, not asserted (may depend on model behavior). */
  observe: string[];
}

const has = (needle: string): ContextCheck => ({
  kind: "contains",
  needle,
  label: `contains ${JSON.stringify(needle)}`,
});
const not = (needle: string): ContextCheck => ({ kind: "absent", needle, label: `absent   ${JSON.stringify(needle)}` });
/** No TSV body anywhere: result tables render as two-space-indented lines
 *  whose first char is a tab (the header/index column). */
const NO_TSV: ContextCheck = { kind: "regex-absent", needle: "\\n  \\t", label: "absent   TSV table body" };

const VARIANTS: Variant[] = [
  {
    name: "latest-baseline",
    settings: {},
    exercises: "LATEST preset (unchanged default behavior)",
    require: [has("# Current Dataflow"), has("# Reasoning (your recent steps)"), not("# Agent Events")],
    observe: [],
  },
  {
    name: "delta",
    settings: { contextMode: "delta" },
    exercises: "DELTA preset (unchanged default behavior)",
    require: [has("# Agent Events"), has("## Agent Event"), not("# Current Dataflow")],
    observe: [],
  },
  {
    name: "shape-only",
    settings: {
      summarizeParams: {
        operators: { defaults: { result: { latest: { detail: "shape", column: { schema: true } } } } },
      },
    },
    exercises: "result detail=shape + schema line (no raw rows at all)",
    require: [has("Output Table:"), has("Schema ("), NO_TSV],
    observe: [],
  },
  {
    name: "code-visible",
    settings: {
      summarizeParams: {
        operators: {
          defaults: { property: { includeCode: true, codeHistory: 2 }, result: { history: { lastK: 1 } } },
        },
      },
    },
    exercises: "current code in operator blocks + code/result history (dossier)",
    require: [has("\nCode:")],
    observe: ["Code @ step", "Result @ step"],
  },
  {
    name: "stats-minimal",
    settings: {
      summarizeParams: {
        operators: {
          defaults: {
            result: {
              latest: { tuple: { sampleRows: 5 }, column: { stats: true } },
            },
          },
        },
      },
    },
    exercises: "column stats with metric subset (null+distinct only) + 5-row sample cap",
    require: [has("Column Schema and stats:"), not("mean=")],
    observe: ["top_5={", "top_10={"],
  },
  {
    name: "tuple-hints",
    settings: {
      summarizeParams: {
        operators: {
          defaults: { result: { latest: { tuple: { sampleRows: 8, duplicates: true, fdHints: true } } } },
        },
      },
    },
    exercises: "sample-based duplicate/FD tuple hints + 8-row sample cap",
    require: [],
    observe: ["Sample duplicates", "Sample FDs"],
  },
];

/* ---------------------------- helpers ---------------------------- */

function emptyWorkflowContent(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

/** The rendered context of the LAST agent step that recorded one — i.e. what
 *  the model saw on its final generation. */
function lastRenderedContext(steps: ReActStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.role !== "agent" || !s.inputMessages?.length) continue;
    const first = s.inputMessages[0] as { content?: unknown };
    if (typeof first?.content === "string") return first.content;
  }
  return "";
}

function runCheck(context: string, c: ContextCheck): boolean {
  if (c.kind === "contains") return context.includes(c.needle);
  if (c.kind === "absent") return !context.includes(c.needle);
  return !new RegExp(c.needle).test(context);
}

async function stageTaskData(task: Task): Promise<string> {
  const dir = path.join(REPO_ROOT, "kramabench", "data", task.id);
  await fs.mkdir(dir, { recursive: true });
  for (const f of task.dataFiles) {
    await fs.copyFile(f.localPath, path.join(dir, path.basename(f.localPath)));
  }
  return dir;
}

/* ------------------------------ main ------------------------------ */

interface VariantResult {
  variant: string;
  exercises: string;
  completed: boolean;
  finalState: string;
  agentSteps: number;
  contextChars: number;
  checks: Array<{ label: string; pass: boolean }>;
  observed: Record<string, boolean>;
  parsedAnswer: string;
  goldAnswer: string;
  score?: unknown;
  errors: string[];
  durationMs: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let taskId = "environment-easy-1";
  let model = process.env.TEXERA_AGENT_MODEL ?? "gpt-5.2";
  let only: Set<string> | null = null;
  let outRoot = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") taskId = argv[++i];
    else if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--variants") only = new Set(argv[++i].split(",").map(s => s.trim()));
    else if (argv[i] === "--out") outRoot = argv[++i];
  }
  const variants = only ? VARIANTS.filter(v => only!.has(v.name)) : VARIANTS;

  // Load the one task.
  process.env.KRAMABENCH_TASKS = taskId;
  const adapter = new KramabenchAdapter();
  let task: Task | undefined;
  for await (const t of adapter.load({ rootDir: KRAMA_ROOT })) task = t;
  if (!task) throw new Error(`task ${taskId} not found under ${KRAMA_ROOT}`);
  if (task.dataFiles.length === 0) throw new Error(`task ${taskId} has no resolvable data files`);

  const staged = await stageTaskData(task);
  log(`task ${task.id}: staged ${task.dataFiles.length} file(s) at ${staged}`);
  const prompt = adapter.buildPrompt(task, { datasetPathPrefix: "" });

  const runId = String(Date.now());
  const outDir = path.join(outRoot, runId);
  await fs.mkdir(outDir, { recursive: true });
  log(`run ${runId}: model=${model}, ${variants.length} variant(s) — output ${outDir}`);

  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`logged in as uid=${user.uid}`);

  const cu = await createComputingUnit(token, `params-e2e-${runId}`, { unitType: "local", uri: LOCAL_CU_URI });
  const cuid = cu.computingUnit.cuid;
  log(`cuid=${cuid}`);

  const results: VariantResult[] = [];
  try {
    for (const variant of VARIANTS) {
      if (!variants.includes(variant)) continue;
      log(`── variant ${variant.name} — ${variant.exercises}`);
      const t0 = Date.now();
      let wid: number | null = null;
      let agentId: string | null = null;
      const errors: string[] = [];
      let steps: ReActStep[] = [];
      let finalState = "UNKNOWN";
      let finalAnswer = "";
      let completed = false;

      try {
        wid = await createWorkflow(token, `params-e2e-${variant.name}-${runId}`, emptyWorkflowContent(), "");
        const agentInfo = await createAgent({
          modelType: model,
          name: `params-e2e-${variant.name}`,
          userToken: token,
          workflowId: wid,
          computingUnitId: cuid,
          settings: { ...(adapter.defaultAgentSettings?.() ?? {}), ...variant.settings } as any,
        });
        agentId = agentInfo.id;

        const turn = await runAgentTurn(agentId, prompt, { timeoutMs: TURN_TIMEOUT_MS });
        steps = turn.steps;
        finalState = turn.finalState;
        finalAnswer = turn.finalAnswer;
        completed = turn.completed;
        errors.push(...turn.errors);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      } finally {
        if (agentId) await deleteAgent(agentId).catch(e => errors.push(`cleanup agent: ${e.message}`));
        if (wid !== null) await deleteWorkflow(token, wid).catch(e => errors.push(`cleanup wf: ${e.message}`));
      }

      const context = lastRenderedContext(steps);
      const checks = variant.require.map(c => ({ label: c.label, pass: runCheck(context, c) }));
      const observed = Object.fromEntries(variant.observe.map(m => [m, context.includes(m)]));
      const parsedAnswer = parseFinalAnswer(finalAnswer);
      const score = adapter.evaluate ? adapter.evaluate(task!, parsedAnswer) : undefined;

      const res: VariantResult = {
        variant: variant.name,
        exercises: variant.exercises,
        completed,
        finalState,
        agentSteps: steps.filter(s => s.role === "agent").length,
        contextChars: context.length,
        checks,
        observed,
        parsedAnswer,
        goldAnswer: task.goldAnswer,
        score,
        errors,
        durationMs: Date.now() - t0,
      };
      results.push(res);

      await fs.writeFile(
        path.join(outDir, `${variant.name}.trace.json`),
        JSON.stringify(
          {
            ...res,
            prompt,
            lastContext: context,
            steps: steps.map(s => ({ ...s, timestamp: new Date(s.timestamp).toISOString() })),
          },
          null,
          2
        )
      );

      const passed = checks.every(c => c.pass);
      log(
        `   ${passed ? "✓" : "✗"} checks=${checks.filter(c => c.pass).length}/${checks.length} ` +
          `completed=${completed} steps=${res.agentSteps} ctx=${(context.length / 1024).toFixed(1)}kB ` +
          `answer=${JSON.stringify(parsedAnswer.slice(0, 60))} (${Math.round(res.durationMs / 1000)}s)`
      );
      for (const c of checks.filter(c => !c.pass)) log(`     FAILED: ${c.label}`);
      for (const [m, seen] of Object.entries(observed)) log(`     observe: ${m} → ${seen ? "present" : "not present"}`);
    }
  } finally {
    await terminateComputingUnit(token, cuid).catch(e => logErr(`cleanup cu: ${e.message}`));
  }

  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ runId, model, taskId, results }, null, 2));

  // Final report.
  log("");
  log(`=== SUMMARY (task=${taskId}, model=${model}) ===`);
  let allPass = true;
  for (const r of results) {
    const ok = r.checks.every(c => c.pass);
    if (!ok || !r.completed) allPass = false;
    log(
      `${(ok && r.completed ? "PASS" : "FAIL").padEnd(5)} ${r.variant.padEnd(16)} ` +
        `checks=${r.checks.filter(c => c.pass).length}/${r.checks.length} completed=${r.completed} ` +
        `steps=${r.agentSteps} ctx=${(r.contextChars / 1024).toFixed(1)}kB answer=${JSON.stringify(r.parsedAnswer.slice(0, 40))}`
    );
  }
  log(`summary.json + per-variant traces → ${outDir}`);
  if (!allPass) {
    logErr("one or more variants failed their context checks — inspect the traces");
    process.exit(1);
  }
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
