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

// What a person does in the app, for the end-to-end scripts. Playwright comes from
// the repository's frontend/node_modules.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const { chromium } = createRequire(`${repo}/frontend/package.json`)("playwright");
export const CLOCK = /^20\d\d-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/;
const RUN_SECONDS = 300;
const PROMPT = "Ask about your data, then Submit";

const disabled = (label) => [...document.querySelectorAll("button")]
  .find((button) => button.innerText.trim() === label)?.disabled === true;
const enabled = (label) => [...document.querySelectorAll("button")]
  .find((button) => button.innerText.trim() === label)?.disabled === false;

export async function register(page, base, username) {
  await page.goto(`${base}/register`);
  await page.fill("#username", username);
  await page.fill("#password", "e2e-password");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.waitForURL(/\/app\/?$/);
  await page.getByPlaceholder(PROMPT).waitFor();
}

export async function upload(page, path, confirmation) {
  await page.setInputFiles("input[type=file]", path);
  await page.getByText(confirmation).waitFor({ timeout: 30_000 });
}

// Press a button that runs something, and wait until the app hands it back. The app
// disables the button while it works; a quick run may be over before that is seen.
export async function runUntilDone(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction(disabled, label, { timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(enabled, label, { timeout: RUN_SECONDS * 1000, polling: 500 });
}

// The texts of the newest group of chat messages, one per message.
export async function lastMessages(page) {
  return page.locator("[role=log] .message-row").last().locator(".message").evaluateAll(
    (messages) => messages.filter((m) => !m.querySelector(".message")).map((m) => m.innerText.trim()));
}

// The newest answer: the message just before its run's "✓ N steps" line.
export async function lastAnswer(page) {
  const texts = await lastMessages(page);
  const totals = texts.findLastIndex((text) => text.startsWith("✓"));
  return totals > 0 ? texts[totals - 1] : "";
}

export async function ask(page, question) {
  const started = Date.now();
  await page.getByPlaceholder(PROMPT).fill(question);
  await runUntilDone(page, "Submit");
  return { question, seconds: (Date.now() - started) / 1000, final: (await lastAnswer(page)).slice(0, 400) };
}
