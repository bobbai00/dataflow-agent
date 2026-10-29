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

import { describe, expect, test } from "bun:test";
import { createErrorResult, formatExecuteOperatorResult, getVisibleResultHeaders } from "./tools-utility";

describe("getVisibleResultHeaders", () => {
  test("returns every key when no internal columns are present", () => {
    expect(getVisibleResultHeaders({ a: 1, b: 2 })).toEqual(["a", "b"]);
  });

  test("strips __row_index__ from the result", () => {
    expect(getVisibleResultHeaders({ __row_index__: 0, a: 1 })).toEqual(["a"]);
  });

  test("strips __is_visualization__ from the result", () => {
    expect(getVisibleResultHeaders({ __is_visualization__: true, a: 1 })).toEqual(["a"]);
  });

  test("strips every known internal column at once", () => {
    expect(getVisibleResultHeaders({ __row_index__: 0, __is_visualization__: true, a: 1, b: 2 })).toEqual(["a", "b"]);
  });

  test("preserves visible column order", () => {
    expect(getVisibleResultHeaders({ z: 1, __row_index__: 0, a: 2, __is_visualization__: true, m: 3 })).toEqual([
      "z",
      "a",
      "m",
    ]);
  });

  test("returns an empty array for an empty row", () => {
    expect(getVisibleResultHeaders({})).toEqual([]);
  });

  test("returns an empty array when only internal columns are present", () => {
    expect(getVisibleResultHeaders({ __row_index__: 0, __is_visualization__: true })).toEqual([]);
  });
});

describe("createErrorResult", () => {
  test("wraps the error with the [ERROR] prefix", () => {
    expect(createErrorResult("boom")).toBe("[ERROR] boom");
  });

  test("keeps the prefix even for empty error text", () => {
    expect(createErrorResult("")).toBe("[ERROR] ");
  });
});

describe("formatExecuteOperatorResult", () => {
  test("renders the operator id in the standard executed message", () => {
    expect(formatExecuteOperatorResult("op-1")).toBe("Executed operator op-1");
  });
});
