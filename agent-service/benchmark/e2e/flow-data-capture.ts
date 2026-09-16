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
 * Flow-section + data-annotation end-to-end capture.
 *
 * Goal: PROVE — against the live JVM stack, with REAL backend execution
 * (real columnStats, real operator errors, real lineage) — that
 *   (1) the consolidated FLOW section ("# Operators needing attention …")
 *       renders only at flowEvidence>0 and grows rung-by-rung (L1 loaderHint,
 *       L2 lineageErrorContext / lineageStats, L3 graphAudit), and
 *   (2) the per-operator DATA annotations render only at dataEvidence>0 and grow
 *       rung-by-rung (L1 Schema, L2 Data hints, L3 Format hints).
 *
 * Unlike `agent-run.ts` this does NOT use the LLM. It builds a fixed 4-operator
 * workflow deterministically via debug-mode `Function(...)` tool calls over the
 * WebSocket, each of which runs the SAME post-step backend execution the LLM
 * path runs — so the agent's snapshot ends up holding genuine results. It then
 * PATCHes `flowEvidence`/`dataEvidence`/`contextMode` and reads the assembled
 * next-step context back via the WS `nextContext` event — byte-for-byte what the
 * model would receive on its next prepareStep.
 *
 * The 4 operators are chosen to light up every rung:
 *   src       DataLoading,  OK,   rich columns (currency/percent strings, dup keys)
 *   proc      DataProcessing(src), OK but 0 rows  → flow L2 lineageStats (empty alarm)
 *   bad       DataProcessing(src), runtime KeyError → flow L2 lineageErrorContext
 *   badLoader DataLoading,  FileNotFoundError, orphan → flow L1 loaderHint + L3 graphAudit
 */

import { createAgent, deleteAgent } from "../../src/api/agent-service-api";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  extractUserFromToken,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { AgentMode } from "../../src/types/agent";
import { EMPTY_WORKFLOW } from "./agent-driven-specs";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const MODEL_TYPE = process.env.TEXERA_AGENT_MODEL ?? "claude-haiku-4.5";
const PORT = Number(process.env.PORT ?? "3001");
const HTTP_BASE = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? `http://localhost:${PORT}`;
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

const log = (...a: unknown[]) => console.log("[flow-capture]", ...a);

/* ── debug-mode Function(...) encoding ──────────────────────────────────────
 * The debug parser (src/agent/debug-parser.ts) walks a Python/JSON literal with
 * PyParser. We encode TWO levels:
 *   Function(name='createOrModifyOperator', arguments='<DICT>')
 * where <DICT> is itself a quoted-string whose decoded content is a dict literal.
 * pyStr() is the inverse of PyParser.parseString for a single-quoted literal, so
 * applying it once per level (and the parser decoding once per level) round-trips
 * exactly. Our Python uses only double quotes and no backslashes, keeping this
 * robust, but pyStr handles the general case anyway. */
function pyStr(s: string): string {
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `'${body}'`;
}

function debugCreateOp(operatorId: string, code: string, summary: string): string {
  const dict = `{${pyStr("operatorId")}: ${pyStr(operatorId)}, ${pyStr("code")}: ${pyStr(
    code
  )}, ${pyStr("summary")}: ${pyStr(summary)}}`;
  return `Function(name=${pyStr("createOrModifyOperator")}, arguments=${pyStr(dict)})`;
}

/* ── the fixed workflow ─────────────────────────────────────────────────── */

const OPS: { id: string; code: string; summary: string }[] = [
  {
    id: "src",
    summary: "Load a 5-row sales table with currency/percent string columns and a duplicated region key.",
    code: [
      "def load() -> pd.DataFrame:",
      "    import pandas as pd",
      "    return pd.DataFrame({",
      '        "region": ["US", "US", "EU", "EU", "EU"],',
      '        "revenue": ["$1,200.50", "$3,400.00", "$2,100.25", "$900.00", "$5,000.75"],',
      '        "growth": ["12%", "8%", "15%", "3%", "20%"],',
      '        "units": [120, 340, 210, 90, 500],',
      "    })",
    ].join("\n"),
  },
  {
    id: "proc",
    summary:
      "Filter src to an impossible threshold so the output is empty (exercises the empty-output cardinality alarm).",
    code: ["def process(src) -> pd.DataFrame:", '    return src[src["units"] > 999999]'].join("\n"),
  },
  {
    id: "bad",
    summary: "Select a column that does not exist so the operator fails at runtime (exercises lineage error context).",
    code: ["def process(src) -> pd.DataFrame:", '    return src[["nonexistent_column"]]'].join("\n"),
  },
  {
    id: "badLoader",
    summary:
      "Load /tmp/this-file-does-not-exist.csv so the loader fails (exercises loader remediation + dead-loader audit).",
    code: [
      "def load() -> pd.DataFrame:",
      "    import pandas as pd",
      '    return pd.read_csv("/tmp/this-file-does-not-exist-flow-capture.csv")',
    ].join("\n"),
  },
];

