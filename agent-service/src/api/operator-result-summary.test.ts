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
import { operatorInfoToSummary, operatorResultSummaries } from "./operator-result-summary";
import type { OperatorInfo } from "../types/execution";
import { mergeTableProfiles } from "../agent/native/profiles";

const info: OperatorInfo = { state: "Completed", inputTuples: 0, outputTuples: 0, resultMode: "table", result: [] };
test("snapshot API preserves transport truncation even when every row is retained", () => {
  for (const truncated of [true, false]) {
    const summary = JSON.parse(
      JSON.stringify(
        operatorInfoToSummary({
          ...info,
          result: [{ text: "long cell" }],
          totalRowCount: 1,
          truncated,
        })
      )
    );
    expect(summary.truncated).toBe(truncated);
    expect(summary.sampleRecords).toHaveLength(1);
  }
});
test("snapshot API preserves structured schema, profile and producing/retrieval identities without raw envelopes", () => {
  const structured: OperatorInfo = {
    ...info,
    resultSchema: [{ name: "amount", type: "int64", encoding: "number-or-decimal-string" }],
    executionContext: { workflowId: 7, executionId: "102" },
    materialization: { outputPort: 0, executionId: "100", cached: true },
    tableProfile: {
      ...mergeTableProfiles(undefined, { operatorId: "source", operatorRevision: "0123456789abcdef" }),
      resultVersion: "bound",
    },
    resultMetadata: { worker: "raw worker envelope" },
  };
  const summary = JSON.parse(JSON.stringify(operatorInfoToSummary(structured)));
  expect(summary.outputColumns).toBe(1);
  expect(summary.resultSchema).toEqual(structured.resultSchema);
  expect(summary.executionContext.executionId).toBe("102");
  expect(summary.materialization.executionId).toBe("100");
  expect(summary.tableProfile).toEqual(structured.tableProfile);
  expect(summary.resultMetadata).toBeUndefined();
});
test("legacy summary fields keep their previous wire shape", () => {
  expect(JSON.parse(JSON.stringify(operatorInfoToSummary(info)))).toEqual({
    state: "Completed",
    inputTuples: 0,
    outputTuples: 0,
    sampleRecords: [],
  });
});

test("a result reused from cache shows the table it reused and its inputs' rows, not zeros", () => {
  const port = (portID: string) => ({ portID, displayName: portID, allowMultiInputs: false, isDynamicPort: false });
  const operator = (operatorID: string, inputs: string[]) =>
    ({ operatorID, inputPorts: inputs.map(port), outputPorts: [port("output-0")] }) as any;
  const link = (source: string, target: string, portID: string) => ({
    linkID: `${source}-${target}`,
    source: { operatorID: source, portID: "output-0" },
    target: { operatorID: target, portID },
  });
  const workflow = {
    operators: [operator("orders", []), operator("people", []), operator("joined", ["input-0", "input-1"])],
    links: [link("orders", "joined", "input-0"), link("people", "joined", "input-1")],
  };
  // The engine reports a cached region's counts as -1, or none for an output it kept no count for.
  const cached = (rows: number | undefined, outputTuples: number): OperatorInfo => ({
    ...info,
    state: "CompletedFromCache",
    inputTuples: -1,
    outputTuples,
    inputPortShapes: [{ portIndex: 0, rows: -1, columns: 0 }],
    totalRowCount: rows,
    resultSchema: [{ name: "id", type: "int64", encoding: "" }],
  });
  const summaries = operatorResultSummaries(
    new Map([
      ["orders", cached(120, 0)],
      ["people", { ...info, outputTuples: 40, totalRowCount: 40 }],
      ["joined", cached(118, -1)],
    ]),
    workflow
  );
  expect(summaries.orders).toMatchObject({ cached: true, outputTuples: 120 });
  expect(summaries.joined).toMatchObject({
    cached: true,
    outputTuples: 118,
    inputTuples: 160,
    inputPortShapes: [
      { portIndex: 0, rows: 120, columns: 1 },
      { portIndex: 1, rows: 40, columns: 0 },
    ],
  });
  expect(summaries.people.cached).toBeUndefined();
  // A count nothing records stays unknown rather than zero.
  expect(operatorResultSummaries(new Map([["orders", cached(undefined, 0)]]), workflow).orders.outputTuples).toBe(-1);
});
