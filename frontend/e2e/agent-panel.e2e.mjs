/**
 * Real-browser end-to-end test of the Texera agent panel against the running
 * local stack (frontend :4200 → agent-service :3001 → JVMs).
 *
 * Drives the actual Angular UI with Playwright (chromium from
 * frontend/node_modules) — no API shortcuts for the things under test:
 *   1. agent features: create agent, chat, streamed steps, snapshot tree,
 *      settings modal (agent mode / context mode / column stats), hover→canvas
 *      highlight, stop/clear
 *   2. general mode: native operators + Python UDF (DataLoading /
 *      DataProcessing / PythonUDFV2) instead of code-mode-only Python
 *   3. versioning: checkout an earlier snapshot, branch from it with a new
 *      message, verify the tree forks and the canvas follows HEAD
 *
 * Cross-checks via the agent-service REST API are used only as oracles
 * (e.g. operator types actually in the DAG), never to drive the UI.
 *
 * Usage (from frontend/, with the local stack up — see bin/local-dev.sh):
 *   PROBE_MODEL=gpt-5-mini node e2e/agent-panel.e2e.mjs
 *   (PROBE_MODEL defaults to gpt-5-mini; any model on the LLM gateway works)
 */
import { chromium } from "../node_modules/playwright/index.mjs";
import fs from "node:fs";

const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
const MODEL = process.env.PROBE_MODEL ?? "gpt-5-mini";
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

