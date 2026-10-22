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
// The task card, as the doc shows it, with the files listed under it.
const TASK = [
  "You have three files: every athlete entry at the six Olympic Games from 2006 to 2016 (three Summer, three Winter), a lookup from country codes to country names, and each country's location (latitude, longitude, continent, average elevation).",
  "Question: How is a country's location related to the gold medals it wins, and is the relationship different for the Winter Games than for the Summer Games?",
  "Your report should include:",
  "- For each season, the share of gold medals won by countries in three zones: tropical (within 25° of the equator), temperate (25° to 45°), and cold (45° or more).",
  "- For each season, the share of gold medals won by each continent.",
  "- Whether average elevation shows a similar pattern.",
  "- Your conclusion in 2–3 sentences: does location matter, for which Games does it matter more, and how strongly?",
  "",
  "The files:",
  ...STUDY.files[1].map(file => datasetPath(1, file)),
].join("\n");
// Two probes of what the task leaves unsaid: team medals counted once (911 and 269 golds), and the
// golds that found no location (2 with the name fixes, 237 without them).
const FOLLOW_UPS = [
  "How did you count a gold medal for a team event, and how many gold medals did you count in total for the Summer Games and for the Winter Games?",
  "Were there any gold medals you could not place in a zone or continent? Which countries, and how many medals?",
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
// The key: cold countries took 76.6% of Winter golds and 40.2% of Summer golds; Europe leads both seasons.
const correct = /\b7[5-8](\.\d)?\s?%/.test(first) && /\b(39|4[01])(\.\d)?\s?%/.test(first) && /europe/i.test(first);
console.log(
  correct
    ? "\nPASS turn 1 matches the answer key"
    : "\nFAIL turn 1 does not match the answer key (cold: Winter 77%, Summer 40%; Europe leads both)"
);
process.exit(correct ? 0 : 1);
