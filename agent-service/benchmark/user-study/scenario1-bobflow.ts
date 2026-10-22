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
 * Scenario 1 of the user study on BobFlow, as a participant would do it: a new
 * workflow and agent, the task card's question with the four files, then two
 * follow-ups (a question about a step, and a change). Prints each answer and
 * how long it took, the dataflow the agent built, and exits 1 when the first
 * answer is not the key's. The workflow stays for inspection.
 *
 *   AGENT_BASE=http://localhost:3002 PROBE_MODEL=claude-haiku-5.5 bun run benchmark/user-study/scenario1-bobflow.ts
 */
import { login } from "../../src/api";
import { datasetPath, STUDY, studyLogin } from "./study";
import { createStudyAgent, studyWorkflowUrl } from "./bobflow";

const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";
const TASK = [
  "You have four files from a survey of restaurants in Mexico: the restaurants, their cuisines, the diners, and the ratings diners gave.",
  "Question: Among low- and medium-priced restaurants, which cuisine has the biggest gap in average overall rating between low-budget diners and medium/high-budget diners?",
  "- Only compare cuisines with at least 5 ratings from each group.",
  "- Report the cuisine, each group's average rating, and how many ratings each average is based on.",
  "",
  "The files:",
  ...STUDY.files[1].map(file => datasetPath(1, file)),
].join("\n");
const FOLLOW_UPS = [
  "Did you count a rating of 0 as a real rating or as missing? And what did you do with diners whose budget is '?'?",
  "Please redo it using the food rating instead of the overall rating, and tell me whether the answer changes.",
];

const token = await studyLogin(login);
const { api, agent, wid } = await createStudyAgent(token, {
  name: `S1 test ${new Date().toISOString().slice(0, 16)}`,
  model: MODEL,
});
console.log(`agent ${agent.id} on workflow ${wid}: ${studyWorkflowUrl(wid)}`);

const answers: string[] = [];
for (const [i, content] of [TASK, ...FOLLOW_UPS].entries()) {
  const started = Date.now();
  const reply = await api.post(`/${agent.id}/message`, { content });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  answers.push(reply.answer ?? "");
  console.log(
    `\nturn ${i + 1} (${seconds} s, ${reply.steps} model steps): ${(reply.answer ?? JSON.stringify(reply)).replace(/\s+/g, " ").slice(0, 600)}`
  );
  const workflow = await api.get(`/${agent.id}/workflow`);
  const results = (await api.get(`/${agent.id}/operator-results`)).results ?? {};
  for (const op of workflow.workflow?.operators ?? []) {
    const r = results[op.operatorID];
    const rows = r ? (r.error ? "FAILED" : `${r.totalRowCount ?? r.outputTuples} rows`) : "no result";
    console.log(`  ${op.operatorID} [${op.nativeOp?.type}] ${rows}${op.nativeOp?.doc ? ` — ${op.nativeOp.doc}` : ""}`);
  }
}
const first = answers[0];
const correct =
  /pizzeria/i.test(first) &&
  /0\.94\d?\b/.test(first) &&
  /1\.1[67]\d?\b/.test(first) &&
  /\b17\b/.test(first) &&
  /\b24\b/.test(first);
console.log(
  correct
    ? "\nPASS turn 1 matches the answer key"
    : "\nFAIL turn 1 does not match the answer key (Pizzeria, 0.94 (17), 1.17 (24))"
);
process.exit(correct ? 0 : 1);
