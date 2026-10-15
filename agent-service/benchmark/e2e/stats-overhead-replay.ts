/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** Study build (study/stats-overhead): replay recorded traces with data statistics and runtime stats on or off.
 *
 * Each job replays one recorded attempt's `dataflow(python, statements)` calls, in order, as debug input to a
 * fresh agent and workflow, so no model is called. The arm sets what the engine computes:
 *   none     profile off, runtime checks off (including the hooks stable always runs)
 *   data     full table profile, runtime checks off
 *   runtime  runtime checks on (uncapped), profile off
 *   both     full table profile and runtime checks
 * Every operator carries the job's study tag, so the runtime writes per-check timing and memory to the
 * workflow's sandbox workspace (NATIVE_WORKSPACE/<wid>/stats-study.jsonl), which is copied into the job's output.
 *
 * Usage (with the stack's environment): bun benchmark/e2e/stats-overhead-replay.ts <plan.json> <out-dir> [lanes]
 * A plan is [{id, path, arm, dataRoot?, heavy?, memGB?}]; finished jobs (out/<id>/done.json) are skipped, so a
 * stopped run resumes. A PAUSE file in <out-dir> holds new jobs until it is removed. Memory gate: no new job below
 * 3 GB available or 1.5 GB free swap; a job starts only with memGB + 2 GB available. Heavy jobs run alone, and only
 * with memGB + 4 GB available and no swap-out in the last 30 s. Each job records the host's swap traffic and lowest
 * available memory during its run (done.json "host"), so a job slowed by swapping can be found and rerun.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import { nativeDebugInput } from "./native-debug-input";

type Arm = "none" | "data" | "runtime" | "both";
interface Job {
  id: string;
  path: string;
  arm: Arm;
  dataRoot?: string;
  heavy?: boolean;
  /** Estimated worker memory in GB; the job starts only with that much available plus a margin. */
  memGB?: number;
}

const [planPath, outDir, lanesArg] = process.argv.slice(2);
if (!planPath || !outDir) throw new Error("Usage: stats-overhead-replay.ts <plan.json> <out-dir> [lanes]");
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Job[];
const lanes = Number(lanesArg ?? 1);
const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT!;
const workspaces = process.env.NATIVE_WORKSPACE!;
const CALL_TIMEOUT_MS = 60 * 60 * 1000;
/** The engine stores each execution's results under the engine checkout; deleting a workflow keeps them. */
const RESULTS =
  process.env.STATS_RESULTS_DIR ??
  "/home/bob/Desktop/dataflow-agent/.claude/worktrees/registered-python-design/amber/user-resources/workflow-results";

/** Remove this job's stored results: entries named for its workflow and one of its executions, written after the
 * job started. Other stacks share the directory, so nothing else is touched. */
function removeResults(wid: number, executions: Set<string>, since: number): number {
  let removed = 0;
  for (const kind of ["operator-port-result", "operator-port-state", "operator-console-messages", "workflow-runtime-statistics"]) {
    const dir = join(RESULTS, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const match = /^wid_(\d+)_eid_(\d+)_/.exec(name);
      if (!match || Number(match[1]) !== wid || !executions.has(match[2])) continue;
      const path = join(dir, name);
      if (statSync(path).mtimeMs < since - 60_000) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
const ARMS: Record<Arm, { profile: boolean; checks: boolean }> = {
  none: { profile: false, checks: false },
  data: { profile: true, checks: false },
  runtime: { profile: false, checks: true },
  both: { profile: true, checks: true },
};
mkdirSync(outDir, { recursive: true });
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Host samples every 5 s: cumulative swap pages in and out, and available GB. Other sessions' idle processes
 * page back in all the time (about 1,400 pages/s here) while memory is free; swap-out is what memory pressure
 * looks like, so the heavy-job gate reads swap-out. */
const samples: Array<{ t: number; swapIn: number; swapOut: number; available: number }> = [];
function vmstatSwap() {
  const text = readFileSync("/proc/vmstat", "utf8");
  const get = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(text)?.[1] ?? 0);
  return { swapIn: get("pswpin"), swapOut: get("pswpout") };
}
setInterval(() => {
  samples.push({ t: Date.now(), ...vmstatSwap(), available: memory().available });
  while (samples.length > 2000) samples.shift();
}, 5_000);
/** Swap pages written out in the last `ms`. */
function recentSwapOut(ms: number): number {
  const now = samples.at(-1);
  const then = samples.find(s => s.t >= Date.now() - ms);
  return now && then && now !== then ? now.swapOut - then.swapOut : Infinity;
}
function memory() {
  const info = Object.fromEntries(
    readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [key, value] = line.split(":");
        return [key, parseInt(value) / 1024 / 1024];
      })
  );
  // Engine results are stored under the engine checkout on /home; hold new jobs below 15 GB free.
  const df = Bun.spawnSync(["df", "-B1", "--output=avail", "/home"]).stdout.toString().trim().split("\n").at(-1);
  return { available: info.MemAvailable as number, swapFree: info.SwapFree as number, diskFree: Number(df) / 2 ** 30 };
}

/** The recorded calls of one attempt, in order. */
function recordedCalls(path: string): Array<{ python?: string; statements?: string }> {
  const steps = JSON.parse(readFileSync(join(path, "react_steps.json"), "utf8")).steps as any[];
  return steps.flatMap(step => (step.toolCalls ?? []).filter((c: any) => c?.toolName === "dataflow").map((c: any) => c.input));
}

/** The original attempt's display settings, with the arm's engine switches and generous replay limits. */
function settingsFor(job: Job, tag: string) {
  const original = JSON.parse(readFileSync(join(job.path, "settings.json"), "utf8"));
  const arm = ARMS[job.arm];
  return {
    agentMode: "native",
    contextMode: "delta",
    retrievalViews: original.retrievalViews ?? ["full"],
    maxOperatorResultCharLimit: original.maxOperatorResultCharLimit ?? 2000,
    maxResultRows: original.maxResultRows ?? 3,
    fullResultCharLimit: original.fullResultCharLimit ?? 5000,
    dataEvidenceCharLimit: 2000,
    flowEvidenceCharLimit: 2000,
    thoughtReplay: false,
    enableCodeInSnapshot: false,
    maxSteps: 1000,
    toolTimeoutSeconds: 3600,
    executionTimeoutMinutes: 60,
    nativeProfileCollection: arm.profile,
    nativeProfileScope: "full",
    dataEvidence: arm.profile,
    flowEvidence: arm.checks,
    nativeRuntimeChecks: arm.checks,
    nativeStudyTag: tag,
  };
}

/** Send one debug input; resolve when the agent has built its next context. */
function debug(agentId: string, content: string) {
  return new Promise<{ completeMs: number; contextMs: number; error?: string }>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = 0,
      completed = 0,
      settled = false,
      error: string | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("call timed out"))), CALL_TIMEOUT_MS);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = performance.now();
        ws.send(JSON.stringify({ type: "debug", content }));
      } else if (frame.type === "complete" || frame.type === "error") {
        completed = performance.now();
        if (frame.type === "error") error = String(frame.error ?? "error");
        // Some failed calls end without a next context; the call itself is over.
        setTimeout(() => finish(() => resolve({ completeMs: completed - sent, contextMs: -1, error })), 120_000);
      } else if (frame.type === "nextContext" && completed) {
        const done = performance.now();
        finish(() => resolve({ completeMs: completed - sent, contextMs: done - completed, error }));
      }
    };
    ws.onerror = () => finish(() => reject(new Error("WebSocket failed")));
    ws.onclose = () => finish(() => reject(new Error("WebSocket closed before the next context")));
  });
}

