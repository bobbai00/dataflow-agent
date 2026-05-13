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
 * One-shot smoke test for the parallel-tool-call refactor: sends a literal
 * prompt through the agent-service, captures the trace, and reports how many
 * agent steps emitted >1 tool call (the only direct evidence that
 * parallel-tool-calls actually took effect).
 *
 * Pipeline mirrors `processTask` from run.ts:
 *   login → compute unit → empty workflow → agent (CODE mode) → runAgentTurn
 *   → write trace under `output/single-prompt/<runId>/`.
 *
 * Usage:
 *   bun run benchmark/llm-training-data-generation/scripts/run-single-prompt.ts \
 *     [--prompt-file PATH] [--out DIR] [--model NAME]
 *
 * If `--prompt-file` is omitted, the script reads from stdin so the caller can
 * heredoc the prompt in. No dataset upload — the prompt is sent verbatim and
 * any `pd.read_csv('data/…')` resolves against the CU's working directory.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(__dirname, "..", "output", "single-prompt");

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? `${15 * 60 * 1000}`);
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

const log = (...args: unknown[]) => console.log("[smoke]", ...args);
const logErr = (...args: unknown[]) => console.error("[smoke]", ...args);

interface CliArgs {
  promptFile?: string;
  outDir: string;
  model: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    outDir: DEFAULT_OUT,
    model: process.env.TEXERA_AGENT_MODEL ?? "claude-haiku-4.5",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt-file") out.promptFile = argv[++i];
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--model") out.model = argv[++i];
  }
  return out;
}

async function readPrompt(promptFile?: string): Promise<string> {
  if (promptFile) return fs.readFile(promptFile, "utf-8");
  // Read all of stdin.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function emptyWorkflowContent(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

function summarizeParallelism(steps: ReActStep[]): {
  totalAgentSteps: number;
  stepsWithMultipleToolCalls: number;
  maxToolCallsInOneStep: number;
  toolCallCountHistogram: Record<number, number>;
} {
  const agentSteps = steps.filter(s => s.role === "agent");
  let maxN = 0;
  let multi = 0;
  const histo: Record<number, number> = {};
  for (const s of agentSteps) {
    const n = s.toolCalls?.length ?? 0;
    histo[n] = (histo[n] ?? 0) + 1;
    if (n > maxN) maxN = n;
    if (n > 1) multi += 1;
  }
  return {
    totalAgentSteps: agentSteps.length,
    stepsWithMultipleToolCalls: multi,
    maxToolCallsInOneStep: maxN,
    toolCallCountHistogram: histo,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = (await readPrompt(args.promptFile)).trim();
  if (!prompt) throw new Error("empty prompt — pipe one in via stdin or pass --prompt-file");

  const runId = String(Date.now());
  const outDir = path.join(args.outDir, runId);
  await fs.mkdir(outDir, { recursive: true });

  log(`run ${runId} — model=${args.model} prompt-bytes=${prompt.length}`);

  log(`logging in as ${USERNAME}`);
  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`uid=${user.uid} email=${user.email || user.name}`);

  let cuid: number | null = null;
  let wid: number | null = null;
  let agentId: string | null = null;

  try {
    log(`provisioning local CU at ${LOCAL_CU_URI}`);
    const cu = await createComputingUnit(token, `smoke-cu-${runId}`, {
      unitType: "local",
      uri: LOCAL_CU_URI,
    });
    cuid = cu.computingUnit.cuid;
    log(`  cuid=${cuid}`);

    wid = await createWorkflow(token, `smoke-wf-${runId}`, emptyWorkflowContent(), "parallel-mode smoke");
    log(`  wid=${wid}`);

    const agentInfo = await createAgent({
      modelType: args.model,
      name: `smoke-agent-${runId}`,
      userToken: token,
      workflowId: wid,
      computingUnitId: cuid,
      settings: {
        agentMode: "code",
        // Explicit even though default is true post-refactor, so this script
        // is a self-contained record of what was tested.
        parallelToolCalls: true,
      } as any,
    });
    agentId = agentInfo.id;
    log(`  agentId=${agentId}`);

    log(`running turn (timeout=${TURN_TIMEOUT_MS}ms)…`);
    const t0 = Date.now();
    const turn = await runAgentTurn(agentId, prompt, { timeoutMs: TURN_TIMEOUT_MS });
    const durationMs = Date.now() - t0;
    log(`turn finished in ${durationMs}ms — completed=${turn.completed} steps=${turn.steps.length}`);

    const parallelism = summarizeParallelism(turn.steps);
    log(`parallelism: agentSteps=${parallelism.totalAgentSteps}`);
    log(`  stepsWithMultipleToolCalls=${parallelism.stepsWithMultipleToolCalls}`);
    log(`  maxToolCallsInOneStep=${parallelism.maxToolCallsInOneStep}`);
    log(`  histogram=${JSON.stringify(parallelism.toolCallCountHistogram)}`);

    let finalWorkflow: WorkflowContent | null = null;
    try {
      finalWorkflow = (await getCurrentWorkflow(agentId)).workflow;
    } catch (err) {
      logErr(`failed to fetch final workflow: ${err instanceof Error ? err.message : String(err)}`);
    }

    await fs.writeFile(
      path.join(outDir, "trace.json"),
      JSON.stringify(
        {
          runId,
          model: args.model,
          prompt,
          parallelism,
          finalState: turn.finalState,
          finalAnswer: turn.finalAnswer,
          completed: turn.completed,
          errors: turn.errors,
          steps: turn.steps.map(s => ({ ...s, timestamp: new Date(s.timestamp).toISOString() })),
          snapshots: Object.fromEntries(turn.snapshots.map(s => [s.stepId, s.workflow])),
          finalWorkflow,
          timings: { durationMs },
        },
        null,
        2
      )
    );
    log(`wrote ${path.join(outDir, "trace.json")}`);
    log(`final answer (first 240 chars): ${turn.finalAnswer.slice(0, 240)}`);
  } finally {
    if (agentId) {
      try {
        await deleteAgent(agentId);
      } catch (err) {
        logErr(`cleanup agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (wid !== null) {
      try {
        await deleteWorkflow(token, wid);
      } catch (err) {
        logErr(`cleanup workflow: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (cuid !== null) {
      try {
        await terminateComputingUnit(token, cuid);
      } catch (err) {
        logErr(`cleanup cu: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
