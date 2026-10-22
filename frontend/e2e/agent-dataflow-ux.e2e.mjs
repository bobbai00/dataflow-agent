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
 * Real-browser end-to-end test of how a native-mode agent's work shows in the
 * workspace, from a task to feedback:
 *   1. a task: the dataflow builds up on the canvas one action at a time (not
 *      all at once), operators show "Running" while they compute and then
 *      their outcome; each step's row lists only adds, modifies and deletes;
 *      the version tree has a version per action under its verb (add, run,
 *      show), each timed by when its action happened
 *   2. the operator's panel: read-only properties, and a data section, open
 *      by default and collapsible, with each input's and the output's size,
 *      columns and first records (both inputs for a join); no result panel
 *   3. a run from the panel: the operator shows "Running", and operators whose
 *      result is reused from cache say "cached" and keep their row counts
 *   4. feedback on an operator, from its panel: the agent answers in the chat
 *   5. feedback in the chat after the task is solved: a question is answered
 *      in words, and no correction shows up as a message of the user's; a
 *      change the user asks for edits the dataflow, its row listing the edit
 *
 * The agent-service REST API serves as an oracle; the UI is driven only
 * through the browser. The test provisions its own computing unit and
 * workflow and removes both.
 *
 * Usage (from frontend/, with the local stack up — see bin/local-dev.sh):
 *   PROBE_MODEL=claude-haiku-5.5 node e2e/agent-dataflow-ux.e2e.mjs
 */
import { chromium } from "../node_modules/playwright/index.mjs";
import fs from "node:fs";

const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
const CU = process.env.CU_BASE ?? "http://localhost:8888";
const CU_URI = process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085";
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";
const OUT_DIR = process.env.OUT_DIR ?? "./fe-e2e-dataflow-ux-out";
const TURN_TIMEOUT = Number(process.env.TURN_TIMEOUT_MS ?? "420000");
const HEADLESS = process.env.HEADFUL ? false : true;
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(probe, timeout = 60000, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() - t0 > timeout) return undefined;
    await sleep(every);
  }
}

