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

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgent,
  createComputingUnit,
  createDataset,
  createDatasetVersion,
  createWorkflow,
  deleteAgent,
  deleteDataset,
  deleteWorkflow,
  extractUserFromToken,
  getCurrentWorkflow,
  login,
  runAgentTurn,
  terminateComputingUnit,
  uploadFileToDataset,
} from "../../src/api";
import { AgentMode, type ReActStep } from "../../src/types/agent";
import type { WorkflowContent } from "../../src/types/workflow";

import {
  aggregateSummary,
  defaultScore,
  parseFinalAnswer,
  type DatasetAdapter,
  type Task,
  type TraceRecord,
} from "./protocol";
import { FetaqaAdapter } from "./adapters/fetaqa";
import { KramabenchAdapter } from "./adapters/kramabench";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_ROOT = path.resolve(ROOT, "data");
const OUTPUT_ROOT = path.resolve(ROOT, "output");

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const MODEL_TYPE = process.env.TEXERA_AGENT_MODEL ?? "claude-haiku-4.5";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? `${10 * 60 * 1000}`);
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

const log = (...args: unknown[]) => console.log("[trace-gen]", ...args);
const logErr = (...args: unknown[]) => console.error("[trace-gen]", ...args);

interface CliArgs {
  source: string;
  limit: number;
  offset: number;
  outputDir: string;
  dataRoot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--offset") args.offset = Number(argv[++i]);
    else if (a === "--output") args.outputDir = argv[++i];
    else if (a === "--data-root") args.dataRoot = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: bun run benchmark/llm-training-data-generation/run.ts [--source fetaqa|kramabench] [--limit N] [--offset N] [--output PATH] [--data-root PATH]");
      process.exit(0);
    }
  }
  return {
    source: args.source ?? "fetaqa",
    limit: Number.isFinite(args.limit) ? (args.limit as number) : 10,
    offset: Number.isFinite(args.offset) ? (args.offset as number) : 0,
    outputDir: args.outputDir ?? OUTPUT_ROOT,
    dataRoot: args.dataRoot,
  };
}

function getAdapter(name: string): DatasetAdapter {
  switch (name.toLowerCase()) {
    case "fetaqa":
      return new FetaqaAdapter();
    case "kramabench":
      return new KramabenchAdapter();
    default:
      throw new Error(`Unknown source adapter: ${name}`);
  }
}

interface PerTaskResources {
  taskId: string;
  datasetDid?: number;
  workflowWid?: number;
  agentId?: string;
}

