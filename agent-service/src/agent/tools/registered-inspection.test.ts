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
import { inspectRegisteredSchema, inspectRegisteredSource } from "./registered-inspection";
import { prepareRegisteredDataflowActions } from "./dataflow-actions";

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

const workbook = (patch: Record<string, unknown> = {}) =>
  info({
    resultSchema: [
      { name: "sheet", type: "string" },
      { name: "row_no", type: "integer" },
      { name: "line", type: "string" },
    ],
    totalRowCount: 3,
    result: [
      { sheet: "Main", row_no: 0, line: "id | amount" },
      { sheet: "Main", row_no: 1, line: "secret data row" },
      { sheet: "Details", row_no: 0, line: "code | notes" },
    ],
    tableProfile: {
      native: {
        operations: {
          scan: {
            preview: true,
            resolvedFiles: 1,
            selectedFiles: 1,
            omittedFiles: 0,
            sources: [{ path: "/data/example.xlsx", format: "excel", sheets: ["Main", "Details", "Empty"] }],
          },
        },
      },
    },
    ...patch,
  });

test("source inspection gives every retained workbook sheet and its first raw row only", () => {
  const result = inspectRegisteredSource(op({ preview: 2 }), workbook());
  expect(result.sheets.map(s => s.name)).toEqual(["Main", "Details", "Empty"]);
  expect(result.sheets[0].first_raw_row).toBe("id | amount");
  expect(result.sheets[2].first_raw_row).toBeNull();
  expect(result.text).not.toContain("secret data row");
  expect(result.text).toContain("raw layout");
  expect(result.text).toContain('"Empty"');
  expect(result.sheet_names_complete).toBe(true);
});

test("source inspection does not infer missing sheets or claim a selected sheet lists the whole workbook", () => {
  const selected = inspectRegisteredSource(op({ preview: 1, sheet: "Main" }), workbook());
  expect(selected.sheet_names_complete).toBe(false);
  const partial = inspectRegisteredSource(op({ preview: 1 }), workbook({ tableProfile: undefined, truncated: true }));
  expect(partial.sheets.map(s => s.name)).toEqual(["Main", "Details"]);
  expect(partial.sheet_names_complete).toBe(false);
  expect(partial.text).toContain("not retained");
  expect(() =>
    inspectRegisteredSource({ ...op(), nativeOp: { ...op().nativeOp!, type: "Aggregate" } }, workbook())
  ).toThrow("SOURCE_REQUIRES_SCAN");
});

test("source pages do not mistake a retained tail row for a header or hide clipping", () => {
  const saved = workbook({
    result: [
      { sheet: "Main", row_no: 8, line: "last data row" },
      { sheet: "Details", row_no: 0, line: "x".repeat(9000) },
    ],
  });
  const first = inspectRegisteredSource(op({ preview: 9 }), saved, 0, 1);
  expect(first.sheets[0].first_raw_row).toBeNull();
  expect(first.next_offset).toBe(1);
  const next = inspectRegisteredSource(op({ preview: 9 }), saved, 1, 1);
  expect(next.sheets[0].first_raw_row).toHaveLength(8000);
  expect(next.sheets[0].first_raw_row_truncated).toBe(true);
  expect(next.text).toContain("clipped");
});

test("registered tool accepts schema/source inspection and rejects invalid pages atomically", () => {
  for (const target of ["schema", "source"])
    for (const page of [{}, { offset: 0, limit: 10 }]) {
      const result = prepareRegisteredDataflowActions({
        reasoning: "Discover available fields.",
        actions: [{ type: "inspect", target, operator_id: "source", ...page }],
      });
      expect(result.status).toBe("pending");
    }
  for (const page of [
    { offset: -1, limit: 10 },
    { offset: 0, limit: 201 },
  ]) {
    const result = prepareRegisteredDataflowActions({
      reasoning: "Discover fields.",
      actions: [
        { type: "edit", python: "", changes: "set a: scan(files='x.csv')" },
        { type: "inspect", target: "schema", operator_id: "source", ...page },
      ],
    });
    expect(result.status).toBe("error");
    expect(result.actions).toEqual([]);
  }
});

test("operator reference accepts semantic filter while retired map/process stay unavailable", () => {
  for (const name of ["filter", "map", "process"]) {
    const result = prepareRegisteredDataflowActions({
      reasoning: "Read the operator contract before editing.",
      actions: [{ type: "inspect", target: "reference", topic: "operators", operator_names: [name] }],
    });
    expect(result.status).toBe(name === "filter" ? "pending" : "error");
  }
});
