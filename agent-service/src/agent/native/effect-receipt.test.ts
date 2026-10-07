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
import { effectLine } from "./effect-receipt";
import type { OperatorInfo } from "../../types/execution";

const table = (id: string, rows: Record<string, unknown>[], schema: Array<[string, string]>) =>
  ({
    state: "Completed", inputTuples: 0, outputTuples: rows.length, totalRowCount: rows.length, resultMode: "table",
    result: rows, resultSchema: schema.map(([name, type]) => ({ name, type })), resultVersion: { id },
  }) as unknown as OperatorInfo;

test("an integer id column names the rows that entered and left", () => {
  const schema: Array<[string, string]> = [["sample_id", "int64"], ["score", "float64"], ["flag", "bool"]];
  const before = table("v1", [{ sample_id: 1, score: 3, flag: true }, { sample_id: 2, score: 2, flag: true }], schema);
  const after = table("v2", [{ sample_id: 1, score: 4, flag: true }, { sample_id: 7, score: 9, flag: true }], schema);
  expect(effectLine("top@3", before, after)).toBe(
    "changed since top@3: 2 → 2 rows; entered (1): 7; left (1): 2; 1 kept with new values (rows matched on sample_id)."
  );
});

test("unchanged values, cached versions and unidentifiable rows stay quiet or brief", () => {
  const schema: Array<[string, string]> = [["unit", "str"], ["score", "float64"]];
  const rows = [{ unit: "a", score: 1 }];
  expect(effectLine("t@1", table("v1", rows, schema), table("v1", rows, schema))).toBeUndefined();
  expect(effectLine("t@1", table("v1", rows, schema), table("v2", rows, schema))).toBeUndefined();
  const dup = [{ unit: "a", score: 1 }, { unit: "a", score: 2 }];
  expect(effectLine("t@1", table("v1", dup, schema), table("v2", [...dup, { unit: "b", score: 0 }], schema))).toBe(
    "changed since t@1: 2 → 3 rows; 1 rows new, 0 rows gone."
  );
});
