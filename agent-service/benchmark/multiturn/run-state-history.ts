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
/** Run one frozen LongDS session. Arguments: prepared-dir output-dir baseline|history [turn-limit].
 * Only manifest.json enters solver prompts. Gold is read offline after each turn.
 * The output directory must be new; partial sessions are never silently rerun. */
import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAgent, deleteAgent, getReActSteps, getSnapshot, runAgentTurn } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import { ActionMonitor, compareRequests } from "../e2e/state-history-diagnostics";
import { requiredToolChoiceRecovery } from "../../src/agent/llm-drivers/required-tool-choice";

const [preparedArg, outputArg, arm, limitArg] = Bun.argv.slice(2);
assert.ok(
  preparedArg && outputArg && ["baseline", "history"].includes(arm),
  "Use prepared-dir output-dir baseline|history [turn-limit]"
);
const prepared = resolve(preparedArg),
  output = resolve(outputArg);
const manifest = JSON.parse(readFileSync(join(prepared, "manifest.json"), "utf8"));
const model = process.env.TEXERA_AGENT_MODEL ?? "gpt-5.6-luna";
assert.ok(["gpt-5.6-luna", "gpt-5.6-terra"].includes(model), "Use Luna or Terra");
const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3015";
const wireRoot = process.env.TEXERA_LLM_TRACE_DIR;
assert.ok(wireRoot, "Actual wire capture must be enabled");
// Matched first-task experiments can supply the same user message to both
// interfaces while retaining their own system prompts and action protocols.
const firstPromptPath = process.env.LONGDS_FIRST_PROMPT_FILE;
const firstPrompt = firstPromptPath ? readFileSync(resolve(firstPromptPath), "utf8") : undefined;
assert.ok(firstPrompt === undefined || firstPrompt.trim(), "The first-task prompt override must not be empty");
const promptsPath = process.env.LONGDS_PROMPTS_FILE;
const matchedPrompts: { turn_id: number; prompt: string }[] | undefined = promptsPath
  ? JSON.parse(readFileSync(resolve(promptsPath), "utf8"))
  : undefined;
const settingsPath = process.env.LONGDS_AGENT_SETTINGS_FILE;
const settingsOverride = settingsPath ? JSON.parse(readFileSync(resolve(settingsPath), "utf8")) : {};
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const save = (path: string, data: unknown) => writeFileSync(join(output, path), JSON.stringify(data, null, 2) + "\n");
const event = (data: unknown) =>
  appendFileSync(
    join(output, "events.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...(data as any) }) + "\n"
  );
const alerts: any[] = [];
const alert = (kind: string, details: any) => {
  const record = { kind, ...details };
  alerts.push(record);
  event({ event: "alert", ...record });
  save("anomalies.json", alerts);
  console.log(`ALERT ${arm} ${manifest.key}: ${kind}`);
};
const json = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json() as Promise<any>;
};
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const unit = await createComputingUnit(token, `state-history-${arm}-${Date.now()}`, {
  unitType: "local",
  uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
});
const cuid = unit.computingUnit.cuid;
const wid = await createWorkflow(
  token,
  `state-history-${arm}-${manifest.key}-${Date.now()}`,
  new WorkflowState().getWorkflowContent()
);
const settings = {
  agentMode: "native" as const,
  contextMode: "delta" as const,
  messageLayout: "native" as const,
  stateHistory: arm === "history",
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
  ...settingsOverride,
};
assert.equal(settings.agentMode, "native");
assert.equal(settings.stateHistory, arm === "history", "Settings cannot change the declared history condition");
const agent = await createAgent({
  baseUrl,
  userToken: token,
  modelType: model,
  workflowId: wid,
  computingUnitId: cuid,
  settings,
  ...(promptsPath
    ? {
        matched_prompts_file: resolve(promptsPath),
        matched_prompts_sha256: createHash("sha256")
          .update(readFileSync(resolve(promptsPath)))
          .digest("hex"),
      }
    : {}),
});
const agentUrl = `${baseUrl}/api/agents/${agent.id}`;
const wireDir = join(wireRoot!, agent.id);
const turns = manifest.turns.slice(0, limitArg ? Number(limitArg) : undefined);
const actualSettings = await json(`${agentUrl}/settings`);
assert.equal(actualSettings.stateHistory, arm === "history");
const system = await json(`${agentUrl}/system-info`);
save("system-info.json", system);
save("settings.json", actualSettings);
save("protocol.json", {
  arm,
  model,
  reasoning_effort: "medium (gateway configuration; verify mapping)",
  task: manifest.key,
  agent_id: agent.id,
  wid,
  cuid,
  baseUrl,
  wire_directory: wireDir,
  turns: turns.length,
  dataset_revision: manifest.dataset_revision,
  prepared,
  model_call_limit: 40,
  max_output_tokens: 8192,
  model_request_timeout_ms: 180000,
  sdk_retries: 0,
  turn_retries: 0,
  turn_timeout_ms: 1200000,
  manifest_sha256: createHash("sha256")
    .update(readFileSync(join(prepared, "manifest.json")))
    .digest("hex"),
  prompt_sha256: createHash("sha256").update(system.systemPrompt).digest("hex"),
  ...(firstPrompt !== undefined
    ? {
        first_prompt_override: resolve(firstPromptPath!),
        first_prompt_sha256: createHash("sha256").update(firstPrompt).digest("hex"),
      }
    : {}),
  settings,
});
const answerContract =
  "Report the answer as a single-line JSON object holding exactly the quantities this question asks for, and nothing else. For numerical answers, provide the exact value requested (rounded as specified if mentioned). Do not restate the whole chain of reasoning as the answer.\nYour last line MUST BE: **Final Answer: <single-line JSON>**";
