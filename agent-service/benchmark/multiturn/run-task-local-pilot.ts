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
/** A short matched continuation: replay the identical recorded Task 1 through
 * the real engine, prove both initial graphs match, then solve Tasks 2 and 3.
 * Neither benchmark reference answers nor dependency annotations reach models. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { executionFingerprints, workflowExecutionPlan } from "../../src/agent/native/result-versions";
import { env } from "../../src/config/env";
import { nativeDebugInput } from "../e2e/native-debug-input";
import { assertNativeCleanupSafe } from "../e2e/native-cleanup";

const [protocolArg, outputArg] = Bun.argv.slice(2);
assert(protocolArg && outputArg, "Use frozen-protocol.json output-dir");
const load = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const protocol = load(resolve(protocolArg)),
  directory = resolve(outputArg);
mkdirSync(directory, { recursive: true });
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
for (const [path, sha] of Object.entries(protocol.source_hashes))
  assert.equal(digest(readFileSync(path)), sha, `Source changed: ${path}`);
const prompts = load(join(protocol.prepared, "prompts.json"));
assert.equal(digest(readFileSync(join(protocol.prepared, "prompts.json"))), protocol.prompt_sha256);
const seedBytes = readFileSync(protocol.seed_trace);
assert.equal(digest(seedBytes), protocol.seed_sha256, "Seed trace changed");
const seed = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(seedBytes))).steps;
assert.equal(seed[0].content, prompts[0].prompt);
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const resources: Array<{ label: string; base: string; dir: string; agentId: string; wid: number; cuid: number }> = [];
const save = (dir: string, name: string, value: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n");
const json = async (url: string, options?: RequestInit) => {
  const response = await fetch(url, options);
  assert(response.ok, `HTTP ${response.status} ${url}: ${(await response.clone().text()).slice(0, 500)}`);
  return response.json() as Promise<any>;
};
async function debug(resource: (typeof resources)[number], content: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${resource.base.replace(/^http/, "ws")}/api/agents/${resource.agentId}/react`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Seed replay timed out"));
    }, 240_000);
    let sent = false,
      ended = false;
    socket.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        socket.send(JSON.stringify({ type: "debug", content }));
      } else if (frame.type === "complete") ended = true;
      else if (frame.type === "nextContext" && ended) {
        clearTimeout(timer);
        socket.close();
        resolve();
      } else if (frame.type === "error") {
        clearTimeout(timer);
        socket.close();
        reject(new Error(String(frame.content)));
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Seed replay socket failed"));
    };
  });
}
try {
  for (const arm of protocol.arms) {
    const dir = join(directory, arm.label);
    mkdirSync(dir, { recursive: true });
    const cuid = (
      await createComputingUnit(token, `task-local-${arm.label}-${Date.now()}`, {
        unitType: "local",
        uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
      })
    ).computingUnit.cuid;
    const wid = await createWorkflow(
      token,
      `task-local-${arm.label}-${Date.now()}`,
      new WorkflowState().getWorkflowContent()
    );
    const agentId = (
      await createAgent({
        baseUrl: arm.base,
        userToken: token,
        modelType: protocol.model,
        workflowId: wid,
        computingUnitId: cuid,
        settings: protocol.settings,
      })
    ).id;
    const resource = { label: arm.label, base: arm.base, dir, agentId, wid, cuid };
    resources.push(resource);
    save(dir, "resources.json", resource);
    save(dir, "system-info.json", await json(`${arm.base}/api/agents/${agentId}/system-info`));
    save(dir, "settings.json", await json(`${arm.base}/api/agents/${agentId}/settings`));
    await debug(resource, seed[0].content);
    for (const step of seed)
      for (const call of step.toolCalls ?? []) {
        assert.equal(call.toolName, "dataflow");
        await debug(resource, nativeDebugInput("dataflow", call.input));
      }
    const history = await json(`${arm.base}/api/agents/${agentId}/task-history`);
    assert.equal(history.tasks.length, 1);
    assert.equal(history.tasks[0].status, "answered");
    assert.equal(history.tasks[0].answer, load(join(protocol.seed_turn, "answer.json")).answer);
    save(dir, "seed-task-history.json", history);
    save(dir, "seed-workflow.json", await json(`${arm.base}/api/agents/${agentId}/workflow`));
    const trace = (await getReActSteps(agentId, arm.base)).steps;
    assert(!trace.some(step => step.usage?.inputTokens), "Seed replay must make no model calls");
    writeFileSync(join(dir, "seed-react_steps.json.gz"), Bun.gzipSync(JSON.stringify({ steps: trace })));
    console.log(`SEEDED ${arm.label} ${history.tasks[0].operators.length} operators`);
  }
  const graphProofs = resources.map(resource => {
    const wf = load(join(resource.dir, "seed-workflow.json")).workflow;
    return [...executionFingerprints(workflowExecutionPlan(wf))].sort((a, b) => a[0].localeCompare(b[0]));
  });
  assert.deepEqual(graphProofs[0], graphProofs[1], "Initial operator definitions and upstream graphs differ");
  save(directory, "seed-gate.json", {
    status: "passed",
    identical_operator_fingerprints: graphProofs[0],
    model_calls: 0,
  });
  console.log("SEED GATE PASSED; starting four model answers");
  const settled = await Promise.allSettled(
    resources.map(async resource => {
      const rows: any[] = [];
      let previous = (await getReActSteps(resource.agentId, resource.base)).steps.length;
      for (const turnId of protocol.turn_ids) {
        const prompt = prompts.find((entry: any) => entry.turn_id === turnId).prompt;
        const dir = join(resource.dir, `t${String(turnId).padStart(2, "0")}`);
        mkdirSync(dir);
        writeFileSync(join(dir, "prompt.txt"), prompt);
        const started = Date.now();
        await json(`${resource.base}/api/agents/${resource.agentId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: prompt }),
          signal: AbortSignal.timeout(1_200_000),
        });
        const all = (await getReActSteps(resource.agentId, resource.base)).steps,
          steps = all.slice(previous);
        previous = all.length;
        const model = steps.filter(step => step.role === "agent"),
          end = model.findLast(step => step.isEnd);
        const solution = model
          .flatMap(step =>
            (step.toolResults ?? [])
              .map(result => (result.output as any)?.answer)
              .filter(answer => typeof answer === "string")
          )
          .at(-1);
        const total = (key: string) =>
          model.every(step => step.usage?.[key as keyof typeof step.usage] != null)
            ? model.reduce((sum, step) => sum + Number(step.usage?.[key as keyof typeof step.usage]), 0)
            : null;
        const stats = {
          llm_calls: model.length,
          input_tokens: total("inputTokens"),
          output_tokens: total("outputTokens"),
          cached_tokens: total("cachedInputTokens"),
          cache_write_tokens: total("cacheCreationInputTokens"),
          elapsed_seconds: (Date.now() - started) / 1000,
        };
        writeFileSync(join(dir, "react_steps.json.gz"), Bun.gzipSync(JSON.stringify({ steps })));
        save(dir, "workflow.json", await json(`${resource.base}/api/agents/${resource.agentId}/workflow`));
        save(dir, "task-history.json", await json(`${resource.base}/api/agents/${resource.agentId}/task-history`));
        save(dir, "stats.json", stats);
        save(dir, "answer.json", {
          answer: solution ?? end?.content ?? "",
          completed: !!end && typeof solution === "string",
        });
        // Evaluation-only data are read after the solver has answered.
        const gold = load(join(protocol.prepared, "gold.json")).turns.find((turn: any) => turn.turn_id === turnId);
        const manifest = load(join(protocol.prepared, "manifest.json")).turns.find(
          (turn: any) => turn.turn_id === turnId
        );
        rows.push({
          turn_id: turnId,
          context: manifest.context,
          question: manifest.question,
          solution: solution ?? end?.content ?? "",
          ground_truth: gold.answer,
          state_type: gold.state_type,
          depends_tasks: gold.depends_tasks,
          depends_span: gold.depends_span,
          success: !!end && typeof solution === "string",
          stats,
        });
        save(resource.dir, "results_with_ground_truth.json", rows);
        console.log(`DONE ${resource.label} Q${turnId} calls=${model.length} completed=${!!end}`);
        assert(end && typeof solution === "string", "No completed answer; retaining every attempted turn");
      }
    })
  );
  save(
    directory,
    "outcomes.json",
    settled.map(result => ({
      status: result.status,
      ...(result.status === "rejected" ? { reason: String(result.reason) } : {}),
    }))
  );
  assert(
    settled.every(result => result.status === "fulfilled"),
    "A continuation failed; see saved outcomes"
  );
} finally {
  for (const resource of resources) {
    const agent = await json(`${resource.base}/api/agents/${resource.agentId}`);
    const execution = await json(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource.wid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertNativeCleanupSafe(agent, execution, resource);
    await deleteAgent(resource.agentId, resource.base);
    await deleteWorkflow(token, resource.wid);
    await terminateComputingUnit(token, resource.cuid);
    save(resource.dir, "cleanup.json", { removed: true, ...resource });
  }
}
