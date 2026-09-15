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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import type { NativeOpView } from "./catalog";
import type { CompiledNativeOp } from "./codegen";
import { NATIVE_V2_OPERATORS } from "./catalog-v2";

const runtimePath = fileURLToPath(new URL("./python/runtime.py", import.meta.url));
// Each immutable version needs a self-contained worker payload. Encode the
// unchanged runtime compactly so a modest DAG does not exceed the database's
// full-text index input limit. Model-visible operator definitions stay typed.
const runtimePayload = deflateSync(readFileSync(runtimePath), { level: 9 }).toString("base64");
const defaultPython = fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

export function nativeRevision(view: NativeOpView): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: view.version ?? "v1",
        type: view.type,
        inputs: view.inputs,
        properties: view.properties,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

function runtimeSpec(view: NativeOpView, operatorId: string) {
  return { ...view, version: "v2", id: operatorId, revision: view.revision ?? nativeRevision(view) };
}

/** No user code is evaluated: the subprocess parses/compiles source with the
 * standard library only. Bounded and async, so large batches do not block Bun. */
export async function validateNativeV2(view: NativeOpView, operatorId: string): Promise<void> {
  const child = Bun.spawn([process.env.UDF_PYTHON_PATH ?? defaultPython, runtimePath], {
    stdin: new Blob([JSON.stringify(runtimeSpec(view, operatorId))]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error("Python syntax validation timed out; no operator was changed.");
    if (code !== 0) throw new Error(`Python syntax validation unavailable: ${stderr.slice(0, 500)}`);
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(`NATIVE_ERROR_V2:${JSON.stringify(result.diagnostic)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function compileNativeV2(view: NativeOpView, operatorId: string): CompiledNativeOp {
  if (!NATIVE_V2_OPERATORS.some(def => def.type === view.type)) throw new Error(`Unknown V2 operator ${view.type}`);
  const inputs = view.inputs ?? [];
  const distinct = [...new Set(inputs)];
  const spec = runtimeSpec(view, operatorId);
  // Avoid shadowing even when an input deliberately uses our private prefix.
  let prefix = "_native_v2";
  while (distinct.some(id => id.startsWith(prefix))) prefix += "_";
  const source = distinct.length === 0;
  // JSON is decoded, never textually rewritten into Python tokens. In
  // particular callback strings containing true/false/null stay byte-for-byte.
  const code = [
    `def ${source ? "load()" : `process(${distinct.join(", ")})`}:`,
    `    return ${prefix}_scope["execute_native"](${prefix}_spec, [${inputs.join(", ")}])`,
    `import json as ${prefix}_json`,
    `${prefix}_spec = ${prefix}_json.loads(${JSON.stringify(JSON.stringify(spec))})`,
    `${prefix}_scope = {"__name__": "__native_v2_runtime__"}`,
    `import base64 as ${prefix}_base64, zlib as ${prefix}_zlib`,
    `exec(${prefix}_zlib.decompress(${prefix}_base64.b64decode(${JSON.stringify(runtimePayload)})).decode("utf-8"), ${prefix}_scope)`,
  ].join("\n");
  return { operatorType: source ? "DataLoading" : "DataProcessing", code };
}
