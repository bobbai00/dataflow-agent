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
 * Real-agent e2e runner.
 *
 * For each AgentDrivenSpec:
 *   1. create a fresh empty workflow on the Texera backend
 *   2. attach a fresh agent (talking to the real LLM gateway) to that
 *      workflow + a shared computing unit
 *   3. send the spec's directive prompt over the WS, drain the trace
 *   4. fetch the agent's head snapshot
 *   5. call the spec's validator (throws SpecAssertionError on mismatch)
 *   6. delete the workflow + agent (CU lives until the run ends)
 *
 * This complements `run.ts`: that one drives static, hand-built workflows
 * through the execution path. This one drives the agent itself, so the
 * trace we validate is the agent's decisions plus their executed results.
 */

import { createAgent, deleteAgent, getSnapshot, runAgentTurn } from "../../src/api/agent-service-api";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  extractUserFromToken,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { AgentMode } from "../../src/types/agent";

import { AGENT_DRIVEN_SPECS, EMPTY_WORKFLOW, SpecAssertionError } from "./agent-driven-specs";
import type { AgentDrivenSpec } from "./agent-driven-specs";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const MODEL_TYPE = process.env.TEXERA_AGENT_MODEL ?? "claude-haiku-4.5";
const TURN_TIMEOUT_MS = Number(process.env.TEXERA_AGENT_TURN_TIMEOUT_MS ?? "600000");
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";
// Context-assembly knobs (paper §5). Defaults match production defaults so the
// harness behaves identically unless overridden — used to exercise each SELECT
// mode (latest|delta) and the flow/data DECORATE levels end-to-end.
const CONTEXT_MODE = (process.env.TEXERA_AGENT_CONTEXT_MODE ?? "latest") as "delta" | "latest";
const FLOW_LEVEL = process.env.TEXERA_AGENT_FLOW_EVIDENCE === "true";
const DATA_LEVEL = process.env.TEXERA_AGENT_DATA_EVIDENCE === "true";

const log = (...args: unknown[]) => console.log("[agent-e2e]", ...args);
const logErr = (...args: unknown[]) => console.error("[agent-e2e]", ...args);

interface SpecRunResult {
  ok: boolean;
  steps: number;
  durationMs: number;
  failure?: string;
}

