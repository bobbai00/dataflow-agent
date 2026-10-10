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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Opt-in research capture at the SDK transport boundary. Request/response
 * bodies are exact; headers, keys and URL query strings are never recorded.
 * Intermediary transformations are outside this observation point. */
export function withModelWireTrace(
  directory: string | undefined,
  metadata: () => { agentId: string; [key: string]: unknown },
  fetchImpl: typeof fetch = globalThis.fetch
): typeof fetch {
  if (!directory) return fetchImpl;
  let sequence = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const context = metadata();
    if (!/^[\w-]+$/.test(context.agentId)) throw new Error("Invalid agent ID for wire trace");
    const base = join(directory, context.agentId);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const id = String(++sequence).padStart(6, "0");
    const body =
      typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined;
    if (body === undefined) throw new Error("Cannot capture model request body");
    const meta = { ...context, sequence, started_at: new Date().toISOString() };
    const saveMeta = (extra = {}) =>
      writeFile(join(base, `${id}-meta.json`), JSON.stringify({ ...meta, ...extra }, null, 2), { mode: 0o600 });
    await writeFile(join(base, `${id}-request.json`), body, { mode: 0o600 });
    await saveMeta();
    try {
      const response = await fetchImpl(input, init);
      await writeFile(join(base, `${id}-response.json`), await response.clone().text(), { mode: 0o600 });
      await saveMeta({ finished_at: new Date().toISOString(), status: response.status });
      return response;
    } catch (error) {
      await saveMeta({
        finished_at: new Date().toISOString(),
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }) as typeof fetch;
}