async function replay(job: Job, token: string, cuid: number) {
  const dir = join(outDir, job.id);
  mkdirSync(dir, { recursive: true });
  const tag = `${job.id}-${Date.now()}`;
  const calls = recordedCalls(job.path);
  const started = Date.now();
  const wid = await createWorkflow(token, `stats-overhead ${job.id}`, new WorkflowState().getWorkflowContent());
  const workspace = join(workspaces, String(wid));
  mkdirSync(workspace, { recursive: true });
  if (job.dataRoot) writeFileSync(join(workspace, ".data-root"), job.dataRoot);
  const settings = settingsFor(job, tag);
  writeFileSync(join(dir, "job.json"), JSON.stringify({ ...job, tag, wid, cuid, settings, calls: calls.length, started }, null, 1));
  const agent = await createAgent({ baseUrl, userToken: token, modelType: "gpt-5.6-luna", workflowId: wid, computingUnitId: cuid, settings });
  const timings: any[] = [];
  const executions = new Set<string>();
  try {
    for (const [index, input] of calls.entries()) {
      const at = Date.now();
      try {
        const result = await debug(agent.id, nativeDebugInput("dataflow", input));
        timings.push({ index, at, ...result });
      } catch (error) {
        timings.push({ index, at, failed: String(error) });
        break;
      }
    }
    const trace = await getReActSteps(agent.id, baseUrl);
    writeFileSync(join(dir, "react_steps.json"), JSON.stringify(trace.steps));
    for (const step of trace.steps as any[])
      for (const result of step.toolResults ?? [])
        for (const action of result?.output?.actions ?? [])
          for (const run of action?.output?.execution_runs ?? []) if (run?.executionId) executions.add(String(run.executionId));
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(await getSnapshot(agent.id, "head", baseUrl)));
  } finally {
    writeFileSync(join(dir, "calls.json"), JSON.stringify(timings, null, 1));
    const study = join(workspace, "stats-study.jsonl");
    if (existsSync(study)) copyFileSync(study, join(dir, "stats-study.jsonl"));
    try {
      await deleteAgent(agent.id, baseUrl);
      await deleteWorkflow(token, wid);
      rmSync(workspace, { recursive: true, force: true });
      writeFileSync(join(dir, "cleanup.json"), JSON.stringify({ executions: [...executions], removed: removeResults(wid, executions, started) }));
    } catch (error) {
      log(`${job.id}: cleanup failed: ${error}`);
    }
  }
  const failed = timings.filter(t => t.failed).length;
  const during = samples.filter(s => s.t >= started);
  const host = {
    swapInPages: during.length > 1 ? during.at(-1)!.swapIn - during[0].swapIn : null,
    swapOutPages: during.length > 1 ? during.at(-1)!.swapOut - during[0].swapOut : null,
    minAvailableGB: during.length ? Math.min(...during.map(s => s.available)) : null,
    samples: during.length,
  };
  writeFileSync(join(dir, "done.json"), JSON.stringify({ seconds: (Date.now() - started) / 1000, calls: calls.length, replayed: timings.length, failed, host }));
  log(`${job.id}: ${timings.length}/${calls.length} calls in ${((Date.now() - started) / 1000).toFixed(0)} s${failed ? ` (${failed} failed)` : ""}`);
}