async function uploadDataForTask(
  token: string,
  task: Task,
  ownerEmail: string,
  runId: string
): Promise<{ did: number; datasetPathPrefix: string }> {
  const datasetName = `${task.source}-${task.id}-${runId}`;
  const ds = await createDataset(token, datasetName, `Auto-uploaded for ${task.id}`, false, true);

  for (const f of task.dataFiles) {
    const bytes = await fs.readFile(f.localPath);
    await uploadFileToDataset(token, ds.dataset.did, f.relPath, bytes, "trace-gen upload");
  }

  const versionRes = await createDatasetVersion(token, ds.dataset.did, "");
  const versionName = versionRes.datasetVersion.name; // expected "v1"

  return {
    did: ds.dataset.did,
    datasetPathPrefix: `/${ownerEmail}/${datasetName}/${versionName}`,
  };
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

interface ProcessTaskInput {
  token: string;
  ownerEmail: string;
  cuid: number;
  runId: string;
  task: Task;
  adapter: DatasetAdapter;
  outputDir: string;
}

/**
 * Build the per-task react-steps.json envelope. Mirrors the shape used by the
 * agent-service frontend export so traces are interchangeable between
 * sources. Numeric epoch `timestamp`s are rendered as ISO strings.
 */
function buildReActStepsExport(opts: {
  agentId: string;
  agentName: string;
  modelType: string;
  steps: ReActStep[];
}) {
  return {
    agentId: opts.agentId,
    agentName: opts.agentName,
    modelType: opts.modelType,
    exportedAt: new Date().toISOString(),
    stepCount: opts.steps.length,
    steps: opts.steps.map(s => ({
      ...s,
      timestamp: new Date(s.timestamp).toISOString(),
    })),
  };
}

async function processTask(input: ProcessTaskInput): Promise<TraceRecord> {
  const { token, ownerEmail, cuid, runId, task, adapter, outputDir } = input;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const errors: string[] = [];
  const resources: PerTaskResources = { taskId: task.id };

  let prompt = "";
  let reactSteps: ReActStep[] = [];
  let snapshots: Record<string, WorkflowContent> = {};
  let finalAnswer = "";
  let finalState = "UNKNOWN";
  let finalWorkflow: WorkflowContent | null = null;
  let agentMode: TraceRecord["agentInfo"]["agentMode"] = "unknown";
  let agentName = "";

  try {
    log(`task ${task.id}: uploading ${task.dataFiles.length} data file(s)`);
    const { did, datasetPathPrefix } = await uploadDataForTask(token, task, ownerEmail, runId);
    resources.datasetDid = did;

    log(`task ${task.id}: creating workflow`);
    const wid = await createWorkflow(
      token,
      `${task.source}-${task.id}-${runId}`,
      emptyWorkflowContent(),
      `Auto-generated for trace generation: ${task.id}`
    );
    resources.workflowWid = wid;

    // TEXERA_SETTINGS_JSON lets an A/B harness inject an arm's settings
    // (e.g. {"learnedConfig":{"budgetTokens":4000}} or {"selectorConfig":{}})
    // over the adapter defaults without a bespoke runner.
    const extraSettings = process.env.TEXERA_SETTINGS_JSON ? JSON.parse(process.env.TEXERA_SETTINGS_JSON) : {};
    const settingsHints = { ...(adapter.defaultAgentSettings?.() ?? {}), ...extraSettings };
    log(`task ${task.id}: creating agent (model=${MODEL_TYPE}, mode=${settingsHints.agentMode ?? "default"})`);
    const agentInfo = await createAgent({
      modelType: MODEL_TYPE,
      name: `${adapter.name}-${task.id}`,
      userToken: token,
      workflowId: wid,
      computingUnitId: cuid,
      settings: settingsHints,
    });
    resources.agentId = agentInfo.id;
    agentName = agentInfo.name;
    const reportedMode = agentInfo.settings?.agentMode;
    agentMode = reportedMode === "code" ? AgentMode.CODE : reportedMode === "native" ? AgentMode.NATIVE : "unknown";

    prompt = adapter.buildPrompt(task, { datasetPathPrefix });
    log(`task ${task.id}: running agent turn (timeout=${TURN_TIMEOUT_MS}ms)`);
    const turnStart = Date.now();
    const turn = await runAgentTurn(agentInfo.id, prompt, {
      timeoutMs: TURN_TIMEOUT_MS,
    });
    const turnMs = Date.now() - turnStart;

    reactSteps = turn.steps;
    finalState = turn.finalState;
    finalAnswer = turn.finalAnswer;
    for (const e of turn.errors) errors.push(e);

    for (const snap of turn.snapshots) snapshots[snap.stepId] = snap.workflow;

    // Authoritative final workflow: fetch it from the agent-service so we
    // capture the exact state of the agent's HEAD, even if no `snapshot`
    // frame fired during the turn (e.g. read-only conversational replies).
    try {
      const wf = await getCurrentWorkflow(agentInfo.id);
      finalWorkflow = wf.workflow;
    } catch (err) {
      errors.push(`failed to fetch final workflow: ${err instanceof Error ? err.message : String(err)}`);
      // Fall back to the last snapshot we observed during streaming.
      if (turn.snapshots.length > 0) finalWorkflow = turn.snapshots[turn.snapshots.length - 1].workflow;
    }

    if (turn.completed) {
      log(`task ${task.id}: completed in ${turnMs}ms with ${reactSteps.length} step(s)`);
    } else {
      log(`task ${task.id}: did NOT cleanly complete (${errors.join("; ") || "no error message"})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`pipeline error: ${msg}`);
    logErr(`task ${task.id}: ${msg}`);
  } finally {
    // Cleanup per-task resources regardless of success.
    if (resources.agentId) {
      try {
        await deleteAgent(resources.agentId);
      } catch (err) {
        errors.push(`failed to delete agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (resources.workflowWid !== undefined) {
      try {
        await deleteWorkflow(token, resources.workflowWid);
      } catch (err) {
        errors.push(`failed to delete workflow: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (resources.datasetDid !== undefined) {
      try {
        await deleteDataset(token, resources.datasetDid);
      } catch (err) {
        errors.push(`failed to delete dataset: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // The free-text reply contains preamble like "Perfect! ... Final Answer: <x>".
  // Score on the parsed value so we measure the actual answer, not the prose.
  const parsedAnswer = parseFinalAnswer(finalAnswer);
  const finishedAt = new Date().toISOString();
  const score = adapter.evaluate
    ? adapter.evaluate({ ...task, goldAnswer: task.goldAnswer }, parsedAnswer)
    : defaultScore(task.goldAnswer, parsedAnswer);

  const record: TraceRecord = {
    task,
    prompt,
    agentInfo: {
      agentId: resources.agentId ?? "",
      modelType: MODEL_TYPE,
      agentMode,
    },
    finalState,
    finalAnswer,
    reactSteps,
    snapshots,
    finalWorkflow,
    timings: { startedAt, finishedAt, durationMs: Date.now() - startedMs },
    errors,
    score,
  };

  // Trace folder: one folder per task with task / steps / workflow / meta files.
  const traceDir = path.join(outputDir, adapter.name, "traces", task.id);
  await fs.mkdir(traceDir, { recursive: true });

  await fs.writeFile(path.join(traceDir, "task.json"), JSON.stringify(task, null, 2));

  await fs.writeFile(
    path.join(traceDir, "react-steps.json"),
    JSON.stringify(
      buildReActStepsExport({
        agentId: resources.agentId ?? "",
        agentName,
        modelType: MODEL_TYPE,
        steps: reactSteps,
      }),
      null,
      2
    )
  );

  await fs.writeFile(path.join(traceDir, "workflow.json"), JSON.stringify(finalWorkflow, null, 2));

  // meta.json carries everything that's not task/steps/workflow but is still
  // useful when inspecting a single trace (parsed answer, score, timings, errors).
  await fs.writeFile(
    path.join(traceDir, "meta.json"),
    JSON.stringify(
      {
        agentInfo: record.agentInfo,
        prompt,
        finalState,
        finalAnswer,
        parsedAnswer,
        score,
        timings: record.timings,
        snapshotStepIds: Object.keys(snapshots),
        errors,
      },
      null,
      2
    )
  );

  log(`task ${task.id}: wrote ${traceDir} (score=${score.score.toFixed(3)} passed=${score.passed})`);

  return record;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log(`source=${args.source} limit=${args.limit} offset=${args.offset}`);

  const adapter = getAdapter(args.source);
  const sourceRoot = args.dataRoot ?? adapter.defaultSourceDir ?? path.join(DATA_ROOT, adapter.name);

  // Sanity check before we touch backend services. Manifest-based sources
  // (FeTaQA) require their manifest file; directory-based sources (KramaBench)
  // only need the source root to exist.
  if (adapter.manifestName) {
    try {
      await fs.access(path.join(sourceRoot, adapter.manifestName));
    } catch {
      throw new Error(`No ${adapter.manifestName} under ${sourceRoot}. Run the dataset prep script first.`);
    }
  } else {
    try {
      await fs.access(sourceRoot);
    } catch {
      throw new Error(`Source root does not exist: ${sourceRoot} (pass --data-root).`);
    }
  }
  log(`source root: ${sourceRoot}`);

  const runId = String(Date.now());
  const startedAt = new Date().toISOString();

  log(`logging in as ${USERNAME}`);
  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  const ownerEmail = user.email || user.name;
  log(`logged in as uid=${user.uid} email=${ownerEmail}`);

  let cuid: number | null = null;
  const records: TraceRecord[] = [];

  try {
    log(`provisioning local CU at ${LOCAL_CU_URI}`);
    const cu = await createComputingUnit(token, `trace-gen-cu-${runId}`, {
      unitType: "local",
      uri: LOCAL_CU_URI,
    });
    cuid = cu.computingUnit.cuid;
    log(`  cuid=${cuid}`);

    // TEXERA_TASK_IDS (comma-separated) selects specific tasks by id across the
    // whole set — for domain-spread A/B subsets. Overrides limit/offset paging.
    const taskIdFilter = process.env.TEXERA_TASK_IDS
      ? new Set(process.env.TEXERA_TASK_IDS.split(",").map(s => s.trim()).filter(Boolean))
      : null;
    const effectiveLimit = taskIdFilter ? 100000 : args.limit;

    let processed = 0;
    for await (const task of adapter.load({ rootDir: sourceRoot, limit: effectiveLimit, offset: args.offset })) {
      if (taskIdFilter && !taskIdFilter.has(task.id)) continue;
      log(`---- [${processed + 1}/${taskIdFilter ? taskIdFilter.size : args.limit}] ${task.id} ----`);
      const record = await processTask({
        token,
        ownerEmail,
        cuid,
        runId,
        task,
        adapter,
        outputDir: args.outputDir,
      });
      records.push(record);
      processed += 1;
    }
  } finally {
    if (cuid != null) {
      try {
        await terminateComputingUnit(token, cuid);
      } catch (err) {
        logErr(`failed to terminate cu ${cuid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const summary = aggregateSummary({
    source: adapter.name,
    modelType: MODEL_TYPE,
    agentMode: records[0]?.agentInfo.agentMode ?? "unknown",
    startedAt,
    finishedAt,
    records,
  });

  const summaryFile = path.join(args.outputDir, adapter.name, "summary.json");
  await fs.mkdir(path.dirname(summaryFile), { recursive: true });
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));

  log("=================== summary ===================");
  log(`source         : ${summary.source}`);
  log(`model          : ${summary.modelType} (mode=${summary.agentMode})`);
  log(`total tasks    : ${summary.total}`);
  log(`completed (no err): ${summary.total - summary.errored}`);
  log(`errored        : ${summary.errored}`);
  log(`passed         : ${summary.passed} (${(summary.passRate * 100).toFixed(1)}%)`);
  log(`mean score     : ${summary.meanScore.toFixed(3)}`);
  log(`median score   : ${summary.medianScore.toFixed(3)}`);
  log(`duration       : ${(summary.durationMs / 1000).toFixed(1)}s`);
  log(`summary written: ${summaryFile}`);
  log("==============================================");
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
