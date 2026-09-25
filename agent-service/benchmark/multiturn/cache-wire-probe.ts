/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
/** Run the real dataflow agent in-process, exactly as the service builds it,
 * and capture every request body it puts on the wire together with the usage
 * the provider returned. Then locate, for each pair of consecutive requests,
 * the first byte that differs: that is where the provider's prompt cache ends. */
import { mkdirSync, writeFileSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { TexeraAgent } from "../../src/agent/texera-agent";
import { VercelToolUseDriver } from "../../src/agent/llm-drivers/vercel-tool-use-driver";
import { buildContextAssembler } from "../../src/server";
import { WorkflowState } from "../../src/agent/workflow-state";
import { AgentMode } from "../../src/types/agent";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  getBackendConfig,
  login,
  terminateComputingUnit,
} from "../../src/api";

const [promptsPath, outDir, turns = "3", model = "gpt-5.6-luna"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const prompts: Array<{ turn_id: number; prompt: string }> = (await Bun.file(promptsPath).json()).slice(0, Number(turns));
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");

const wire: Array<{ body: string; usage?: any }> = [];
const capture = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? init.body : "";
  const response = await fetch(url, init);
  if (body.includes('"messages"')) {
    const usage = await response
      .clone()
      .json()
      .then((j: any) => j.usage)
      .catch(() => undefined);
    wire.push({ body, usage });
  }
  return response;
}) as typeof fetch;
const openai = createOpenAI({ baseURL: `${getBackendConfig().modelsEndpoint}/api`, apiKey: token, fetch: capture });

const name = `cache-wire-${Date.now()}`;
const cuid = (await createComputingUnit(token, name, { unitType: "local", uri: process.env.TEXERA_LOCAL_CU_URI }))
  .computingUnit.cuid;
const wid = await createWorkflow(token, name, new WorkflowState().getWorkflowContent());
const agent = new TexeraAgent({
  driver: new VercelToolUseDriver({ model: openai.chat(model) }),
  contextAssembler: buildContextAssembler("vercel-tool-use", openai),
  modelType: model,
  agentId: name,
  agentName: "probe",
});
try {
  await agent.initialize({ userToken: token, workflowId: wid, computingUnitId: cuid });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    contextMode: "delta" as any,
    nativeProfileCollection: true,
    dataEvidence: true,
    flowEvidence: true,
    nativeTaskContext: true,
    nativeTaskHistory: true,
    maxSteps: 40,
    maxOperatorResultCharLimit: 2000,
    maxOperatorResultCellCharLimit: 2000,
  } as any);
  for (const turn of prompts) await agent.sendMessage(turn.prompt);
} finally {
  await deleteWorkflow(token, wid).catch(() => {});
  await terminateComputingUnit(token, cuid).catch(() => {});
}

writeFileSync(`${outDir}/wire.json`, JSON.stringify(wire, null, 1));
console.log(`captured ${wire.length} requests`);
for (let i = 1; i < wire.length; i++) {
  const a = wire[i - 1].body,
    b = wire[i].body;
  let d = 0;
  while (d < a.length && d < b.length && a[d] === b[d]) d++;
  const u = wire[i].usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? "?";
  console.log(
    `req${i + 1}: body ${b.length}B, identical to previous for ${d}B (${Math.round((100 * d) / b.length)}%), ` +
      `provider prompt=${u.prompt_tokens ?? "?"} cached=${cached}\n` +
      `   prev: …${JSON.stringify(a.slice(Math.max(0, d - 60), d + 90))}\n` +
      `   this: …${JSON.stringify(b.slice(Math.max(0, d - 60), d + 90))}`
  );
}
