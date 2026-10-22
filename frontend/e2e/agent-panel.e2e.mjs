/**
 * Real-browser end-to-end test of the Texera agent panel against the running
 * local stack (frontend :4200 → agent-service :3001 → JVMs).
 *
 * Drives the actual Angular UI with Playwright (chromium from
 * frontend/node_modules) — no API shortcuts for the things under test:
 *   1. agent features in native mode (the default): create agent, chat,
 *      streamed steps, hover→canvas highlight, snapshot tree, settings modal
 *      (agent mode / context mode / data and flow evidence), clear
 *   2. versioning: checkout an earlier snapshot, branch from it with a new
 *      message, verify the tree forks and the canvas follows HEAD
 *   3. code mode: a second agent switched to Code from the settings modal
 *      gets the code-mode tools and answers through a Python operator; tab
 *      switching and deleting an agent by closing its tab
 *
 * Cross-checks via the agent-service REST API are used only as oracles
 * (e.g. operator types actually in the DAG), never to drive the UI. The test
 * provisions its own local computing unit and workflow and removes both.
 *
 * Usage (from frontend/, with the local stack up — see bin/local-dev.sh):
 *   PROBE_MODEL=claude-haiku-4.5 node e2e/agent-panel.e2e.mjs
 *   (PROBE_MODEL defaults to claude-haiku-4.5; any model on the LLM gateway works)
 */
import { chromium } from "../node_modules/playwright/index.mjs";
import fs from "node:fs";

