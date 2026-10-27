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
 * End-to-end check of agent-panel drag & drop upload:
 *   drop a CSV on the panel -> uploaded to the user's `agent-uploads` dataset
 *   -> a version is committed -> the file is attached to the message as a chip
 *      showing its dataset path (the text box stays as typed)
 *   -> the path is readable through the dataset API
 *   -> the chip can be removed; dropping the file again reuses its version
 *   -> the sent message carries the path, shows the file as a chip, and the
 *      agent can actually load it (real turn, real execution).
 */
import { chromium } from "../node_modules/playwright/index.mjs";

// Usage (from frontend/, with the local stack up — see bin/local-dev.sh):
//   node e2e/agent-drop-upload.e2e.mjs
//   SKIP_AGENT_TURN=1 node e2e/agent-drop-upload.e2e.mjs   # skip the LLM turn
//   HEADFUL=1 PROBE_MODEL=gpt-5-mini node e2e/agent-drop-upload.e2e.mjs   # the chat's agent on another model
//   TEXERA_USERNAME=agent-demo TEXERA_PASSWORD=... node e2e/agent-drop-upload.e2e.mjs   # another account
const FE = process.env.FE_BASE ?? "http://localhost:4200";
const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:3001";
// Dataset endpoints live on file-service, not texera-web.
const FILE = process.env.FILE_BASE ?? "http://localhost:9092";
const CU = process.env.CU_BASE ?? "http://localhost:8888";
const CU_URI = process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085";
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";
const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const RUN_AGENT_TURN = process.env.SKIP_AGENT_TURN ? false : true;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

let token = "";
const api = async (base, method, path, body) => {
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
};

// A name with a space in it on purpose: the service must sanitize it before it
// becomes part of a dataset path.
const CSV_NAME = `drop test ${Date.now()}.csv`;
const CSV_BODY = "city,homes,median_value\nDorchester,4210,712500\nBackBay,980,2450000\nRoslindale,2110,689000\n";