const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const unit = await createComputingUnit(token, `stats-overhead-${Date.now()}`, {
  unitType: "local",
  uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const pending = plan.filter(job => !existsSync(join(outDir, job.id, "done.json")));
log(`${pending.length} of ${plan.length} jobs to run on ${lanes} lane(s); computing unit ${cuid}`);
let active = 0,
  heavyActive = false;
async function lane(number: number) {
  for (;;) {
    while (existsSync(join(outDir, "PAUSE"))) await sleep(10_000);
    const mem = memory();
    const fits = (job: Job) =>
      job.heavy
        ? mem.available >= (job.memGB ?? 0.5) + 4 && mem.swapFree >= 1.5 && recentSwapOut(30_000) < 1000
        : mem.available >= (job.memGB ?? 0.5) + 2 && mem.swapFree >= 1.5;
    const index = mem.available < 3 || mem.diskFree < 15
      ? -1
      : pending.findIndex(job => !(job.heavy && active > 0) && !heavyActive && fits(job));
    if (index < 0) {
      if (!pending.length) return;
      await sleep(index < 0 && pending.length && !heavyActive ? 15_000 : 2_000);
      continue;
    }
    const [job] = pending.splice(index, 1);
    active++;
    heavyActive = heavyActive || !!job.heavy;
    try {
      await replay(job, token, cuid);
    } catch (error) {
      log(`${job.id}: FAILED ${error}`);
      writeFileSync(join(outDir, `${job.id}.error`), String(error));
    } finally {
      active--;
      if (job.heavy) heavyActive = false;
    }
  }
}
await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
log("all jobs finished");
