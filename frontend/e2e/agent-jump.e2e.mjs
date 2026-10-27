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

/**
 * Real-browser check of jumping between versions in the version tree, without
 * a model. The agent's work comes from recorded conversations, replayed by
 * benchmark/tracker/replay-dataflow.ts as branches of one tree; then the test
 * clicks versions in the tree:
 *   1. a version in the middle of a call: the canvas shows exactly that
 *      version's operators, and the chat shows the restore as a step
 *   2. a step's own version on another branch: the canvas shows its operators
 *      and the chat that branch's steps, which the page already held (a jump
 *      no longer resends the steps)
 *   3. the first version again: the restore is reused, no new step is made
 * and that the workflow the page saves to Texera holds runnable code (the
 * agent sends its operators without the Python runtime; the page puts it back).
 * Each click is timed until the canvas shows the version.
 *
 * Usage (from frontend/, with the stack's engine up, an agent service of this
 * checkout whose model is the replayer — benchmark/tracker/start-agent.sh — and
 * the frontend served against both):
 *   CONVERSATIONS=/path/conversations-dataflow.jsonl AGENT_BASE=http://localhost:3147 MODEL_PORT=3193 \
 *     FE_BASE=http://localhost:4300 WEB_BASE=http://localhost:64080 CU_ID=10 [CHROME_PATH=/usr/bin/google-chrome] \
 *     node e2e/agent-jump.e2e.mjs
 */

import { chromium } from "../node_modules/playwright/index.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
const OUT_DIR = process.env.OUT_DIR ?? "./fe-e2e-jump-out";
const HEADLESS = process.env.HEADFUL ? false : true;
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(probe, timeout = 30000, every = 50) {
  const t0 = Date.now();
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() - t0 > timeout) return undefined;
    await sleep(every);
  }
}

let token = "";
async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function chat(page) {
  return page.locator("texera-agent-chat").last();
}
async function domClick(locator) {
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.evaluate(el => el.click());
}
// The chat panel is always open.
async function openAgentPanel(page) {
  await page.locator("#agent-container #content").waitFor({ state: "visible", timeout: 20000 });
}
/** The operators the canvas shows, by id. */
async function canvasOperators(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("texera-workflow-editor #workflow-editor g.joint-element[model-id]"))
      .filter(el => el.querySelector(".texera-operator-icon"))
      .map(el => el.getAttribute("model-id"))
      .sort()
  );
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Click `node`'s pill in the version tree; resolve with the ms until the canvas shows `expected`. */
async function jump(page, node, expected) {
  // A version's pill reads "v<number> <action>".
  const target = chat(page).locator(".snapshot-node", { hasText: new RegExp(`^\\s*v${node.version}\\b`) });
  await target
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  const started = Date.now();
  await domClick(target.first());
  const shown = await until(async () => same(await canvasOperators(page), expected), 20000, 20);
  return shown ? Date.now() - started : undefined;
}

