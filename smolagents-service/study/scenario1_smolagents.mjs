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
// a fresh account, the three Olympic files, the task card's question, then two
// follow-ups probing what the task left unsaid. Prints what the agent answered and
// how long each turn took; exits 1 when the findings are not the key's.
//
//   node study/scenario1_smolagents.mjs BASE_URL STUDY_DIR OUT_DIR
import { mkdirSync, writeFileSync } from "node:fs";

import { ask, chromium, lastAnswer, lastMessages, register, upload } from "../tests/e2e/browser.mjs";

const [base, studyDir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const files = ["athlete_events_2006_2016.csv", "noc_regions.csv", "country_geo.csv"];
const TASK = [
  "You have three files: every athlete entry at the six Olympic Games from 2006 to 2016 (three Summer, three Winter), a lookup from country codes to country names, and each country's location (latitude, longitude, continent, average elevation).",
  "Question: How is a country's location related to the gold medals it wins, and is the relationship different for the Winter Games than for the Summer Games?",
  "Your report should include:",
  "- For each season, the share of gold medals won by countries in three zones: tropical (within 25° of the equator), temperate (25° to 45°), and cold (45° or more).",
  "- For each season, the share of gold medals won by each continent.",
  "- Whether average elevation shows a similar pattern.",
  "- Your conclusion in 2–3 sentences: does location matter, for which Games does it matter more, and how strongly?",
].join("\n");
// Two probes of what the task leaves unsaid: team medals counted once (911 and 269 golds), and the
// golds that found no location (2 with the name fixes, 237 without them).
const FOLLOW_UPS = [
  "How did you count a gold medal for a team event, and how many gold medals did you count in total for the Summer Games and for the Winter Games?",
  "Were there any gold medals you could not place in a zone or continent? Which countries, and how many medals?",
];

const turns = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
try {
  await register(page, base, `study_s1_${Date.now().toString(36)}`);
  for (const name of files) await upload(page, `${studyDir}/scenario-1/${name}`, "the agent hears about it with your next message");
  turns.push({ ...(await ask(page, TASK)), answer: await lastAnswer(page) });
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
  // The key: cold countries took 76.6% of Winter golds and 40.2% of Summer golds; Europe leads both seasons.
  const correct = /\b7[5-8](\.\d)?\s?%/.test(turns[0].answer) && /\b(39|4[01])(\.\d)?\s?%/.test(turns[0].answer) && /europe/i.test(turns[0].answer);
  console.log(correct ? "PASS turn 1 matches the answer key" : "FAIL turn 1 does not match the answer key (cold: Winter 77%, Summer 40%; Europe leads both)");
  process.exit(correct ? 0 : 1);
} catch (error) {
  await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {});
  console.error("failed:", error);
  process.exit(2);
} finally {
  await browser.close();
}