function prompt(turn: any, first: boolean) {
  if (matchedPrompts) {
    const matches = matchedPrompts.filter(p => p.turn_id === turn.turn_id);
    assert.equal(matches.length, 1, `Expected one matched prompt for task ${turn.turn_id}`);
    assert.ok(matches[0].prompt.trim());
    return matches[0].prompt;
  }
  if (first && firstPrompt !== undefined) return firstPrompt;
  const question = `[Task ${turn.turn_id}]\n${turn.context}\nQuestion: ${turn.question}`;
  if (!first) return question;
  const persistence =
    "Operators remain available across requests in one dataflow. Name them meaningfully. After editing definitions or edges, explicitly execute before retrieving current results.";
  return `You are an expert data scientist working through a long analysis with me. I will send you a series of requests, one at a time, about the same data.\n\nData files available (use these paths verbatim; never modify input files):\n${manifest.files.map((f: string) => ` - ${f}`).join("\n")}\n\n${persistence}\nDo not use plotting libraries. Use text summaries and statistics. Use code for every calculation. Answer when you have evidence.\n\n${answerContract}\n\n${question}`;
}
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
    const boundary = previous ? previous.meta.messageId !== meta.messageId : true;
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
      task_boundary: boundary,
    };
    rows.push(row);
    if (!seenWire.has(file) && meta.finished_at) {
      seenWire.add(file);
      if (body.model !== model) alert("model_mismatch", { call: prefix, model: body.model });
      if (row.max_output_tokens !== 8192)
        alert("output_limit_mismatch", { call: prefix, observed: row.max_output_tokens });
      if (row.finish_reason === "length") alert("output_limit_reached", { call: prefix });
      if (row.response_choice_count > 1)
        alert("multiple_response_choices", {
          call: prefix,
          count: row.response_choice_count,
          recovered_tool_choice: recoveredChoice ?? null,
        });
      if (meta.error || response?.error) alert("provider_error", { call: prefix, error: meta.error ?? response.error });
      if (check && !boundary && (check.changed_fields.length || check.first_changed_message !== null))
        alert("within_task_prefix_change", { call: prefix, check });
      if (cached === 0 && row.prompt_tokens >= 10000 && previous)
        alert("zero_prompt_cache_candidate", { call: prefix, task_boundary: boundary, check });
    }
    previous = { body, meta };
  }
  save("wire-usage.json", rows);
}
const records: any[] = [];
const allPriorIds = new Set((await getReActSteps(agent.id, baseUrl)).steps.map(step => step.id));
const start = Date.now();
let activeTurn: number | null = null,
  lastProgress = Date.now();