async function main() {
  token = (await api(WEB, "POST", "/api/auth/login", { username: "texera", password: "texera" })).json.accessToken;
  // The agent's work: recorded conversations replayed through the agent service, no model called.
  const replay = spawnSync(
    "bun",
    [
      "../benchmark/tracker/replay-dataflow.ts",
      "--conversations",
      process.env.CONVERSATIONS,
      "--out",
      `${OUT_DIR}/replay.jsonl`,
      "--agent",
      AGENT,
      "--texera",
      WEB,
      "--model-port",
      process.env.MODEL_PORT ?? "3199",
      "--cu",
      process.env.CU_ID ?? "10",
      "--limit",
      process.env.CONVERSATION_COUNT ?? "3",
    ],
    { encoding: "utf8", timeout: 900000 }
  );
  if (replay.status !== 0) throw new Error(`replay failed: ${replay.stderr || replay.stdout}`);
  const start = JSON.parse(fs.readFileSync(`${OUT_DIR}/replay.jsonl`, "utf8").split("\n")[0]);
  const agentId = start.agentId;
  const wid = start.workflowId;
  console.log("agent", agentId, "workflow", wid);

  // CHROME_PATH: a Chrome to use instead of Playwright's own download.
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: process.env.CHROME_PATH });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(t => {
    try {
      localStorage.setItem("access_token", t);
    } catch {}
  }, token);
  const page = await context.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  const consoleErrors = [];
  page.on("console", m => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("response", r => {
    if (r.status() >= 500) consoleErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  const shot = async name => page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false }).catch(() => {});

  try {
    await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
    await page.locator("texera-workflow-editor").first().waitFor({ timeout: 90000 });
    await openAgentPanel(page);
    await chat(page).locator(".snapshot-node").first().waitFor({ timeout: 30000 });
    await shot("01-opened");

    const tree = (await api(AGENT, "GET", `/api/agents/${agentId}/snapshot-tree`)).json.nodes;
    const versions = tree.filter(node => node.version !== undefined);
    const operatorsAt = async node =>
      ((await api(AGENT, "GET", `/api/agents/${agentId}/versions/${node.id}`)).json?.workflow?.operators ?? [])
        .map(op => op.operatorID)
        .sort();
    const stepsBefore = (await api(AGENT, "GET", `/api/agents/${agentId}/react-steps`)).json.steps.length;

    // 1. A version in the middle of a call: an add of the first conversation, whose step went on after it.
    const middle = versions.find(node => node.owned === false && node.action?.kind === "add");
    const middleOps = await operatorsAt(middle);
    let ms = await jump(page, middle, middleOps);
    check(
      "a version in the middle of a call shows exactly its operators",
      ms !== undefined,
      `${middleOps} in ${ms} ms`
    );
    const restoredRow = await until(
      async () =>
        (await chat(page).locator(".user-action-text").allTextContents()).some(text =>
          text.includes(`You restored v${middle.version}`)
        ),
      15000
    );
    check("…and the chat shows the restore as a step", !!restoredRow);
    const stepsAfter = (await api(AGENT, "GET", `/api/agents/${agentId}/react-steps`)).json.steps;
    check(
      "…the only new step is the restore",
      stepsAfter.length === stepsBefore + 1,
      `${stepsBefore} → ${stepsAfter.length}`
    );
    await shot("02-middle");

    // What the page saves to Texera is what Texera runs from its own toolbar: the code must hold the runtime.
    const saved = await until(async () => {
      const r = await api(WEB, "GET", `/api/workflow/${wid}`);
      const content = typeof r.json?.content === "string" ? JSON.parse(r.json.content) : r.json?.content;
      const ops = content?.operators ?? [];
      return ops.length && same(ops.map(op => op.operatorID).sort(), middleOps) ? ops : undefined;
    }, 20000);
    const codes = (saved ?? []).map(op => String(op.operatorProperties?.code ?? ""));
    check(
      "the workflow the page saved runs outside the agent: its code holds the runtime",
      codes.length > 0 &&
        codes.every(
          code => code.includes("def execute_native_from_engine") && !/exec\(_texera_native_runtime_/.test(code)
        ),
      `${codes.length} operators, ${codes.map(code => code.length).join("/")} chars`
    );

    // 2. A step's own version on another branch: its operators, and that branch's steps, held by the page.
    const owner = id => tree.find(node => node.id === id)?.reactStepId;
    const otherStep = versions
      .filter(node => node.owned === true && node.action?.kind !== "start" && node.reactStepId !== middle.reactStepId)
      .at(-1);
    const otherOps = await operatorsAt(otherStep);
    ms = await jump(page, otherStep, otherOps);
    check("a step's version on another branch shows its operators", ms !== undefined, `${otherOps} in ${ms} ms`);
    const shownStep = await until(
      async () =>
        (await chat(page)
          .locator(`[data-step-id="${owner(otherStep.id)}"]`)
          .count()) > 0,
      15000
    );
    check("…and the chat shows that branch's steps, without the server resending them", !!shownStep);
    await shot("03-other-branch");

    // 3. The middle version again: the restore made in 1 is reused.
    ms = await jump(page, middle, middleOps);
    const stepsAgain = (await api(AGENT, "GET", `/api/agents/${agentId}/react-steps`)).json.steps.length;
    check(
      "going back to the same version reuses its restore",
      ms !== undefined && stepsAgain === stepsAfter.length,
      `${stepsAgain} steps, ${ms} ms`
    );
    await shot("04-back");
  } catch (e) {
    check("script completed without exception", false, String(e).slice(0, 1200));
    await shot("99-error");
  } finally {
    const errs = consoleErrors.filter(e => !/favicon|ERR_|WebSocket is closed|404|NG0100|403 \(Forbidden\)/.test(e));
    check("no unexpected browser console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    await api(AGENT, "DELETE", `/api/agents/${agentId}`);
    await api(WEB, "POST", "/api/workflow/delete", { wids: [wid] });
    await browser.close();
  }
  fs.writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
