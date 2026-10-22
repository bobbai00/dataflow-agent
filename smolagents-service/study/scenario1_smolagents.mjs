// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Scenario 1 of the user study on the script agent, as a participant would do it:
// a fresh account, the four restaurant files, the task card's question, then two
// follow-ups (a question about a step, and a change). Prints what the agent
// answered and how long each turn took; exits 1 when the answer is not the key's.
//
//   node study/scenario1_smolagents.mjs BASE_URL STUDY_DIR OUT_DIR
import { mkdirSync, writeFileSync } from "node:fs";

import { ask, chromium, lastMessages, register, upload } from "../tests/e2e/browser.mjs";

const [base, studyDir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const files = ["rating_final.csv", "userprofile.csv", "geoplaces2.csv", "chefmozcuisine.csv"];
const TASK = [
  "You have four files from a survey of restaurants in Mexico: the restaurants, their cuisines, the diners, and the ratings diners gave.",
  "Question: Among low- and medium-priced restaurants, which cuisine has the biggest gap in average overall rating between low-budget diners and medium/high-budget diners?",
  "- Only compare cuisines with at least 5 ratings from each group.",
  "- Report the cuisine, each group's average rating, and how many ratings each average is based on.",
].join("\n");
const FOLLOW_UPS = [
  "Did you count a rating of 0 as a real rating or as missing? And what did you do with diners whose budget is '?'?",
  "Please redo it using the food rating instead of the overall rating, and tell me whether the answer changes.",
];

const turns = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
try {
  await register(page, base, `study_s1_${Date.now().toString(36)}`);
  for (const name of files) await upload(page, `${studyDir}/scenario-1/${name}`, "the agent hears about it with your next message");
  turns.push(await ask(page, TASK));
  await page.screenshot({ path: `${out}/turn1.png`, fullPage: true });
  for (const question of FOLLOW_UPS) turns.push(await ask(page, question));
  await page.screenshot({ path: `${out}/final.png`, fullPage: true });
  const transcript = await lastMessages(page);
  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  const details = await Promise.all(runs.map(async run => (await page.request.get(`${base}/api/runs/${run.id}`)).json()));
  writeFileSync(`${out}/result.json`, JSON.stringify({ turns, transcript, runs: details }, null, 2));
  for (const [i, turn] of turns.entries()) console.log(`turn ${i + 1} (${turn.seconds.toFixed(0)} s): ${turn.final.replace(/\s+/g, " ")}`);
  const steps = details.map(run => `${run.steps?.length ?? "?"} steps, ${run.python_execs?.length ?? "?"} code runs`);
  console.log("runs:", steps.join(" | "));
  const answer = turns[0].final;
  const correct = /pizzeria/i.test(answer) && /0\.94\d?\b/.test(answer) && /1\.1[67]\d?\b/.test(answer) && /\b17\b/.test(answer) && /\b24\b/.test(answer);
  console.log(correct ? "PASS turn 1 matches the answer key" : "FAIL turn 1 does not match the answer key (Pizzeria, 0.94 (17), 1.17 (24))");
  process.exit(correct ? 0 : 1);
} catch (error) {
  await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {});
  console.error("failed:", error);
  process.exit(2);
} finally {
  await browser.close();
}