const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
const CU = process.env.CU_BASE ?? "http://localhost:8888";
const CU_URI = process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085";
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4.5";
const OUT_DIR = process.env.OUT_DIR ?? "./fe-e2e-out";
const TURN_TIMEOUT = Number(process.env.TURN_TIMEOUT_MS ?? "420000");
const HEADLESS = process.env.HEADFUL ? false : true;
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// Bring our own computing unit; the workspace is pointed at it by name (selectComputingUnit).
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
async function terminateComputingUnit(cuid) {
  await api(CU, "DELETE", `/api/computing-unit/${cuid}/terminate`);
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
async function deleteWorkflow(wid) {
  await api(WEB, "POST", "/api/workflow/delete", { wids: [wid] });
}
async function agentsForWorkflow(wid) {
  const r = await api(AGENT, "GET", "/api/agents");
  return (r.json?.agents ?? []).filter(a => a.delegate?.workflowId === wid);
}
async function operatorsOf(agentId) {
  return (await api(AGENT, "GET", `/api/agents/${agentId}/workflow`)).json?.workflow?.operators ?? [];
}

// ---------- UI helpers ----------
function chat(page) {
  return page.locator("texera-agent-chat").last();
}
// Any agent of another workflow shows as a tab, and under headless Chromium a
// tab pane can linger in its `ant-tabs-switch-leave` state over the panel and
// swallow real clicks; dispatch clicks inside the panel on the element itself.
async function domClick(locator) {
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.evaluate(el => el.click());
}
async function openAgentPanel(page) {
  const docked = page.locator("#agent-docked-button");
  if (await docked.isVisible().catch(() => false)) await docked.click();
  await page.locator("#agent-container #content").waitFor({ state: "visible", timeout: 20000 });
}
// A new workflow attaches to the first unit the service lists as running,
// which can be a stale one; attach this run's own unit.
async function selectComputingUnit(page, name) {
  await page.locator(".computing-units-dropdown-button").click();
  const option = page.locator(".computing-unit-option", { hasText: name }).first();
  await option.waitFor({ timeout: 15000 });
  await option.click();
  await sleep(1500);
}
async function createAgentViaUI(page, modelId, name) {
  // With several agent tabs the strip overflows and "+ Agent" scrolls out under the canvas.
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
  // Enabled only once the workspace connected to a computing unit.
  await btn.waitFor({ state: "visible" });
  await page.waitForFunction(el => !el.disabled, await btn.elementHandle(), { timeout: 60000 });
  await domClick(btn);
  await page.locator(".agent-tab-name", { hasText: name }).waitFor({ timeout: 30000 });
  await chat(page).locator("textarea").waitFor({ timeout: 30000 });
}
async function sendAndWait(page, text, { timeout = TURN_TIMEOUT } = {}) {
  const c = chat(page);
  const before = await c.locator("[data-step-id]").count();
  const ta = c.locator("textarea");
  await page.waitForFunction(el => !el.disabled, await ta.elementHandle(), { timeout: 60000 });
  await ta.fill(text);
  await domClick(c.locator(".input-area button.ant-btn-primary"));
  // Turn is running while the loading indicator / stop button shows.
  await c
    .locator(".loading-message, .input-area button.ant-btn-dangerous")
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const generating =
      (await c.locator(".loading-message").count()) > 0 ||
      (await c.locator(".input-area button.ant-btn-dangerous").count()) > 0;
    if (!generating && (await c.locator("[data-step-id]").count()) > before) break;
    await sleep(1000);
  }
  const after = await c.locator("[data-step-id]").count();
  return { before, after };
}
async function lastStepText(page) {
  return (await chat(page).locator("[data-step-id]").last().innerText()).replace(/\s+/g, " ");
}
// The mini-map draws a second JointJS paper over the same graph, so every
// operator label exists twice in the DOM; count the main editor's only.
async function canvasOperatorNames(page) {
  return (
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("text.texera-operator-name, .texera-operator-name"))
        .filter(el => !el.closest("texera-mini-map"))
        .map(el => el.textContent ?? "")
    )
  )
    .map(s => s.trim())
    .filter(Boolean);
}
// What the main editor draws for each operator: the label above the box, the
// caption inside it and its icon. A wrapped caption is one <tspan> per line.
async function canvasOperatorBoxes(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll("g.joint-element[model-id]"))
        .filter(el => !el.closest("texera-mini-map"))
        .map(el => {
          const text = selector => {
            const node = el.querySelector(selector);
            const lines = node ? Array.from(node.querySelectorAll("tspan")) : [];
            const raw = lines.length ? lines.map(line => line.textContent).join(" ") : node?.textContent ?? "";
            return raw.replace(/\s+/g, " ").trim();
          };
          const icon = el.querySelector(".texera-operator-icon");
          return [
            el.getAttribute("model-id"),
            {
              label: text(".texera-operator-friendly-name"),
              caption: text(".texera-operator-name"),
              icon: icon?.getAttribute("xlink:href") ?? icon?.getAttribute("href") ?? "",
            },
          ];
        })
    )
  );
}
// Highlight one operator the way a click on its box does (JointJS listens for
// mousedown on the cell); the agent panel can cover the box, so dispatch it.
async function highlightOperator(page, operatorId) {
  const box = page.locator(`texera-workflow-editor g.joint-element[model-id="${operatorId}"]`).first();
  await box.waitFor({ timeout: 10000 });
  await box.locator(".texera-operator-icon").evaluate(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: x + width / 2, clientY: y + height / 2, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new MouseEvent("mouseup", at));
  });
}
async function openSettingsModal(page) {
  await domClick(chat(page).locator('button[nztooltiptitle="View system prompt"]'));
  const modal = page.locator(".ant-modal", { hasText: "Agent System Information" });
  await modal.waitFor({ timeout: 10000 });
  await modal.locator(".ant-tabs-tab", { hasText: "Parameters" }).click();
  return modal;
}
async function closeModal(page) {
  await page.keyboard.press("Escape");
  await page
    .locator(".ant-modal")
    .first()
    .waitFor({ state: "hidden", timeout: 10000 })
    .catch(() => {});
}
function paramItem(page, modal, labelText) {
  return modal.locator(".settings-param-item", {
    has: page.locator(".settings-param-label", { hasText: new RegExp(`^\\s*${labelText}\\s*$`) }),
  });
}
async function setSelectParam(page, modal, labelText, optionText) {
  const item = paramItem(page, modal, labelText);
  await item.locator("nz-select").click();
  const opt = page.locator(
    `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${optionText}"]`
  );
  await opt.first().waitFor({ timeout: 10000 });
  await opt.first().click();
  await item.locator("button", { hasText: "Save" }).click();
}
async function selectOptions(page, modal, labelText) {
  const item = paramItem(page, modal, labelText);
  await item.locator("nz-select").click();
  const dd = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await dd.first().waitFor({ timeout: 10000 });
  const opts = await dd
    .first()
    .locator(".ant-select-item-option")
    .evaluateAll(els => els.map(e => e.getAttribute("title") ?? e.textContent ?? ""));
  // Close by clicking the select again (Escape is unreliable for nz-select).
  await item.locator("nz-select").click();
  await dd
    .first()
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
  return opts.map(s => s.trim());
}