// ---------- backend oracles ----------
let token = "";
const H = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: H(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
async function login() {
  const r = await api(WEB, "POST", "/api/auth/login", { username: "texera", password: "texera" });
  token = r.json.accessToken;
}
async function createComputingUnit(name) {
  const r = await api(CU, "POST", "/api/computing-unit/create", {
    name,
    unitType: "local",
    cpuLimit: "NaN",
    memoryLimit: "NaN",
    gpuLimit: "NaN",
    jvmMemorySize: "NaN",
    shmSize: "NaN",
    uri: CU_URI,
  });
  if (r.status !== 200) throw new Error(`createComputingUnit ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.computingUnit?.cuid ?? r.json.cuid;
}
async function createWorkflow(name) {
  const r = await api(WEB, "POST", "/api/workflow/create", {
    name,
    content: JSON.stringify({
      operators: [],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    }),
    description: "fe-e2e",
  });
  if (r.status !== 200) throw new Error(`createWorkflow ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.wid ?? r.json.workflow?.wid;
}
async function agentsForWorkflow(wid) {
  const r = await api(AGENT, "GET", "/api/agents");
  return (r.json?.agents ?? []).filter(a => a.delegate?.workflowId === wid);
}
async function operatorsOf(agentId) {
  return (await api(AGENT, "GET", `/api/agents/${agentId}/workflow`)).json?.workflow?.operators ?? [];
}
async function stepsOf(agentId) {
  return (await api(AGENT, "GET", `/api/agents/${agentId}/react-steps`)).json?.steps ?? [];
}
async function versionsOf(agentId) {
  const tree = (await api(AGENT, "GET", `/api/agents/${agentId}/snapshot-tree`)).json;
  return (tree?.nodes ?? []).filter(node => node.version !== undefined).sort((a, b) => a.version - b.version);
}
async function agentIdle(agentId) {
  const agent = (await api(AGENT, "GET", "/api/agents")).json?.agents?.find(a => a.id === agentId);
  return agent?.state === "AVAILABLE";
}
/** Wait for the agent to take up a turn (it may already have), then to finish it. */
async function agentTurnDone(agentId) {
  await until(async () => !(await agentIdle(agentId)), 15000, 300);
  return until(() => agentIdle(agentId), TURN_TIMEOUT, 1000);
}
async function lastAnswer(agentId) {
  const steps = await stepsOf(agentId);
  return [...steps].reverse().find(s => s.role === "agent" && s.isEnd)?.content ?? "";
}

// ---------- UI helpers ----------
const chat = page => page.locator("texera-agent-chat").last();
/** The canvas panel of the selected operator. */
const panel = page => page.locator("texera-workflow-editor texera-agent-interaction");
// Under headless Chromium a tab pane can linger in its leave state over the
// agent panel and swallow real clicks; dispatch clicks on the element itself.
async function domClick(locator) {
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.evaluate(el => el.click());
}
async function openAgentPanel(page) {
  const docked = page.locator("#agent-docked-button");
  if (await docked.isVisible().catch(() => false)) await docked.click();
  await page.locator("#agent-container #content").waitFor({ state: "visible", timeout: 20000 });
}
async function selectComputingUnit(page, name) {
  await page.locator(".computing-units-dropdown-button").click();
  const option = page.locator(".computing-unit-option", { hasText: name }).first();
  await option.waitFor({ timeout: 15000 });
  await option.click();
  await sleep(1500);
}
async function createAgentViaUI(page, modelId, name) {
  await domClick(page.locator(".agent-tabs .ant-tabs-tab", { hasText: "+ Agent" }));
  const reg = page.locator("texera-agent-registration");
  await reg.locator(".model-card").first().waitFor({ timeout: 30000 });
  const label = modelId
    .split("-")
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  const card = reg.locator(".model-card", { has: page.locator("h5", { hasText: new RegExp(`^${label}$`) }) });
  if ((await card.count()) === 0)
    throw new Error(`model card "${label}" not found; cards=${await reg.locator(".model-card h5").allTextContents()}`);
  await domClick(card.first());
  await reg.locator("input[nz-input]").fill(name);
  const btn = reg.locator("button", { hasText: /Create Agent/ });
  await btn.waitFor({ state: "visible" });
  await page.waitForFunction(el => !el.disabled, await btn.elementHandle(), { timeout: 60000 });
  await domClick(btn);
  await page.locator(".agent-tab-name", { hasText: name }).waitFor({ timeout: 30000 });
  await chat(page).locator("textarea").waitFor({ timeout: 30000 });
}
/** Type a message into the chat and send it. */
async function send(page, text) {
  const ta = chat(page).locator(".input-area textarea");
  await page.waitForFunction(el => !el.disabled, await ta.elementHandle(), { timeout: 60000 });
  await ta.fill(text);
  await domClick(chat(page).locator(".input-area button.ant-btn-primary"));
}
/** What the main canvas shows right now: its operators and each one's status pill. */
async function canvasState(page) {
  return page.evaluate(() => {
    // Operators only: region overlays are elements of the paper too.
    const boxes = Array.from(
      document.querySelectorAll("texera-workflow-editor #workflow-editor g.joint-element[model-id]")
    ).filter(box => box.querySelector(".texera-operator-icon"));
    const status = {};
    const ports = {};
    for (const box of boxes) {
      const id = box.getAttribute("model-id");
      const pill = box.querySelector(".texera-operator-status");
      const shown = pill && getComputedStyle(pill).display !== "none";
      status[id] = shown ? (box.querySelector(".texera-operator-status-text")?.textContent ?? "").trim() : "";
      ports[id] = Array.from(box.querySelectorAll(".port-label"))
        .filter(label => getComputedStyle(label).visibility !== "hidden")
        .map(label => label.textContent.trim());
    }
    return { operators: boxes.map(box => box.getAttribute("model-id")), status, ports };
  });
}
/** Sample the canvas every `every` ms until `done()` holds; returns the samples. */
async function watchCanvas(page, done, { every = 120, timeout = TURN_TIMEOUT } = {}) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    samples.push({ t: Date.now() - t0, ...(await canvasState(page).catch(() => ({ operators: [], status: {} }))) });
    if (await done()) break;
    await sleep(every);
  }
  samples.push({ t: Date.now() - t0, ...(await canvasState(page)) });
  return samples;
}
async function selectOperator(page, operatorId) {
  const box = page.locator(`texera-workflow-editor #workflow-editor g.joint-element[model-id="${operatorId}"]`).first();
  await box.waitFor({ timeout: 10000 });
  await box.locator(".texera-operator-icon").evaluate(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: x + width / 2, clientY: y + height / 2, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new MouseEvent("mouseup", at));
  });
  await panel(page).locator(".op-id", { hasText: operatorId }).waitFor({ timeout: 10000 });
}
/** The chips of the chat's step rows. */
async function stepChips(page) {
  return (await chat(page).locator(".react-card-action .chip-label").allTextContents()).map(t => t.trim());
}
/** The version tree's pills, top to bottom. */
async function treeLabels(page) {
  return (await chat(page).locator(".snapshot-node-label").allTextContents()).map(t => t.trim());
}
/** What the chat shows as the user's: messages and notes, in order. */
async function chatTranscript(page) {
  return chat(page)
    .locator(".messages-container > *")
    .evaluateAll(items =>
      items.map(item =>
        item.classList.contains("correction-note")
          ? `note: ${item.textContent.replace(/\s+/g, " ").trim()}`
          : item.classList.contains("user-message")
            ? `you: ${item.textContent.replace(/\s+/g, " ").trim()}`
            : item.classList.contains("ai-message")
              ? "agent"
              : ""
      )
    );
}
/** The panel's data section: each table's role, source, shape, columns and records shown. */
async function panelData(page) {
  return panel(page)
    .locator(".data-block")
    .evaluateAll(blocks =>
      blocks.map(block => ({
        role: block.querySelector(".data-role")?.textContent.trim(),
        source: block.querySelector(".data-source")?.textContent.trim() ?? "",
        shape: block.querySelector(".data-shape")?.textContent.trim() ?? "",
        cached: !!block.querySelector(".data-badge.cached"),
        columns: Array.from(block.querySelectorAll(".data-table th .column-name")).map(th => th.textContent.trim()),
        records: block.querySelectorAll(".data-table tbody tr").length,
        note: block.querySelector(".data-note")?.textContent.trim() ?? "",
      }))
    );
}

