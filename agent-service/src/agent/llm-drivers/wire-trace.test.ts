/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withModelWireTrace } from "./wire-trace";

test("wire trace captures exact bodies and usage but never authorization headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-wire-test-"));
  try {
    const payload = '{"model":"test", "messages":[{"role":"user","content":"Task"}],"max_completion_tokens":8192}';
    const response = {
      choices: [{ finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1200, completion_tokens: 100 },
    };
    let submitted = "";
    const fake = (async (_input: any, init: any) => {
      submitted = init.body;
      return Response.json(response);
    }) as typeof fetch;
    const wrapped = withModelWireTrace(directory, () => ({ agentId: "agent-a", headId: "step-4" }), fake);
    const actual = await wrapped("http://localhost/api/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer secret-do-not-record" },
      body: payload,
    });
    expect(await actual.json()).toEqual(response);
    expect(submitted).toBe(payload);
    const files = await readdir(join(directory, "agent-a"));
    expect(files.sort()).toEqual(["000001-meta.json", "000001-request.json", "000001-response.json"]);
    expect(await readFile(join(directory, "agent-a", "000001-request.json"), "utf8")).toBe(payload);
    const texts = await Promise.all(files.map(file => readFile(join(directory, "agent-a", file), "utf8")));
    expect(texts.join("")).not.toContain("secret-do-not-record");
    const raw = JSON.parse(await readFile(join(directory, "agent-a", "000001-response.json"), "utf8"));
    expect(raw.usage.prompt_tokens_details).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wire trace records provider failures before propagating them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-wire-test-"));
  try {
    const wrapped = withModelWireTrace(directory, () => ({ agentId: "agent-a" }), (async () => {
      throw new Error("provider timeout");
    }) as unknown as typeof fetch);
    await expect(wrapped("http://localhost/api/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(
      "provider timeout"
    );
    const meta = JSON.parse(await readFile(join(directory, "agent-a", "000001-meta.json"), "utf8"));
    expect(meta.error.message).toBe("provider timeout");
    expect(meta.finished_at).toBeDefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
