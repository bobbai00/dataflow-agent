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
/** Run ONE LongDS turn from gold state (the gold-prefix protocol), dataflow arm.
 * Arguments: turn-dir prepared-dir output-dir baseline|history|ledger
 *   baseline  current agent; history adds sealed-version inspection and rollback;
 *   ledger    history plus task ledgers, provenance cards and execution notes.
 *   turn-dir   a `gold_prefix.py` turn folder (seed.changes, message.dataflow.txt, question.txt)
 * The reference tables are loaded as executed operators through the service's
 * hidden seed-state step; the single request carries the completed tasks and
 * the current question. Gold is read offline after the turn. */
import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAgent, deleteAgent, getReActSteps, getSnapshot, runAgentTurn } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import { ActionMonitor, compareRequests } from "../e2e/state-history-diagnostics";
import { requiredToolChoiceRecovery } from "../../src/agent/llm-drivers/required-tool-choice";

const [turnArg, preparedArg, outputArg, arm] = Bun.argv.slice(2);
assert.ok(
  turnArg && preparedArg && outputArg && ["baseline", "history", "ledger"].includes(arm),
  "Use turn-dir prepared-dir output-dir baseline|history|ledger"
);
const turnDir = resolve(turnArg),
  prepared = resolve(preparedArg),
  output = resolve(outputArg);
const turnId = Number(basename(turnDir).replace(/^t0*/, ""));
assert.ok(Number.isInteger(turnId) && turnId >= 2, `Turn folder must be tNN with N >= 2: ${turnDir}`);
const manifest = JSON.parse(readFileSync(join(prepared, "manifest.json"), "utf8"));
const gold = JSON.parse(readFileSync(join(prepared, "gold.json"), "utf8")).turns.find(
  (g: any) => g.turn_id === turnId
);
assert.ok(gold, `No gold turn ${turnId}`);
const seedChanges = readFileSync(join(turnDir, "seed.changes"), "utf8");
const userPrompt = readFileSync(join(turnDir, "message.dataflow.txt"), "utf8");
assert.ok(seedChanges.trim() && userPrompt.trim(), "Turn folder is incomplete");
// Every file the request lists, and every file the seed loads, must exist:
// an agent given a path it cannot open searches the disk for it.
const listedFiles = [
  ...((manifest.files ?? []) as string[]),
  ...[...seedChanges.matchAll(/scan\("([^"]+)"/g)].map(match => match[1]),
];
const missingFiles = listedFiles.filter(file => !existsSync(resolve(join(import.meta.dir, "../../.."), file)));
assert.ok(!missingFiles.length, `Listed data files do not exist: ${missingFiles.join(", ")}`);
const model = process.env.TEXERA_AGENT_MODEL ?? "gpt-5.6-luna";
const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3037";
const wireRoot = process.env.TEXERA_LLM_TRACE_DIR;
assert.ok(wireRoot, "Actual wire capture must be enabled");
const settingsPath = process.env.LONGDS_AGENT_SETTINGS_FILE;
const settingsOverride = settingsPath ? JSON.parse(readFileSync(resolve(settingsPath), "utf8")) : {};
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const save = (path: string, data: unknown) => writeFileSync(join(output, path), JSON.stringify(data, null, 2) + "\n");
const event = (data: unknown) =>
  appendFileSync(join(output, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...(data as any) }) + "\n");
