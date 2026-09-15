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

const [sessionPath, outputPath, arm = "batch", limit = "9"] = process.argv.slice(2);
if (!sessionPath || !outputPath || !["batch", "recipes", "batch-bottom", "recipes-bottom"].includes(arm)) throw new Error("Usage: run-native.ts session.json output-dir batch|recipes|batch-bottom|recipes-bottom [turn-limit]");
const out = resolve(outputPath);
if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
mkdirSync(out, { recursive: true });
const spec = await Bun.file(sessionPath).json();
const settings = {
  nativeCatalogVersion: "v1" as const, nativeRecipes: arm.startsWith("recipes"),
  ...(arm.endsWith("bottom") ? { summarizeParams: { userTaskPlacement: "bottom" as const } } : {}),
  maxSteps: 25, maxOperatorResultCharLimit: 2000, maxOperatorResultCellCharLimit: 2000,
  thoughtReplay: false, sessionTurns: false, versionedMode: false,
};
const session = await nativeTestSession(settings);
const write = (path: string, value: unknown) => Bun.write(`${out}/${path}`, JSON.stringify(value, null, 2));
await write("config.json", { arm, model: "gpt-5.6-luna", settings: await session.settings(), session: spec, service: session.baseUrl,
  cost_rates_usd_per_million: { input: .2, cached_input: .02, output: 1.2 },
  cost_source: "Repository Luna accounting; cached-aware, not an invoice. V1 uses shared legacy backend; V2 transport is unavailable." });
let prior = 0;
try {
  for (let i = 0; i < Math.min(spec.turns.length, Number(limit)); i++) {
    const turn = spec.turns[i];
    const dir = `t${String(i + 1).padStart(2, "0")}`;
    mkdirSync(`${out}/${dir}`);
    const prompt = (i === 0 ? "We are working through a multi-turn analysis. Keep useful state and reusable computations for later requests. Distinguish published results from definitions and data versions.\n\n" : "") + turn.prompt + "\nReturn the requested JSON as your final answer.";
    await write(`${dir}/prompt.json`, { id: turn.id, prompt });
    const start = Date.now();
    try {
      const result = await runAgentTurn(session.agentId, prompt, { baseUrl: session.baseUrl, timeoutMs: 600_000 });
      await write(`${dir}/answer.json`, { answer: result.finalAnswer, completed: result.completed, errors: result.errors });
    } catch (error: any) {
      await write(`${dir}/answer.json`, { answer: "", error: String(error) });
      await session.request(`/${session.agentId}/stop`, "POST");
    }
    const trace = (await session.trace()).steps;
    const steps = trace.slice(prior); prior = trace.length;
    await write(`${dir}/react_steps.json`, steps);
    const snapshot = await session.snapshot();
    await write(`${dir}/workflow.json`, snapshot.workflow);
    await write(`${dir}/operator_results.json`, snapshot.results);
    const calls = steps.filter(s => s.role === "agent" && s.usage && (s.usage.inputTokens ?? 0) > 0);
    const sum = (key: string) => calls.reduce((n, s) => n + Number((s.usage as any)?.[key] ?? 0), 0);
    const input = sum("inputTokens"), output = sum("outputTokens"), cached = sum("cachedInputTokens");
    const stats = { input_tokens: input, output_tokens: output, cached_tokens: cached, reasoning_tokens: sum("reasoningTokens"),
      llm_calls: calls.length, cost_usd: ((input - cached) * .2 + cached * .02 + output * 1.2) / 1e6,
      elapsed_seconds: (Date.now() - start) / 1000, tool_calls: steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0),
      reuse_calls: steps.flatMap(s => s.toolCalls ?? []).filter(c => c.input?.reuse).length,
      memory_steps: trace.length };
    await write(`${dir}/stats.json`, stats);
    console.log(JSON.stringify({ arm, turn: i + 1, ...stats }));
  }
} finally { await session.close(); }
