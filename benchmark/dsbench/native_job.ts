/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// One fresh workflow, computing unit and agent for one DSBench question.
import { strict as assert } from "node:assert";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { verifyLoadedService } from "./native_integrity";
import {
  nativeGenerationProvenance,
  nativeModelCapabilityOptions,
  nativeModelRequestTimeoutOptions,
  nativeRequestTimeoutProvenance,
} from "./native_capabilities";

const root = resolve(import.meta.dir, "../..");
const config = JSON.parse(readFileSync(Bun.argv[2], "utf8"));
// Validate before loading SDKs or allocating workflows/computing units.
const modelCapabilityOptions = nativeModelCapabilityOptions(
  config.model_capabilities,
);
const modelRequestTimeoutOptions = nativeModelRequestTimeoutOptions(
  config.model_request_timeout_seconds,
);
const directory = config.output_dir;
const base = config.endpoint;
const api = await import(
  pathToFileURL(join(root, "agent-service/src/api/index.ts")).href
);
const agentApi = await import(
  pathToFileURL(join(root, "agent-service/src/api/agent-service-api.ts")).href
);
const { WorkflowState } = await import(
  pathToFileURL(join(root, "agent-service/src/agent/workflow-state.ts")).href
);
const { assertNativeCleanupSafe } = await import(
  pathToFileURL(join(root, "agent-service/benchmark/e2e/native-cleanup.ts"))
    .href
);
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
save("native-generation-provenance.json", nativeGenerationProvenance(config));
save("model-request-timeout.json", nativeRequestTimeoutProvenance(config));
const started = performance.now();
const lifecycle: Record<string, number> = {};
let token: string;
let resource: { agentId?: string; wid?: number; cuid?: number } = {};
let turn: any;
let failure: string | undefined;
let integrityFailure = false;
const observed = new Map<string, any>();

