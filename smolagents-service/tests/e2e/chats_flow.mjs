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

// Someone with a seeded chat (when the server seeds) signs in to a new, empty
// chat with the seeded one listed, and moves between chats. A notebook and its
// two data files are dropped in one drag; the agent answers from the notebook's
// variables; a scratch chat sets its own; then the person goes back to each chat,
// whose history and variables (and only its own) are back. A reload stays on the
// chat in use; opening the app afresh starts a new chat again.
//
//   node tests/e2e/chats_flow.mjs BASE_URL OUT_DIR
import { mkdirSync, writeFileSync } from "node:fs";

import { ask, chromium, drop, register, runCode } from "./browser.mjs";

const [base, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/sales.csv`, "region,amount\nWest,1200\nWest,800\nEast,1000\nEast,300\nNorth,700\n");
writeFileSync(`${out}/managers.csv`, "region,manager\nWest,Ada\nEast,Grace\nNorth,Linus\n");
const cell = (type, text) => ({ cell_type: type, source: text.split(/(?<=\n)/) });
writeFileSync(`${out}/region_review.ipynb`, JSON.stringify({ cells: [
  cell("markdown", "# Region review\n\nWhich region sells the most, and who runs it?"),
  cell("code", "import pandas as pd\nsales = pd.read_csv('sales.csv')\nmanagers = pd.read_csv('managers.csv')"),
  cell("code", "by_region = sales.groupby('region')['amount'].sum().sort_values(ascending=False)\nby_region"),
  cell("markdown", "West sells the most: 2,000."),
] }));

const checks = {};
const chats = async (page) => (await page.request.get(`${base}/api/chats`)).json();
const selected = async (page) => (await page.locator("#chat-list label.selected").allInnerTexts()).join("|");
const shown = async (page) => page.locator("[role=log]").innerText();
const empty = async (page) => (await page.locator("[role=log] .message").count()) === 0;
async function open(page, title, waitFor) {
  await page.locator("#chat-list label", { hasText: title }).click();
  await page.locator("[role=log]").getByText(waitFor).first().waitFor({ timeout: 30_000 });
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
try {
  await register(page, base, `chats_${Date.now().toString(36)}`);
  for (let tries = 0; tries < 240; tries++) {  // the account's seed, when the server seeds new accounts
    const { status } = await (await page.request.get(`${base}/api/seed`)).json();
    if (["done", "failed", "disabled"].includes(status)) break;
    await page.waitForTimeout(1000);
  }
  const seeded = (await chats(page))[0];
  if (seeded) {
    await page.locator("#chat-list label", { hasText: seeded.title }).waitFor({ timeout: 240_000 });
    checks.seedListed = true;
  }
  await page.getByText("Signed in as").waitFor({ timeout: 240_000 });
  checks.opensOnANewChat = (await selected(page)) === "" && await empty(page) && !page.url().includes("chat=");
  await page.screenshot({ path: `${out}/1-opened.png` });

  await drop(page, [`${out}/region_review.ipynb`, `${out}/sales.csv`, `${out}/managers.csv`],
    "Imported region_review.ipynb");
  checks.dropStatus = await page.locator("#upload-status").innerText();
  checks.dropAddedAll = checks.dropStatus.includes("Added sales.csv, managers.csv");
  checks.importedChatSelected = (await selected(page)).startsWith("📓 region_review.ipynb");
  const answer = await ask(page, "Using the notebook's tables, who manages the region that sells the most? "
    + "Name the manager and the total.");
  checks.answer = answer.final;
  checks.answerRight = /Ada/.test(answer.final) && /2,?000/.test(answer.final);

  await page.getByRole("button", { name: "＋ New chat" }).click();
  await page.waitForFunction(() => !document.querySelector("[role=log] .message"));
  checks.scratchRan = (await runCode(page, "scratch = 41\n'by_region' in globals()")).includes("→ False");
  checks.scratchChatListed = (await selected(page)).startsWith("▶ your code");
  await page.screenshot({ path: `${out}/2-three-chats.png` });

  await open(page, "📓 region_review.ipynb", "region_review.ipynb");
  const notebookChat = await shown(page);
  checks.notebookChatBack = notebookChat.includes("This chat is back from your trace") && notebookChat.includes("Ada")
    && !notebookChat.includes("scratch = 41");
  checks.notebookVariablesBack = (await runCode(page, "by_region.idxmax(), 'scratch' in globals()"))
    .includes("→ ('West', False)");
  await page.screenshot({ path: `${out}/3-back-on-the-notebook.png` });

  await open(page, "▶ your code", "Ran your code");
  checks.scratchVariablesBack = (await runCode(page, "scratch + 1")).includes("→ 42");

  if (seeded) {
    await open(page, seeded.title, seeded.title.replace(/^📓 /, ""));
    checks.seedVariablesBack = (await runCode(page, "'listings' in globals(), 'by_region' in globals()"))
      .includes("→ (True, False)");
  }
  const last = seeded ? seeded.title : "▶ your code";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[role=log]").getByText("from your trace").first().waitFor({ timeout: 60_000 });
  checks.reloadStaysOnTheChat = (await selected(page)).startsWith(last) && page.url().includes("chat=");
  await page.screenshot({ path: `${out}/4-reloaded.png` });
  await page.goto(`${base}/app/`);
  await page.locator("#chat-list label", { hasText: last }).waitFor({ timeout: 60_000 });
  checks.freshVisitOpensANewChat = (await selected(page)) === "" && await empty(page);

  const listed = await chats(page);
  checks.chats = listed.map((chat) => `${chat.title} (${chat.runs})`);
  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  checks.everyRunInAListedChat = runs.every((run) => listed.some((chat) => chat.id === run.chat_id));
} catch (error) {
  checks.error = String(error).slice(0, 500);
  await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {});
}
await browser.close();

writeFileSync(`${out}/report.json`, JSON.stringify(checks, null, 1));
console.log(JSON.stringify(checks, null, 1));
const passed = !checks.error && checks.opensOnANewChat && checks.dropAddedAll && checks.importedChatSelected
  && checks.answerRight && checks.scratchRan && checks.scratchChatListed && checks.notebookChatBack
  && checks.notebookVariablesBack && checks.scratchVariablesBack && checks.reloadStaysOnTheChat
  && checks.freshVisitOpensANewChat && checks.everyRunInAListedChat
  && checks.chats.length === (checks.seedListed ? 3 : 2) && (!checks.seedListed || checks.seedVariablesBack);
console.log(passed ? "PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