async function main() {
  token = (await api(WEB, "POST", "/api/auth/login", { username: USERNAME, password: PASSWORD })).json.accessToken;
  const wid = (
    await api(WEB, "POST", "/api/workflow/create", {
      name: `drop-upload-e2e ${Date.now()}`,
      content: JSON.stringify({
        operators: [],
        operatorPositions: {},
        links: [],
        commentBoxes: [],
        settings: { dataTransferBatchSize: 400 },
      }),
      description: "drop-upload-e2e",
    })
  ).json.workflow.wid;
  // Stale agents from earlier runs leave tab panes that never finish their
  // leave animation and swallow clicks. Remove only those — agents bound to an
  // earlier drop-upload-e2e workflow — never other sessions' agents.
  for (const a of (await api(AGENT, "GET", "/api/agents")).json.agents ?? []) {
    const workflow = (await api(WEB, "GET", `/api/workflow/${a.delegate?.workflowId}`)).json;
    if (workflow?.name?.startsWith("drop-upload-e2e ")) await api(AGENT, "DELETE", `/api/agents/${a.id}`);
  }
  // The agent cannot be created until the workspace reaches a running
  // computing unit; bring a local one rather than rely on the account's.
  const cuid = (
    await api(CU, "POST", "/api/computing-unit/create", {
      name: `drop-upload-e2e ${Date.now()}`,
      unitType: "local",
      cpuLimit: "NaN",
      memoryLimit: "NaN",
      gpuLimit: "NaN",
      jvmMemorySize: "NaN",
      shmSize: "NaN",
      uri: CU_URI,
    })
  ).json.computingUnit.cuid;
  console.log("workflow", wid, "| computing unit", cuid);

  const browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(t => {
    try {
      localStorage.setItem("access_token", t);
    } catch {}
  }, token);
  const page = await context.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  const pageErrors = [];
  page.on("console", m => {
    if (m.type() === "error") pageErrors.push(m.text().slice(0, 200));
  });

  try {
    // The chat's agent, with this run's unit and model, before the page opens (a chat
    // without one starts its own, on whichever unit the workspace selects first).
    const created = await api(AGENT, "POST", "/api/agents", {
      modelType: MODEL,
      workflowId: wid,
      computingUnitId: cuid,
      settings: { operatorDoc: true },
    });
    if (created.status >= 300) throw new Error(`createAgent ${created.status} ${created.text.slice(0, 200)}`);
    await page.goto(`${FE}/user/workflow/${wid}`, { waitUntil: "domcontentloaded", timeout: 180000 });
    await page.locator("texera-workflow-editor, #workflow-editor").first().waitFor({ timeout: 60000 });
    const trigger = page.locator(".ant-layout-sider-trigger");
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      await sleep(600);
    }
    // The chat panel is always open; its agent was made before the page opened.
    await page.locator("#agent-container #content").waitFor({ state: "visible", timeout: 20000 });
    const composer = page.locator("texera-agent-chat .input-area textarea");
    await composer.waitFor({ timeout: 30000 });

    // ---- the drop itself ----
    const dataTransfer = await page.evaluateHandle(
      ({ name, body }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([body], name, { type: "text/csv" }));
        return dt;
      },
      { name: CSV_NAME, body: CSV_BODY }
    );
    const panel = "texera-agent-chat .agent-chat-container";
    await page.dispatchEvent(panel, "dragenter", { dataTransfer });
    await page.dispatchEvent(panel, "dragover", { dataTransfer });
    const overlayVisible = await page
      .locator(".file-drop-overlay")
      .isVisible()
      .catch(() => false);
    check("drop overlay appears on dragover", overlayVisible);

    await page.dispatchEvent(panel, "drop", { dataTransfer });
    check(
      "drop overlay closes after the drop",
      !(await page
        .locator(".file-drop-overlay")
        .isVisible()
        .catch(() => false))
    );

    // ---- the file is attached as a chip, with its dataset path ----
    const chips = page.locator(".attachment-list.composer .attachment-chip");
    const readyChip = page.locator(".attachment-list.composer .attachment-chip:not(.uploading):not(.failed)");
    await readyChip
      .first()
      .waitFor({ timeout: 120000 })
      .catch(() => {});
    const path = (
      (await readyChip
        .first()
        .locator(".attachment-detail")
        .textContent()
        .catch(() => "")) ?? ""
    ).trim();
    check("the dropped file is attached as one chip", (await chips.count()) === 1, `${await chips.count()} chip(s)`);
    check("the chip shows the file's dataset path", /^\/\S+\/agent-uploads\/v\d+\/\S+$/.test(path), path);
    if (!path) throw new Error("no dataset path on the chip");
    check("file name sanitized in the path", path.endsWith(".csv") && !/\s/.test(path), path);
    check(
      "the chip names the file",
      ((await readyChip.first().locator(".attachment-name").textContent()) ?? "").trim() === path.split("/").pop()
    );
    check("the text box stays as typed (empty)", (await composer.inputValue()) === "");

    // ---- the path is real ----
    const presign = await api(FILE, "GET", `/api/dataset/presign-download?filePath=${encodeURIComponent(path)}`);
    check("dataset API resolves the path", presign.status === 200, `status ${presign.status}`);
    if (presign.status === 200) {
      const body = await (await fetch(presign.json.presignedUrl)).text();
      check("uploaded bytes match the dropped file", body === CSV_BODY, `${body.length} bytes`);
    }

    // ---- dropping the identical file again ----
    // The bytes are already committed, so LakeFS has no diff and file-service
    // refuses to cut a version. That must resolve to the existing version, not
    // surface as a failed upload.
    await chips
      .first()
      .locator(".attachment-remove")
      .evaluate(el => el.click());
    check("the chip's × removes it", (await chips.count()) === 0);
    await page.dispatchEvent(panel, "dragenter", { dataTransfer });
    await page.dispatchEvent(panel, "drop", { dataTransfer });
    await readyChip
      .first()
      .waitFor({ timeout: 120000 })
      .catch(() => {});
    const secondPath = (
      (await readyChip
        .first()
        .locator(".attachment-detail")
        .textContent()
        .catch(() => "")) ?? ""
    ).trim();
    check("re-dropping the same file still yields a path", !!secondPath, secondPath || "(none)");
    check("re-drop reuses the version it is already in", secondPath === path, `${secondPath} vs ${path}`);
    const errorToast = await page.locator(".ant-notification-notice-message").count();
    check("no error notification raised", errorToast === 0, `${errorToast} notice(s)`);

    // ---- the agent can use it ----
    if (RUN_AGENT_TURN) {
      await composer.fill("Load this file and tell me how many rows it has.");
      await page.locator("texera-agent-chat .input-area button.ant-btn-primary").click();
      const sentChip = page.locator("texera-agent-chat .user-message .attachment-list.sent .attachment-chip");
      await sentChip
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
      check(
        "the sent message shows the file as a chip, and the composer is cleared",
        (
          (await sentChip
            .first()
            .textContent()
            .catch(() => "")) ?? ""
        ).includes(path) && (await chips.count()) === 0
      );
      const t0 = Date.now();
      while (Date.now() - t0 < 300000) {
        const generating =
          (await page.locator("texera-agent-chat .loading-message").count()) > 0 ||
          (await page.locator("texera-agent-chat .input-area button.ant-btn-dangerous").count()) > 0;
        if (!generating && (await page.locator("texera-agent-chat [data-step-id]").count()) > 1) break;
        await sleep(1500);
      }
      const agents = (await api(AGENT, "GET", "/api/agents")).json.agents.filter(a => a.delegate?.workflowId === wid);
      const steps = (await api(AGENT, "GET", `/api/agents/${agents[0].id}/react-steps`)).json;
      const list = steps.steps ?? steps;
      const sent = list.find(s => s.role === "user")?.content ?? "";
      check(
        "the message carries the path for the agent",
        sent.endsWith(`Attached files:\n${path}`),
        JSON.stringify(sent.slice(-160))
      );
      const outputs = list
        .flatMap(s => s.toolResults ?? [])
        .map(tr => (typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output)))
        .join("\n");
      const operators =
        (await api(AGENT, "GET", `/api/agents/${agents[0].id}/workflow`)).json?.workflow?.operators ?? [];
      const fileName = path.split("/").pop();
      const answer = list.filter(s => s.role === "agent" && s.content).at(-1)?.content ?? "";
      // Mode-agnostic: a native scan carries the path in its spec, a code-mode loader in its code.
      check(
        "agent built an operator that reads the dropped file",
        operators.some(o => JSON.stringify(o.operatorProperties ?? {}).includes(fileName)),
        operators.map(o => `${o.operatorID}:${o.operatorType}`).join(",")
      );
      check(
        "the dropped file was found and read",
        !/SCAN_NOT_FOUND|No such file or directory|EXECUTION_FAILURE|schema is not available/.test(outputs)
      );
      check("the answer reports the file's 3 data rows", /\b3\b|\bthree\b/i.test(answer), answer.slice(0, 160));
      console.log("\nfinal answer:", answer.slice(0, 300).replace(/\n/g, " "));
    }

    console.log("\npage errors:", pageErrors.length ? pageErrors.slice(0, 3) : "none");
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    console.log("workflow", wid, "| dropped as", path);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await browser.close();
    await api(CU, "DELETE", `/api/computing-unit/${cuid}/terminate`);
  }
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
