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

// N people use a running server at the same time, each in their own browser context:
// register, upload a CSV, ask two questions (the second leans on the first), open
// "My traces", then check over the API that another user's run is invisible to them.
//
//   node tests/e2e/concurrent_users.mjs BASE_URL CSV OUT_DIR [USERS]
import { mkdirSync, writeFileSync } from "node:fs";

import { ask, chromium, CLOCK, register, upload } from "./browser.mjs";

const [base, csv, out, users = "10"] = process.argv.slice(2);
const count = Number(users);
const stamp = Date.now().toString(36);
const QUESTIONS = [
  "How many homes are in my file, and what is the median TOTAL_VALUE? " +
    "Also plot a histogram of TOTAL_VALUE for homes under $3M.",
  "Using the same data, which CITY has the highest median TOTAL_VALUE? Give the name and the value.",
];
mkdirSync(out, { recursive: true });

async function person(browser, index) {
  const username = `e2e_${stamp}_${index}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const result = { username, errors: [] };
  const step = (what) => console.log(`${new Date().toISOString().slice(11, 19)} ${username}: ${what}`);
  try {
    await register(page, base, username);
    await upload(page, csv, "the agent hears about it with your next message");

    result.answers = [];
    for (const question of QUESTIONS) {
      result.answers.push(await ask(page, question));
      step(`answered in ${result.answers.at(-1).seconds.toFixed(0)} s`);
    }
    result.charts = await page.locator("[role=log] img").evaluateAll(
      (images) => images.filter((image) => image.complete && image.naturalWidth > 0).length);
    if (index === 0) await page.screenshot({ path: `${out}/chat.png` });

    step("opening My traces");
    await page.getByRole("tab", { name: "My traces" }).click();
    await page.getByRole("button", { name: "Refresh" }).click();
    // Dataframe cells are found by what they show; gradio also renders hidden sizing cells.
    const shown = (table, pattern) => page.locator(table).getByText(pattern).filter({ visible: true });
    const runCells = shown("#runs-table", CLOCK);
    await runCells.nth(QUESTIONS.length - 1).waitFor({ timeout: 15_000 });
    result.tracesShown = await runCells.count();
    await shown("#runs-table", QUESTIONS[0].slice(0, 30)).first().click();
    const stepCells = shown("#steps-table", CLOCK);
    await stepCells.first().waitFor({ timeout: 15_000 });
    result.stepsShown = await stepCells.count();
    result.spansShown = await shown("#spans-table", /^(LLM|Python)$/).count();
    await stepCells.first().click();
    await page.locator("#step-context").getByText("New task").first().waitFor({ timeout: 15_000 });
    result.contextShown = true;
    if (index === 0) await page.screenshot({ path: `${out}/traces.png` });

    const runs = await (await page.request.get(`${base}/api/runs`)).json();
    result.runIds = runs.map((run) => run.id);
    step("done");
    result.page = page;
    result.context = context;
  } catch (error) {
    result.errors.push(String(error).slice(0, 500));
    await page.screenshot({ path: `${out}/failed-${index}.png` }).catch(() => {});
  }
  return result;
}

const browser = await chromium.launch();
const started = Date.now();
const people = await Promise.all(Array.from({ length: count }, (_, i) => person(browser, i)));
const wall = (Date.now() - started) / 1000;

// Isolation, seen from the browser: each person asks for the next person's run.
for (const [i, me] of people.entries()) {
  const other = people[(i + 1) % count];
  if (!me.page || !other.runIds?.length) continue;
  me.otherRunStatus = (await me.page.request.get(`${base}/api/runs/${other.runIds[0]}`)).status();
  me.ownRunStatus = (await me.page.request.get(`${base}/api/runs/${me.runIds[0]}`)).status();
}
await browser.close();

const report = {
  base, users: count, stamp, wallSeconds: wall,
  people: people.map(({ page, context, ...rest }) => rest),
};
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
const failed = report.people.filter((p) => p.errors.length || p.runIds?.length !== QUESTIONS.length
  || (count > 1 && p.otherRunStatus !== 404)
  || p.ownRunStatus !== 200 || p.tracesShown !== QUESTIONS.length || !(p.stepsShown > 0) || !(p.spansShown > 0)
  || !p.contextShown || !(p.charts > 0));
for (const p of report.people) {
  console.log(`${p.username}: runs ${p.runIds?.length ?? 0}, charts ${p.charts ?? 0}, traces ${p.tracesShown ?? 0}, `
    + `steps ${p.stepsShown ?? 0}, spans ${p.spansShown ?? 0}, context ${p.contextShown ? "yes" : "no"}, `
    + `other-run ${p.otherRunStatus}, `
    + `${(p.answers ?? []).map((a) => `${a.seconds.toFixed(0)}s`).join(" + ")}${p.errors.length ? "  ERROR " + p.errors[0] : ""}`);
}
console.log(`${count} users, ${wall.toFixed(0)} s wall; ${failed.length} failed`);
console.log(`stamp=${stamp}`);
process.exit(failed.length ? 1 : 0);
