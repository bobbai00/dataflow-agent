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
//   (FE_BASE, WEB_BASE, AGENT_BASE as the other e2e scripts)
import { chromium } from "playwright";

const [wid, archive, out] = process.argv.slice(2);
const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";

const login = await fetch(`${WEB}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "texera", password: "texera" }),
});
const { accessToken } = await login.json();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
await context.addInitScript(token => localStorage.setItem("access_token", token), accessToken);
const page = await context.newPage();
try {
  await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
  // The panel is docked away by default; its button appears once the workspace has loaded.
  const docked = page.locator("#agent-docked-button");
  const content = page.locator("#agent-container #content");
  if (!(await content.isVisible().catch(() => false))) {
    await docked.waitFor({ state: "visible", timeout: 60_000 });
    await docked.click();
  }
  await content.waitFor({ state: "visible", timeout: 30_000 });
  // The agent panel shows the agents of the selected computing unit: pick the study's.
  await page.locator(".computing-units-dropdown-button").click();
  const unit = page.locator(".computing-unit-option", { hasText: process.env.STUDY_CU ?? "user-study" }).first();
  await unit.waitFor({ timeout: 15_000 });
  await unit.click();
  // Create the agent as a participant's facilitator would, in the panel: the model card, a name, Create.
  await page.locator(".agent-tabs .ant-tabs-tab", { hasText: "+ Agent" }).evaluate(el => el.click());
  const registration = page.locator("texera-agent-registration");
  const model = process.env.STUDY_MODEL ?? "Claude Sonnet 5.5";
  const card = registration
    .locator(".model-card", { has: page.locator("h5", { hasText: new RegExp(`^${model}$`) }) })
    .first();
  await card.waitFor({ timeout: 30_000 });
  await card.evaluate(el => el.click());
  await registration.locator("input[nz-input]").fill("Bob");
  const create = registration.locator("button", { hasText: /Create Agent/ });
  await page.waitForFunction(el => !el.disabled, await create.elementHandle(), { timeout: 60_000 });
  await create.evaluate(el => el.click());
  const tab = page.locator(".agent-tab-name", { hasText: "Bob" }).first();
  await tab.waitFor({ timeout: 60_000 });
  // Every tab's chat is rendered; the Import button of the active tab is the one a person would press.
  const fileInput = page.locator('.ant-tabs-tabpane-active texera-agent-chat input[type=file][accept*="json"]').first();
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
