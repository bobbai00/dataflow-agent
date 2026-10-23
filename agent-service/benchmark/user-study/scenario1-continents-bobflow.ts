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
 * A one-question Scenario 1 on BobFlow: the three continents with the most
 * golds at the Winter Games and at the Summer Games, 2008–2014. Prints the
 * answer, how long it took, the dataflow the agent built, and the check
 * against the key; exits 1 when the answer misses it. The workflow stays
 * for inspection.
 *
 *   AGENT_BASE=http://localhost:3002 PROBE_MODEL=claude-haiku-4.5 bun run benchmark/user-study/scenario1-continents-bobflow.ts
 */
import { login } from "../../src/api";
import { datasetPath, STUDY, studyLogin } from "./study";
import { createStudyAgent, studyWorkflowUrl } from "./bobflow";

const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4.5";
const INTRO =
  "You have three files: every athlete entry at the six Olympic Games from 2006 to 2016, a lookup from country codes to country names, and each country's location (latitude, longitude, continent, elevation).";
export const QUESTION =
  "Which three continents won the most gold medals at the Winter Games, and which three at the Summer Games, between 2008 and 2014? Give the number of gold medals for each.";
const TASK = [
  INTRO,
  `Question: ${QUESTION}`,
  "",
  "The files:",
  ...STUDY.files[1].map(file => datasetPath(1, file)),
].join("\n");

/**
 * The key (team golds counted once, codes and names both joined, the Games of 2008–2014):
 * Winter Europe 123, North America 42, Asia 18; Summer Europe 258, Asia 169, North America 112.
 * The hints name the shortcut behind a wrong number.
 */
export function checkContinents(answer: string): { pass: boolean; missing: string[]; hints: string[] } {
  const expected: Array<[string, RegExp]> = [
    ["Europe", /europe/i],
    ["North America", /north america/i],
    ["Asia", /asia/i],
    ["Winter Europe 123", /\b123\b/],
    ["Winter North America 42", /\b42\b/],
    ["Winter Asia 18", /\b18\b/],
    ["Summer Europe 258", /\b258\b/],
    ["Summer Asia 169", /\b169\b/],
    ["Summer North America 112", /\b112\b/],
  ];
  const missing = expected.filter(([, pattern]) => !pattern.test(answer)).map(([name]) => name);
  const hints: string[] = [];
  if (/\b(181|392)\b/.test(answer)) hints.push("counted all six Games instead of 2008–2014");
  if (/\b(79|201)\b/.test(answer)) hints.push("joined by ISO3 code only, losing Germany and 23 more countries");
  if (/\b(200|148|569|336)\b/.test(answer)) hints.push("counted athlete rows, not medals");
  return { pass: missing.length === 0, missing, hints };
}

if (import.meta.main) {
  const token = await studyLogin(login);
  const { api, agent, wid } = await createStudyAgent(token, {
    name: `S1 continents ${new Date().toISOString().slice(0, 16)}`,
    model: MODEL,
  });
  console.log(`agent ${agent.id} (${MODEL}) on workflow ${wid}: ${studyWorkflowUrl(wid)}`);
  const started = Date.now();
  const reply = await api.post(`/${agent.id}/message`, { content: TASK });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const answer: string = reply.answer ?? "";
  console.log(
    `\nanswer (${seconds} s, ${reply.steps} model steps): ${(answer || JSON.stringify(reply)).replace(/\s+/g, " ")}`
  );
  const workflow = await api.get(`/${agent.id}/workflow`);
  const results = (await api.get(`/${agent.id}/operator-results`)).results ?? {};
  const operators = workflow.workflow?.operators ?? [];
  for (const op of operators) {
    const r = results[op.operatorID];
    const rows = r ? (r.error ? "FAILED" : `${r.totalRowCount ?? r.outputTuples} rows`) : "no result";
    console.log(`  ${op.operatorID} [${op.nativeOp?.type}] ${rows}${op.nativeOp?.doc ? ` — ${op.nativeOp.doc}` : ""}`);
  }
  const types = operators.reduce((acc: Record<string, number>, op: any) => {
    const type = op.nativeOp?.type ?? op.operatorType;
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n${operators.length} operators: ${Object.entries(types)
      .map(([type, count]) => `${type} ${count}`)
      .join(", ")}`
  );
  const check = checkContinents(answer);
  console.log(check.pass ? "PASS the answer matches the key" : `FAIL the answer misses: ${check.missing.join(", ")}`);
  for (const hint of check.hints) console.log(`HINT ${hint}`);
  process.exit(check.pass ? 0 : 1);
}
