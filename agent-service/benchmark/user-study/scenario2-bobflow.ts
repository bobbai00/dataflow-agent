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
 * answered the scenario's question with the planted bug. The agent's analysis
 * (scenario-2/dataflow/bobflow_steps.json, made by make_bobflow_steps.py) is
 * replayed through the agent's debug channel, so every operator is built and
 * executed for real and the chat shows the question, the agent's steps and
 * its reply. The agent gets the study's instructions for this scenario.
 *
 *   AGENT_BASE=http://localhost:3002 PROBE_MODEL=claude-haiku-5.5 \
 *     bun run benchmark/user-study/scenario2-bobflow.ts "P03"
 *
 * Prints the workflow to open for the participant, and checks the planted
 * numbers the JSON's `bug` block names (the rows of one operator, and the first
 * row of the answer).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { login } from "../../src/api";
import { STUDY, studyLogin } from "./study";
import { createStudyAgent, studyWorkflowUrl } from "./bobflow";

const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";
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
  /** The planted bug: which operator, and the numbers that show it (see make_bobflow_steps.py). */
  bug: {
    operator: string;
    planted_numbers: { [operator: string]: number | [string, number] };
    fixed_numbers: { [operator: string]: number | [string, number] };
  };
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

// The planted analysis, as the participant finds it: every operator ran, and the
// numbers the bug block names hold (`<operator>_rows`: that operator's row count;
// `top1`: the first row of the answer, its first text and first number).
const results = (await api.get(`/${agent.id}/operator-results`)).results ?? {};
const rows = (id: string) => results[id]?.totalRowCount ?? results[id]?.outputTuples;
const operatorCount = spec.steps.flatMap(step => step.statements.split("\n")).filter(line => /^set /.test(line)).length;
const answerOperator = [...spec.steps.at(-1)!.statements.matchAll(/^set (\w+):/gm)].at(-1)?.[1] ?? "";
const top = results[answerOperator]?.sampleRecords?.[0] ?? {};
const topText = Object.values(top).find(value => typeof value === "string");
const topNumber = Object.values(top).find(value => typeof value === "number");
const checks: Array<[string, boolean, string]> = [
  [
    "every operator has a result",
    Object.keys(results).length === operatorCount && !Object.values(results).some((r: any) => r.error),
    `${Object.keys(results).length} of ${operatorCount} results, ${Object.values(results).filter((r: any) => r.error).length} failed`,
  ],
];
for (const [key, expected] of Object.entries(spec.bug.planted_numbers)) {
  if (Array.isArray(expected)) {
    const [text, number] = expected;
    checks.push([
      `${answerOperator} starts with ${text} ${number} (the bug)`,
      topText === text && typeof topNumber === "number" && Math.round(topNumber) === number,
      `${String(topText)} ${String(topNumber)}`,
    ]);
  } else {
    const operator = key.replace(/_rows$/, "");
    checks.push([
      `${operator} has ${expected.toLocaleString()} rows (the bug)`,
      rows(operator) === expected,
      String(rows(operator)),
    ]);
  }
}
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
// With ARCHIVE_OUT, the analysis also goes to a file the chat's Import button takes into a fresh agent.
if (process.env.ARCHIVE_OUT) {
  const archive = await api.get(`/${agent.id}/archive`);
  const text = JSON.stringify(archive);
  writeFileSync(process.env.ARCHIVE_OUT, text);
  console.log(`archive: ${process.env.ARCHIVE_OUT} (${(text.length / 1e6).toFixed(1)} MB, ${archive.stepCount} steps)`);
}
console.log(`\nOpen for the participant: ${studyWorkflowUrl(wid)}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
