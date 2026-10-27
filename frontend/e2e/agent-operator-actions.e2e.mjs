/**
 * Real-browser end-to-end test of running, editing and giving feedback on the
 * operators a native-mode agent builds, from the operator's panel on the canvas.
 *
 * Drives the Angular UI with Playwright (chromium from frontend/node_modules):
 *   1. the agent builds a small dataflow with a filter
 *   2. selecting the filter opens its panel (Run / Edit / Feedback) instead of
 *      the property editor
 *   3. Edit → change the condition → Save & run: the operator changes, its
 *      result shows in the panel, and the chat records "You edited … and ran it"
 *   4. Run on another operator: its result shows, recorded as "You ran …"
 *   5. an invalid edit is refused with the reason and records nothing
 *   6. Feedback on the filter: the agent answers in light of the user's edit,
 *      and its model input carried the edit and the run
 *   7. versions: each action of the agent's calls and of the canvas is a
 *      version (v1, v2, …): the chat lists the edits, the version tree every
 *      action under its verb; a run is answered by the agent; clicking a
 *      version in the middle of a call restores it, as a step the agent reads
 *   8. docs: the agent writes a one-line doc for every operator and the
 *      canvas boxes show it
 *
 * The agent-service REST API serves as an oracle (operator definitions, steps,
 * the model's input messages); the UI is driven only through the browser. The
 * test provisions its own computing unit and workflow and removes both.
 *
 * Usage (from frontend/, with the local stack up — see bin/local-dev.sh):
 *   PROBE_MODEL=claude-haiku-5.5 node e2e/agent-operator-actions.e2e.mjs
 */
import { chromium } from "../node_modules/playwright/index.mjs";
import fs from "node:fs";

const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
const CU = process.env.CU_BASE ?? "http://localhost:8888";
const CU_URI = process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085";
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";
const OUT_DIR = process.env.OUT_DIR ?? "./fe-e2e-actions-out";
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

// ---------- UI helpers ----------
function chat(page) {
  return page.locator("texera-agent-chat").last();
}
/** The canvas panel of the selected operator. */
function panel(page) {
  return page.locator("texera-workflow-editor texera-agent-interaction");
}
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
// A workflow without an agent opens the panel on the registration.
async function createAgentViaUI(page, modelId, name) {
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
  await page.locator("#agent-container #title", { hasText: name }).waitFor({ timeout: 30000 });
  await chat(page).locator("textarea").waitFor({ timeout: 30000 });
}
async function sendAndWait(page, text, { timeout = TURN_TIMEOUT } = {}) {
  const c = chat(page);
  const before = await c.locator("[data-step-id]").count();
  const ta = c.locator(".input-area textarea");
  await page.waitForFunction(el => !el.disabled, await ta.elementHandle(), { timeout: 60000 });
  await ta.fill(text);
  await domClick(c.locator(".input-area button.ant-btn-primary"));
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
}
/** The agent's final reply of its latest turn. */
async function lastAnswer(agentId) {
  const steps = await stepsOf(agentId);
  return [...steps].reverse().find(s => s.role === "agent" && s.isEnd)?.content ?? "";
}
async function agentIdle(agentId) {
  const agent = (await api(AGENT, "GET", "/api/agents")).json?.agents?.find(a => a.id === agentId);
  return agent?.state === "AVAILABLE";
}
// Selecting an operator is a mousedown on its box (JointJS cell:pointerdown);
// the agent panel can cover the box, so dispatch it on the element.
async function selectOperator(page, operatorId) {
  const box = page.locator(`texera-workflow-editor g.joint-element[model-id="${operatorId}"]`).first();
  await box.waitFor({ timeout: 10000 });
  await box.locator(".texera-operator-icon").evaluate(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: x + width / 2, clientY: y + height / 2, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new MouseEvent("mouseup", at));
  });
  await panel(page).locator(".op-id", { hasText: operatorId }).waitFor({ timeout: 10000 });
}
/** Each chip of the chat's step rows: [label, version]. */
async function stepChips(page) {
  return chat(page)
    .locator(".react-card-action")
    .evaluateAll(chips =>
      chips.map(chip => [
        chip.querySelector(".chip-label")?.textContent?.trim() ?? "",
        chip.querySelector(".chip-version")?.textContent?.trim() ?? "",
      ])
    );
}
/** The version tree's pills, top to bottom. */
async function treeLabels(page) {
  return (await chat(page).locator(".snapshot-node-label").allTextContents()).map(t => t.trim());
}
/** The caption each canvas box shows, by operator id (a wrapped caption is one tspan per line). */
async function canvasCaptions(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll("texera-workflow-editor #workflow-editor g.joint-element[model-id]"))
        // Operators only: region overlays are elements of the paper too.
        .filter(el => el.querySelector(".texera-operator-icon"))
        .map(el => {
          const node = el.querySelector(".texera-operator-name");
          const lines = node ? Array.from(node.querySelectorAll("tspan")).map(line => line.textContent) : [];
          const text = lines.length ? lines.join(" ") : node?.textContent ?? "";
          return [el.getAttribute("model-id"), text.replace(/\s+/g, " ").trim()];
        })
    )
  );
}
/** Wait for the agent to take up a turn of its own (it may already have), then to finish it. */
async function agentTurnDone(agentId) {
  await until(async () => !(await agentIdle(agentId)), 15000, 300);
  return until(() => agentIdle(agentId), TURN_TIMEOUT, 1000);
}
async function userActionRows(page) {
  return (await chat(page).locator(".user-action-text").allTextContents()).map(t => t.replace(/\s+/g, " ").trim());
}

