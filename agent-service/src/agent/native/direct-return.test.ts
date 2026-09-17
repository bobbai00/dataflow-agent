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
import { resolveDirectReturn } from "./direct-return";
const info = {
  state: "Completed",
  resultMode: "table",
  inputTuples: 0,
  outputTuples: 1,
  result: [{ profit: 90 }],
  resultSchema: [{ name: "profit", type: "double", encoding: "json-number" }],
  totalRowCount: 1,
  displayedRows: 1,
  truncated: false,
};
test("returns a complete computed row or scalar without asking a model to copy it", () => {
  expect(resolveDirectReturn({ operator: "total", format: "row" }, info)).toBe('{"profit":90}');
  expect(resolveDirectReturn({ operator: "total", format: "value", column: "profit" }, info)).toBe("90");
});
test("engine cache hits are successful materializations", () => {
  expect(resolveDirectReturn({ operator: "total", format: "row" }, { ...info, state: "CompletedFromCache" })).toBe(
    '{"profit":90}'
  );
});
test("column orientation preserves typed arrays without nested table cells", () => {
  expect(resolveDirectReturn({ operator: "total", format: "columns" }, info)).toBe('{"profit":[90]}');
  expect(
    resolveDirectReturn(
      { operator: "total", format: "columns" },
      {
        ...info,
        result: [],
        totalRowCount: 0,
        displayedRows: 0,
      }
    )
  ).toBe('{"profit":[]}');
});
test("JSON decoding is explicit, validates syntax, and preserves exact numeric text", () => {
  const text = '{"large":9007199254740993,"items":[1,null],"nested":{"x":2}}';
  const request = { operator: "answer", format: "json" as const, column: "profit" };
  expect(resolveDirectReturn(request, { ...info, result: [{ profit: text }] })).toBe(text);
  for (const value of [90, "not JSON", '{"x":NaN}'])
    expect(() => resolveDirectReturn(request, { ...info, result: [{ profit: value }] })).toThrow();
  // Ordinary string columns must not be silently parsed into another type.
  expect(resolveDirectReturn({ ...request, format: "row" }, { ...info, result: [{ profit: "[1,2]" }] })).toBe(
    '{"profit":"[1,2]"}'
  );
});
test("refuses truncated, failed, ambiguous and missing results", () => {
  const request = { operator: "total", format: "row" as const };
  for (const result of [
    undefined,
    { ...info, error: "bad" },
    { ...info, truncated: true },
    { ...info, totalRowCount: 2 },
    { ...info, state: "Blocked" },
  ])
    expect(() => resolveDirectReturn(request, result)).toThrow();
  expect(() => resolveDirectReturn({ ...request, format: "value", column: "missing" }, info)).toThrow();
  expect(() => resolveDirectReturn(request, { ...info, result: [], totalRowCount: 0, displayedRows: 0 })).toThrow();
});
test("empty records are valid and scalar strings remain strings", () => {
  expect(
    resolveDirectReturn(
      { operator: "total", format: "records" },
      { ...info, result: [], totalRowCount: 0, displayedRows: 0 }
    )
  ).toBe("[]");
  expect(
    resolveDirectReturn(
      { operator: "total", format: "value", column: "profit" },
      { ...info, result: [{ profit: "9007199254740993" }] }
    )
  ).toBe('"9007199254740993"');
});
test("a single-column result needs no column name; an ambiguous one still does", () => {
  // Omitting the column was previously an error, costing a model call to supply
  // the only name the result could have had.
  expect(resolveDirectReturn({ operator: "total", format: "value" }, info)).toBe("90");
  const text = '{"languages":[{"name":"Go"}]}';
  expect(resolveDirectReturn({ operator: "answer", format: "json" }, { ...info, result: [{ profit: text }] })).toBe(
    text
  );
  const pair = {
    ...info,
    result: [{ profit: 90, units: 4 }],
    resultSchema: [
      { name: "profit", type: "double", encoding: "json-number" },
      { name: "units", type: "long", encoding: "json-number" },
    ],
  };
  expect(() => resolveDirectReturn({ operator: "total", format: "value" }, pair)).toThrow(
    "value/json require an existing column"
  );
  expect(resolveDirectReturn({ operator: "total", format: "value", column: "units" }, pair)).toBe("4");
  // Inference never rescues a named column that the result does not have.
  expect(() => resolveDirectReturn({ operator: "total", format: "value", column: "missing" }, info)).toThrow();
});
