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

// Someone imports a notebook: first without its data (it must be refused, naming the
// file), then with it. The notebook's helper function reads globals a later cell sets,
// and the agent is asked to reuse that function with other settings, so the cells and
// the agent must share one namespace, as a Jupyter kernel's cells do.
//
//   node tests/e2e/notebook_flow.mjs BASE_URL OUT_DIR
import { mkdirSync, writeFileSync } from "node:fs";

import { ask, chromium, lastMessages, register, upload } from "./browser.mjs";

const [base, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const csv = `${out}/sales.csv`;
writeFileSync(csv, `region,product,amount
West,Laptop,1200
West,Phone,800
East,Laptop,1000
East,Tablet,300
North,Phone,700
North,Tablet,450
South,Monitor,200
`);
const notebook = `${out}/sales_review.ipynb`;
const cell = (type, text) => ({ cell_type: type, source: text.split(/(?<=\n)/) });
writeFileSync(notebook, JSON.stringify({ cells: [
  cell("markdown", "# Sales review\n\nWhich regions sell the most?"),
  cell("code", "%matplotlib inline\nimport pandas as pd\n\ndef top(frame):\n" +
    "    return frame.groupby(BY)['amount'].sum().sort_values(ascending=False).head(N)\n"),
  cell("markdown", "Load the sales and pick what to rank."),
  cell("code", "sales = pd.read_csv('sales.csv')\nBY, N = 'region', 2"),
  cell("code", "top(sales)"),
  cell("markdown", "West and East sell the most: 2,000 and 1,300."),
] }));
const QUESTION = "Reuse your top() function from the notebook to rank the top 3 products instead of regions. " +
  "List them with their totals.";

const checks = {};
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
try {
  await register(page, base, `notebook_${Date.now().toString(36)}`);
  await upload(page, notebook, "did not import it");
  checks.refusedWithoutData = await page.getByText("it reads sales.csv, which is not in your files").isVisible();
  checks.nothingRan = (await page.locator("[role=log] .message").count()) === 0;

  await upload(page, csv, "the agent hears about it with your next message");
  await upload(page, notebook, "Imported sales_review.ipynb");
  const imported = (await lastMessages(page)).join("\n");
  checks.allCellsRan = imported.includes("imported 3 cells") && !imported.includes("failed");

  const answer = await ask(page, QUESTION);
  checks.answer = answer.final;
  const said = answer.final.replace(/,/g, "");
  checks.answerRight = ["Laptop", "Phone", "Tablet"].every((p) => said.includes(p))
    && ["2200", "1500", "750"].every((n) => said.includes(n));
  await page.screenshot({ path: `${out}/chat.png`, fullPage: true });

  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  const details = await Promise.all(runs.map(async (run) => (await page.request.get(`${base}/api/runs/${run.id}`)).json()));
  checks.runKinds = details.map((run) => `${run.kind}:${run.status}`).sort();
  const lastCell = details.find((run) => run.kind === "notebook").python_execs.at(-1).output ?? "";  // folded in the chat
  checks.cellOutput = /West\s+2000/.test(lastCell) && /East\s+1300/.test(lastCell);
  const agentRun = details.find((run) => run.kind === "agent");
  checks.agentCalledTop = agentRun.python_execs.some((execution) => /\btop\(/.test(execution.code));
  checks.agentErrors = agentRun.python_execs.map((execution) => execution.error).filter(Boolean);
  checks.workerPids = [...new Set(details.flatMap((run) => run.python_execs.map((execution) => execution.worker_pid)))];
} catch (error) {
  checks.error = String(error).slice(0, 500);
  await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {});
}
await browser.close();

writeFileSync(`${out}/report.json`, JSON.stringify(checks, null, 1));
console.log(JSON.stringify(checks, null, 1));
const passed = !checks.error && checks.refusedWithoutData && checks.nothingRan && checks.allCellsRan
  && checks.cellOutput && checks.answerRight && checks.agentCalledTop && !checks.agentErrors.some((e) => /NameError/.test(e))
  && checks.workerPids.length === 1 && JSON.stringify(checks.runKinds) === JSON.stringify(["agent:ok", "notebook:ok"]);
console.log(passed ? "PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
