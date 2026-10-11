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

import { expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import { registeredReferenceText } from "../prompts";
import { inspectRegisteredSchema } from "./registered-inspection";
import { prepareDataflowCall } from "./turn-tool";

const op = (properties: Record<string, unknown> = {}): OperatorPredicate => ({
  operatorID: "source",
  operatorType: "PythonUDF",
  operatorVersion: "v1",
  operatorProperties: {},
  inputPorts: [],
  outputPorts: [],
  showAdvanced: false,
  nativeOp: { type: "Scan", inputs: [], properties, revision: "revision" },
});
const info = (patch: Record<string, unknown> = {}): OperatorInfo =>
  ({
    state: "Completed",
    inputTuples: 0,
    outputTuples: 1,
    resultMode: "full",
    resultSchema: [{ name: "value", type: "integer", encoding: "" }],
    result: [{ value: 1 }],
    resultVersion: { id: "result-1", operatorRevision: "revision" },
    ...patch,
  }) as unknown as OperatorInfo;

test("schema inspection exposes all 179 exact names independently of record samples", () => {
  const schema = Array.from({ length: 179 }, (_, i) => ({
    name: i === 0 ? "Trailing " : `field_${i}`,
    type: "string",
    encoding: "",
  }));
  const result = inspectRegisteredSchema(op(), info({ resultSchema: schema, result: [] }));
  expect(result.columns).toHaveLength(179);
  expect(result.columns[0]).toEqual({ index: 0, name: "Trailing ", type: "string" });
  expect(result.text).toContain('"Trailing "');
  expect(result.text).toContain('"field_178"');
  expect(result.complete).toBe(true);
  expect(result.next_offset).toBeNull();
  expect(result.result_version).toBe("result-1");
});

test("schema pagination keeps exact long and special names, and validates page boundaries", () => {
  const names = ["a|b", "line\nbreak", "x".repeat(600), ...Array.from({ length: 203 }, (_, i) => `column_${i}`)];
  const saved = info({ resultSchema: names.map(name => ({ name, type: "string", encoding: "" })) });
  const first = inspectRegisteredSchema(op(), saved);
  expect(first.columns).toHaveLength(200);
  expect(first.complete).toBe(false);
  expect(first.next_offset).toBe(200);
  expect(first.columns[2].name).toHaveLength(600);
  expect(first.text).toContain("line\\nbreak");
  const second = inspectRegisteredSchema(op(), saved, 200, 6);
  expect(second.columns.map(c => c.index)).toEqual([200, 201, 202, 203, 204, 205]);
  expect(second.next_offset).toBeNull();
  expect(second.complete).toBe(false);
  for (const [offset, limit] of [
    [-1, 10],
    [0, 0],
    [0, 201],
    [1.5, 2],
  ])
    expect(() => inspectRegisteredSchema(op(), saved, offset, limit)).toThrow("INVALID_PAGE");
});

test("inspect does not present stale, failed, or unavailable schemas as current", () => {
  expect(() => inspectRegisteredSchema(op(), undefined)).toThrow("RESULT_NOT_RUN");
  expect(() => inspectRegisteredSchema(op(), info({ state: "Failed", error: "bad input" }))).toThrow("RESULT_FAILED");
  expect(() => inspectRegisteredSchema(op(), info({ resultVersion: { operatorRevision: "old" } }))).toThrow(
    "RESULT_STALE"
  );
  expect(() => inspectRegisteredSchema(op(), info({ resultSchema: undefined }))).toThrow("SCHEMA_UNAVAILABLE");
});

test("show schema pages from an offset, and a malformed page is refused before anything runs", () => {
  const call = (statements: string) => prepareDataflowCall({ python: "", statements }, ["sample_stats", "full"]);
  const first = call("show schema source");
  expect(first.status).toBe("pending");
  expect(first.actions.map(item => item.action)).toEqual([
    { type: "execute", operator_ids: ["source"] },
    { type: "inspect", target: "schema", operator_id: "source" },
  ]);
  const page = call("show schema source from 200");
  expect(page.actions[1].action).toEqual({
    type: "inspect",
    target: "schema",
    operator_id: "source",
    offset: 200,
    limit: 200,
  });
  for (const statements of [
    "set a: scan(files='x.csv')\nshow schema source from -1",
    "set a: scan(files='x.csv')\nshow schema source from 1.5",
    "show schema data/source.csv",
  ]) {
    const rejected = call(statements);
    expect(rejected.status).toBe("error");
    expect(rejected.actions).toEqual([]);
  }
  expect(call("show schema data/source.csv").error).toContain("takes the ID of an operator, not a path or a call");
});

test("show builtin reads a built-in contract; retired map and process are not built-ins", () => {
  expect(registeredReferenceText({ topic: "operators", operator_names: ["filter"] })).toContain(
    "filter(t, lambda row: condition)"
  );
  for (const name of ["map", "process"])
    expect(() => registeredReferenceText({ topic: "operators", operator_names: [name] })).toThrow(
      `Unknown built-in operator ${name}.`
    );
});
