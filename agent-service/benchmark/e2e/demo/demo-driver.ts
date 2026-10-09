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
 * Multi-turn agent demo driver over the agent-service REST API.
 *
 *   cd agent-service && bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/northwind-lite.json
 *
 * Scenario JSON: { name, workflowName?, agentName?, model?, maxSteps?, allowedOperatorTypes?,
 *                  turns: [ { say: "…" } | { checkout: <1-based turn index whose head to restore> } ] }
 * Env: DEMO_USER / DEMO_PASSWORD (default agent-demo / agent-demo-2026), DEMO_CUID (default 39),
 *      PROBE_MODEL (default claude-haiku-4.5). Agents and workflows are KEPT so the session can be
 *      opened in the frontend afterwards; a JSON transcript lands next to the scenario file.
 */
import { login, createWorkflow } from "../../../src/api";
import { EMPTY_WORKFLOW } from "../agent-driven-specs";

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error("usage: bun run demo-driver.ts <scenario.json>");
  process.exit(2);
}
const sc = JSON.parse(await Bun.file(scenarioPath).text());
const MODEL = sc.model ?? process.env.PROBE_MODEL ?? "claude-haiku-4.5";
const CUID = Number(process.env.DEMO_CUID ?? "39");
const A = `${process.env.AGENT_BASE ?? "http://localhost:3001"}/api/agents`;
const token = await login(process.env.DEMO_USER ?? "agent-demo", process.env.DEMO_PASSWORD ?? "agent-demo-2026");
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const j = async (r: Response) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const get = (p: string) => fetch(`${A}${p}`, { headers: H }).then(j);
const post = (p: string, body: unknown) => fetch(`${A}${p}`, { method: "POST", headers: H, body: JSON.stringify(body) }).then(j);

const wid = sc.workflowId ?? (await createWorkflow(token, sc.workflowName ?? sc.name, EMPTY_WORKFLOW, `agent demo: ${sc.name}`));
const agent = await post("", {
  modelType: MODEL,
  name: sc.agentName ?? `demo-${sc.name}`,
  workflowId: wid,
  computingUnitId: CUID,
  settings: {
    agentMode: "code",
    maxSteps: sc.maxSteps ?? 60,
    ...(sc.allowedOperatorTypes ? { allowedOperatorTypes: sc.allowedOperatorTypes } : {}),
  },
});
if (!agent.id) {
  console.error("agent create failed", agent);
  process.exit(1);
}
console.log(`# scenario=${sc.name} model=${MODEL} wid=${wid} agent=${agent.id} cuid=${CUID}`);
const log: any[] = [];
const turnHeads: string[] = [];

async function snapshot(label: string) {
  const wf = await get(`/${agent.id}/workflow`);
  const ops = wf.workflow?.operators ?? [];
  const links = wf.workflow?.links ?? [];
  const res = await get(`/${agent.id}/operator-results`);
  console.log(`  DAG(${label}): ${ops.map((o: any) => `${o.operatorID}:${o.operatorType}`).join(", ")}`);
  console.log(`  LINKS: ${links.map((l: any) => `${l.source.operatorID}->${l.target.operatorID}`).join(", ")}`);
  for (const [op, v] of Object.entries<any>(res.results ?? {})) {
    const tail = v.error
      ? "ERR=" + String(v.error).replace(/\n/g, " ").slice(0, 160)
      : "sample=" + JSON.stringify(v.sampleRecords ?? []).slice(0, 160);
    console.log(`  RESULT ${op}: ${v.state} rows=${v.outputTuples} ${tail}`);
  }
  return {
    ops: ops.map((o: any) => ({ id: o.operatorID, type: o.operatorType, props: o.operatorProperties })),
    links: links.map((l: any) => [l.source.operatorID, l.target.operatorID]),
    results: Object.fromEntries(
      Object.entries<any>(res.results ?? {}).map(([k, v]) => [
        k,
        { state: v.state, rows: v.outputTuples, error: v.error, sample: (v.sampleRecords ?? []).slice(0, 3) },
      ])
    ),
  };
}

let i = 0;
for (const turn of sc.turns) {
  i++;
  if (turn.checkout !== undefined) {
    const target = typeof turn.checkout === "number" ? turnHeads[turn.checkout - 1] : turn.checkout;
    const r = await post(`/${agent.id}/checkout`, { stepId: target });
    console.log(`\n## turn ${i}: CHECKOUT -> ${target} : ${JSON.stringify(r).slice(0, 120)}`);
    const snap = await snapshot("after checkout");
    log.push({ turn: i, checkout: target, response: r, snap });
    turnHeads.push(target);
    continue;
  }
  console.log(`\n## turn ${i}: ${turn.say.slice(0, 160)}${turn.say.length > 160 ? "…" : ""}`);
  const before = (await get(`/${agent.id}/react-steps`)).steps.length;
  const t0 = Date.now();
  const r = await post(`/${agent.id}/message`, { content: turn.say });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const steps = (await get(`/${agent.id}/react-steps`)).steps;
  const mine = steps.slice(before);
  const calls = mine.flatMap((s: any) =>
    (s.toolCalls ?? []).map((tc: any) => {
      const tr = (s.toolResults ?? []).find((x: any) => x.toolCallId === tc.toolCallId);
      return { tool: tc.toolName, input: tc.input, ok: !tr?.isError, out: String(tr?.output ?? "").slice(0, 200) };
    })
  );
  console.log(`  state=${r.state} newSteps=${mine.length} toolCalls=${calls.length} time=${secs}s headId=${r.headId}`);
  for (const c of calls) {
    const target = `${c.input?.operatorId ?? ""}${c.input?.operatorType ? ":" + c.input.operatorType : ""}`;
    console.log(`   - ${c.ok ? "✓" : "✗"} ${c.tool}(${target}) ${c.ok ? "" : c.out.replace(/\n/g, " ")}`);
  }
  console.log(`  ANSWER: ${(r.answer ?? "").replace(/\n/g, " ").slice(0, 700)}`);
  const snap = await snapshot("after turn");
  turnHeads.push(r.headId);
  log.push({ turn: i, say: turn.say, secs: Number(secs), state: r.state, newSteps: mine.length, calls, answer: r.answer, headId: r.headId, snap });
}
const tree = await get(`/${agent.id}/snapshot-tree`);
console.log(`\n# snapshot tree: ${tree.nodes.length} nodes`);
console.log(`# KEPT: workflow ${wid} (open http://localhost:4200/user/workflow/${wid} as agent-demo), agent ${agent.id}`);
await Bun.write(scenarioPath.replace(/\.json$/, "") + ".log.json", JSON.stringify({ scenario: sc.name, model: MODEL, wid, agentId: agent.id, turns: log, tree }, null, 2));
