/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// The participant's Scenario 2 setup through the browser: open a workflow that has
// an agent, press the chat's Import button on the study archive, and check that the
// canvas and the agent's results come back. Prints what arrived and saves a screenshot.
//
//   node e2e/study-import-archive.mjs <workflow id> <archive.json> <out.png>
//   (FE_BASE, WEB_BASE, AGENT_BASE, CU_BASE as the other e2e scripts; STUDY_CU names the computing
//   unit, STUDY_MODEL the agent's model, by id or by name: claude-haiku-5.5 or "Claude Haiku 5.5")
import { chromium } from "playwright";

const [wid, archive, out] = process.argv.slice(2);
const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
const CU = process.env.CU_BASE ?? "http://localhost:8888";

const login = await fetch(`${WEB}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "texera", password: "texera" }),
});
const { accessToken } = await login.json();
const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

// The workflow's agent, on the study's computing unit, made as a participant's facilitator would
// before the page opens: a chat without an agent starts its own, on whichever unit the workspace
// selects first.
const unitName = process.env.STUDY_CU ?? "user-study";
const unit = (await (await fetch(`${CU}/api/computing-unit`, { headers })).json()).find(
  u => u.computingUnit?.name === unitName
);
if (!unit) throw new Error(`no computing unit named ${unitName}`);
const model = (process.env.STUDY_MODEL ?? "claude-haiku-5.5").toLowerCase().replaceAll(" ", "-");
const made = await fetch(`${AGENT}/api/agents`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    modelType: model,
    name: "Bob",
    workflowId: Number(wid),
    computingUnitId: unit.computingUnit.cuid,
    settings: { operatorDoc: true },
  }),
});
if (!made.ok) throw new Error(`creating the agent failed: ${made.status} ${(await made.text()).slice(0, 200)}`);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
await context.addInitScript(token => localStorage.setItem("access_token", token), accessToken);
const page = await context.newPage();
try {
  await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
  // The chat panel is always open, on the agent made above.
  await page.locator("#agent-container #content").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(".computing-units-dropdown-button").click();
  const option = page.locator(".computing-unit-option", { hasText: unitName }).first();
  await option.waitFor({ timeout: 15_000 });
  await option.click();
  await page.locator("#agent-container #title", { hasText: "Bob" }).waitFor({ timeout: 60_000 });
  const fileInput = page.locator('texera-agent-chat input[type=file][accept*="json"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 30_000 });
  page.on("console", message => {
    if (["error", "warning"].includes(message.type()))
      console.log(`browser ${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", error => console.log(`page error: ${String(error).slice(0, 300)}`));
  const started = Date.now();
  await fileInput.setInputFiles(archive);
  // The chat reports the outcome in a notification: success, or the failure's reason.
  const outcome = page.locator(".ant-notification-notice-message, .ant-notification-notice-description", {
    hasText: /Imported \d+ ReAct steps|Import failed|not valid JSON|does not contain/,
  });
  await outcome.first().waitFor({ timeout: 600_000 });
  const notice = await outcome.first().innerText();
  if (!/Imported \d+/.test(notice)) throw new Error(`import did not succeed: ${notice}`);
  await page.waitForFunction(() => document.querySelectorAll(".texera-operator-icon").length >= 29, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);
  const icons = await page.locator(".texera-operator-icon").count();
  await page.screenshot({ path: out, fullPage: false });
  const agents = (await (await fetch(`${AGENT}/api/agents`)).json()).agents.filter(
    a => a.delegate?.workflowId === Number(wid)
  );
  const agent = agents[0];
  const results = (await (await fetch(`${AGENT}/api/agents/${agent.id}/operator-results`)).json()).results ?? {};
  const settings = await (await fetch(`${AGENT}/api/agents/${agent.id}/settings`)).json();
  const steps = (await (await fetch(`${AGENT}/api/agents/${agent.id}/react-steps`)).json()).steps;
  console.log(
    `${notice} in ${((Date.now() - started) / 1000).toFixed(1)} s; canvas shows ${icons} operator icons (the mini-map doubles them); ` +
      `agent ${agent.id}: ${steps.length} steps, ${Object.keys(results).length} operators with results, ` +
      `${Object.values(results).filter(r => r.error).length} failed, instructions ${settings.instructions ? "set" : "NOT set"}; saved ${out}`
  );
} catch (error) {
  await page.screenshot({ path: out, fullPage: false }).catch(() => {});
  console.error("failed:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