// ---------- main ----------
async function main() {
  await login();
  const unitName = `fe-e2e-ux ${Date.now()}`;
  const cuid = await createComputingUnit(unitName);
  const wid = await createWorkflow(`fe-e2e-ux ${Date.now()}`);
  console.log("workflow", wid, "computing unit", cuid, "model", MODEL);
  const browser = await chromium.launch({ headless: HEADLESS });
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
  const shot = async name => page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false }).catch(() => {});

  try {
    await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
    await page.locator("texera-workflow-editor").first().waitFor({ timeout: 60000 });
    const trigger = page.locator(".ant-layout-sider-trigger");
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      await sleep(600);
    }
    await selectComputingUnit(page, unitName);
    await openAgentPanel(page);
    await createAgentViaUI(page, MODEL, "e2e-ux");
    const agent = (await agentsForWorkflow(wid))[0];
    check("agent created on the workflow, native mode", agent?.settings?.agentMode === "native", agent?.modelType);
    check("the workspace has no separate result panel", (await page.locator("texera-result-panel").count()) === 0);

    // ===== 1. a task: the dataflow builds up action by action =====
    await send(
      page,
      "Make a table of orders with columns order_id (1 to 6) and amount (10, 25, 40, 55, 70, 85), and a table of " +
        "customers with columns order_id (1 to 6) and region (east, west, east, north, west, east). Join them on " +
        "order_id, keep the orders whose amount is over 30, and show the result. How many orders remain?"
    );
    const samples = await watchCanvas(page, () => agentIdle(agent.id));
    fs.writeFileSync(`${OUT_DIR}/canvas-samples.json`, JSON.stringify(samples, null, 1));
    await shot("01-task-done");
    const answer = await lastAnswer(agent.id);
    check("the agent answers 4 orders", /\b4\b|\bfour\b/i.test(answer), answer.slice(0, 160));
    const ops = await operatorsOf(agent.id);
    const join = ops.find(o => o.nativeOp?.type === "Join");
    check(
      "the dataflow joins two tables",
      !!join && join.nativeOp.inputs.length === 2,
      ops.map(o => `${o.operatorID}:${o.nativeOp?.type}`).join(", ")
    );
    const counts = samples.map(sample => sample.operators.length);
    const distinct = [...new Set(counts)];
    check(
      "operators appear on the canvas one at a time, not all at once",
      distinct.length >= 3 && Math.max(...counts) === ops.length,
      `operator counts seen: ${distinct.join(" → ")}`
    );
    const sawRunning = samples.some(sample => Object.values(sample.status).includes("Running"));
    check("operators show Running while they compute", sawRunning);
    const final = await canvasState(page);
    check(
      "each computed operator then shows its outcome",
      ops.every(o => ["✓", "cached"].includes(final.status[o.operatorID])),
      JSON.stringify(final.status)
    );
    const chips = await stepChips(page);
    check(
      "the steps list only adds, modifies and deletes",
      chips.length > 0 && chips.every(label => /^(add|modify|delete|define) /.test(label)),
      chips.join(" | ")
    );
    check(
      "every operator's add is listed",
      ops.every(o => chips.includes(`add ${o.operatorID}`)),
      chips.join(" | ")
    );
    const tree = await treeLabels(page);
    check(
      "the version tree lists each action under its verb",
      tree[0] === "v0 start" &&
        tree.some(label => /^v\d+ add /.test(label)) &&
        tree.some(label => /^v\d+ run\b/.test(label)) &&
        tree.some(label => /^v\d+ show /.test(label)),
      tree.join(" | ")
    );
    const versions = await versionsOf(agent.id);
    const times = versions.map(node => node.timestamp);
    check(
      "each version is timed by its action: in order, and not all at the step's time",
      times.every((time, i) => i === 0 || time >= times[i - 1]) && new Set(times).size > 2,
      versions.map(node => `v${node.version} ${node.action?.kind} @${node.timestamp % 100000}`).join(", ")
    );

    // ===== 2. the operator's panel: properties, and its data =====
    await selectOperator(page, join.operatorID);
    await shot("02-join-panel");
    const properties = await panel(page).locator(".property-list dt").allTextContents();
    check("the panel lists the join's properties", properties.length >= 2, properties.join(", "));
    let data = await panelData(page);
    const inputs = data.filter(block => block.role?.startsWith("Input"));
    const output = data.find(block => block.role === "Output");
    check(
      "the data section shows both inputs of the join, with size, columns and a few records",
      inputs.length === 2 &&
        inputs.every(input => /^6 rows · 2 columns$/.test(input.shape) && input.columns.length === 2) &&
        inputs.every(input => input.records > 0 && input.records <= 3),
      JSON.stringify(inputs)
    );
    check(
      "…and the join's output, its first records",
      /^6 rows · 3 columns$/.test(output?.shape ?? "") && output.records > 0 && output.records <= 5,
      JSON.stringify(output)
    );
    await domClick(panel(page).locator(".section-toggle"));
    check("the data can be hidden", (await panel(page).locator(".data-block").count()) === 0);
    await domClick(panel(page).locator(".section-toggle"));
    check("…and shown again", (await panel(page).locator(".data-block").count()) === 3);

    // ===== 3. a run from the panel =====
    const filter = ops.find(o => o.nativeOp?.type === "Filter") ?? join;
    await selectOperator(page, filter.operatorID);
    await domClick(panel(page).locator(".run-action"));
    const runSamples = await watchCanvas(
      page,
      async () =>
        (await panel(page).locator(".run-action").innerText()).trim() === "Run" && (await agentIdle(agent.id)),
      { every: 80, timeout: 120000 }
    );
    fs.writeFileSync(`${OUT_DIR}/run-samples.json`, JSON.stringify(runSamples, null, 1));
    check(
      "a run from the panel shows the operator Running",
      runSamples.some(sample => sample.status[filter.operatorID] === "Running")
    );
    await agentTurnDone(agent.id);
    const afterRun = await canvasState(page);
    const cached = Object.entries(afterRun.status)
      .filter(([, status]) => status === "cached")
      .map(([id]) => id);
    check(
      "operators reused from cache say so, and keep their row counts",
      cached.every(id => afterRun.ports[id].every(label => label !== "0")),
      `cached: ${cached.join(", ") || "(none)"}; ports: ${JSON.stringify(afterRun.ports)}`
    );
    data = await panelData(page);
    check(
      "the panel shows the run's output",
      data.some(block => block.role === "Output" && block.records > 0),
      JSON.stringify(data)
    );
    await shot("03-run");

    // ===== 4. feedback on an operator, from its panel =====
    const stepsBeforeFeedback = (await stepsOf(agent.id)).length;
    await domClick(panel(page).locator(".feedback-action"));
    const box = panel(page).locator(".feedback-input");
    await box.waitFor({ timeout: 10000 });
    await box.fill("Which regions are left after this step? Answer in one short sentence.");
    await domClick(panel(page).locator(".send-btn"));
    await agentTurnDone(agent.id);
    let steps = await stepsOf(agent.id);
    const feedback = steps.slice(stepsBeforeFeedback).find(s => s.role === "user" && s.messageSource === "feedback");
    check(
      "operator feedback reaches the agent, naming the operator",
      feedback?.content?.startsWith(`Feedback on \`${filter.operatorID}\``),
      feedback?.content?.slice(0, 120)
    );
    const feedbackReply = await lastAnswer(agent.id);
    check("the agent answers the feedback", /east|west|north/i.test(feedbackReply), feedbackReply.slice(0, 200));
    await shot("04-operator-feedback");

    // ===== 5. feedback in the chat after the task is solved =====
    const stepsBeforeChat = (await stepsOf(agent.id)).length;
    await send(page, "Thanks! In one sentence, what does the final table contain?");
    await agentTurnDone(agent.id);
    steps = await stepsOf(agent.id);
    const turn = steps.slice(stepsBeforeChat);
    check(
      "a follow-up is answered in words, with no correction",
      turn.filter(s => s.role === "user").length === 1 &&
        !turn.some(s => s.messageSource === "correction") &&
        turn.some(s => s.role === "agent" && s.isEnd && s.content?.trim()),
      turn.map(s => `${s.role}/${s.messageSource ?? "-"}: ${String(s.content).slice(0, 60)}`).join(" | ")
    );
    const transcript = await chatTranscript(page);
    check(
      "the chat shows no message of the user's that the user did not write",
      !transcript.some(line => line.startsWith("you:") && /That reply was text/.test(line)),
      transcript.filter(Boolean).join(" | ").slice(0, 400)
    );
    check(
      "no correction was needed in the whole session",
      !steps.some(s => s.messageSource === "correction" || /^That reply was text/.test(s.content ?? "")),
      steps
        .filter(s => s.messageSource === "correction")
        .map(s => s.content.slice(0, 60))
        .join(" | ")
    );
    await shot("05-chat-feedback");

    // A change asked for in the chat edits the dataflow; its row lists the edit.
    const versionsBeforeChange = (await versionsOf(agent.id)).length;
    const chipsBeforeChange = (await stepChips(page)).length;
    await send(page, "Also leave out the orders from the north region, and show the result again. How many remain?");
    await agentTurnDone(agent.id);
    const changes = (await versionsOf(agent.id))
      .slice(versionsBeforeChange)
      .filter(node => ["add", "update", "delete"].includes(node.action?.kind));
    const newChips = (await stepChips(page)).slice(chipsBeforeChange);
    check(
      "a change asked for in the chat edits the dataflow, and the step's row lists the edit",
      changes.length > 0 && newChips.length > 0 && newChips.every(label => /^(add|modify|delete|define) /.test(label)),
      `versions: ${changes.map(node => `v${node.version} ${node.action.kind} ${node.action.operatorId}`).join(", ")}; chips: ${newChips.join(" | ")}`
    );
    const changedAnswer = await lastAnswer(agent.id);
    check("…and the answer reflects it: 3 orders", /\b3\b|\bthree\b/i.test(changedAnswer), changedAnswer.slice(0, 160));
    check("…with no correction", !(await stepsOf(agent.id)).some(s => s.messageSource === "correction"));
    await shot("06-chat-change");
  } catch (e) {
    check("script completed without exception", false, String(e).slice(0, 1200));
    await shot("99-error");
  } finally {
    // NG0100 and the 403 on a permission probe are pre-existing dev-mode noise.
    const known = consoleErrors.filter(e => /NG0100|403 \(Forbidden\)/.test(e));
    const errs = consoleErrors.filter(e => !/favicon|ERR_|WebSocket is closed|404|NG0100|403 \(Forbidden\)/.test(e));
    check(
      "no unexpected browser console errors",
      errs.length === 0,
      errs.slice(0, 3).join(" | ") || `(known pre-existing: ${known.length})`
    );
    for (const a of await agentsForWorkflow(wid)) await api(AGENT, "DELETE", `/api/agents/${a.id}`);
    await api(WEB, "POST", "/api/workflow/delete", { wids: [wid] });
    await api(CU, "DELETE", `/api/computing-unit/${cuid}/terminate`);
    await browser.close();
    fs.writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
    const failed = results.filter(r => !r.ok);
    console.log(`\n===== ${results.length - failed.length}/${results.length} passed`);
    for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? " — " + f.detail : ""}`);
    process.exit(failed.length ? 1 : 0);
  }
}
main().catch(e => {
  console.error("fatal", e);
  process.exit(2);
});