const heartbeat = setInterval(() => {
  event({ event: "heartbeat", turn_id: activeTurn, seconds_since_progress: (Date.now() - lastProgress) / 1000 });
}, 15000);
try {
  for (const [index, turn] of turns.entries()) {
    activeTurn = turn.turn_id;
    const dir = `t${String(turn.turn_id).padStart(2, "0")}`;
    mkdirSync(join(output, dir));
    const userPrompt = prompt(turn, index === 0);
    writeFileSync(join(output, dir, "prompt.txt"), userPrompt);
    const current = new Map<string, any>(),
      done = new Set<string>();
    const monitor = new ActionMonitor();
    let pending = Promise.resolve();
    const started = Date.now();
    const result = await runAgentTurn(agent.id, userPrompt, {
      baseUrl,
      timeoutMs: 1200000,
      onStep: step => {
        if (allPriorIds.has(step.id)) return;
        current.set(step.id, step);
        lastProgress = Date.now();
        save(`${dir}/react_steps.json`, [...current.values()]);
        const outcomes = (step.toolResults ?? []).flatMap((r: any) =>
          r.output?.kind === "dataflow-actions" ? [r.output] : []
        );
        if (step.role !== "agent" || done.has(step.id) || outcomes.some((r: any) => r.status === "pending")) return;
        done.add(step.id);
        event({ event: "step_complete", turn_id: turn.turn_id, step_id: step.id, calls: step.toolCalls?.length ?? 0 });
        console.log(`${arm} ${manifest.key} turn ${turn.turn_id}/${turns.length} step ${step.stepId}`);
        pending = pending.then(async () => {
          const snapshot = await getSnapshot(agent.id, step.id, baseUrl);
          save(`${dir}/snapshot-${step.stepId}.json`, snapshot);
          const state = JSON.stringify({
            operators: snapshot.workflow?.operators.map(op => [op.operatorID, op.nativeOp?.revision]),
            results: Object.entries(snapshot.results).map(([id, r]: [string, any]) => [
              id,
              r.resultVersion?.id ?? r.materialization ?? null,
            ]),
          });
          for (const outcome of outcomes)
            for (const receipt of outcome.actions)
              if (!["pending", "skipped"].includes(receipt.status))
                for (const kind of monitor.observe(receipt, state))
                  alert(kind, { turn_id: turn.turn_id, step_id: step.id, action_index: receipt.index });
          auditWire();
        });
      },
    });
    await pending;
    if (result.completionSource === "rest") alert("completion_recovered_from_rest", { turn_id: turn.turn_id });
    auditWire();
    const steps = [...current.values()];
    for (const step of steps) allPriorIds.add(step.id);
    const answered = steps
      .flatMap(step =>
        (step.toolResults ?? []).flatMap((r: any) =>
          r.output?.kind === "dataflow-actions" && typeof r.output.answer === "string" ? [r.output.answer] : []
        )
      )
      .at(-1);
    const answer =
      answered?.match(/(?:\*\*\s*)?final answer:\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*$/is)?.[1]?.trim() ?? answered ?? "";
    const errors = [
      ...result.errors,
      ...steps.filter(s => s.role === "agent" && /^Error:/.test(s.content ?? "")).map(s => s.content),
    ];
    if (!answered) alert("turn_without_answer", { turn_id: turn.turn_id, errors, model_steps: done.size });
    if (!result.completed) {
      await fetch(`${agentUrl}/stop`, { method: "POST" });
      alert("incomplete_turn", { turn_id: turn.turn_id, errors });
    }
    const usage = steps.filter(s => s.role === "agent").map(s => s.usage ?? {});
    const stats = {
      llm_calls: done.size,
      input_tokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0),
      cached_tokens: usage.reduce((n, u) => n + (u.cachedInputTokens ?? 0), 0),
      cache_write_tokens: usage.reduce((n, u) => n + (u.cacheCreationInputTokens ?? 0), 0),
      output_tokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
      elapsed_seconds: (Date.now() - started) / 1000,
    };
    save(`${dir}/answer.json`, {
      answer,
      response: answered ?? result.finalAnswer,
      errors,
      completed: result.completed,
      completion_source: result.completionSource,
    });
    save(`${dir}/stats.json`, stats);
    save(`${dir}/workflow.json`, await json(`${agentUrl}/workflow`));
    const gold = JSON.parse(readFileSync(join(prepared, "gold.json"), "utf8")).turns.find(
      (g: any) => g.turn_id === turn.turn_id
    );
    records.push({
      turn_id: turn.turn_id,
      context: turn.context,
      question: turn.question,
      solution: answer,
      ground_truth: gold.answer,
      state_type: gold.state_type,
      depends_tasks: gold.depends_tasks,
      depends_span: gold.depends_span,
      success: !!answer && !errors.length,
      error: errors.join("; "),
      steps: done.size,
      stats,
    });
    save("results_with_ground_truth.json", records);
    save("summary.json", {
      task: manifest.key,
      arm,
      model,
      turns_total: turns.length,
      turns_completed: records.length,
      answers_present: records.filter(r => r.solution).length,
      elapsed_seconds: (Date.now() - start) / 1000,
      anomalies: alerts.length,
    });
    console.log(
      `DONE ${arm} ${manifest.key} turn ${turn.turn_id} answer=${!!answer} seconds=${stats.elapsed_seconds.toFixed(1)}`
    );
    if (!answered && errors.some(error => /litellm\.|invalid_function_parameters|invalid_request_error/i.test(error)))
      throw new Error("Session stopped after a provider rejection; preserve this setup attempt before recovery");
    if (!result.completed)
      throw new Error("Session stopped after incomplete turn; inspect backend termination before any recovery");
  }
} finally {
  clearInterval(heartbeat);
  auditWire();
  save("react_steps.json", (await getReActSteps(agent.id, baseUrl)).steps);
  await deleteAgent(agent.id, baseUrl);
  await terminateComputingUnit(token, cuid);
}
// Full traces and per-step snapshots remain on disk; release in-memory agents after each session.
