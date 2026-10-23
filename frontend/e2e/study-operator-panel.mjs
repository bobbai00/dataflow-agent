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

// The canvas and the operator panel of a prepared study workflow: selecting an
// operator marks everything upstream of it, and the panel's Summary action gets
// the agent's summary into the panel and the chat. Prints what it finds and
// saves screenshots.
//
//   node e2e/study-operator-panel.mjs <workflow id> <operator id> <out prefix>
//   (FE_BASE, WEB_BASE, STUDY_CU as the other scripts)
import { chromium } from "playwright";

const [wid, operatorId, out] = process.argv.slice(2);
const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";

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
const shot = name => page.screenshot({ path: `${out}-${name}.png`, fullPage: false });
try {
  await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
  const content = page.locator("#agent-container #content");
  if (!(await content.isVisible().catch(() => false))) {
    const docked = page.locator("#agent-docked-button");
    await docked.waitFor({ state: "visible", timeout: 60_000 });
    await docked.click();
  }
  await content.waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".computing-units-dropdown-button").click();
  const unit = page.locator(".computing-unit-option", { hasText: process.env.STUDY_CU ?? "user-study" }).first();
  await unit.waitFor({ timeout: 15_000 });
  await unit.click();
  await page.waitForTimeout(3000);
  const usable = page.locator(".agent-tab-title:not(:has(.workflow-lock-icon)) .agent-tab-name").first();
  if (await usable.count()) {
    await usable.click();
    await page.waitForTimeout(3000);
  }
  const element = page.locator(`g.joint-element[model-id="${operatorId}"]`).first();
  await element.waitFor({ timeout: 30_000 });
  // Pan the canvas until the operator sits in the part of the editor the agent
  // panel (docked on the right) does not cover: drag the blank canvas leftwards.
  for (let attempt = 0; attempt < 12; attempt++) {
    const box = await element.boundingBox();
    if (box && box.x > 260 && box.x + box.width < 1250 && box.y > 120 && box.y + box.height < 1100) break;
    const dx = box ? Math.max(-800, Math.min(800, 700 - box.x)) : -800;
    const dy = box ? Math.max(-500, Math.min(500, 600 - box.y)) : 0;
    await page.mouse.move(800, 1000);
    await page.mouse.down();
    await page.mouse.move(800 + dx / 2, 1000 + dy / 2, { steps: 5 });
    await page.mouse.move(800 + dx, 1000 + dy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  console.log(`operator ${operatorId} at ${JSON.stringify(await element.boundingBox())}`);
  console.log(
    `canvas: ${await page.locator("g.joint-element").count()} elements, ${await page.locator("g.joint-link").count()} links`
  );
  const links = await page.locator("g.joint-link .connection").first().getAttribute("d");
  console.log(`first edge path: ${links?.slice(0, 80)}…  (a C segment means a curve)`);
  console.log(
    `scan glyphs shown: ${await page.locator(`g.joint-element .texera-operator-file-glyph[display="inline"], g.joint-element .texera-operator-file-glyph:not([display="none"])`).count()}`
  );

  // Select: a single click highlights the operator and marks its upstream.
  // (The invisible `rect.boundary` sits over the body, so click by coordinates.)
  const center = async () => {
    const box = await element.locator("rect.body").boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  let at = await center();
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(600);
  const upstreamOps = await page
    .locator("g.joint-element.upstream-of-selected")
    .evaluateAll(els => els.map(el => el.getAttribute("model-id")));
  const upstreamLinks = await page.locator("g.joint-link.upstream-of-selected").count();
  console.log(
    `upstream of ${operatorId}: ${upstreamOps.length} operators (${upstreamOps.join(", ")}), ${upstreamLinks} links`
  );
  await shot("selected");

  // Open the panel and ask for a summary.
  at = await center();
  await page.mouse.dblclick(at.x, at.y);
  const panel = page.locator("texera-agent-interaction");
  await panel.waitFor({ timeout: 15_000 });
  const summaryButton = panel.locator(".summary-action");
  await summaryButton.waitFor({ timeout: 15_000 });
  const disabled = await summaryButton.isDisabled();
  console.log(`panel open; Summary ${disabled ? "disabled (no connected agent)" : "enabled"}`);
  const chartFrames = await panel.locator("iframe.data-chart").count();
  console.log(`chart frames in the panel: ${chartFrames}`);
  if (chartFrames > 0) {
    const frame = panel.locator("iframe.data-chart").first();
    const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
    console.log(`chart html: ${srcdoc.length} chars, has <svg>: ${srcdoc.includes("<svg")}`);
  }
  if (!disabled && !process.env.SKIP_SUMMARY) {
    await summaryButton.click();
    await panel.locator(".op-summary-card").waitFor({ timeout: 10_000 });
    const text = panel.locator(".op-summary-text");
    await text.waitFor({ timeout: 180_000 });
    const summary = (await text.innerText()).replace(/\s+/g, " ").trim();
    console.log(`summary in panel (${summary.length} chars): ${summary.slice(0, 400)}`);
    await page.waitForTimeout(1000);
    const chat = await page.locator("texera-agent-chat").innerText();
    console.log(
      `chat has the request: ${chat.includes(`Summarize ${operatorId}`) || chat.includes("Summarize `" + operatorId)}; chat has the reply: ${chat.includes(summary.slice(0, 40))}`
    );
  }
  await shot("panel");
} catch (error) {
  await shot("failed").catch(() => {});
  console.error("failed:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
