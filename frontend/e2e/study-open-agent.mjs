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

// What a participant sees when the facilitator opens a prepared study workflow: the
// agent panel's tabs (and whether the workflow's agent is usable), the chat's steps
// and the canvas. Prints them and saves a screenshot.
//
//   node e2e/study-open-agent.mjs <workflow id> <out.png>   (FE_BASE, WEB_BASE, STUDY_CU as the other scripts)
import { chromium } from "playwright";

const [wid, out] = process.argv.slice(2);
const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";

const login = await fetch(`${WEB}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.STUDY_USER ?? "texera",
    password: process.env.STUDY_PASSWORD ?? "texera",
  }),
});
const { accessToken } = await login.json();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
await context.addInitScript(token => localStorage.setItem("access_token", token), accessToken);
const page = await context.newPage();
try {
  await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
  // The chat panel is always open.
  const content = page.locator("#agent-container #content");
  await content.waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(".computing-units-dropdown-button").click();
  const unit = page.locator(".computing-unit-option", { hasText: process.env.STUDY_CU ?? "user-study" }).first();
  await unit.waitFor({ timeout: 15_000 });
  await unit.click();
  await page.waitForTimeout(3000);
  // The panel shows the workflow's agent (its name in the title); a workflow without one starts its chat.
  await page.waitForTimeout(4000);
  const title = (await page.locator("#agent-container #title").innerText()).trim();
  console.log(
    `panel: ${title}${(await page.locator("texera-agent-registration").count()) ? " (no agent: registration)" : ""}`
  );
  if (await page.locator("texera-agent-chat").count()) {
    const steps = await page.locator("texera-agent-chat .message").count();
    const text = await page
      .locator("texera-agent-chat")
      .innerText()
      .catch(() => "");
    console.log(
      `chat: ${steps} rendered blocks; mentions the question: ${/most expensive|Olympic/i.test(text)}; mentions the reply: ${/Marina|Pacific Heights|Pizzeria|cold/i.test(text)}`
    );
  }
  await page.waitForTimeout(2000);
  console.log(
    `canvas: ${await page.locator(".texera-operator-icon").count()} operator icons (the mini-map doubles them)`
  );
  await page.screenshot({ path: out, fullPage: false });
} catch (error) {
  await page.screenshot({ path: out, fullPage: false }).catch(() => {});
  console.error("failed:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
