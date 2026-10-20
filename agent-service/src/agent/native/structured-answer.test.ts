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
import { composeStructuredAnswer } from "./answer";

function table(rows: Array<Record<string, unknown>>): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows.length,
    resultMode: "table",
    result: rows,
    totalRowCount: rows.length,
    truncated: false,
  };
}

function value(
  rows: Array<Record<string, unknown>>,
  shape: "scalar" | "list" | "records",
  decimals: number | null
): unknown {
  const composed = composeStructuredAnswer({ id: "result", column: "value", shape, decimals }, table(rows));
  if ("reason" in composed) throw new Error(composed.reason);
  expect(composed.text).toBe(composed.json);
  return JSON.parse(composed.json);
}

test("null decimals preserves computed numeric precision in every explicit answer shape", () => {
  const first = 0.12345678901234567;
  const second = 93.05000000000001;
  expect(value([{ value: first }], "scalar", null)).toBe(first);
  expect(value([{ value: first }, { value: second }], "list", null)).toEqual([first, second]);
  expect(value([{ value: first }, { value: second }], "records", null)).toEqual([{ value: first }, { value: second }]);
});

test("explicit decimal rounding preserves timestamp and numeric text bytes", () => {
  const timestamp = "2024-01-01T12:34:56.123456";
  const text = '{"estimate":0.12345678901234567,"version":"1.23"}';
  expect(value([{ value: timestamp }], "scalar", 2)).toBe(timestamp);
  expect(value([{ value: timestamp }, { value: text }], "list", 2)).toEqual([timestamp, text]);
  expect(value([{ value: timestamp }, { value: text }], "records", 2)).toEqual([{ value: timestamp }, { value: text }]);
});

test("typed rounding changes numeric values recursively and follows ties to even", () => {
  const nested = { positive: 0.125, negative: -0.125, values: [0.375, "0.375", null] };
  expect(value([{ value: nested }], "scalar", 2)).toEqual({
    positive: 0.12,
    negative: -0.12,
    values: [0.38, "0.375", null],
  });
  expect(value([{ value: { precise: 0.12345678901234567 } }], "scalar", null)).toEqual({
    precise: 0.12345678901234567,
  });
  expect(value([{ value: 2.5 }, { value: 3.5 }], "list", 0)).toEqual([2, 4]);
});

test("record answers preserve selected columns and JSON nulls while rounding only numbers", () => {
  const composed = composeStructuredAnswer(
    { id: "result", column: null, shape: "records", decimals: 2 },
    table([{ label: "cost 12.3456", numeric: 12.3456, missing: undefined, infinite: Infinity, __row_index__: 0 }])
  );
  expect(composed).toEqual({
    json: '[{"label":"cost 12.3456","numeric":12.35,"missing":null,"infinite":null}]',
    text: '[{"label":"cost 12.3456","numeric":12.35,"missing":null,"infinite":null}]',
  });
});
