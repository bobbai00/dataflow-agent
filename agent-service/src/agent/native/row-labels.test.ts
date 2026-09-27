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
import { ROW_LABEL_COLUMN, withoutRowLabels } from "./execution-transport";

const base: OperatorInfo = { state: "Completed", inputTuples: 5, outputTuples: 2, resultMode: "table" };

test("a table's pandas row labels never reach the agent: rows, schema and column stats drop the column", () => {
  const info: OperatorInfo = {
    ...base,
    result: [
      { id: 12, [ROW_LABEL_COLUMN]: 2 },
      { id: 14, [ROW_LABEL_COLUMN]: 4 },
    ],
    resultSchema: [
      { name: "id", type: "int64", encoding: "number-or-decimal-string" },
      { name: ROW_LABEL_COLUMN, type: "int64", encoding: "number-or-decimal-string" },
    ],
    columnStats: { id: "(int64): min=12, max=14", [ROW_LABEL_COLUMN]: "(int64): min=2, max=4" },
  };
  const out = withoutRowLabels(info);
  expect(out.result).toEqual([{ id: 12 }, { id: 14 }]);
  expect(out.resultSchema?.map(c => c.name)).toEqual(["id"]);
  expect(Object.keys(out.columnStats ?? {})).toEqual(["id"]);
  // The input is not mutated, and a result without labels is returned as is.
  expect(info.result?.[0]).toHaveProperty(ROW_LABEL_COLUMN, 2);
  const plain: OperatorInfo = { ...base, result: [{ id: 1 }] };
  expect(withoutRowLabels(plain)).toBe(plain);
});
