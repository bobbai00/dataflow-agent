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
import { emptyAncestors } from "./input-coverage";

const op = (id: string, inputs: string[], taskSource?: any) =>
  ({
    operatorID: id,
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: { type: inputs.length ? "Filter" : "Scan", properties: {}, inputs, version: "v2" },
    ...(taskSource ? { taskSource } : {}),
  }) as any;

test("an operator that emptied a non-empty input is named; a legitimately empty source is not", () => {
  const operators = [op("source", []), op("after_univariate", ["source"]), op("summary", ["after_univariate"])];
  const results = new Map<string, any>([
    ["source", { totalRowCount: 721 }],
    ["after_univariate", { totalRowCount: 0 }],
    ["summary", { totalRowCount: 1 }],
  ]);
  // The university trace: 721 rows in, 0 out, and a one-row summary of nothing.
  expect(emptyAncestors("summary", operators, [], results)).toEqual([{ operator: "after_univariate", inputRows: 721 }]);
  // An empty scan has no non-empty input to have lost.
  results.set("source", { totalRowCount: 0 });
  expect(emptyAncestors("summary", operators, [], results)).toEqual([]);
});

test("errors, missing results and retained historical inputs are not reported as empty", () => {
  const operators = [
    op("source", []),
    op("kept", ["source"]),
    op("mixed", ["kept", "task_archive_x"]),
    op("task_archive_x", [], { operator: "old", atTask: 1 }),
  ];
  const results = new Map<string, any>([
    ["source", { totalRowCount: 10 }],
    ["kept", { totalRowCount: 0, error: "boom" }],
    ["task_archive_x", { totalRowCount: 0 }],
    ["mixed", { totalRowCount: 3 }],
  ]);
  expect(emptyAncestors("mixed", operators, [], results)).toEqual([]);
});
