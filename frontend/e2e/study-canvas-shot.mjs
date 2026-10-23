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

// Opens a study workflow as the participant will see it and saves a screenshot,
// printing how many operators the canvas shows and how many carry a one-line doc.
//
//   node e2e/study-canvas-shot.mjs <workflow id> <out.png>   (FE_BASE, WEB_BASE as the other e2e scripts)
import { chromium } from "playwright";

const [wid, out] = process.argv.slice(2);
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
try {
  await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
  const loaded = await page
    .waitForFunction(() => document.querySelectorAll(".texera-operator-icon").length > 0, null, { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  if (!loaded) console.log(`no operators appeared; at ${page.url()}, title "${await page.title()}"`);
  await page.waitForTimeout(3000); // results and docs arrive after the canvas
  const operators = await page.locator(".texera-operator-icon").count();
  const docs = await page.evaluate(
    () => document.body.innerText.match(/Load listings|Keep entire homes|Turn the price text/g)?.length ?? 0
  );
  await page.screenshot({ path: out, fullPage: false });
  console.log(
    `workflow ${wid}: ${operators} operators on the canvas, ${docs} of the expected docs visible; saved ${out}`
  );
} finally {
  await browser.close();
}
