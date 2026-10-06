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
import type { OperatorInfo } from "../../types/execution";
import type { NativeOpView } from "./catalog";
import { catalogResultSummary } from "./catalog-summary";

const op: NativeOpView = { type: "Scan", revision: "r1", inputs: [], properties: { files: "data/*.csv" } };
function info(): OperatorInfo {
  return {
    state: "Completed",
    totalRowCount: 100,
    truncated: true,
    resultSchema: [
      { name: "amount", type: "float64" },
      { name: "label", type: "str" },
    ],
    result: [{ amount: 999, label: "PRIVATE_SAMPLE_RECORD" }],
    resultVersion: { id: "v1", complete: true, operatorRevision: "r1" },
    tableProfile: {
      resultVersion: "v1",
      status: "available",
      columnCount: 2,
      coverage: { complete: true, rowsProcessed: 100 },
      columns: {
        amount: {
          type: "float64",
          rowsProcessed: 100,
          nullCount: 4,
          distinctCount: 12,
          min: { type: "float64", value: 1.25 },
          max: { type: "float64", value: 8.5 },
        },
        label: {
          type: "str",
          rowsProcessed: 100,
          nullCount: 0,
          distinctCount: 3,
          min: { type: "str", value: "PRIVATE_TEXT_VALUE" },
          max: null,
        },
      },
      native: { operations: { scan: { sources: [{ path: "data/actually_read.csv" }] } } },
    },
  } as unknown as OperatorInfo;
}

test("catalog uses full profiles rather than retained sample records", () => {
  const text = catalogResultSummary(op, info());
  expect(text).toContain("100 rows × 2 columns");
  expect(text).toContain("stats full");
  expect(text).toContain("null=4/100");
  expect(text).toContain("range=1.25..8.5");
  expect(text).toContain("files read: data/actually_read.csv");
  expect(text).not.toContain("PRIVATE_SAMPLE_RECORD");
  expect(text).not.toContain("PRIVATE_TEXT_VALUE");
  expect(text).not.toContain("999");
});

test("partial and mismatched profiles cannot advertise full-table statistics", () => {
  const value = info();
  value.tableProfile!.coverage = { ...value.tableProfile!.coverage, complete: false, rowsProcessed: 20 };
  expect(catalogResultSummary(op, value)).toContain("stats partial 20/100 rows");
  value.tableProfile!.resultVersion = "old-version";
  const text = catalogResultSummary(op, value);
  expect(text).not.toContain("statistics unavailable");
  expect(text).not.toContain("amount:");
  expect(text).not.toContain("label:");
  expect(text).not.toContain("null=");
  expect(text).not.toContain("files read:");
  expect(text).toContain("source paths: data/*.csv");
});

test("catalog bounds columns and files and labels unavailable results", () => {
  const value = info();
  value.resultSchema = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, type: "str", encoding: "" }));
  value.tableProfile!.columns = Object.fromEntries(
    value.resultSchema.map(field => [field.name, { ...value.tableProfile!.columns.label }])
  );
  value.tableProfile!.columnCount = 100;
  value.tableProfile!.native!.operations = {
    scan: { sources: Array.from({ length: 30 }, (_, i) => ({ path: `data/${i}.csv` })) },
  };
  const text = catalogResultSummary(op, value);
  expect(text).toContain("+97 column stats");
  expect(text).toContain("+27 files");
  expect(text.length).toBeLessThan(700);
  value.error = "failed execution";
  expect(catalogResultSummary(op, value)).toBe("unavailable");
});

test("result summaries omit schema-only columns and absent statistics", () => {
  const value = info();
  value.tableProfile = undefined;
  expect(catalogResultSummary({ ...op, type: "Process", properties: {} }, value)).toBe("100 rows × 2 columns");

  value.tableProfile = info().tableProfile;
  delete value.tableProfile!.columns.label;
  const text = catalogResultSummary(op, value);
  expect(text).toContain("amount:float64(null=4/100");
  expect(text).not.toContain("label:");
});

test("scan summaries distinguish selected files from omitted files", () => {
  const value = info();
  value.tableProfile!.native!.operations = {
    scan: { selectedFiles: 1, resolvedFiles: 4, omittedFiles: 3, sources: [{ path: "data/actually_read.csv" }] },
  };
  const text = catalogResultSummary(op, value);
  expect(text).toContain("files selected=1/4, omitted=3");
  expect(text).toContain("files read: data/actually_read.csv");
});
