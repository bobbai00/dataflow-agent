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

// Someone brings an existing script: they upload it with its data, run it from the
// panel under the chat, and then ask the agent about what it computed.
//
//   node tests/e2e/script_flow.mjs BASE_URL BOSTON_CSV OUT_DIR
//
// BOSTON_CSV is the doctored Boston demo file (agent-service/benchmark/e2e/demo/
// prepare-boston-demo.py). Exits 1 unless every check holds.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { ask, chromium, lastMessages, register, runUntilDone, upload } from "./browser.mjs";

const [base, csv, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const script = `${out}/neighborhoods.py`;
writeFileSync(script, `import pandas as pd

homes = pd.read_csv("${basename(csv)}")  # next to this script, in the user's files
clean = homes[homes.TOTAL_VALUE < 10_000_000]
by_city = (clean.groupby("CITY").TOTAL_VALUE
           .agg(["median", "count"]).sort_values("median", ascending=False))
print(by_city.head(5))
by_city.head(10)["median"].plot.barh(title="Median assessed value, top 10 neighborhoods")
len(clean)
`);
const QUESTION = "Using the by_city table from my script, which neighborhood has the most homes, and what is its median?";

const checks = {};
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
try {
  await register(page, base, `script_${Date.now().toString(36)}`);
  await upload(page, csv, "the agent hears about it with your next message");
  await upload(page, script, "press Run to run it");
  checks.scriptLoaded = (await page.locator("#code-box").innerText()).includes("by_city");

  await runUntilDone(page, "Run");
  await page.getByText("the agent sees this run").waitFor({ timeout: 60_000 });
  const ran = (await lastMessages(page)).join("\n");
  checks.outputShown = ran.includes("CHARLESTOWN") && ran.includes("29118");
  checks.variablesShown = ran.includes("by_city (DataFrame, 16×2)");
  checks.chartShown = await page.locator("[role=log] img").evaluateAll(
    (images) => images.some((image) => image.complete && image.naturalWidth > 0));

  const answer = await ask(page, QUESTION);
  checks.answer = answer.final;
  const said = answer.final.replace(/,/g, "").toUpperCase();
  checks.answerRight = said.includes("WEST ROXBURY") && said.includes("752700");
  await page.screenshot({ path: `${out}/chat.png`, fullPage: true });

  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  checks.runKinds = runs.map((run) => run.kind).sort();
  const details = await Promise.all(runs.map(async (run) => (await page.request.get(`${base}/api/runs/${run.id}`)).json()));
  const agentRun = details.find((run) => run.kind === "agent");
  checks.agentUsedTheVariable = agentRun.python_execs.some((execution) => execution.code.includes("by_city"));
  checks.agentReloadedTheCsv = agentRun.python_execs.some((execution) => execution.code.includes("read_csv"));
  checks.workerPids = [...new Set(details.flatMap((run) => run.python_execs.map((execution) => execution.worker_pid)))];
} catch (error) {
  checks.error = String(error).slice(0, 500);
  await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {});
}
await browser.close();

writeFileSync(`${out}/report.json`, JSON.stringify(checks, null, 1));
console.log(JSON.stringify(checks, null, 1));
const passed = !checks.error && checks.scriptLoaded && checks.outputShown && checks.variablesShown && checks.chartShown
  && checks.answerRight && checks.agentUsedTheVariable && checks.workerPids.length === 1
  && JSON.stringify(checks.runKinds) === JSON.stringify(["agent", "script"]);
console.log(passed ? "PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
