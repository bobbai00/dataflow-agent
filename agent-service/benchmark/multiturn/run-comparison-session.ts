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
/** One matched session over REST; persisted traces are compressed, resources owned by this job are removed. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAgent, deleteAgent } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { env } from "../../src/config/env";
import { comparisonAnswer } from "./comparison-answer";

const [preparedArg, outputArg, protocolArg] = Bun.argv.slice(2);
assert.ok(preparedArg && outputArg && protocolArg, "Use prepared-dir output-dir protocol.json");
const prepared = resolve(preparedArg),
  output = resolve(outputArg);
const load = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const job = load(join(output, "job.json")),
  protocol = load(resolve(protocolArg));
const manifest = load(join(prepared, "manifest.json"));
const prompts = load(join(prepared, "prompts.json"));
const turns = manifest.turns.slice(0, job.turn_limit ?? undefined);
assert.equal(turns.length, job.turns_total);
const save = (file: string, value: unknown) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + "\n");
const zip = (file: string, value: unknown) => writeFileSync(join(output, file), Bun.gzipSync(JSON.stringify(value)));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
assert.equal(
  sha(readFileSync(join(prepared, "prompts.json"), "utf8")),
  protocol.prompt_hashes[job.task],
  "Frozen task prompts changed"
);
const base = protocol.endpoint;
const json = async (url: string, options?: RequestInit) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${(await response.text()).slice(0, 500)}`);
  return response.json() as Promise<any>;
};
let agentId: string | undefined, cuid: number | undefined, wid: number | undefined;
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const records: any[] = [],
  cleanup: any[] = [];
let previousCount = 0;
try {
  const unit = await createComputingUnit(token, `state-comparison-${job.arm}-${Date.now()}`, {
    unitType: "local",
    uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = unit.computingUnit.cuid;
  wid = await createWorkflow(
    token,
    `state-comparison-${job.arm}-${Date.now()}`,
    new WorkflowState().getWorkflowContent()
  );
  const agent = await createAgent({
    baseUrl: base,
    userToken: token,
    modelType: protocol.model,
    workflowId: wid,
    computingUnitId: cuid,
    settings: job.settings,
  });
  agentId = agent.id;
  save("resources.json", { agent_id: agentId, cuid, wid, endpoint: base });
  const agentUrl = `${base}/api/agents/${agentId}`;
  const settings = await json(`${agentUrl}/settings`);
  for (const [key, value] of Object.entries(job.settings))
    assert.deepEqual(settings[key], value, `Effective setting drift: ${key}`);
  save("settings.json", settings);
  const system = await json(`${agentUrl}/system-info`);
  if (protocol.full_input_policy) {
    assert.deepEqual(
      system.inputBudget,
      { tokens: protocol.full_input_policy.budget_tokens, scale: protocol.full_input_policy.scale },
      "Full input policy drift"
    );
    assert.equal(system.modelCallLimit, protocol.max_model_calls_per_turn, "Model-call limit drift");
  }
  save("system-info.json", system);
  writeFileSync(join(output, "system_prompt.txt"), system.systemPrompt);
  save("runtime.json", {
    input_budget: system.inputBudget,
    model_call_limit: system.modelCallLimit,
    prompt_sha256: sha(system.systemPrompt),
    model: protocol.model,
    engine_endpoint: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    prompts_sha256: sha(readFileSync(join(prepared, "prompts.json"), "utf8")),
  });
  for (const turn of turns) {
    const dir = `t${String(turn.turn_id).padStart(2, "0")}`;
    mkdirSync(join(output, dir));
    const matches = prompts.filter((p: any) => p.turn_id === turn.turn_id);
    assert.equal(matches.length, 1);
    const prompt = matches[0].prompt;
    writeFileSync(join(output, dir, "prompt.txt"), prompt);
    const started = Date.now();
    // The synchronous endpoint can disconnect while work continues. Recover by reading state, never resubmitting a paid turn.
    let response: any;
    try {
      response = await json(`${agentUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prompt }),
        signal: AbortSignal.timeout(1_200_000),
      });
    } catch (error) {
      save(`${dir}/transport-error.json`, { error: String(error) });
      const deadline = started + 1_200_000;
      while (Date.now() < deadline) {
        const state = await json(agentUrl);
        if (state.state === "AVAILABLE") break;
        await Bun.sleep(1000);
      }
      if (Date.now() >= deadline) {
        await fetch(`${agentUrl}/stop`, { method: "POST" });
        throw error;
      }
    }
    const all = (await json(`${agentUrl}/react-steps`)).steps;
    const steps = all.slice(previousCount);
    previousCount = all.length;
    assert.equal(steps[0]?.role, "user");
    assert.equal(steps[0]?.content, prompt, "Trace belongs to another request");
    zip(`${dir}/react_steps.json.gz`, { steps });
    zip(`${dir}/workflow.json.gz`, await json(`${agentUrl}/workflow`));
    if (settings.stateHistory) save(`${dir}/task-history.json`, await json(`${agentUrl}/task-history`));
    const modelSteps = steps.filter((s: any) => s.role === "agent");
    const { answer, completed } = comparisonAnswer(modelSteps, response?.answer);
    const total = (field: string) =>
      modelSteps.every((s: any) => s.usage?.[field] != null)
        ? modelSteps.reduce((n: number, s: any) => n + s.usage[field], 0)
        : null;
    const stats = {
      llm_calls: modelSteps.length,
      input_tokens: total("inputTokens"),
      output_tokens: total("outputTokens"),
      cached_tokens: total("cachedInputTokens"),
      cache_write_tokens: total("cacheCreationInputTokens"),
      elapsed_seconds: (Date.now() - started) / 1000,
    };
    const historyActions = modelSteps
      .flatMap((s: any) => (s.toolCalls ?? []).flatMap((c: any) => c.input?.actions ?? []))
      .filter(
        (a: any) =>
          (a.type === "inspect" && ["state", "task"].includes(a.target) && a.task_id != null) ||
          (a.type === "edit" && /(?:^|\n)(?:fork operator\b|update operator\s+\S+\s+from task\b)/.test(a.changes ?? ""))
      );
    const gold = load(join(prepared, "gold.json")).turns.find((t: any) => t.turn_id === turn.turn_id);
    records.push({
      turn_id: turn.turn_id,
      context: turn.context,
      question: turn.question,
      solution: answer,
      ground_truth: gold.answer,
      state_type: gold.state_type,
      depends_tasks: gold.depends_tasks,
      depends_span: gold.depends_span,
      success: completed,
      error: completed ? null : "No successful Answer action",
      steps: modelSteps.length,
      stats,
      history_actions: historyActions,
    });
    save(`${dir}/answer.json`, { answer, completed });
    save(`${dir}/stats.json`, stats);
    save("results_with_ground_truth.json", records);
    save("summary.json", {
      task: manifest.key,
      arm: job.arm,
      turns_total: turns.length,
      turns_completed: records.length,
      answers_present: records.filter(r => r.solution).length,
    });
    console.log(
      `DONE ${job.arm} ${manifest.key} ${turn.turn_id}/${turns.length} calls=${modelSteps.length} answer=${completed}`
    );
    if (!completed) throw new Error("No successful Answer action; preserving partial session");
  }
} finally {
  for (const [resource, action] of [
    [
      "agent",
      async () => {
        if (agentId) await deleteAgent(agentId, base);
      },
    ],
    [
      "computing-unit",
      async () => {
        if (cuid != null) await terminateComputingUnit(token, cuid);
      },
    ],
    [
      "workflow",
      async () => {
        if (wid != null) await deleteWorkflow(token, wid);
      },
    ],
  ] as const) {
    try {
      await action();
      cleanup.push({ resource, status: "removed" });
    } catch (error) {
      cleanup.push({ resource, status: "error", error: String(error) });
    }
  }
  save("cleanup.json", cleanup);
}
