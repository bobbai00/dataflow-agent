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
/** Does a *growing* conversation cache its shared prefix? Call A, then call B =
 * A's messages plus more. B's cached count should cover A's whole prompt. Each
 * shape mirrors something the dataflow agent actually sends. */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool, type ModelMessage } from "ai";
import { getBackendConfig, login } from "../../src/api";

const model = process.argv[2] ?? "gpt-5.6-luna";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const provider = createOpenAI({ baseURL: `${getBackendConfig().modelsEndpoint}/api`, apiKey: token });
const salt = Date.now(); // a fresh prefix per run, so nothing is pre-cached
const big = (tag: string) =>
  `${tag} ${salt}\n` +
  Array.from({ length: 450 }, (_, i) => `${i},item_${i},${(i * 7.31) % 100},${(i * 3.17) % 100}`).join("\n");
const system = `You are a careful data analyst ${salt}. Answer in one word.`;
const tools = {
  dataflow: tool({
    description: "Run a batch of operators.",
    inputSchema: jsonSchema<{ q: string }>({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
    execute: async () => "ok",
  }),
};
const call = (id: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "dataflow", input: { q: "x" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "dataflow", output: { type: "text", value: big("RESULT " + id).slice(0, 3000) } }] },
];

async function run(messages: ModelMessage[]) {
  const r = await generateText({ model: provider.chat(model), system, messages, tools, toolChoice: "none", maxOutputTokens: 400 });
  const u = r.usage as any;
  return { in: u.inputTokens as number, cached: (u.cachedInputTokens ?? 0) as number };
}

async function shape(label: string, a: ModelMessage[], extra: ModelMessage[]) {
  const first = await run(a);
  const second = await run([...a, ...extra]);
  const covered = Math.round((100 * second.cached) / first.in);
  console.log(`${label.padEnd(44)} A in=${first.in}  B in=${second.in} cached=${second.cached}  (${covered}% of A)`);
}

const pair: ModelMessage[] = [
  { role: "user", content: big("TASK 1") },
  { role: "assistant", content: "Final Answer: 42" },
];
await shape("user, then more", [{ role: "user", content: big("A") }], [
  { role: "assistant", content: "ok" },
  { role: "user", content: "next" },
]);
await shape("completed pair, then a new user turn", [...pair, { role: "user", content: "q2" }], [
  { role: "assistant", content: "ok" },
  { role: "user", content: "q3" },
]);
await shape("two consecutive user messages, then more", [...pair, { role: "user", content: "CATALOG" }, { role: "user", content: "EVENTS q2" }], [
  { role: "assistant", content: "ok" },
  { role: "user", content: "q3" },
]);
await shape("tool call + result in history, then more", [...pair, { role: "user", content: "q2" }, ...call("c1")], [
  ...call("c2"),
  { role: "user", content: "q3" },
]);