async function get(url: string, auth = false) {
  const response = await fetch(url, {
    ...(auth ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}

async function collect() {
  let steps = [...observed.values()];
  let completeTrace = !resource.agentId;
  let accounting: any;
  if (resource.agentId) {
    const journal = join(
      process.env.MODEL_REQUEST_JOURNAL_DIR ??
        process.env.TEXERA_LLM_TRACE_DIR ??
        join(tmpdir(), "texera-agent-model-requests"),
      resource.agentId,
      "model-requests.jsonl",
    );
    if (existsSync(journal))
      copyFileSync(journal, join(directory, "model-request-journal.jsonl"));
    try {
      accounting = await get(
        `${base}/api/agents/${resource.agentId}/model-metrics`,
      );
      save("model-accounting.json", accounting);
      writeFileSync(
        join(directory, "model-requests.jsonl"),
        accounting.requests
          .map((request: any) => JSON.stringify(request))
          .join("\n") + "\n",
      );
    } catch (error) {
      save("model-accounting-fetch-error.json", { error: String(error) });
    }
    try {
      const trace = await agentApi.getReActSteps(resource.agentId, base);
      steps = trace.steps;
      completeTrace = true;
    } catch (error) {
      save("trace-fetch-error.json", { error: String(error) });
    }
  }
  save("react_steps.json", steps);
  const modelSteps = steps.filter(
    (step: any) => step.role === "agent" && step.inputMessages && step.usage,
  );
  const usage: any = {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
  };
  const keys: Record<string, string> = {
    input_tokens: "inputTokens",
    output_tokens: "outputTokens",
    cached_tokens: "cachedInputTokens",
    cache_creation_tokens: "cacheCreationInputTokens",
    reasoning_tokens: "reasoningTokens",
  };
  for (const step of modelSteps)
    for (const [name, key] of Object.entries(keys))
      usage[name] += step.usage[key] ?? 0;
  if (accounting?.usage) {
    for (const [name, key] of Object.entries(keys))
      usage[name] = accounting.usage[key] ?? 0;
  }
  const errors = steps
    .filter(
      (step: any) =>
        step.role === "agent" && /^Error:/.test(step.content ?? ""),
    )
    .map((step: any) => step.content);
  const answered = steps.some((step: any) =>
    (step.toolResults ?? []).some((result: any) =>
      result.output?.actions?.some(
        (action: any) =>
          action.status === "ok" && action.action?.type === "answer",
      ),
    ),
  );
  const response = turn?.finalAnswer ?? "";
  writeFileSync(join(directory, "response.txt"), response);
  save("answer.json", { answer: response });
  save("stats.json", {
    ...usage,
    total_tokens: usage.input_tokens + usage.output_tokens,
    model_calls_succeeded: accounting?.succeededRequests ?? modelSteps.length,
    model_calls_attempted:
      accounting?.attemptedRequests ??
      (errors.length ? null : modelSteps.length),
    failed_model_calls: accounting?.failedRequests ?? errors.length,
    model_call_count_source: accounting
      ? "Agent-service transport model-accounting.json"
      : "Agent-service per-request inputMessages/usage; gateway wire audit recorded separately",
    usage_incomplete: accounting
      ? accounting.usageStatus !== "complete"
      : Boolean(config.expected_service_source_hashes) || !completeTrace || errors.length > 0,
    native_agent_error_steps: errors.length,
    num_steps: modelSteps.length,
    elapsed_seconds: (performance.now() - started) / 1000,
  });
  save("status.json", {
    completed: Boolean(
      turn?.completed && answered && !failure && !errors.length,
    ),
    turn_completed: Boolean(turn?.completed),
    answer_action_completed: answered,
    error: failure ?? null,
    errors: [...(turn?.errors ?? []), ...errors],
    integrity_failure: integrityFailure,
    provider_blocked:
      /billing_not_active|AuthenticationError|PermissionDeniedError|insufficient_quota/.test(
        [failure, ...errors].join(" "),
      ),
  });
  if (resource.agentId) {
    for (const [name, route] of [
      ["snapshot.json", "snapshots/head"],
      ["workflow.json", "workflow"],
      ["operator_results.json", "operator-results"],
    ]) {
      try {
        save(
          name!,
          await get(`${base}/api/agents/${resource.agentId}/${route}`),
        );
      } catch (error) {
        save(name!.replace(".json", "-fetch-error.json"), {
          error: String(error),
        });
      }
    }
  }
}

async function cleanup() {
  if (!resource.agentId || !resource.wid || !resource.cuid) {
    save("cleanup.json", {
      removed: false,
      partial_resource: resource,
      reason: "Incomplete provisioning; retained for inspection",
    });
    return;
  }
  try {
    const agent = await get(`${base}/api/agents/${resource.agentId}`);
    const history = await get(
      `${process.env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource.wid}`,
      true,
    );
    save("execution-history.json", history);
    const complete = resource as { agentId: string; wid: number; cuid: number };
    assertNativeCleanupSafe(agent, history, complete);
    await agentApi.deleteAgent(complete.agentId, base);
    await api.deleteWorkflow(token, complete.wid);
    await api.terminateComputingUnit(token, complete.cuid);
    save("cleanup.json", { removed: true });
  } catch (error) {
    save("cleanup.json", { removed: false, error: String(error), resource });
  }
}

try {
  token = await api.login(
    process.env.TEXERA_USERNAME ?? "texera",
    process.env.TEXERA_PASSWORD ?? "texera",
  );
  const name = `dsbench-${config.arm}-${config.task_id}-${Date.now()}`;
  const cu = await api.createComputingUnit(token, name, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI,
  });
  resource.cuid = cu.computingUnit.cuid;
  save("resource.json", resource);
  resource.wid = await api.createWorkflow(
    token,
    name,
    new WorkflowState().getWorkflowContent(),
  );
  save("resource.json", resource);
  assert(
    process.env.NATIVE_WORKSPACE,
    "NATIVE_WORKSPACE is required for task-only isolation",
  );
  const workspace = join(process.env.NATIVE_WORKSPACE, String(resource.wid));
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, "task-inputs.json"),
    JSON.stringify({
      relative_path: config.input_relative_path ?? `dsbench/${config.task_id}`,
    }) + "\n",
  );
  const agent = await agentApi.createAgent({
    baseUrl: base,
    userToken: token,
    modelType: config.model,
    workflowId: resource.wid,
    computingUnitId: resource.cuid,
    settings: config.settings,
    ...modelCapabilityOptions,
    ...modelRequestTimeoutOptions,
  });
  resource.agentId = agent.id;
  save("resource.json", resource);
  save(
    "model-request-timeout.json",
    nativeRequestTimeoutProvenance(config, agent),
  );
  if (modelRequestTimeoutOptions.modelRequestTimeoutMs !== undefined)
    assert.equal(
      agent.modelRequestTimeoutMs,
      modelRequestTimeoutOptions.modelRequestTimeoutMs,
      "Model request timeout drift or unsupported native API",
    );
  const actual = await get(`${base}/api/agents/${agent.id}/settings`);
  save("settings.json", actual);
  const info = await get(`${base}/api/agents/${agent.id}/system-info`);
  save("system-info.json", info);
  try {
    if (config.expected_service_source_hashes) {
      const preflightAccounting = await get(
        `${base}/api/agents/${agent.id}/model-metrics`,
      );
      save("preflight-model-accounting.json", preflightAccounting);
      verifyLoadedService(
        preflightAccounting,
        config.expected_service_source_hashes,
        config.resource_scope?.owned_service_pids?.["agent-service"],
      );
    }
    for (const [key, value] of Object.entries(config.settings))
      assert.deepEqual(actual[key], value, `Setting drift: ${key}`);
    assert(
      info.systemPrompt.includes(config.shared_principles),
      "Shared principles differ from native system prompt",
    );
    assert.equal(
      info.systemPrompt.split("## Analysis principles").length - 1,
      1,
    );
    const tool = info.tools.find((item: any) => item.name === "dataflow");
    const retrieval = tool.inputSchema.properties.actions.items.anyOf.find(
      (item: any) => item.properties.type.const === "retrieve",
    );
    assert.deepEqual(
      retrieval.properties.view.enum,
      config.settings.retrievalViews,
    );
  } catch (error) {
    integrityFailure = true;
    throw error;
  }
  lifecycle.setup_seconds = (performance.now() - started) / 1000;
  const solveStarted = performance.now();
  try {
    turn = await agentApi.runAgentTurn(agent.id, config.prompt, {
      baseUrl: base,
      timeoutMs: config.task_timeout_seconds * 1000,
      onStep: (step: any) => {
        observed.set(step.id, step);
        appendFileSync(
          join(directory, "react-step-events.jsonl"),
          JSON.stringify(step) + "\n",
        );
        if (step.role === "agent")
          console.log(`STEP ${config.arm} ${config.task_id} ${step.id}`);
      },
    });
  } finally {
    lifecycle.solve_seconds = (performance.now() - solveStarted) / 1000;
  }
  save("turn.json", turn);
  if (!turn.completed) {
    await fetch(`${base}/api/agents/${agent.id}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    save("stop-request.json", {
      requested_at: new Date().toISOString(),
      reason: "Turn did not complete",
    });
  }
} catch (error) {
  failure = String(error);
  save("harness-error.json", { error: failure });
  console.log(`ERROR ${config.arm} ${config.task_id}: ${failure}`);
} finally {
  const captureStarted = performance.now();
  try {
    await collect();
  } finally {
    lifecycle.capture_seconds = (performance.now() - captureStarted) / 1000;
    const cleanupStarted = performance.now();
    await cleanup();
    lifecycle.cleanup_seconds = (performance.now() - cleanupStarted) / 1000;
    lifecycle.worker_seconds = (performance.now() - started) / 1000;
    save("lifecycle.json", lifecycle);
  }
}
