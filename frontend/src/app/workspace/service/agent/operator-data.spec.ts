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

import { OperatorPredicate } from "../../types/workflow-common.interface";
import {
  cellText,
  errorText,
  formProperties,
  inputOperatorIds,
  operatorProperties,
  summaryOutcome,
  summaryTable,
  tableShape,
} from "./operator-data";

describe("an operator's data", () => {
  it("takes a table's size, its typed columns and its first records from the agent's summary", () => {
    const table = summaryTable(
      {
        state: "CompletedFromCache",
        inputTuples: 0,
        outputTuples: 4,
        totalRowCount: 4,
        cached: true,
        resultSchema: [{ name: "id", type: "int64" }],
        sampleRecords: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      },
      2
    );
    expect(table).toEqual({
      rows: 4,
      columns: [{ name: "id", type: "int64" }],
      records: [{ id: 1 }, { id: 2 }],
      cached: true,
    });
    expect(tableShape(table)).toBe("4 rows · 1 column");
  });

  it("reads columns off the records when no schema came, leaving out the engine's own keys", () => {
    const table = summaryTable(
      { state: "Completed", inputTuples: 0, outputTuples: -1, sampleRecords: [{ __row_index__: 0, a: 1, b: null }] },
      5
    );
    expect(table.columns).toEqual([{ name: "a" }, { name: "b" }]);
    // A count the engine did not record is unknown, not negative.
    expect(table.rows).toBeUndefined();
    expect(tableShape(table)).toBe("2 columns");
  });

  it("keeps a chart's HTML instead of its records", () => {
    const table = summaryTable(
      {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        sampleRecords: [{ __is_visualization__: true, "html-content": "<div>chart</div>" }],
      },
      5
    );
    expect(table).toMatchObject({ html: "<div>chart</div>", columns: [], records: [] });
  });

  it("says what a summary holds: a table once completed, a failure, or nothing yet", () => {
    expect(summaryOutcome("a", undefined, 3)).toEqual({});
    expect(summaryOutcome("a", { state: "Running", inputTuples: 0, outputTuples: 0 }, 3)).toEqual({});
    expect(summaryOutcome("a", { state: "Completed", inputTuples: 0, outputTuples: 0 }, 3).table?.rows).toBe(0);
    expect(summaryOutcome("a", { state: "Failed", inputTuples: 0, outputTuples: 0, error: "boom" }, 3)).toEqual({
      error: "boom",
    });
  });

  it("reads a native operator's failure off its envelope, naming the operator that failed when it is another", () => {
    const envelope = (operatorId: string) =>
      `NATIVE_ERROR_V2:${JSON.stringify({ operatorId, code: "E", message: "division by zero" })}`;
    expect(errorText("ratio", envelope("ratio"))).toBe("division by zero");
    expect(errorText("report", envelope("ratio"))).toBe("ratio failed: division by zero");
    expect(errorText("x", "NATIVE_ERROR_V2:{not json")).toBe("NATIVE_ERROR_V2:{not json");
  });

  it("finds the operators feeding an operator, in port order", () => {
    const join = {
      operatorID: "joined",
      inputPorts: [{ portID: "input-0" }, { portID: "input-1" }],
    } as unknown as OperatorPredicate;
    const links = [
      { source: { operatorID: "people" }, target: { operatorID: "joined", portID: "input-1" } },
      { source: { operatorID: "orders" }, target: { operatorID: "joined", portID: "input-0" } },
      { source: { operatorID: "joined" }, target: { operatorID: "report", portID: "input-0" } },
    ];
    expect(inputOperatorIds(join, links)).toEqual(["orders", "people"]);
    // A native operator names its inputs itself.
    const native = { ...join, nativeOp: { type: "Join", inputs: ["a", "b"], properties: {} } } as OperatorPredicate;
    expect(inputOperatorIds(native, links)).toEqual(["a", "b"]);
  });

  it("names a native operator's settings as its edit form does, or else shows its statement", () => {
    expect(
      formProperties({
        id: "agg",
        op: "aggregate",
        inputs: ["orders"],
        positional: [],
        keywords: [{ name: "by", source: "['region']", kind: "strings", value: ["region"] }],
        statement: "set agg: aggregate(orders, by=['region'])",
      })
    ).toEqual([
      { label: "Input", value: "orders" },
      { label: "Group by", value: "['region']" },
    ]);
    const native = {
      operatorID: "agg",
      nativeOp: { type: "Aggregate", inputs: ["orders"], properties: {}, source: "set agg: aggregate(orders)" },
    } as unknown as OperatorPredicate;
    expect(operatorProperties(native)).toEqual([
      { label: "Inputs", value: "orders" },
      { label: "Statement", value: "set agg: aggregate(orders)" },
    ]);
    const scan = {
      operatorID: "scan",
      operatorProperties: { fileName: "a.csv", hasHeader: true, limit: null, columns: ["a"] },
    } as unknown as OperatorPredicate;
    expect(operatorProperties(scan)).toEqual([
      { label: "File Name", value: "a.csv" },
      { label: "Has Header", value: "true" },
      { label: "Columns", value: '["a"]' },
    ]);
  });

  it("writes a cell as text", () => {
    expect([cellText("a"), cellText(3), cellText(null), cellText(undefined), cellText({ k: 1 })]).toEqual([
      "a",
      "3",
      "null",
      "null",
      '{"k":1}',
    ]);
  });
});
