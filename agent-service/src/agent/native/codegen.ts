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
 * Native operator → engine operator. Every native operator lands as ONE
 * `DataLoading` (no inputs) or `DataProcessing` operator whose code hands the
 * operator's JSON spec to the shared Python runtime (`python/runtime.py`),
 * which validates the contract, executes it with pandas and records the
 * counters that flow evidence reports. The agent never sees this code; it sees
 * the expression it wrote.
 *
 * The same Python is used out of process for parsing and validation. Legacy
 * validation checks syntax only; registered definitions initialize a bounded
 * candidate namespace to check actual signatures before an edit lands.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NATIVE_BY_TYPE, NATIVE_ID_RE, NATIVE_VERSION_ID_RE, type NativeOpView } from "./catalog";
import type { NativeDiagnostic } from "./diagnostics";

export interface CompiledNativeOp {
  /** `DataLoading` for a source (scan, input-less process), else `DataProcessing`. */
  operatorType: "DataLoading" | "DataProcessing";
  code: string;
}

const runtimePath = fileURLToPath(new URL("./python/runtime.py", import.meta.url));
const runtimeSource =
  readFileSync(runtimePath, "utf8") +
  "\n" +
  readFileSync(fileURLToPath(new URL("./python/registered.py", import.meta.url)), "utf8");
const defaultPython = fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

/** The interpreter used for parsing and validation (the engine's UDF Python). */
export function nativePython(): string {
  return process.env.UDF_PYTHON_PATH ?? defaultPython;
}

/** Identity of a definition: type + ordered inputs + parameters. Rendering
 * fields (`source`, `functions`) are excluded so reformatting a program does
 * not invalidate results. */
export function nativeRevision(view: NativeOpView): string {
  return createHash("sha256")
    .update(JSON.stringify({ type: view.type, inputs: view.inputs, properties: view.properties }))
    .digest("hex")
    .slice(0, 16);
}

function runtimeSpec(view: NativeOpView, operatorId: string) {
  const { source: _source, functions: _functions, doc: _doc, ...rest } = view;
  return { ...rest, id: operatorId, revision: view.revision ?? nativeRevision(view) };
}

/** Run parsing/validation as a bounded subprocess with JSON on stdin.
 * Registered validation initializes definition cells, never graph operators. */
export async function runNativePython(request: unknown, timeoutMs = 10_000): Promise<unknown> {
  const child = Bun.spawn([nativePython(), runtimePath], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error("Python validation timed out; no operator was changed.");
    if (code !== 0) throw new Error(`Python validation unavailable: ${stderr.slice(0, 500)}`);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

/** Contract check of several definitions in one subprocess: Python syntax and
 * entry signatures of every function slot plus argument rules. Returns one
 * diagnostic per definition, or undefined where it passed. */
export async function validateNativeOperators(
  definitions: ReadonlyArray<{ id: string; view: NativeOpView }>
): Promise<Array<NativeDiagnostic | undefined>> {
  if (!definitions.length) return [];
  const results = (await runNativePython(definitions.map(d => runtimeSpec(d.view, d.id)))) as Array<{
    ok: boolean;
    diagnostic?: NativeDiagnostic;
  }>;
  return definitions.map((_, i) => (results[i]?.ok ? undefined : results[i]?.diagnostic));
}

/** Single-definition form of {@link validateNativeOperators}; throws the
 * diagnostic in the `NATIVE_ERROR_V2:` envelope the receipts understand. */
export async function validateNativeOperator(view: NativeOpView, operatorId: string): Promise<void> {
  const [diagnostic] = await validateNativeOperators([{ id: operatorId, view }]);
  if (diagnostic) throw new Error(`NATIVE_ERROR_V2:${JSON.stringify(diagnostic)}`);
}

export function compileNativeOp(view: NativeOpView, operatorId = "operator"): CompiledNativeOp {
  const def = NATIVE_BY_TYPE.get(view.type);
  if (!def) throw new Error(`unknown native operator type "${view.type}"`);
  const inputs = view.inputs ?? [];
  // Explicit ports never make input IDs Python names, so there an input may
  // also be an earlier task's version.
  for (const id of inputs) {
    if (!NATIVE_ID_RE.test(id) && !(view.graph && NATIVE_VERSION_ID_RE.test(id)))
      throw new Error(`input operator id "${id}" is not a valid identifier`);
  }
  if (new Set(inputs).size !== inputs.length && view.type !== "Join" && !view.graph) {
    throw new Error(`inputs must be distinct operators (got ${inputs.join(", ")})`);
  }
  if (def.inputs === 0 && inputs.length !== 0) throw new Error(`${def.name} takes no input tables`);
  if (def.inputs === 1 && inputs.length !== 1) throw new Error(`${def.name} takes exactly one input table`);
  if (def.inputs === 2 && inputs.length !== 2)
    throw new Error(`${def.name} takes exactly two input tables (left, right)`);
  if (def.inputs === "many" && view.type === "Union" && inputs.length < 2) {
    throw new Error("union needs at least two input tables");
  }
  const distinct = [...new Set(inputs)];
  // Explicit graph edges address ports, including repeated sources on separate
  // ports. Legacy expressions share one physical input for repeated sources.
  const parameters = view.graph ? inputs.map((_, i) => `_input_${i}`) : distinct;
  const argumentsInOrder = view.graph ? parameters : inputs;
  const spec = runtimeSpec(view, operatorId);
  // Avoid shadowing even when an input deliberately uses our private prefix.
  let prefix = "_native";
  while (distinct.some(id => id.startsWith(prefix))) prefix += "_";
  const source = distinct.length === 0;
  // JSON is decoded, never textually rewritten into Python tokens. In
  // particular callback strings containing true/false/null stay byte-for-byte.
  const code = [
    `def ${source ? "load()" : `process(${parameters.join(", ")})`}:`,
    `    return ${prefix}_scope["execute_native_from_engine"](${prefix}_spec, [${argumentsInOrder.join(", ")}])`,
    `import json as ${prefix}_json`,
    `${prefix}_spec = ${prefix}_json.loads(${JSON.stringify(JSON.stringify(spec))})`,
    `${prefix}_scope = {"__name__": "__native_runtime__"}`,
    `exec(${JSON.stringify(runtimeSource)}, ${prefix}_scope)`,
  ].join("\n");
  return { operatorType: source ? "DataLoading" : "DataProcessing", code };
}
