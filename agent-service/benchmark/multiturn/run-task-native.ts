/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";
import { runAgentTurn } from "../../src/api";

const [sessionPath, outPath, arm = "tasks", limit = "100"] = process.argv.slice(2);
if (!sessionPath || !outPath || !["base", "compact", "return", "context", "tasks"].includes(arm))
  throw new Error("Usage: run-task-native.ts session.json output-dir base|compact|return|context|tasks [limit]");
const out = resolve(outPath);
if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
mkdirSync(out, { recursive: true });
const spec = await Bun.file(sessionPath).json();
const settings = {
  nativeCatalogVersion: "v2" as const,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  nativeCompactPrompt: arm !== "base",
  nativeDirectReturn: ["return", "context", "tasks"].includes(arm),
  nativeTaskContext: ["context", "tasks"].includes(arm),
  nativeTaskHistory: arm === "tasks",
  nativeTaskCache: process.env.TASK_CACHE_BOUNDARIES !== "0",
  maxSteps: 25,
  maxOperatorResultCharLimit: 2000,
  maxOperatorResultCellCharLimit: 2000,
  thoughtReplay: false,
  sessionTurns: false,
  versionedMode: false,
  userTaskPlacement: "bottom" as const,
};
const session = await nativeTestSession(settings);
const write = (path: string, value: unknown) => Bun.write(`${out}/${path}`, JSON.stringify(value, null, 2));
await write("config.json", {
  arm,
  model: "gpt-5.6-luna",
  settings: await session.settings(),
  session: spec,
  service: session.baseUrl,
  engine: process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  cost_rates_usd_per_million: { input: 0.2, cached_input: 0.02, cache_write: 0.25, output: 1.2 },
  cost_source: "Repository accounting assumptions, cache-aware; infrastructure excluded; not provider invoices.",
});
let prior = 0;
try {
  for (let i = 0; i < Math.min(spec.turns.length, Number(limit)); i++) {
    const task = spec.turns[i],
      directory = `t${String(i + 1).padStart(2, "0")}`;
    mkdirSync(`${out}/${directory}`);
    const prompt =
      (i === 0
        ? "We are working through a sequence of analytical tasks in one session. Keep useful state for later requests.\n\n"
        : "") + task.prompt;
    await write(`${directory}/prompt.json`, { id: task.id, prompt });
    const start = Date.now();
    try {
      const result = await runAgentTurn(session.agentId, prompt, { baseUrl: session.baseUrl, timeoutMs: 600000 });
      await write(`${directory}/answer.json`, {
        answer: result.finalAnswer,
        completed: result.completed,
        errors: result.errors,
      });
    } catch (error) {
      await write(`${directory}/answer.json`, { answer: "", error: String(error) });
      await session.request(`/${session.agentId}/stop`, "POST");
    }
    const all = (await session.trace()).steps;
    const steps = all.slice(prior);
    prior = all.length;
    await write(`${directory}/react_steps.json`, steps);
    const snapshot = await session.snapshot();
    await write(`${directory}/workflow.json`, snapshot.workflow);
    await write(`${directory}/operator_results.json`, snapshot.results);
    const calls = steps.filter(s => s.role === "agent" && (s.usage?.inputTokens ?? 0) > 0);
    const sum = (key: string) => calls.reduce((n, s) => n + Number((s.usage as any)?.[key] ?? 0), 0);
    const input = sum("inputTokens"),
      output = sum("outputTokens"),
      cached = sum("cachedInputTokens"),
      written = sum("cacheCreationInputTokens");
    const stats = {
      input_tokens: input,
      output_tokens: output,
      cached_tokens: cached,
      cache_write_tokens: written,
      reasoning_tokens: sum("reasoningTokens"),
      llm_calls: calls.length,
      cost_usd: ((input - cached - written) * 0.2 + cached * 0.02 + written * 0.25 + output * 1.2) / 1e6,
      elapsed_seconds: (Date.now() - start) / 1000,
      tool_calls: steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0),
      historical_inputs: steps
        .flatMap(s => s.toolCalls ?? [])
        .reduce((n, c) => n + (JSON.stringify(c.input).match(/"atTask":/g) ?? []).length, 0),
      direct_returns: steps.filter(s => s.isEnd && s.toolCalls?.some(c => c.input?.return)).length,
    };
    await write(`${directory}/stats.json`, stats);
    console.log(JSON.stringify({ arm, task: i + 1, ...stats }));
  }
} finally {
  await session.close();
}
