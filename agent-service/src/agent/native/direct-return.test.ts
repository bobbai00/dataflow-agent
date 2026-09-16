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
