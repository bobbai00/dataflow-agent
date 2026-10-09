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
 * Multi-turn context FORMAT check: for LATEST and DELTA agents, run two
 * turns against the live stack, then read the assembled next-step context
 * (the WS `nextContext` frame — the same bytes the model would receive) and
 * assert the structural markers of each mode are present.
 */

import { createAgent, deleteAgent, runAgentTurn } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { AgentMode, ContextMode } from "../../src/types/agent";
import { env } from "../../src/config/env";

const MODEL = process.env.TEXERA_AGENT_MODEL ?? "claude-haiku-4.5";
const CU_URI = process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085";
const EMPTY_WORKFLOW = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400 },
};

const TURN1 =
  "Create one Python operator `gen` producing a table with column n = 1..500. Execute it and report how many rows it has.";
const TURN2 =
  "Add a downstream operator `dbl` that doubles n into a column `n2`. Execute and report the sum of n2 over all rows.";

const log = (...a: unknown[]) => console.log("[ctx-fmt]", ...a);

function fetchNextContext(agentId: string): Promise<string> {
  const url = `ws://localhost:${env.PORT}${env.API_PREFIX}/agents/${agentId}/react`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no nextContext frame within 15s"));
    }, 15000);
    ws.onmessage = evt => {
      try {
        const frame = JSON.parse(String(evt.data));
        if (frame.type === "nextContext" && typeof frame.content === "string") {
          clearTimeout(timer);
          ws.close();
          resolve(frame.content);
        }
      } catch {
        /* ignore non-JSON */
      }
    };
    ws.onerror = e => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${String(e)}`));
    };
  });
}

interface ModeSpec {
  name: string;
  settings: Record<string, unknown>;
  requiredMarkers: string[];
}

const MODES: ModeSpec[] = [
  {
    name: "latest",
    settings: { agentMode: AgentMode.CODE, contextMode: ContextMode.LATEST },
    requiredMarkers: ["# User Task", "# Current Dataflow", "Column Schema and stats:"],
  },
  {
    name: "delta",
    settings: { agentMode: AgentMode.CODE, contextMode: ContextMode.DELTA },
    requiredMarkers: ["# User Task", "gen", "dbl"],
  },
];

async function main() {
  const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const cu = await createComputingUnit(token, `ctx-fmt-cu-${Math.floor(Math.random() * 1e9)}`, {
    unitType: "local",
    uri: CU_URI,
  });
  const cuid = cu.computingUnit.cuid;

  let failures = 0;
  try {
    for (const mode of MODES) {
      log(`▶ mode=${mode.name}`);
      const wid = await createWorkflow(token, `ctx-fmt-${mode.name}-${cuid}`, EMPTY_WORKFLOW, mode.name);
      let agentId: string | null = null;
      try {
        const info = await createAgent({
          modelType: MODEL,
          name: `ctx-fmt-${mode.name}`,
          userToken: token,
          workflowId: wid,
          computingUnitId: cuid,
          settings: mode.settings as any,
        });
        agentId = info.id;

        const t1 = await runAgentTurn(agentId, TURN1, { timeoutMs: 300000 });
        log(`  turn1: steps=${t1.steps.length} completed=${t1.completed}`);
        const t2 = await runAgentTurn(agentId, TURN2, { timeoutMs: 300000 });
        log(`  turn2: steps=${t2.steps.length} completed=${t2.completed} answer="${t2.finalAnswer.slice(0, 120)}"`);

        const ctx = await fetchNextContext(agentId);
        log(`  nextContext: ${ctx.length} chars`);
        for (const marker of mode.requiredMarkers) {
          const ok = ctx.includes(marker);
          if (!ok) failures++;
          log(`  ${ok ? "✓" : "✗"} marker: ${JSON.stringify(marker)}`);
        }
        log(`  --- context head ---\n${ctx.slice(0, 600)}\n  --- end head ---`);
      } finally {
        if (agentId) await deleteAgent(agentId).catch(() => {});
        await deleteWorkflow(token, wid).catch(() => {});
      }
    }
  } finally {
    await terminateComputingUnit(token, cuid).catch(() => {});
  }
  log(failures === 0 ? "ALL FORMAT MARKERS PRESENT" : `${failures} marker(s) missing`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error("[ctx-fmt] fatal:", e);
  process.exit(1);
});