// ---------- main ----------
async function main() {
  await login();
  const unitName = `fe-e2e ${Date.now()}`;
  const cuid = await createComputingUnit(unitName);
  const wid = await createWorkflow(`fe-e2e ${Date.now()}`);
  console.log("workflow", wid, "computing unit", cuid, "model", MODEL);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(t => {
    try {
      localStorage.setItem("access_token", t);
    } catch {}
  }, token);
  const page = await context.newPage();
  // The panel uses window.confirm() for "delete agent"; accept it.
  page.on("dialog", d => d.accept().catch(() => {}));
  const consoleErrors = [];
  page.on("console", m => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  // Every settings save the UI sends, with the agent-service's answer.
  const settingsSaves = [];
  page.on("response", r => {
    if (r.request().method() === "PATCH" && /\/api\/agents\/[^/]+\/settings$/.test(r.url()))
      settingsSaves.push(`${r.request().postData()}→${r.status()}`);
  });
  const shot = async name => page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false }).catch(() => {});

  try {
    await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded" });
    await page
      .locator("texera-workflow-editor, #workflow-editor, .texera-workflow-editor")
      .first()
      .waitFor({ timeout: 60000 });
    // The workspace is laid out ~200px wider than the viewport while the left
    // nav is expanded (right-anchored panel + minimap get clipped — pre-existing
    // dashboard layout quirk). Collapse the nav so the agent panel is fully
    // on-screen and receives mouse events.
    const trigger = page.locator(".ant-layout-sider-trigger");
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      await sleep(600);
    }
    await selectComputingUnit(page, unitName);
    await openAgentPanel(page);
    await shot("01-panel-open");

    // ===== 1. Agent features (native mode, the default) =====
    await createAgentViaUI(page, MODEL, "e2e-native");
    let agents = await agentsForWorkflow(wid);
    check(
      "UI created agent bound to this workflow",
      agents.length === 1 && agents[0].name === "e2e-native",
      JSON.stringify(agents.map(a => ({ id: a.id, mode: a.settings?.agentMode, ctx: a.settings?.contextMode })))
    );
    const nativeAgent = agents[0];
    check(
      "new agent defaults: native mode + delta context",
      nativeAgent.settings?.agentMode === "native" && nativeAgent.settings?.contextMode === "delta"
    );
    await shot("02-agent-created");

    const t1 = await sendAndWait(
      page,
      "Build a table with columns id (1, 2, 3) and value (10, 20, 30), run it, and answer with the sum of value."
    );
    check("turn 1: steps streamed into chat", t1.after > t1.before + 1, `steps ${t1.before}→${t1.after}`);
    await shot("03-turn1-done");
    const opsT1 = await operatorsOf(nativeAgent.id);
    check(
      "turn 1: agent DAG has ≥1 operator",
      opsT1.length >= 1,
      opsT1.map(o => `${o.operatorID}:${o.operatorType}`).join(",")
    );
    let names = await canvasOperatorNames(page);
    check(
      "turn 1: canvas renders the agent's operators",
      names.length === opsT1.length,
      `canvas=${names.length} dag=${opsT1.length}`
    );
    let answer = await lastStepText(page);
    check("turn 1: final answer contains 60", /\b60\b/.test(answer), answer.slice(0, 120));

    // ----- native operators look like Texera operators, not the UDF that runs them -----
    const nativeOps = opsT1.filter(o => o.nativeOp);
    check("turn 1: every operator carries its native definition", nativeOps.length === opsT1.length);
    const nativeTypeName = o => o.nativeOp.registeredName ?? o.nativeOp.type;
    let boxes = await canvasOperatorBoxes(page);
    // A label too wide for the box is cut to fit, but keeps the start of the type.
    const labelsType = (label, o) => {
      const full = `${o.operatorID}: ${nativeTypeName(o)}`;
      const kept = label.endsWith("…") ? label.slice(0, -1) : null;
      return label === full || (kept !== null && full.startsWith(kept) && kept.length > `${o.operatorID}: `.length);
    };
    const misdrawn = nativeOps.filter(o => {
      const box = boxes[o.operatorID];
      return !box || !labelsType(box.label, o) || /\/(DataProcessing|DataLoading)\.png$/.test(box.icon);
    });
    check(
      "canvas labels each native operator with its native type and icon",
      nativeOps.length > 0 && misdrawn.length === 0,
      nativeOps.map(o => `${boxes[o.operatorID]?.label} [${boxes[o.operatorID]?.icon}]`).join(" | ")
    );
    const icons = [...new Set(nativeOps.map(o => boxes[o.operatorID]?.icon).filter(Boolean))];
    const iconsLoad = await page.evaluate(
      hrefs =>
        Promise.all(
          hrefs.map(href => fetch(href).then(r => r.ok && (r.headers.get("content-type") ?? "").startsWith("image/")))
        ),
      icons
    );
    check("native operator icons load as images", icons.length > 0 && iconsLoad.every(Boolean), icons.join(", "));

    const shown = nativeOps[nativeOps.length - 1];
    await highlightOperator(page, shown.operatorID);
    const opPanel = page.locator("texera-workflow-editor texera-agent-interaction");
    const panelShown = await opPanel
      .locator(".op-id", { hasText: shown.operatorID })
      .waitFor({ timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    const actionNames = panelShown ? (await opPanel.locator(".op-action").allTextContents()).map(t => t.trim()) : [];
    check(
      "selecting a native operator opens its panel: Run, Edit, Feedback",
      actionNames.join(",") === "Run,Edit,Feedback",
      `${shown.operatorID}: ${actionNames.join(",")}`
    );
    if (panelShown) {
      check(
        "the panel names the operator's native type",
        (await opPanel.locator(".op-type").innerText()).trim() === nativeTypeName(shown)
      );
      check(
        "the property editor stays closed for a native operator",
        !(await page.locator("#right-container").isVisible())
      );
      await domClick(opPanel.locator(".edit-action"));
      const about = await opPanel
        .locator(".about summary")
        .waitFor({ timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      const preview = (
        await opPanel
          .locator(".preview-code")
          .innerText()
          .catch(() => "")
      ).trim();
      check(
        "Edit shows the statement it saves and the catalog entry from agent-service",
        about && preview.startsWith(`set ${shown.operatorID}:`),
        preview.slice(0, 120)
      );
      await shot("03b-native-panel");
      await domClick(opPanel.locator(".cancel-edit"));
      await domClick(opPanel.locator(".op-close"));
    }
    const steps1 = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/react-steps`)).json.steps;
    const withAccess = steps1.filter(s => s.operatorAccess && Object.keys(s.operatorAccess).length > 0);
    check(
      "steps carry operatorAccess (server-derived)",
      withAccess.length >= 1,
      `${withAccess.length}/${steps1.length}`
    );

    // hover a tool-call step → canvas label "<agent>: added"
    const hoverCard = chat(page).locator(".react-card-message [data-step-id]").first();
    if ((await hoverCard.count()) > 0) {
      await page.mouse.move(700, 700);
      await sleep(200);
      let hoverMode = "mouse";
      await hoverCard.hover({ timeout: 5000 }).catch(async () => {
        // Panel may extend past the viewport edge (pre-existing layout quirk);
        // drive the same (mouseenter) handler through the DOM instead.
        hoverMode = "dispatched mouseenter";
        await hoverCard.evaluate(el => el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })));
      });
      let labels = [];
      for (let i = 0; i < 32 && labels.length === 0; i++) {
        if (i === 12 && hoverMode === "mouse") {
          // Under headless Chromium the previously selected tab pane can linger in
          // its `ant-tabs-switch-leave` state and intercept pointer events over the
          // chat; fall back to the same (mouseenter) handler via the DOM.
          hoverMode = "dispatched mouseenter (mouse intercepted by leaving tab pane)";
          await hoverCard.evaluate(el => el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })));
        }
        await sleep(250);
        labels = (
          await page.evaluate(() =>
            Array.from(document.querySelectorAll(".texera-operator-agent-action-progress")).map(
              e => e.textContent ?? ""
            )
          )
        )
          // JointJS renders spaces inside SVG text as NBSP — match any whitespace.
          .filter(t => /e2e-native:\s(added|modified|viewed)/.test(t));
      }
      check(
        "hover step → canvas shows agent action label",
        labels.length >= 1,
        `${[...new Set(labels)].slice(0, 3).join(" | ")} (${hoverMode})`
      );
      await shot("04-hover-label");
      await page.mouse.move(5, 5);
    } else {
      check("hover step → canvas shows agent action label", false, "no react-card step found");
    }

    // snapshot tree shows nodes
    const treeNodes = await chat(page).locator(".snapshot-node").count();
    check("snapshot tree renders ≥1 node", treeNodes >= 1, `nodes=${treeNodes}`);

    // ===== settings modal =====
    let modal = await openSettingsModal(page);
    const modeOpts = await selectOptions(page, modal, "Agent Mode");
    check("Agent Mode select offers exactly Native/Code", modeOpts.join(",") === "Native,Code", modeOpts.join(","));
    const ctxOpts = await selectOptions(page, modal, "Context Mode");
    check(
      "Context Mode select offers exactly Latest/Delta (no Full)",
      ctxOpts.length === 2 && ctxOpts.includes("Latest") && ctxOpts.includes("Delta"),
      ctxOpts.join(",")
    );
    await setSelectParam(page, modal, "Context Mode", "Latest");
    await sleep(500);
    await setSelectParam(page, modal, "Data Evidence", "Disabled");
    await sleep(500);
    await setSelectParam(page, modal, "Flow Evidence", "Enabled");
    await sleep(500);
    await closeModal(page);
    let s = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/settings`)).json;
    check("settings saved from UI: contextMode=latest", s.contextMode === "latest", `contextMode=${s.contextMode}`);
    check(
      "settings saved from UI: dataEvidence=false, flowEvidence=true",
      s.dataEvidence === false && s.flowEvidence === true,
      `dataEvidence=${s.dataEvidence} flowEvidence=${s.flowEvidence}`
    );
    // re-open: the UI must read the values back (not always the defaults)
    modal = await openSettingsModal(page);
    const shownData = (await paramItem(page, modal, "Data Evidence").locator("nz-select").innerText()).trim();
    const shownFlow = (await paramItem(page, modal, "Flow Evidence").locator("nz-select").innerText()).trim();
    check(
      "settings modal reads evidence back (Data Disabled, Flow Enabled)",
      /Disabled/.test(shownData) && /Enabled/.test(shownFlow),
      `data=${shownData} flow=${shownFlow}`
    );
    await setSelectParam(page, modal, "Data Evidence", "Enabled");
    await sleep(500);
    await setSelectParam(page, modal, "Flow Evidence", "Disabled");
    await sleep(500);
    await setSelectParam(page, modal, "Context Mode", "Delta");
    await sleep(500);
    await setSelectParam(page, modal, "Operator Doc", "Enabled");
    await sleep(500);
    await closeModal(page);
    s = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/settings`)).json;
    check("settings saved from UI: operatorDoc=true", s.operatorDoc === true, `operatorDoc=${s.operatorDoc}`);
    const prompt = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/system-info`)).json?.systemPrompt ?? "";
    check(
      "operator doc rebuilds the prompt: instruction plus documented examples",
      prompt.includes("one-line `doc='...'`") && /, doc='[^']+'\)/.test(prompt)
    );
    check(
      "every settings save from the UI succeeded",
      settingsSaves.length >= 6 && settingsSaves.every(save => /→2\d\d$/.test(save)),
      settingsSaves.join(" ")
    );
    await shot("05-settings");

    // ===== 2. Versioning: checkout + branch =====
    const t2 = await sendAndWait(
      page,
      "Now keep only the rows of that table whose value is greater than 15, run it, and answer with how many rows remain."
    );
    check("turn 2: more steps", t2.after > t2.before, `steps ${t2.before}→${t2.after}`);
    const opsT2 = await operatorsOf(nativeAgent.id);
    check("turn 2: DAG grew", opsT2.length > opsT1.length, `${opsT1.length}→${opsT2.length}`);
    answer = await lastStepText(page);
    check("turn 2: answer contains 2", /\b2\b|\btwo\b/i.test(answer), answer.slice(0, 120));
    const addedT2 = opsT2.filter(o => o.nativeOp && !opsT1.some(p => p.operatorID === o.operatorID));
    const documented = addedT2.filter(o => o.nativeOp.doc?.trim());
    check(
      "turn 2 (operator doc on): every new operator carries a doc",
      addedT2.length > 0 && documented.length === addedT2.length,
      addedT2.map(o => `${o.operatorID}: ${o.nativeOp.doc ?? "(none)"}`).join(" | ")
    );
    boxes = await canvasOperatorBoxes(page);
    // A long doc is ellipsized to fit the box; its opening words show.
    const captioned = documented.filter(o =>
      boxes[o.operatorID]?.caption.startsWith(o.nativeOp.doc.replace(/\s+/g, " ").trim().slice(0, 20))
    );
    check(
      "canvas captions a documented operator with its doc",
      documented.length > 0 && captioned.length === documented.length,
      documented.map(o => boxes[o.operatorID]?.caption).join(" | ")
    );
    let tree = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/snapshot-tree`)).json;
    const nodesBefore = tree.nodes.length;
    check("tree has ≥2 snapshots after two turns", nodesBefore >= 2, `nodes=${nodesBefore}`);
    await shot("06-turn2");

    // click an earlier (non-active) snapshot node → checkout
    const uiNodes = chat(page).locator(".snapshot-node");
    const n = await uiNodes.count();
    let checkedOut = false;
    for (let i = 0; i < n && !checkedOut; i++) {
      const node = uiNodes.nth(i);
      const cls = (await node.getAttribute("class")) ?? "";
      if (cls.includes("is-active") || cls.includes("is-root")) continue;
      await domClick(node);
      checkedOut = true;
    }
    await sleep(2500);
    const opsAfterCheckout = (await operatorsOf(nativeAgent.id)).length;
    check(
      "checkout earlier snapshot via tree click → HEAD moved back (fewer operators)",
      checkedOut && opsAfterCheckout < opsT2.length,
      `ops now=${opsAfterCheckout} (was ${opsT2.length})`
    );
    names = await canvasOperatorNames(page);
    check(
      "canvas follows checkout (operator count matches HEAD)",
      names.length === opsAfterCheckout,
      `canvas=${names.length} head=${opsAfterCheckout}`
    );
    const visibleSteps = await chat(page).locator("[data-step-id]").count();
    check(
      "chat shows only steps on the checked-out branch",
      visibleSteps < t2.after,
      `visible=${visibleSteps} total=${t2.after}`
    );
    await shot("07-checkout");

    // branch: new message from the earlier HEAD
    const t3 = await sendAndWait(
      page,
      "Add a column total equal to value times 3, run it, and answer with the largest total."
    );
    check("turn 3 (branch): steps streamed", t3.after > t3.before, `steps ${t3.before}→${t3.after}`);
    answer = await lastStepText(page);
    check("turn 3 (branch): answer contains 90", /\b90\b/.test(answer), answer.slice(0, 120));
    tree = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/snapshot-tree`)).json;
    const parents = new Map();
    for (const nd of tree.nodes) parents.set(nd.parentId, (parents.get(nd.parentId) ?? 0) + 1);
    const forked = [...parents.values()].some(c => c >= 2);
    check(
      "snapshot tree forked (a node has ≥2 children)",
      forked && tree.nodes.length > nodesBefore,
      `nodes=${tree.nodes.length}, fanout=${JSON.stringify([...parents.values()])}`
    );
    const offPath = await chat(page).locator(".snapshot-node.off-path").count();
    check("UI tree shows the abandoned branch as off-path", offPath >= 1, `off-path nodes=${offPath}`);
    await shot("08-branch");

    // clear (after a finished turn) — the button is *ngIf="isAvailable()"
    let clearErr = "";
    try {
      const clearBtn = chat(page).locator('.chat-toolbar button[nztooltiptitle="Clear chat history"]');
      await clearBtn.waitFor({ state: "attached", timeout: 15000 });
      await clearBtn.click({ timeout: 5000 }).catch(() => clearBtn.evaluate(el => el.click()));
    } catch (e) {
      clearErr = String(e).split("\n")[0];
    }
    await sleep(1500);
    const stepsAfterClear = (await api(AGENT, "GET", `/api/agents/${nativeAgent.id}/react-steps`)).json.steps.length;
    check("clear from UI empties history", stepsAfterClear === 0, `steps=${stepsAfterClear} ${clearErr}`);
    check("chat empty after clear", (await chat(page).locator("[data-step-id]").count()) === 0);

    // ===== 3. Code mode, switched from the settings modal =====
    await createAgentViaUI(page, MODEL, "e2e-code");
    const codeAgent = (await agentsForWorkflow(wid)).find(a => a.name === "e2e-code");
    check("second agent created from the UI", !!codeAgent);
    modal = await openSettingsModal(page);
    await setSelectParam(page, modal, "Agent Mode", "Code");
    await sleep(1000);
    await closeModal(page);
    s = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/settings`)).json;
    check("agent mode switched to code from UI", s.agentMode === "code", `agentMode=${s.agentMode}`);
    const tools = ((await api(AGENT, "GET", `/api/agents/${codeAgent.id}/system-info`)).json?.tools ?? []).map(
      t => t.name
    );
    check(
      "code mode tools: createOrModifyOperator (not the native dataflow tool)",
      tools.includes("createOrModifyOperator") && !tools.includes("dataflow"),
      tools.join(",")
    );
    const c1 = await sendAndWait(
      page,
      "Create ONE operator that outputs a table with columns id (1,2,3) and value (10,20,30). Execute it and answer with the sum of value. Be minimal: one operator, then answer."
    );
    check("code turn: steps streamed", c1.after > c1.before + 1, `steps ${c1.before}→${c1.after}`);
    const codeOps = await operatorsOf(codeAgent.id);
    check(
      "code turn: DAG holds a Python operator",
      codeOps.some(o => o.operatorType === "DataLoading" || o.operatorType === "DataProcessing"),
      codeOps.map(o => `${o.operatorID}:${o.operatorType}`).join(",")
    );
    answer = await lastStepText(page);
    check("code turn: final answer contains 60", /\b60\b/.test(answer), answer.slice(0, 120));
    await shot("09-code-mode");

    // switching tabs back to first agent keeps it usable
    await domClick(page.locator(".agent-tab-name", { hasText: "e2e-native" }));
    await chat(page).locator("textarea").waitFor({ timeout: 10000 });
    check("tab switch back to first agent", true);

    // delete agent from tab close
    const closeBtn = page.locator(".agent-tab-title", { hasText: "e2e-code" }).locator(".agent-tab-close");
    await closeBtn.click({ timeout: 5000 }).catch(() => closeBtn.evaluate(el => el.click()));
    await sleep(2000);
    agents = await agentsForWorkflow(wid);
    check(
      "closing tab deletes agent on server",
      !agents.some(a => a.name === "e2e-code"),
      agents.map(a => a.name).join(",")
    );
    await shot("10-final");
  } catch (e) {
    check("script completed without exception", false, String(e).slice(0, 1200));
    await shot("99-error");
  } finally {
    // NG0100 (ExpressionChangedAfterItHasBeenChecked) in WorkspaceComponent and
    // the 403 on a permission probe are pre-existing dev-mode noise unrelated to
    // the agent panel — reported separately, not counted as failures.
    const known = consoleErrors.filter(e => /NG0100|403 \(Forbidden\)/.test(e));
    const errs = consoleErrors.filter(e => !/favicon|ERR_|WebSocket is closed|404|NG0100|403 \(Forbidden\)/.test(e));
    check(
      "no unexpected browser console errors",
      errs.length === 0,
      errs.slice(0, 3).join(" | ") || `(known pre-existing: ${known.length})`
    );
    for (const a of await agentsForWorkflow(wid)) await api(AGENT, "DELETE", `/api/agents/${a.id}`);
    await deleteWorkflow(wid);
    await terminateComputingUnit(cuid);
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