async function runSpec(
  spec: AgentDrivenSpec,
  ctx: { token: string; cuid: number; runId: string }
): Promise<SpecRunResult> {
  const wfName = `${spec.name} [agent-e2e ${ctx.runId}]`;
  log(`▶ ${spec.name}`);
  if (spec.setup) {
    log(`  running spec setup hook`);
    await spec.setup();
  }
  log(`  creating workflow "${wfName}"`);
  const wid = await createWorkflow(ctx.token, wfName, EMPTY_WORKFLOW, spec.description);

  let agentId: string | null = null;
  const t0 = Date.now();
  try {
    log(
      `  creating agent (model=${MODEL_TYPE}, mode=code, contextMode=${CONTEXT_MODE}` +
        `${FLOW_LEVEL !== undefined ? `, flowEvidence=${FLOW_LEVEL}` : ""}` +
        `${DATA_LEVEL !== undefined ? `, dataEvidence=${DATA_LEVEL}` : ""})`
    );
    const agentInfo = await createAgent({
      modelType: MODEL_TYPE,
      name: `agent-e2e-${ctx.runId}-${wid}`,
      userToken: ctx.token,
      workflowId: wid,
      computingUnitId: ctx.cuid,
      settings: {
        agentMode: AgentMode.CODE,
        contextMode: CONTEXT_MODE,
        ...(FLOW_LEVEL !== undefined ? { flowEvidence: FLOW_LEVEL } : {}),
        ...(DATA_LEVEL !== undefined ? { dataEvidence: DATA_LEVEL } : {}),
      },
    });
    agentId = agentInfo.id;
    log(`  agentId=${agentId}; sending prompt (turnTimeout=${TURN_TIMEOUT_MS}ms)`);

    const turn = await runAgentTurn(agentId, spec.prompt, { timeoutMs: TURN_TIMEOUT_MS });
    const durationMs = Date.now() - t0;
    log(
      `  turn finished in ${durationMs}ms: steps=${turn.steps.length} completed=${turn.completed} state=${turn.finalState}`
    );
    for (const e of turn.errors) logErr(`  turn-error: ${e}`);

    log(`  fetching head snapshot`);
    const snapshot = await getSnapshot(agentId, "head");
    if (!snapshot.workflow) {
      return { ok: false, steps: turn.steps.length, durationMs, failure: "head snapshot has no workflow" };
    }
    log(
      `  snapshot: operators=${snapshot.workflow.operators.length} ` +
        `links=${snapshot.workflow.links.length} ` +
        `resultsKeys=${Object.keys(snapshot.results).join(",") || "(none)"}`
    );

    // Strict validation. SpecAssertionError carries the precise mismatch.
    try {
      spec.validate(snapshot, turn);
    } catch (err) {
      const failure = err instanceof SpecAssertionError ? err.message : `${err}`;
      logErr(`  ✗ validator failed: ${failure}`);
      return { ok: false, steps: turn.steps.length, durationMs, failure };
    }
    log(`  ✓ all strict validators passed`);
    return { ok: true, steps: turn.steps.length, durationMs };
  } finally {
    if (agentId) {
      try {
        await deleteAgent(agentId);
      } catch (err) {
        logErr(`  cleanup: deleteAgent(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await deleteWorkflow(ctx.token, wid);
    } catch (err) {
      logErr(`  cleanup: deleteWorkflow(${wid}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  const runId = String(Date.now());
  log(`run id ${runId}, model=${MODEL_TYPE}`);
  log(`logging in as ${USERNAME}`);

  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`logged in: uid=${user.uid} name=${user.name}`);

  let cuid: number | null = null;
  const results: Array<{ name: string; result: SpecRunResult }> = [];
  let allOk = true;

  try {
    log(`provisioning computing unit at ${LOCAL_CU_URI}`);
    const cu = await createComputingUnit(token, `agent-e2e-cu-${runId}`, {
      unitType: "local",
      uri: LOCAL_CU_URI,
    });
    cuid = cu.computingUnit.cuid;
    log(`  cuid=${cuid}`);

    const filter = process.env.TEXERA_AGENT_SPEC_FILTER;
    const specs = filter
      ? AGENT_DRIVEN_SPECS.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()))
      : AGENT_DRIVEN_SPECS;
    if (specs.length === 0) {
      logErr(`no specs match TEXERA_AGENT_SPEC_FILTER="${filter}". Available specs:`);
      for (const s of AGENT_DRIVEN_SPECS) logErr(`  - ${s.name}`);
      process.exit(1);
    }
    if (filter) log(`filter="${filter}" → running ${specs.length}/${AGENT_DRIVEN_SPECS.length} specs`);
    for (const spec of specs) {
      try {
        const result = await runSpec(spec, { token, cuid, runId });
        results.push({ name: spec.name, result });
        if (!result.ok) allOk = false;
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        logErr(`✗ ${spec.name}: ${failure}`);
        results.push({ name: spec.name, result: { ok: false, steps: 0, durationMs: 0, failure } });
        allOk = false;
      }
    }
  } finally {
    if (cuid != null) {
      try {
        log(`cleanup: terminating computing unit ${cuid}`);
        await terminateComputingUnit(token, cuid);
      } catch (err) {
        logErr(`  terminateComputingUnit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  log("");
  log("===== summary =====");
  for (const { name, result } of results) {
    const tag = result.ok ? "✓" : "✗";
    const failure = result.failure ? ` — ${result.failure}` : "";
    log(`  ${tag} ${name}  (steps=${result.steps}, ${result.durationMs}ms)${failure}`);
  }
  log(`overall: ${results.filter(r => r.result.ok).length}/${results.length} passed`);

  if (!allOk) {
    logErr("agent-e2e finished with failures.");
    process.exit(1);
  }
  log("agent-e2e finished successfully.");
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
