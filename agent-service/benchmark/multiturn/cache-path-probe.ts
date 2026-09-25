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
/** Send one identical long prompt twice down each request path and report how
 * much of the second call the provider served from cache. Isolates whether a
 * cache miss comes from the prompt or from the path the request travels. */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool } from "ai";
import { getBackendConfig, login } from "../../src/api";

const model = process.argv[2] ?? "gpt-5.6-luna";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const gateway = createOpenAI({ baseURL: `${getBackendConfig().modelsEndpoint}/api`, apiKey: token });
const direct = createOpenAI({
  baseURL: `${process.env.CODE_AGENT_API_BASE ?? "http://localhost:34000"}/v1`,
  apiKey: process.env.LITELLM_MASTER_KEY ?? "dummy",
});

// ~7k tokens of stable, realistic content: a table the model would be reading.
const rows = Array.from(
  { length: 700 },
  (_, i) => `${i},university_${i},country_${i % 37},${(i * 7.31) % 100},${(i * 3.17) % 100},${(i * 11.9) % 100}`
);
const history = `Data preview:\nid,name,country,teaching,research,citations\n${rows.join("\n")}`;
const system = "You are a careful data analyst. Answer concisely.";
const tools = {
  lookup: tool({
    description: "Look up a value by id.",
    inputSchema: jsonSchema<{ q: string }>({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
    execute: async () => "unused",
  }),
};

async function twice(label: string, provider: typeof gateway, withTools: boolean) {
  const out: string[] = [];
  for (let i = 0; i < 2; i++) {
    const result = await generateText({
      model: provider.chat(model),
      system,
      messages: [{ role: "user", content: `${history}\n\nQuestion: reply with the single word OK.` }],
      ...(withTools ? { tools, toolChoice: "none" as const } : {}),
      maxOutputTokens: 400,
    });
    const u = result.usage as any;
    out.push(`call${i + 1} in=${u.inputTokens} cached=${u.cachedInputTokens ?? 0}`);
  }
  console.log(`${label.padEnd(34)} ${out.join("   ")}`);
}

await twice("via access-control, no tools", gateway, false);
await twice("via access-control, with tools", gateway, true);
await twice("direct to gateway, no tools", direct, false);
await twice("direct to gateway, with tools", direct, true);
