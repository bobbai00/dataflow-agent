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

/**
 * Scenario 2 of the user study on BobFlow: a workflow whose agent has already
 * answered the inspection question with the planted bug. The agent's analysis
 * (scenario-2/dataflow/bobflow_steps.json, made by make_bobflow_steps.py) is
 * replayed through the agent's debug channel, so every operator is built and
 * executed for real and the chat shows the question, the agent's steps and
 * its reply. The agent gets the study's instructions for this scenario.
 *
 *   AGENT_BASE=http://localhost:3002 PROBE_MODEL=claude-sonnet-5.5 \
 *     bun run benchmark/user-study/scenario2-bobflow.ts "P03"
 *
 * Prints the workflow to open for the participant, and checks the planted
 * answers (attach_violations 21,434 rows; 1,920 floors; 410 without violations).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { login } from "../../src/api";
import { STUDY, studyLogin } from "./study";
import { createStudyAgent, studyWorkflowUrl } from "./bobflow";

const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-5.5";
const label = process.argv[2] ?? `test ${new Date().toISOString().slice(0, 16)}`;

/** The doc's instruction for both agents in this scenario. */
// The same rules go to the script agent (`--notebook-instructions @scenario-2/agent-instructions.md`).
export const SCENARIO_2_INSTRUCTIONS =
  "This session reviews an analysis you already made. " +
  readFileSync(join(STUDY.dir, "scenario-2", "agent-instructions.md"), "utf8")
    .trim()
    .replace(/\s*\n\s*/g, " ");

interface Spec {
  question: string;
  steps: Array<{ thought: string; python: string; statements: string }>;
  reply: string;
}

/** Python's repr of a string: single quotes, backslash escapes. */
function pyRepr(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
}

/** A debug input: the step's reasoning, then its dataflow call. */
function functionCall(step: Spec["steps"][number]): string {
  const args = `{'python': ${pyRepr(step.python)}, 'statements': ${pyRepr(step.statements)}}`;
  return `${step.thought}\nFunction(name='dataflow', arguments=${pyRepr(args)})`;
}

const spec: Spec = JSON.parse(readFileSync(join(STUDY.dir, "scenario-2/dataflow/bobflow_steps.json"), "utf8"));
const token = await studyLogin(login);
const { api, agent, wid } = await createStudyAgent(token, {
  name: `Scenario 2 – ${label}`,
  model: MODEL,
  settings: { instructions: SCENARIO_2_INSTRUCTIONS },
});
console.log(`agent ${agent.id} on workflow ${wid}`);

// The debug channel is the agent's WebSocket: each input is applied when the "complete" frame arrives.
const ws = new WebSocket(`${STUDY.agentBase.replace(/^http/, "ws")}/api/agents/${agent.id}/react`);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = event => reject(new Error(`websocket failed: ${String(event)}`));
});
const frames: any[] = [];
let settle: ((frame: any) => void) | undefined;
ws.onmessage = event => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if ((frame.type === "complete" || frame.type === "error") && settle) settle(frame);
};
async function debug(content: string): Promise<void> {
  const done = new Promise<any>(resolve => (settle = resolve));
  ws.send(JSON.stringify({ type: "debug", content }));
  const frame = await done;
  settle = undefined;
  if (frame.type === "error") throw new Error(`debug input failed: ${frame.error}`);
}

const started = Date.now();
await debug(spec.question);
for (const [i, step] of spec.steps.entries()) {
  await debug(functionCall(step));
  const steps = await api.get(`/${agent.id}/react-steps`);
  const last = steps.steps.at(-1);
  const result = last?.toolResults?.[0]?.output;
  const failed = (result?.actions ?? []).filter((item: any) => item.status === "error");
  console.log(
    `step ${i + 1}/${spec.steps.length}: ${step.thought.slice(0, 70)} → ${result?.status ?? "?"}${failed.length ? ` FAILED: ${JSON.stringify(failed.map((item: any) => item.output)).slice(0, 400)}` : ""}`
  );
}
await debug(`Reply(text=${pyRepr(spec.reply)})`);
ws.close();
console.log(`replayed in ${((Date.now() - started) / 1000).toFixed(0)} s`);

// The planted analysis, as the participant finds it.
const results = (await api.get(`/${agent.id}/operator-results`)).results ?? {};
const rows = (id: string) => results[id]?.totalRowCount ?? results[id]?.outputTuples;
const answer = results["answer"]?.sampleRecords ?? [];
const floors = answer.find((row: any) => String(row.answer).startsWith("Unclean or degraded floors"))?.count;
const none = answer.find((row: any) => String(row.question).startsWith("businesses with no"))?.count;
const checks: Array<[string, boolean, string]> = [
  [
    "every operator has a result",
    Object.keys(results).length === 28 && !Object.values(results).some((r: any) => r.error),
    `${Object.keys(results).length} results, ${Object.values(results).filter((r: any) => r.error).length} failed`,
  ],
  [
    "attach_violations has 21,434 rows (the bug)",
    rows("attach_violations") === 21434,
    String(rows("attach_violations")),
  ],
  ["the top violation counts 1,920", floors === 1920, String(floors)],
  ["410 businesses with no violations", none === 410, String(none)],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
console.log(`\nOpen for the participant: ${studyWorkflowUrl(wid)}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
