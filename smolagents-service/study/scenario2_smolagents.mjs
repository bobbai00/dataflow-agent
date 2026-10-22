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

// Scenario 2 of the user study on the script agent, as a participant would do it:
// a fresh account, the three inspection files, the notebook with the planted bug
// imported into the chat, then a question about the analysis (which must change
// nothing) and the feedback naming the fix (after which the agent must rerun and
// report 1,057 floors and 630 businesses without violations). The server must run
// with --notebook-instructions @scenario-2/agent-instructions.md.
//
//   node study/scenario2_smolagents.mjs BASE_URL STUDY_DIR OUT_DIR
import { mkdirSync, writeFileSync } from "node:fs";

import { ask, chromium, lastAnswer, lastMessages, register, upload } from "../tests/e2e/browser.mjs";

const [base, studyDir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const files = ["businesses.csv", "inspections.csv", "violations.csv"];
const NOTEBOOK = "scenario2_notebook.ipynb";
const QUESTION =
  "Business 2862 shows 5 violations in per_business. Which inspection dates do those violations come from, " +
  "and what was its latest 2016 inspection date?";
const FEEDBACK =
  "The merge in `merged` joins on business_id only, so it attaches violations from every inspection a business ever had, " +
  "not just its latest 2016 one. Join on business_id and date instead, rerun what depends on it, and give me the new answers.";

const turns = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
try {
  await register(page, base, `study_s2_${Date.now().toString(36)}`);
  for (const name of files) await upload(page, `${studyDir}/scenario-2/data/${name}`, "the agent hears about it with your next message");
  const started = Date.now();
  await page.setInputFiles("input[type=file]", `${studyDir}/scenario-2/notebook/${NOTEBOOK}`);
  // The status is Markdown: its code span renders without the backticks.
  await page.getByText(`Imported ${NOTEBOOK}`).waitFor({ timeout: 300_000 });
  const importSeconds = (Date.now() - started) / 1000;
  const imported = await lastMessages(page);
  const chat = await page.locator("[role=log]").innerText();
  await page.screenshot({ path: `${out}/imported.png`, fullPage: true });
  console.log(`imported in ${importSeconds.toFixed(0)} s: ${imported.at(-1)?.replace(/\s+/g, " ")}`);
  const checks = [
    ["the notebook's question opens the chat", chat.includes("what inspectors found")],
    ["every cell ran", imported.some(text => /imported 31 cells/.test(text) && !/failed/.test(text))],
    ["the planted answer is shown", imported.some(text => /1,920/.test(text) && /410/.test(text))],
  ];
  turns.push(await ask(page, QUESTION));
  const question = await lastAnswer(page); // the whole answer; a turn keeps its first 400 characters
  await page.screenshot({ path: `${out}/question.png`, fullPage: true });
  turns.push(await ask(page, FEEDBACK));
  const feedback = await lastAnswer(page);
  await page.screenshot({ path: `${out}/feedback.png`, fullPage: true });
  const transcript = await lastMessages(page);
  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  const details = await Promise.all(runs.map(async run => (await page.request.get(`${base}/api/runs/${run.id}`)).json()));
  writeFileSync(`${out}/result.json`, JSON.stringify({ importSeconds, imported, turns, transcript, runs: details }, null, 2));
  for (const [i, turn] of turns.entries()) console.log(`turn ${i + 1} (${turn.seconds.toFixed(0)} s): ${turn.final.replace(/\s+/g, " ")}`);
  console.log("runs:", details.map(run => `${run.kind}: ${run.steps?.length ?? "?"} steps, ${run.python_execs?.length ?? "?"} code runs`).join(" | "));
  checks.push(
    ["the question was answered with dates", /2016|\d\d\/\d\d\/20\d\d|201\d-\d\d-\d\d/.test(question)],
    ["the question changed nothing", !/1,?057|\b630\b/.test(question)],
    ["the feedback led to the corrected answers", /1,?057/.test(feedback) && /\b630\b/.test(feedback)],
  );
  for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
} catch (error) {
  await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {});
  console.error("failed:", error);
  process.exit(2);
} finally {
  await browser.close();
}