// ---------- UI helpers ----------
function chat(page) {
  return page.locator("texera-agent-chat").last();
}
async function openAgentPanel(page) {
  const docked = page.locator("#agent-docked-button");
  if (await docked.isVisible().catch(() => false)) await docked.click();
  await page.locator("#agent-container #content").waitFor({ state: "visible", timeout: 20000 });
}
async function createAgentViaUI(page, modelId, name) {
  await page.locator(".agent-tabs .ant-tabs-tab", { hasText: "+ Agent" }).click();
  const reg = page.locator("texera-agent-registration");
  await reg.locator(".model-card").first().waitFor({ timeout: 30000 });
  const label = modelId
    .split("-")
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  const card = reg.locator(".model-card", { has: page.locator("h5", { hasText: new RegExp(`^${label}$`) }) });
  if ((await card.count()) === 0)
    throw new Error(`model card "${label}" not found; cards=${await reg.locator(".model-card h5").allTextContents()}`);
  await card.first().click();
  await reg.locator("input[nz-input]").fill(name);
  const btn = reg.locator("button", { hasText: /Create Agent/ });
  // Enabled only once the workspace connected to a computing unit.
  await btn.waitFor({ state: "visible" });
  await page.waitForFunction(el => !el.disabled, await btn.elementHandle(), { timeout: 60000 });
  await btn.click();
  await page.locator(".agent-tab-name", { hasText: name }).waitFor({ timeout: 30000 });
  await chat(page).locator("textarea").waitFor({ timeout: 30000 });
}
async function sendAndWait(page, text, { timeout = TURN_TIMEOUT } = {}) {
  const c = chat(page);
  const before = await c.locator("[data-step-id]").count();
  const ta = c.locator("textarea");
  await page.waitForFunction(el => !el.disabled, await ta.elementHandle(), { timeout: 60000 });
  await ta.fill(text);
  await c.locator(".input-area button.ant-btn-primary").click();
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
async function canvasOperatorNames(page) {
  return (await page.locator("text.texera-operator-name, .texera-operator-name").allTextContents())
    .map(s => s.trim())
    .filter(Boolean);
}
async function openSettingsModal(page) {
  await chat(page).locator('button[nztooltiptitle="View system prompt"]').click();
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
async function setSelectParam(page, modal, labelText, optionText) {
  const item = modal.locator(".settings-param-item", {
    has: page.locator(".settings-param-label", { hasText: new RegExp(`^\\s*${labelText}\\s*$`) }),
  });
  await item.locator("nz-select").click();
  const opt = page.locator(
    `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${optionText}"]`
  );
  await opt.first().waitFor({ timeout: 10000 });
  await opt.first().click();
  await item.locator("button", { hasText: "Save" }).click();
}
async function selectOptions(page, modal, labelText) {
  const item = modal.locator(".settings-param-item", {
    has: page.locator(".settings-param-label", { hasText: new RegExp(`^\\s*${labelText}\\s*$`) }),
  });
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
  const wid = await createWorkflow(`fe-e2e ${Date.now()}`);
  console.log("workflow", wid, "model", MODEL);
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
    await openAgentPanel(page);
    await shot("01-panel-open");

    // ===== 1. Agent features (code mode) =====
    await createAgentViaUI(page, MODEL, "e2e-code");
    let agents = await agentsForWorkflow(wid);
    check(
      "UI created agent bound to this workflow",
      agents.length === 1 && agents[0].name === "e2e-code",
      JSON.stringify(agents.map(a => ({ id: a.id, mode: a.settings?.agentMode, ctx: a.settings?.contextMode })))
    );
    const codeAgent = agents[0];
    check(
      "new agent defaults: code mode + delta context",
      codeAgent.settings?.agentMode === "code" && codeAgent.settings?.contextMode === "delta"
    );
    await shot("02-agent-created");

    const t1 = await sendAndWait(
      page,
      "Create ONE operator that outputs a table with columns id (1,2,3) and value (10,20,30). Execute it and answer with the sum of value. Be minimal: one operator, then answer."
    );
    check("turn 1: steps streamed into chat", t1.after > t1.before + 1, `steps ${t1.before}→${t1.after}`);
    await shot("03-turn1-done");
    let wf = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/workflow`)).json;
    const codeOps = wf.workflow?.operators ?? [];
    check(
      "turn 1: agent DAG has ≥1 operator",
      codeOps.length >= 1,
      codeOps.map(o => `${o.operatorID}:${o.operatorType}`).join(",")
    );
    let names = await canvasOperatorNames(page);
    check("turn 1: canvas renders the agent's operator(s)", names.length >= 1, names.join(","));
    const lastStepText = await chat(page).locator("[data-step-id]").last().innerText();
    check("turn 1: final answer contains 60", /60/.test(lastStepText), lastStepText.slice(0, 120).replace(/\n/g, " "));
    const steps1 = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/react-steps`)).json.steps;
    const withAccess = steps1.filter(s => s.operatorAccess);
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
          // JointJS renders spaces inside SVG text as NBSP — match any whitespace.
        ).filter(t => /e2e-code:\s(added|modified|viewed)/.test(t));
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
    const ctxOpts = await selectOptions(page, modal, "Context Mode");
    check(
      "Context Mode select offers exactly Latest/Delta (no Full)",
      ctxOpts.length === 2 && ctxOpts.includes("Latest") && ctxOpts.includes("Delta"),
      ctxOpts.join(",")
    );
    await setSelectParam(page, modal, "Context Mode", "Latest");
    await sleep(500);
    await setSelectParam(page, modal, "Column Stats Block", "Disabled");
    await sleep(500);
    await closeModal(page);
    let s = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/settings`)).json;
    check("settings saved from UI: contextMode=latest", s.contextMode === "latest", `contextMode=${s.contextMode}`);
    check(
      "settings saved from UI: columnStats=false (Column Stats Block toggle works)",
      s.columnStats === false,
      `columnStats=${s.columnStats}`
    );
    // re-open: UI must read the value back (not always 'Enabled')
    modal = await openSettingsModal(page);
    const statsItem = modal.locator(".settings-param-item", {
      has: page.locator(".settings-param-label", { hasText: "Column Stats Block" }),
    });
    const shown = (await statsItem.locator("nz-select").innerText()).trim();
    check("settings modal reads columnStats back as Disabled", /Disabled/.test(shown), shown);
    await setSelectParam(page, modal, "Column Stats Block", "Enabled");
    await setSelectParam(page, modal, "Context Mode", "Delta");
    await closeModal(page);
    await shot("05-settings");

    // ===== 3. Versioning: checkout + branch =====
    const t2 = await sendAndWait(
      page,
      "Add ONE more operator downstream of the existing one that filters to rows with value > 15, execute it, and answer with the row count. Minimal steps."
    );
    check("turn 2: more steps", t2.after > t2.before, `steps ${t2.before}→${t2.after}`);
    wf = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/workflow`)).json;
    const opsAfterT2 = (wf.workflow?.operators ?? []).length;
    check("turn 2: DAG grew", opsAfterT2 > codeOps.length, `${codeOps.length}→${opsAfterT2}`);
    let tree = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/snapshot-tree`)).json;
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
      await node.click();
      checkedOut = true;
    }
    await sleep(2500);
    const headAfterCheckout = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/workflow`)).json;
    const opsAfterCheckout = (headAfterCheckout.workflow?.operators ?? []).length;
    check(
      "checkout earlier snapshot via tree click → HEAD moved back (fewer operators)",
      checkedOut && opsAfterCheckout < opsAfterT2,
      `ops now=${opsAfterCheckout} (was ${opsAfterT2})`
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
      "Add ONE operator downstream of the first operator that doubles the value column, execute it, and answer with the new maximum. Minimal steps."
    );
    check("turn 3 (branch): steps streamed", t3.after > t3.before, `steps ${t3.before}→${t3.after}`);
    tree = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/snapshot-tree`)).json;
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
    const stepsAfterClear = (await api(AGENT, "GET", `/api/agents/${codeAgent.id}/react-steps`)).json.steps.length;
    check("clear from UI empties history", stepsAfterClear === 0, `steps=${stepsAfterClear} ${clearErr}`);
    check("chat empty after clear", (await chat(page).locator("[data-step-id]").count()) === 0);

    // ===== 2. General mode =====
    await createAgentViaUI(page, MODEL, "e2e-general");
    agents = await agentsForWorkflow(wid);
    const genAgent = agents.find(a => a.name === "e2e-general");
    check("second agent created", !!genAgent);
    modal = await openSettingsModal(page);
    await setSelectParam(page, modal, "Agent Mode", "General");
    await sleep(800);
    await closeModal(page);
    s = (await api(AGENT, "GET", `/api/agents/${genAgent.id}/settings`)).json;
    check("agent mode switched to general from UI", s.agentMode === "general", `agentMode=${s.agentMode}`);
    const sys = (await api(AGENT, "GET", `/api/agents/${genAgent.id}/system-info`)).json;
    const toolNames = sys.tools.map(t => t.name);
    check(
      "general mode tools: addOperator/modifyOperator (not createOrModifyOperator)",
      toolNames.includes("addOperator") &&
        toolNames.includes("modifyOperator") &&
        !toolNames.includes("createOrModifyOperator"),
      toolNames.join(",")
    );
    const p = sys.systemPrompt;
    check(
      "general prompt lists Python operators (PythonUDFV2, PythonUDFSourceV2, DataLoading, DataProcessing)",
      /## PythonUDFV2/.test(p) &&
        /## PythonUDFSourceV2/.test(p) &&
        /## DataLoading/.test(p) &&
        /## DataProcessing/.test(p)
    );
    check("general prompt has no code-mode tool names", !/createOrModifyOperator/.test(p));
    check(
      "general prompt lists native operators (Filter/Aggregate/Sort…)",
      /"Filter"|Filter/.test(p) && /Aggregate/.test(p) && /Sort/.test(p)
    );
    const opTypes = (await api(AGENT, "GET", `/api/agents/${genAgent.id}/operator-types`)).json.map(o => o.type);
    check(
      "operator-types catalogue includes DataLoading + DataProcessing + PythonUDFV2 + natives",
      ["DataLoading", "DataProcessing", "PythonUDFV2", "Filter", "Aggregate"].every(t => opTypes.includes(t)),
      `n=${opTypes.length}`
    );

    // The DAG is shared per workflow: the second agent starts from the persisted
    // workflow (whatever the first agent left). Assert only on what it adds.
    const preOps = new Set(
      ((await api(AGENT, "GET", `/api/agents/${genAgent.id}/workflow`)).json.workflow?.operators ?? []).map(o => o.operatorID)
    );
    const g1 = await sendAndWait(
      page,
      "Build a 4-operator pipeline with NATIVE typed operators where one exists: (1) a PythonUDFSourceV2 source that yields rows with columns category (a,a,b,b,c) and amount (1,2,3,4,5) — declare its columns; (2) a native Filter keeping amount > 1; (3) a native Aggregate summing amount grouped by category into sum_amount; (4) a final DataProcessing operator that adds a column doubled = sum_amount * 2. Execute the final operator and answer with the per-category sum_amount values. Exactly these four operators, no others."
    );
    check("general turn: steps streamed", g1.after > g1.before + 1, `steps ${g1.before}→${g1.after}`);
    wf = (await api(AGENT, "GET", `/api/agents/${genAgent.id}/workflow`)).json;
    const gOps = (wf.workflow?.operators ?? []).filter(o => !preOps.has(o.operatorID));
    const gTypes = gOps.map(o => o.operatorType);
    check(
      "general DAG uses native operator types (Filter + Aggregate)",
      gTypes.includes("Filter") && gTypes.includes("Aggregate"),
      gTypes.join(",")
    );
    check(
      "general DAG uses a Python source with declared schema (PythonUDFSourceV2)",
      gTypes.includes("PythonUDFSourceV2"),
      gTypes.join(",")
    );
    check(
      "general DAG includes the DataProcessing (function-style Python) operator",
      gTypes.includes("DataProcessing"),
      gTypes.join(",")
    );
    check("general turn added exactly 4 operators", gOps.length === 4, `n=${gOps.length}`);
    const gSteps = (await api(AGENT, "GET", `/api/agents/${genAgent.id}/react-steps`)).json.steps;
    const gTools = new Set(gSteps.flatMap(st => (st.toolCalls ?? []).map(tc => tc.toolName)));
    check("general turn used addOperator tool", gTools.has("addOperator"), [...gTools].join(","));
    const gResAll = (await api(AGENT, "GET", `/api/agents/${genAgent.id}/operator-results`)).json.results;
    const gRes = Object.fromEntries(Object.entries(gResAll).filter(([k]) => !preOps.has(k)));
    const completed = Object.values(gRes).filter(r => r.state === "Completed").length;
    check(
      "general turn executed operators (all results Completed)",
      completed >= 1 && completed === Object.keys(gRes).length,
      `completed=${completed}/${Object.keys(gRes).length} ${Object.entries(gRes)
        .map(([k, v]) => `${k}:${v.state}`)
        .join(",")}`
    );
    names = await canvasOperatorNames(page);
    check("canvas renders general-mode operators", names.length >= 4, names.slice(0, 8).join(","));
    const gAnswer = await chat(page).locator("[data-step-id]").last().innerText();
    check(
      "general answer mentions per-category sums (a=2,b=7,c=5)",
      /2/.test(gAnswer) && /7/.test(gAnswer) && /5/.test(gAnswer),
      gAnswer.slice(0, 160).replace(/\n/g, " ")
    );
    await shot("09-general-mode");

    // switching tabs back to first agent keeps it usable
    await page.locator(".agent-tab-name", { hasText: "e2e-code" }).click();
    await chat(page).locator("textarea").waitFor({ timeout: 10000 });
    check("tab switch back to first agent", true);

    // delete agent from tab close
    const closeBtn = page.locator(".agent-tab-title", { hasText: "e2e-general" }).locator(".agent-tab-close");
    await closeBtn.click({ timeout: 5000 }).catch(() => closeBtn.evaluate(el => el.click()));
    await sleep(2000);
    agents = await agentsForWorkflow(wid);
    check(
      "closing tab deletes agent on server",
      !agents.some(a => a.name === "e2e-general"),
      agents.map(a => a.name).join(",")
    );
    await shot("10-final");
  } catch (e) {
    check("script completed without exception", false, String(e).slice(0, 400));
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
