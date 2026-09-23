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
/** Run prepared LongDS turns through one dataflow session, under the official
 * protocol. Prompts arrive already built by `benchmark/longds/official_protocol.py`
 * so that every arm, script or dataflow, is given byte-identical task text; this
 * runner only drives the agent and records what it cost. */
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";
import { runAgentTurn } from "../../src/api";

/** A saved-table read in a submitted program: `at(name, task=N)` or `at(name, N)`. */
const HISTORY_REFERENCE = /\bat\(\s*[A-Za-z_]\w*\s*,\s*(?:task\s*=\s*)?\d+\s*\)/g;

const [promptsPath, outPath, arm = "react-catalog", model = "gpt-5.6-luna"] = process.argv.slice(2);
const ARMS = ["react-full", "react-catalog"];
if (!promptsPath || !outPath || !ARMS.includes(arm))
  throw new Error(`Usage: run-longds-turns.ts prompts.json output-dir ${ARMS.join("|")} [model]`);
const out = resolve(outPath);
if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
mkdirSync(out, { recursive: true });
const prompts: Array<{ turn_id: number; prompt: string }> = await Bun.file(promptsPath).json();

const settings = {
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  nativeTaskContext: arm === "react-catalog",
  nativeTaskHistory: true,
  // LongDS's own per-turn cap, as upstream's DSGym runner uses.
  maxSteps: 40,
  maxOperatorResultCharLimit: 2000,
  maxOperatorResultCellCharLimit: 2000,
  thoughtReplay: false,
  // Full history needs visible task numbers to write at(name, task=N); the
  // catalog arm replaces completed turns with its own Q/A layout.
  sessionTurns: arm === "react-full",
  versionedMode: false,
  // The task text goes before the turn's events, so every call of a turn extends
  // the previous call's prompt (a task block placed after the events is pushed
  // down by each new event, and no request is a prefix of the next). Measured on
  // trial 3: with "bottom", later calls of a turn cached 35%; with "top", they
  // reuse the whole previous prompt.
  userTaskPlacement: "top" as const,
};
const session = await nativeTestSession(settings, model);
const write = (path: string, value: unknown) => Bun.write(`${out}/${path}`, JSON.stringify(value, null, 2));
await write("config.json", {
  arm,
  model,
  protocol: "longds-official",
  settings: await session.settings(),
  service: session.baseUrl,
  engine: process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  cost_rates_usd_per_million: { input: 0.2, cached_input: 0.02, cache_write: 0.25, output: 1.2 },
  cost_source: "Repository accounting assumptions, cache-aware; infrastructure excluded; not provider invoices.",
});

const answers: unknown[] = [];
let prior = 0;
try {
  for (const [index, turn] of prompts.entries()) {
    const directory = `t${String(index + 1).padStart(2, "0")}`;
    mkdirSync(`${out}/${directory}`);
    await write(`${directory}/prompt.json`, turn);
    const start = Date.now();
    let answer = "";
    let error: string | undefined;
    try {
      const result = await runAgentTurn(session.agentId, turn.prompt, {
        baseUrl: session.baseUrl,
        timeoutMs: 1_200_000,
      });
      answer = result.finalAnswer ?? "";
    } catch (failure) {
      error = String(failure);
      await session.request(`/${session.agentId}/stop`, "POST");
    }
    await write(`${directory}/answer.json`, { answer, error });
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
        .reduce(
          (n, c) =>
            n +
            (String((c.input as any)?.edits ?? (c.input as any)?.program ?? "").match(HISTORY_REFERENCE) ?? []).length,
          0
        ),
    };
    await write(`${directory}/stats.json`, stats);
    answers.push({ turn_id: turn.turn_id, answer, error, steps: steps.length, stats });
    await write("answers.json", answers);
    console.log(JSON.stringify({ arm, model, turn: turn.turn_id, ...stats }));
  }
} finally {
  await write("answers.json", answers);
  await session.close();
}