// ---------- main ----------
async function main() {
  await login();
  const unitName = `fe-e2e-actions ${Date.now()}`;
  const cuid = await createComputingUnit(unitName);
  const wid = await createWorkflow(`fe-e2e-actions ${Date.now()}`);
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
    await createAgentViaUI(page, MODEL, "e2e-actions");
    const agent = (await agentsForWorkflow(wid))[0];
    check("agent created on the workflow, native mode", agent?.settings?.agentMode === "native", agent?.modelType);

    // ===== 1. the agent builds a dataflow with a filter =====
    await sendAndWait(
      page,
      "Build a table with columns id (1, 2, 3) and value (10, 20, 30), then keep the rows whose value is greater than 15 with a filter operator. Run it and answer with how many rows remain."
    );
    let answer = await lastAnswer(agent.id);
    check("turn 1: the agent answers 2", /\b2\b|\btwo\b/i.test(answer), answer.slice(0, 120));
    let ops = await operatorsOf(agent.id);
    const filter = ops.find(o => o.nativeOp?.type === "Filter");
    const source = ops.find(o => o.nativeOp && o.operatorID !== filter?.operatorID && !o.nativeOp.inputs?.length);
    check(
      "turn 1: the dataflow has a filter and a source",
      !!filter && !!source,
      ops.map(o => `${o.operatorID}:${o.nativeOp?.type}`).join(", ")
    );
    if (!filter || !source) throw new Error("the agent built no filter; nothing to act on");
    // Docs: agents made in the UI write a one-line doc for each operator, which its box shows.
    const documented = ops.filter(o => o.nativeOp?.doc?.trim());
    check(
      "turn 1: every operator carries a one-line doc",
      documented.length === ops.length,
      ops.map(o => `${o.operatorID}: ${o.nativeOp?.doc ?? "(none)"}`).join(" | ")
    );
    const captions = await canvasCaptions(page);
    check(
      "the canvas boxes show the docs, not the raw expressions",
      documented.length > 0 &&
        documented.every(o =>
          captions[o.operatorID]?.startsWith(o.nativeOp.doc.replace(/\s+/g, " ").trim().slice(0, 20))
        ),
      JSON.stringify(captions)
    );
    // Versions: each edit of the agent's calls made one, listed in its step's row.
    const added = (await stepChips(page)).filter(([label, version]) => /^add /.test(label) && /^v\d+$/.test(version));
    check(
      "the chat lists each edit with the version it made",
      ops.every(o => added.some(([label]) => label === `add ${o.operatorID}`)),
      (await stepChips(page)).map(chip => chip.join(" ")).join(" | ")
    );
    const tree = await treeLabels(page);
    check(
      "the version tree starts at v0 and has a version per edit",
      tree[0] === "v0 start" &&
        ops.every(o => tree.some(label => new RegExp(`^v\\d+ add ${o.operatorID}$`).test(label))),
      tree.join(" | ")
    );
    await shot("01-built");

    // ===== 2. selecting an operator opens its panel, not the property editor =====
    await selectOperator(page, filter.operatorID);
    const actions = (await panel(page).locator(".op-action").allTextContents()).map(t => t.trim());
    check(
      "selecting the filter opens its panel: Run, Edit, Feedback, Explain",
      actions.join(",") === "Run,Edit,Feedback,Explain"
    );
    check(
      "the panel names the operator and its type",
      (await panel(page).locator(".op-type").innerText()).trim() === "Filter"
    );
    check(
      "the floating property editor stays closed for a native operator",
      !(await page.locator("#right-container").isVisible())
    );
    await shot("02-panel");

    // ===== 3. Edit → change the condition → Save & run =====
    await domClick(panel(page).locator(".edit-action"));
    const condition = panel(page)
      .locator("texera-native-operator-editor .field", { hasText: "Condition" })
      .locator("textarea");
    await condition.waitFor({ timeout: 20000 });
    const before = await condition.inputValue();
    const edited = before.replace(/\b15\b/, "25");
    check("the editor shows the filter's condition", before !== edited, before);
    await condition.fill(edited);
    const preview = await panel(page).locator(".preview-code").innerText();
    check("the statement preview follows the edit", preview.includes(edited), preview);
    await shot("03-editing");
    const stepsBefore = (await stepsOf(agent.id)).length;
    await domClick(panel(page).locator(".save-run-edit"));
    const shape = await until(async () => {
      const text = await panel(page).locator(".data-output .data-shape").innerText();
      return /^1 row\b/.test(text.trim()) && text.trim();
    }, 90000);
    check("Save & run shows the new result in the panel: 1 row", !!shape, shape ?? "(no result shape)");
    ops = await operatorsOf(agent.id);
    const now = ops.find(o => o.operatorID === filter.operatorID)?.nativeOp?.source ?? "";
    check("the filter's condition changed", now.includes("> 25") && !now.includes("> 15"), now);
    let rows = await userActionRows(page);
    check(
      "the chat records the edit and run",
      rows.some(r => r === `You edited \`${filter.operatorID}\` and ran it · 1 row`),
      rows.join(" | ")
    );
    let steps = await stepsOf(agent.id);
    const editStep = steps[stepsBefore];
    check(
      "the edit is one user step the agent reads",
      editStep?.role === "user" &&
        editStep?.messageSource === "action" &&
        editStep?.userAction?.kind === "edit" &&
        editStep?.content?.startsWith(`I edited and ran \`${filter.operatorID}\` on the canvas.`),
      JSON.stringify(editStep?.userAction)
    );
    const userVersion = editStep?.userAction?.version;
    // The tree shows each version once the canvas has played it.
    const userVersions = await until(
      async () =>
        (await chat(page)
          .locator(".snapshot-node.by-user", { hasText: `modify ${filter.operatorID}` })
          .count()) === 1 &&
        (await chat(page)
          .locator(".snapshot-node.by-user", { hasText: `v${userVersion} show ${filter.operatorID}` })
          .count()) === 1,
      10000
    );
    check(
      "the edit and its run are versions of their own, by the user, in the tree",
      typeof userVersion === "number" && !!userVersions,
      `v${userVersion}: ${(await treeLabels(page)).join(" | ")}`
    );
    // The agent answers the run in a turn of its own.
    await agentTurnDone(agent.id);
    steps = await stepsOf(agent.id);
    const response = steps.find(s => s.messageId === editStep?.messageId && s.role === "agent" && s.isEnd);
    check(
      "the agent answers the edit-and-run in its own turn",
      !!response && /\b1\b|\bone\b|\b25\b|\b30\b/i.test(response.content ?? ""),
      response?.content?.slice(0, 200) ?? "(no reply)"
    );
    // The edit kept the doc written for "> 15"; the agent gives it one that fits.
    const refreshed = (await operatorsOf(agent.id)).find(o => o.operatorID === filter.operatorID)?.nativeOp;
    check(
      "the agent rewrites the doc to fit the user's change",
      !!refreshed?.doc && !/\b15\b/.test(refreshed.doc) && refreshed.source.includes("> 25"),
      `${refreshed?.doc} | ${refreshed?.source}`
    );
    check(
      "the panel stays open on the operator after the canvas reloads",
      (await panel(page).locator(".op-id").innerText()).trim() === filter.operatorID
    );
    await shot("04-edited");

    // ===== 4. Run another operator =====
    await selectOperator(page, source.operatorID);
    await domClick(panel(page).locator(".run-action"));
    // The run is done when the chat's row for it says so and Run is available again.
    const ranRow = `You ran \`${source.operatorID}\` · 3 rows`;
    const ran = await until(
      async () =>
        (await userActionRows(page)).includes(ranRow) &&
        (await panel(page).locator(".run-action").innerText()).trim() === "Run",
      90000
    );
    rows = await userActionRows(page);
    check("the chat records the run", !!ran, rows.join(" | "));
    const sourceShape = (
      await panel(page)
        .locator(".data-output .data-shape")
        .innerText()
        .catch(() => "")
    ).trim();
    check("Run shows the source's result: 3 rows", /^3 rows\b/.test(sourceShape), sourceShape || "(no result shape)");
    await agentTurnDone(agent.id);
    steps = await stepsOf(agent.id);
    const runStep = [...steps].reverse().find(s => s.userAction?.kind === "run");
    check(
      "the agent answers the run",
      steps.some(s => s.messageId === runStep?.messageId && s.role === "agent" && s.isEnd),
      runStep?.messageId
    );
    await shot("05-run");

    // ===== 5. an invalid edit is refused, with the reason, and records nothing =====
    await selectOperator(page, filter.operatorID);
    await domClick(panel(page).locator(".edit-action"));
    await condition.waitFor({ timeout: 20000 });
    await condition.fill("lambda row: row['value'] >");
    const stepsBeforeInvalid = (await stepsOf(agent.id)).length;
    await domClick(panel(page).locator(".save-edit"));
    const reason = await until(async () => (await panel(page).locator(".editor-error").innerText()).trim(), 30000);
    check("an invalid edit shows why", !!reason, reason?.slice(0, 120));
    check("an invalid edit records nothing", (await stepsOf(agent.id)).length === stepsBeforeInvalid);
    await shot("06-invalid");
    await domClick(panel(page).locator(".cancel-edit"));

    // ===== 6. Feedback: the agent answers in light of the user's edit =====
    await domClick(panel(page).locator(".feedback-action"));
    const box = panel(page).locator(".feedback-input");
    await box.waitFor({ timeout: 10000 });
    await box.fill("Why does this keep only one row now? Answer in one sentence.");
    await domClick(panel(page).locator(".send-btn"));
    await until(async () => !(await agentIdle(agent.id)), 20000, 300);
    await until(() => agentIdle(agent.id), TURN_TIMEOUT, 1000);
    answer = await lastAnswer(agent.id);
    check(
      "the agent's reply reflects the user's edit",
      /\b25\b|\b30\b|\bone\b|\b1\b/i.test(answer),
      answer.slice(0, 200)
    );
    steps = await stepsOf(agent.id);
    const feedbackAt = steps.findIndex(s => s.messageSource === "feedback" && s.content?.includes(filter.operatorID));
    const replied = steps.slice(feedbackAt + 1).find(s => s.role === "agent" && s.inputMessages);
    const input = JSON.stringify(replied?.inputMessages ?? []);
    check("feedback names the operator", feedbackAt >= 0, steps[feedbackAt]?.content?.slice(0, 100));
    check(
      "the agent's model input carried the user's edit and run",
      input.includes(`I edited and ran \\\`${filter.operatorID}\\\` on the canvas`) ||
        input.includes(`I edited and ran \`${filter.operatorID}\` on the canvas`),
      `input ${input.length} chars`
    );
    check(
      "…and the run of the source",
      input.includes(`I ran \\\`${source.operatorID}\\\` on the canvas`) ||
        input.includes(`I ran \`${source.operatorID}\` on the canvas`)
    );
    await shot("07-feedback");

    // ===== 7. a later request builds on the user's change =====
    await sendAndWait(page, `How many rows does ${filter.operatorID} have now? Reply with the number.`);
    answer = await lastAnswer(agent.id);
    check("a later turn uses the edited filter: 1 row", /\b1\b|\bone\b/i.test(answer), answer.slice(0, 120));
    ops = await operatorsOf(agent.id);
    const kept = ops.find(o => o.operatorID === filter.operatorID)?.nativeOp?.source ?? "";
    check("the agent kept the user's change", kept.includes("25"), kept);
    await shot("08-final");

    // ===== 8. restore a version from the middle of the agent's first call =====
    const versions = (await api(AGENT, "GET", `/api/agents/${agent.id}/snapshot-tree`)).json.nodes.filter(
      node => node.version !== undefined && node.action?.kind === "add" && node.action?.operatorId === source.operatorID
    );
    const sourceVersion = versions[0];
    await domClick(
      chat(page).locator(".snapshot-node", { hasText: `v${sourceVersion.version} add ${source.operatorID}` })
    );
    await until(async () => (await operatorsOf(agent.id)).length === 1, 20000);
    ops = await operatorsOf(agent.id);
    check(
      "a version from the tree brings back that dataflow: only the source",
      ops.map(o => o.operatorID).join(",") === source.operatorID,
      ops.map(o => o.operatorID).join(",")
    );
    if (sourceVersion.owned === false) {
      const restored = await until(
        async () => (await userActionRows(page)).includes(`You restored v${sourceVersion.version}`),
        20000
      );
      check(
        "restoring a version inside a call is a step the chat shows",
        !!restored,
        (await userActionRows(page)).join(" | ")
      );
      const restoreStep = (await stepsOf(agent.id)).find(s => s.userAction?.kind === "restore");
      check(
        "…which tells the agent what was undone",
        restoreStep?.content?.includes(`No longer defined: \`${filter.operatorID}\``),
        restoreStep?.content?.slice(0, 200)
      );
    }
    await until(async () => Object.keys(await canvasCaptions(page)).length === 1, 15000);
    check("the canvas shows the restored version", Object.keys(await canvasCaptions(page)).length === 1);
    await shot("09-restored");
  } catch (e) {
    check("script completed without exception", false, String(e).slice(0, 1200));
    await shot("99-error");
  } finally {
    // NG0100 and the 403 on a permission probe are pre-existing dev-mode noise.
    const known = consoleErrors.filter(e => /NG0100|403 \(Forbidden\)/.test(e));
    // The invalid edit's 400 is expected: the agent refused it, and the panel said why.
    const errs = consoleErrors.filter(
      e => !/favicon|ERR_|WebSocket is closed|404|NG0100|403 \(Forbidden\)|400 \(Bad Request\)/.test(e)
    );
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
