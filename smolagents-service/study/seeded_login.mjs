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

// What a seeded participant sees on the script agent: sign in, and the chat opens
// on the imported notebook; ask the scenario's question; reload, and the whole
// conversation is still there. Prints what it finds and saves screenshots.
//
//   node study/seeded_login.mjs BASE_URL USERNAME PASSWORD OUT_DIR [QUESTION]
import { mkdirSync } from "node:fs";

import { ask, chromium, lastAnswer } from "../tests/e2e/browser.mjs";

const [base, username, password, out, question] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const QUESTION =
  question ?? "Why does the analysis contain no listing above $999?";

async function login(page) {
  await page.goto(`${base}/login`);
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

/** Everything the chat shows, every row (lastMessages reads only the newest row). */
async function chatText(page) {
  await page.waitForTimeout(1500);
  return page.locator("[role=log]").innerText();
}

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 1100 } })
).newPage();
try {
  await login(page);
  // The chat shows the seeded notebook without any upload or import.
  await page.waitForSelector("text=from your trace", { timeout: 240_000 });
  let text = await chatText(page);
  console.log(
    `on login: notebook shown ${/📓/.test(text)}; cells shown ${(text.match(/Ran Python · step/g) ?? []).length}; answer shown ${/Marina/.test(text)}`,
  );
  await page.screenshot({ path: `${out}/login.png`, fullPage: true });
  const turn = {
    ...(await ask(page, QUESTION)),
    answer: await lastAnswer(page),
  };
  console.log(
    `question (${turn.seconds.toFixed(0)} s): ${turn.answer.replace(/\s+/g, " ").slice(0, 500)}`,
  );
  await page.screenshot({ path: `${out}/answered.png`, fullPage: true });
  // A reload continues from the trace: the notebook, the question and the answer are all back.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=from your trace", { timeout: 120_000 });
  text = await chatText(page);
  console.log(
    `after reload: notebook shown ${/📓/.test(text)}; question shown ${text.includes(QUESTION.slice(0, 30))}; answer shown ${text.includes(turn.answer.slice(0, 40))}`,
  );
  await page.screenshot({ path: `${out}/reloaded.png`, fullPage: true });
} catch (error) {
  await page
    .screenshot({ path: `${out}/failed.png`, fullPage: true })
    .catch(() => {});
  console.error("failed:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