/* ── WS helpers ─────────────────────────────────────────────────────────── */

function wsUrl(agentId: string): string {
  return `${WS_BASE}/api/agents/${encodeURIComponent(agentId)}/react`;
}

/**
 * Send a sequence of debug inputs over one WS connection, awaiting the
 * `complete` frame (which fires only after post-step backend execution) between
 * each. Resolves once all inputs are drained.
 */
async function runDebugSequence(agentId: string, inputs: string[], perStepTimeoutMs = 180_000): Promise<void> {
  const ws = new WebSocket(wsUrl(agentId));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = e => reject(new Error(`WS open error: ${String((e as any)?.message ?? e)}`));
  });

  try {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const opLabel = OPS[i]?.id ?? `step${i}`;
      log(`  debug[${i}] → ${opLabel} (awaiting backend execution)`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for complete after ${opLabel}`)),
          perStepTimeoutMs
        );
        ws.onmessage = ev => {
          let msg: any;
          try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
          } catch {
            return;
          }
          if (msg.type === "error") {
            clearTimeout(timer);
            reject(new Error(`server error after ${opLabel}: ${msg.error}`));
          } else if (msg.type === "complete") {
            clearTimeout(timer);
            resolve();
          }
        };
        ws.send(JSON.stringify({ type: "debug", content: input }));
      });
    }
  } finally {
    ws.close();
  }
}

/**
 * Open a fresh WS and read the very first `nextContext` frame the server pushes
 * on connect (server.ts open handler). This is the assembled next-step context
 * under the agent's CURRENT settings — so we PATCH settings first, then call
 * this. One-shot connection avoids races with broadcast re-pushes.
 */
async function captureContext(agentId: string, timeoutMs = 30_000): Promise<string> {
  const ws = new WebSocket(wsUrl(agentId));
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for nextContext")), timeoutMs);
      ws.onerror = e => {
        clearTimeout(timer);
        reject(new Error(`WS error: ${String((e as any)?.message ?? e)}`));
      };
      ws.onmessage = ev => {
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "nextContext") {
          clearTimeout(timer);
          resolve(typeof msg.content === "string" ? msg.content : "");
        }
      };
    });
  } finally {
    ws.close();
  }
}

async function patchSettings(agentId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${HTTP_BASE}/api/agents/${encodeURIComponent(agentId)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`PATCH settings failed: ${res.status} ${await res.text()}`);
  }
}

/* ── assertion harness ──────────────────────────────────────────────────── */

const FLOW_HEADER = "# Operators needing attention";
let failures = 0;
const check = (label: string, cond: boolean) => {
  log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

function summarizeFlow(ctx: string): string {
  const idx = ctx.indexOf(FLOW_HEADER);
  if (idx < 0) return "(no flow section)";
  return ctx.slice(idx).trim();
}

async function main(): Promise<void> {
  const runId = String(Date.now());
  log(`run ${runId} model=${MODEL_TYPE} http=${HTTP_BASE}`);
  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`logged in uid=${user.uid}`);

  let cuid: number | null = null;
  let wid: number | null = null;
  let agentId: string | null = null;
  const dump: Record<string, string> = {};

  try {
    const cu = await createComputingUnit(token, `flow-capture-cu-${runId}`, { unitType: "local", uri: LOCAL_CU_URI });
    cuid = cu.computingUnit.cuid;
    log(`cuid=${cuid}`);

    wid = await createWorkflow(token, `flow-capture [${runId}]`, EMPTY_WORKFLOW, "flow/data capture fixture");
    log(`wid=${wid}`);

    const agent = await createAgent({
      modelType: MODEL_TYPE,
      name: `flow-capture-${runId}`,
      userToken: token,
      workflowId: wid,
      computingUnitId: cuid,
      settings: { agentMode: AgentMode.CODE, contextMode: "latest", flowEvidence: false, dataEvidence: false },
    });
    agentId = agent.id;
    log(`agentId=${agentId}`);

    // 1) Build + execute the fixture deterministically (real backend runs).
    log("building fixture workflow via debug Function(...) calls…");
    const inputs = OPS.map(o => debugCreateOp(o.id, o.code, o.summary));
    await runDebugSequence(agentId, inputs);
    log("fixture built — agent snapshot now holds real results + errors");

    // 2) FLOW ladder — isolate flow by holding dataEvidence=false, contextMode=latest.
    log("");
    log("===== FLOW ladder (dataEvidence=false, contextMode=latest) =====");
    for (const flowEvidence of [0, 1, 2, 3]) {
      await patchSettings(agentId, { flowEvidence, dataEvidence: false, contextMode: "latest" });
      const ctx = await captureContext(agentId);
      dump[`flow${flowEvidence}_data0`] = ctx;
      log(`flowEvidence=${flowEvidence}:`);
      const hasFlow = ctx.includes(FLOW_HEADER);
      if (flowEvidence === 0) {
        check("flowEvidence=false → NO flow section", !hasFlow);
      } else {
        check(`flowEvidence=${flowEvidence} → flow section present`, hasFlow);
      }
      if (flowEvidence >= 1) {
        // L1 loaderHint: badLoader's FileNotFound surfaces with an error line.
        check("  L1: badLoader appears in flow section", /###\s+`badLoader`/.test(ctx) && /error:/.test(ctx));
      }
      if (flowEvidence >= 2) {
        // L2 lineageErrorContext: bad's runtime error block referencing upstream.
        check("  L2: bad (runtime-error op) appears in flow section", /###\s+`bad`/.test(ctx));
      }
      if (flowEvidence >= 3) {
        // L3 graphAudit: dead-loader audit line on the orphan badLoader.
        check("  L3: dead-loader Graph check present", ctx.includes("Graph check"));
      }
    }

    // 3) DATA ladder — isolate data by holding flowEvidence=false.
    log("");
    log("===== DATA ladder (flowEvidence=false, contextMode=latest) =====");
    for (const dataEvidence of [0, 1, 2, 3]) {
      await patchSettings(agentId, { flowEvidence: false, dataEvidence, contextMode: "latest" });
      const ctx = await captureContext(agentId);
      dump[`flow0_data${dataEvidence}`] = ctx;
      log(`dataEvidence=${dataEvidence}:`);
      const hasSchema = ctx.includes("Schema (");
      const hasDataHints = ctx.includes("Data hints:");
      const hasFormatHints = ctx.includes("Format hints:");
      check("  no flow section (flowEvidence=false)", !ctx.includes(FLOW_HEADER));
      check(`  Schema line ${dataEvidence >= 1 ? "present" : "absent"}`, dataEvidence >= 1 ? hasSchema : !hasSchema);
      check(
        `  Data hints ${dataEvidence >= 2 ? "present" : "absent"}`,
        dataEvidence >= 2 ? hasDataHints : !hasDataHints
      );
      check(
        `  Format hints ${dataEvidence >= 3 ? "present" : "absent"}`,
        dataEvidence >= 3 ? hasFormatHints : !hasFormatHints
      );
    }

    // 4) Combined + both context modes — confirm flow+data compose and SELECT
    //    policy (latest vs delta) both carry the new section.
    log("");
    log("===== Combined flow=3/data=3 across context modes =====");
    for (const contextMode of ["latest", "delta"] as const) {
      await patchSettings(agentId, { flowEvidence: true, dataEvidence: true, contextMode });
      const ctx = await captureContext(agentId);
      dump[`flow3_data3_${contextMode}`] = ctx;
      log(`contextMode=${contextMode}:`);
      check("  flow section present", ctx.includes(FLOW_HEADER));
      check("  Schema present", ctx.includes("Schema ("));
      check("  Data hints present", ctx.includes("Data hints:"));
      check("  Format hints present", ctx.includes("Format hints:"));
    }

    // Show the richest flow section so a human can eyeball the real content.
    log("");
    log("===== Captured FLOW section (flow=3, data=3, latest) =====");
    console.log(summarizeFlow(dump["flow3_data3_latest"] ?? ""));
  } finally {
    const outPath = `/tmp/flow-data-capture-${runId}.txt`;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(dump)) {
      parts.push(`\n\n##################### ${k} #####################\n${v}`);
    }
    await Bun.write(outPath, parts.join("\n"));
    log(`full captures written to ${outPath}`);

    if (agentId) await deleteAgent(agentId).catch(() => {});
    if (wid != null) await deleteWorkflow(token, wid).catch(() => {});
    if (cuid != null) await terminateComputingUnit(token, cuid).catch(() => {});
  }

  log("");
  if (failures > 0) {
    log(`FAILED — ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  log("ALL ASSERTIONS PASSED");
}

main().catch(err => {
  console.error("[flow-capture] fatal:", err);
  process.exit(1);
});