const alerts: any[] = [];
const alert = (kind: string, details: any) => {
  const record = { kind, ...details };
  alerts.push(record);
  event({ event: "alert", ...record });
  save("anomalies.json", alerts);
  console.log(`ALERT ${arm} ${manifest.key} t${turnId}: ${kind}`);
};
const json = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json() as Promise<any>;
};
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const unit = await createComputingUnit(token, `gold-prefix-${arm}-${Date.now()}`, {
  unitType: "local",
  uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const wid = await createWorkflow(
  token,
  `gold-prefix-${arm}-${manifest.key}-t${turnId}-${Date.now()}`,
  new WorkflowState().getWorkflowContent()
);
const settings = {
  agentMode: "native" as const,
  contextMode: "delta" as const,
  messageLayout: "native" as const,
  stateHistory: arm !== "baseline",
  stateLedger: arm === "ledger",
  userTaskPlacement: "bottom" as const,
  contextWindowTokens: 0,
  turnHistory: "full" as const,
  sessionTurns: false,
  versionedMode: false,
  maxSteps: 40,
  executionTimeoutMs: 240_000,
  maxOperatorResultCharLimit: 2000,
  maxResultRows: 50,
  nativeProfileCollection: true,
  dataEvidence: false,
  flowEvidence: false,
  thoughtReplay: false,
  thoughtReplayK: 10,
  retrievalViews: ["sample_stats", "full"],
  fullResultCharLimit: 5000,
  dataEvidenceCharLimit: 2000,
  ...settingsOverride,
};
assert.equal(settings.agentMode, "native");
assert.equal(settings.stateHistory, arm !== "baseline", "Settings cannot change the declared history condition");
assert.equal(settings.stateLedger, arm === "ledger", "Settings cannot change the declared ledger condition");
const agent = await createAgent({ baseUrl, userToken: token, modelType: model, workflowId: wid, computingUnitId: cuid, settings });
const agentUrl = `${baseUrl}/api/agents/${agent.id}`;
const wireDir = join(wireRoot!, agent.id);
const actualSettings = await json(`${agentUrl}/settings`);
assert.equal(actualSettings.stateHistory, arm !== "baseline");
// A service built before the setting existed does not report it; that is "off".
assert.equal(actualSettings.stateLedger ?? false, arm === "ledger");
const system = await json(`${agentUrl}/system-info`);
save("system-info.json", system);
save("settings.json", actualSettings);
writeFileSync(join(output, "prompt.txt"), userPrompt);
writeFileSync(join(output, "seed.changes"), seedChanges);
save("protocol.json", {
  protocol: "gold-prefix",
  arm,
  model,
  task: manifest.key,
  turn_id: turnId,
  state_type: gold.state_type,
  depends_tasks: gold.depends_tasks,
  agent_id: agent.id,
  wid,
  cuid,
  baseUrl,
  wire_directory: wireDir,
  turn_dir: turnDir,
  dataset_revision: manifest.dataset_revision,
  model_call_limit: settings.maxSteps,
  max_output_tokens: 8192,
  prompt_sha256: createHash("sha256").update(system.systemPrompt).digest("hex"),
  message_sha256: createHash("sha256").update(userPrompt).digest("hex"),
  seed_sha256: createHash("sha256").update(seedChanges).digest("hex"),
  settings,
});

// Seed: the reference tables become executed operators, outside the model's view.
// Seeding a late turn of a large session executes dozens of scans and can
// outlive the HTTP client; the service keeps executing, so a dropped request
// falls back to polling the trace for the hidden seed step's receipt.
async function seedReceiptFromTrace(): Promise<any> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const steps = (await getReActSteps(agent.id, baseUrl)).steps as any[];
    const seed = steps.find(step => step.synthetic === "state");
    const output = seed?.toolResults?.[0]?.output;
    if (output?.kind === "dataflow-actions" && output.status !== "pending") {
      const info = await json(agentUrl);
      if (info.state === "AVAILABLE")
        return {
          http: "polled",
          status: output.status,
          error: output.error ?? null,
          operators: output.operators,
          actions: output.actions.map((item: any) => ({ type: item.action.type, status: item.status, output: item.output })),
        };
    }
    await Bun.sleep(5000);
  }
  throw new Error("seed-state did not complete within 30 minutes");
}
const seedStarted = Date.now();
let seedReceipt: any;
let seedHttp: number | string = 0;
try {
  const seedResponse = await fetch(`${agentUrl}/seed-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes: seedChanges, completedTasks: turnId - 1 }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  seedHttp = seedResponse.status;
  seedReceipt = await seedResponse.json();
  if (!seedResponse.ok) throw new Error(`HTTP ${seedResponse.status}: ${JSON.stringify(seedReceipt).slice(0, 500)}`);
} catch (error: any) {
  if (/HTTP 4\d\d/.test(String(error?.message))) throw error;
  event({ event: "seed_request_dropped", error: String(error?.message ?? error) });
  seedReceipt = await seedReceiptFromTrace();
  seedHttp = seedReceipt.http;
}
save("seed-receipt.json", { http: seedHttp, seconds: (Date.now() - seedStarted) / 1000, ...seedReceipt });
if (seedReceipt.status !== "completed") {
  await deleteAgent(agent.id, baseUrl).catch(() => {});
  await terminateComputingUnit(token, cuid).catch(() => {});
  throw new Error(`seed-state failed: HTTP ${seedHttp} ${JSON.stringify(seedReceipt).slice(0, 2000)}`);
}
const seededOperators = (seedReceipt.operators ?? []).map((op: any) => op.id);
const seedWorkflow = await json(`${agentUrl}/workflow`);
save("seed-workflow.json", seedWorkflow);
const stepsBefore = (await getReActSteps(agent.id, baseUrl)).steps;
assert.ok(stepsBefore.some((s: any) => s.synthetic === "state"), "seed step missing from the trace");

const seenWire = new Set<string>();
function auditWire() {
  if (!existsSync(wireDir)) return;
  const metas = readdirSync(wireDir)
    .filter(f => f.endsWith("-meta.json"))
    .sort();
  const rows: any[] = [];
  let previous: { body: any; meta: any } | undefined;
  for (const file of metas) {
    const prefix = file.replace("-meta.json", "");
    const meta = JSON.parse(readFileSync(join(wireDir, file), "utf8"));
    const body = JSON.parse(readFileSync(join(wireDir, `${prefix}-request.json`), "utf8"));
    const responsePath = join(wireDir, `${prefix}-response.json`);
    let response: any;
    if (existsSync(responsePath)) {
      try {
        response = JSON.parse(readFileSync(responsePath, "utf8"));
      } catch {}
    }
    const usage = response?.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? null;
    const recoveredChoice = requiredToolChoiceRecovery(body, response);
    const check = previous ? compareRequests(previous.body, body) : null;
    const row = {
      call: prefix,
      meta,
      model: body.model,
      max_output_tokens: body.max_completion_tokens ?? body.max_tokens,
      prompt_tokens: usage?.prompt_tokens ?? null,
      cached_tokens: cached,
      output_tokens: usage?.completion_tokens ?? null,
      cache_write_tokens:
        usage?.prompt_tokens_details?.cache_write_tokens ??
        usage?.prompt_tokens_details?.cache_creation_tokens ??
        usage?.cache_creation_input_tokens ??
        null,
      finish_reason: response?.choices?.[recoveredChoice ?? 0]?.finish_reason ?? null,
      response_choice_count: response?.choices?.length ?? null,
      recovered_tool_choice: recoveredChoice ?? null,
      prefix: check,
    };
    rows.push(row);
    if (!seenWire.has(file) && meta.finished_at) {
      seenWire.add(file);
      if (body.model !== model) alert("model_mismatch", { call: prefix, model: body.model });
      if (row.max_output_tokens !== 8192) alert("output_limit_mismatch", { call: prefix, observed: row.max_output_tokens });
      if (row.finish_reason === "length") alert("output_limit_reached", { call: prefix });
      if (row.response_choice_count > 1)
        alert("multiple_response_choices", { call: prefix, count: row.response_choice_count, recovered_tool_choice: recoveredChoice ?? null });
      if (meta.error || response?.error) alert("provider_error", { call: prefix, error: meta.error ?? response.error });
      if (check && (check.changed_fields.length || check.first_changed_message !== null))
        alert("within_turn_prefix_change", { call: prefix, check });
      const seeded = JSON.stringify(body.messages ?? body.input ?? "");
      if (seeded.includes("seed-state") || seeded.includes("Load the tables in force"))
        alert("seed_step_visible_to_model", { call: prefix });
    }
    previous = { body, meta };
  }
  save("wire-usage.json", rows);
}

const priorIds = new Set(stepsBefore.map((step: any) => step.id));
const start = Date.now();
let lastProgress = Date.now();
const heartbeat = setInterval(() => {
  event({ event: "heartbeat", seconds_since_progress: (Date.now() - lastProgress) / 1000 });
}, 15000);
try {
  const current = new Map<string, any>(),
    done = new Set<string>();
  const monitor = new ActionMonitor();
  let pending = Promise.resolve();
  const result = await runAgentTurn(agent.id, userPrompt, {
    baseUrl,
    timeoutMs: 1200000,
    onStep: step => {
      if (priorIds.has(step.id)) return;
      current.set(step.id, step);
      lastProgress = Date.now();
      save("react_steps.json", [...current.values()]);
      const outcomes = (step.toolResults ?? []).flatMap((r: any) => (r.output?.kind === "dataflow-actions" ? [r.output] : []));
      if (step.role !== "agent" || done.has(step.id) || outcomes.some((r: any) => r.status === "pending")) return;
      done.add(step.id);
      event({ event: "step_complete", step_id: step.id, calls: step.toolCalls?.length ?? 0 });
      console.log(`${arm} ${manifest.key} t${turnId} step ${step.stepId}`);
      pending = pending.then(async () => {
        const snapshot = await getSnapshot(agent.id, step.id, baseUrl);
        // Per-step snapshots carry the whole workflow and its results (~10 MB
        // each); keep them compressed.
        writeFileSync(join(output, `snapshot-${step.stepId}.json.gz`), Bun.gzipSync(JSON.stringify(snapshot)));
        const state = JSON.stringify({
          operators: snapshot.workflow?.operators.map(op => [op.operatorID, op.nativeOp?.revision]),
          results: Object.entries(snapshot.results).map(([id, r]: [string, any]) => [id, r.resultVersion?.id ?? r.materialization ?? null]),
        });
        for (const outcome of outcomes)
          for (const receipt of outcome.actions)
            if (!["pending", "skipped"].includes(receipt.status))
              for (const kind of monitor.observe(receipt, state)) alert(kind, { step_id: step.id, action_index: receipt.index });
        auditWire();
      });
    },
  });
  await pending;
  if (result.completionSource === "rest") alert("completion_recovered_from_rest", {});
  auditWire();
  const steps = [...current.values()];
  const answered = steps
    .flatMap(step =>
      (step.toolResults ?? []).flatMap((r: any) =>
        r.output?.kind === "dataflow-actions" && typeof r.output.answer === "string" ? [r.output.answer] : []
      )
    )
    .at(-1);
  const answer =
    answered?.match(/(?:\*\*\s*)?final answer:\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*$/is)?.[1]?.trim() ?? answered ?? "";
  const errors = [...result.errors, ...steps.filter(s => s.role === "agent" && /^Error:/.test(s.content ?? "")).map(s => s.content)];
  if (!answered) alert("turn_without_answer", { errors, model_steps: done.size });
  if (!result.completed) {
    await fetch(`${agentUrl}/stop`, { method: "POST" });
    alert("incomplete_turn", { errors });
  }
  const usage = steps.filter(s => s.role === "agent").map(s => s.usage ?? {});
  const stats = {
    llm_calls: done.size,
    input_tokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0),
    cached_tokens: usage.reduce((n, u) => n + (u.cachedInputTokens ?? 0), 0),
    cache_write_tokens: usage.reduce((n, u) => n + (u.cacheCreationInputTokens ?? 0), 0),
    output_tokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
    reasoning_tokens: usage.reduce((n, u) => n + (u.reasoningTokens ?? 0), 0),
    elapsed_seconds: (Date.now() - start) / 1000,
    seed_seconds: seedReceipt ? (JSON.parse(readFileSync(join(output, "seed-receipt.json"), "utf8")).seconds as number) : null,
  };
  // Which seeded tables the turn actually used: inputs of new operators and reads.
  const finalWorkflow = await json(`${agentUrl}/workflow`);
  const finalOperators: any[] = finalWorkflow.workflow?.operators ?? finalWorkflow.operators ?? [];
  const newOps = finalOperators.filter((op: any) => !seededOperators.includes(op.operatorID));
  const reusedInputs = new Set<string>();
  for (const op of newOps) for (const input of op.nativeOp?.inputs ?? []) if (seededOperators.includes(input)) reusedInputs.add(input);
  const retrieved = new Set<string>();
  for (const step of steps)
    for (const tc of step.toolCalls ?? [])
      for (const action of tc.input?.actions ?? [])
        if (action.type === "retrieve" && seededOperators.includes(action.operator_id)) retrieved.add(action.operator_id);
  const rawReads = newOps.filter((op: any) => op.nativeOp?.type === "Scan" || /read_csv|read_parquet|read_excel/.test(JSON.stringify(op.nativeOp?.functions ?? {}))).map((op: any) => op.operatorID);
  save("answer.json", { answer, response: answered ?? result.finalAnswer, errors, completed: result.completed, completion_source: result.completionSource });
  save("stats.json", stats);
  save("workflow.json", finalWorkflow);
  save("state-use.json", {
    seeded_operators: seededOperators,
    new_operators: newOps.map((op: any) => op.operatorID),
    seeded_inputs_used: [...reusedInputs],
    seeded_tables_retrieved: [...retrieved],
    new_source_reads: rawReads,
  });
  save("results_with_ground_truth.json", [
    {
      turn_id: turnId,
      context: gold.context,
      question: gold.question,
      solution: answer,
      ground_truth: gold.answer,
      state_type: gold.state_type,
      depends_tasks: gold.depends_tasks,
      depends_span: gold.depends_span,
      success: !!answer && !errors.length,
      error: errors.join("; "),
      steps: done.size,
      stats,
      protocol: "gold-prefix",
      arm,
      model,
    },
  ]);
  console.log(`DONE ${arm} ${manifest.key} t${turnId} answer=${!!answer} calls=${done.size} seconds=${stats.elapsed_seconds.toFixed(1)}`);
} finally {
  clearInterval(heartbeat);
  auditWire();
  save("react_steps_all.json", (await getReActSteps(agent.id, baseUrl)).steps);
  await deleteAgent(agent.id, baseUrl);
  await terminateComputingUnit(token, cuid);
}
