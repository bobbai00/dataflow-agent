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

import { expect, test } from "bun:test";
import {
  NATIVE_RUNTIME_TOKEN,
  compileNativeOp,
  inlineNativeRuntime,
  nativeRuntimeForClients,
  nativeSpecOf,
  withNativeRuntime,
  workflowNativeRuntime,
} from "./codegen";

const scan = compileNativeOp({ type: "Scan", properties: { files: "data/a.csv" }, inputs: [] }, "a");

test("compiled code names the runtime instead of holding it, and keeps its spec", () => {
  expect(scan.code.length).toBeLessThan(2000);
  expect(scan.code.split("\n").at(-1)).toBe(`exec(${NATIVE_RUNTIME_TOKEN}, _native_scope)`);
  expect(nativeSpecOf(scan.code)).toMatchObject({ type: "Scan", id: "a" });
});

test("the engine's copy has the runtime inline, and reading it back gives the short form again", () => {
  const inline = inlineNativeRuntime(scan.code);
  expect(inline.length).toBeGreaterThan(100_000);
  expect(inline).not.toContain(NATIVE_RUNTIME_TOKEN);
  expect(inline).toContain("def execute_native_from_engine");
  expect(nativeSpecOf(inline)).toEqual(nativeSpecOf(scan.code));
  const workflow = { operators: [{ operatorID: "a", operatorProperties: { code: scan.code } }] };
  const saved = workflowNativeRuntime(workflow, "inline");
  expect(saved.operators[0].operatorProperties.code).toBe(inline);
  expect(workflowNativeRuntime(saved, "token").operators[0].operatorProperties.code).toBe(scan.code);
  expect(withNativeRuntime([{ operatorID: "a", code: scan.code }])[0].code).toBe(inline);
});

test("other code passes through unchanged", () => {
  const code = "def process(t):\n    return t";
  expect(inlineNativeRuntime(code)).toBe(code);
  expect(withNativeRuntime([{ code }])[0].code).toBe(code);
});

test("a client that puts the runtime back with what the agent sends gets the engine's code", () => {
  const { token, literal } = nativeRuntimeForClients();
  expect(scan.code.replace(`exec(${token},`, () => `exec(${literal},`)).toBe(inlineNativeRuntime(scan.code));
});
