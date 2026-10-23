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

import { NativeOperatorDefinition, OperatorPredicate } from "../../types/workflow-common.interface";
import {
  assembleNativeStatement,
  isNativeOperator,
  isVisualizationOperator,
  nativeArgumentLabel,
  nativeFieldSource,
  nativeOperatorIcon,
  nativeOperatorSummary,
  nativeOperatorTypeName,
  nativePositionalLabel,
  nativeScanFileKind,
  nativeScanFileLabel,
  nativeScanFiles,
  nativeStatementBody,
  pythonString,
} from "./native-operator";

// Definitions as the agent stores them (shapes from a real session).
const aggregate: NativeOperatorDefinition = {
  type: "Aggregate",
  inputs: ["joined"],
  properties: {
    groupBy: ["station_name"],
    aggregations: [
      { fn: "count", as: "ride_count" },
      { fn: "mean", as: "avg_ride_minutes", col: "duration_minutes" },
    ],
  },
  source:
    "set agg: aggregate(joined, by=['station_name'], outputs={'ride_count': count(), 'avg_ride_minutes': mean('duration_minutes')})",
};
const join: NativeOperatorDefinition = {
  type: "Join",
  inputs: ["trips", "stations"],
  properties: { on: [["start_station_id", "station_id"]], type: "inner", validate: "many_to_one" },
  source: "set joined: join(trips, stations, on=[('start_station_id','station_id')], how='inner')",
};
const registered: NativeOperatorDefinition = {
  type: "Process",
  inputs: ["records"],
  registeredName: "widen",
  properties: {
    registered: {
      cells: ["def widen(table, *, factor=2):\n    return table"],
      entry: "widen",
      settings: { factor: 3 },
    },
  },
  source: "set wide: widen(records, factor=3)",
};
const operator = (id: string, nativeOp?: NativeOperatorDefinition) =>
  ({ operatorID: id, operatorType: "DataProcessing", nativeOp }) as unknown as OperatorPredicate;

describe("native operator presentation", () => {
  it("recognizes only operators the agent defined natively", () => {
    expect(isNativeOperator(operator("agg", aggregate))).toBe(true);
    expect(isNativeOperator(operator("csv"))).toBe(false);
    expect(isNativeOperator(undefined)).toBe(false);
  });

  it("uses Texera's icon for the equivalent operator, the native icons for the rest, and Python for functions", () => {
    expect(nativeOperatorIcon(aggregate)).toBe("assets/operator_images/Aggregate.png");
    expect(nativeOperatorIcon(join)).toBe("assets/operator_images/HashJoin.png");
    expect(nativeOperatorIcon({ ...aggregate, type: "Scan" })).toBe("assets/operator_images/CSVFileScan.png");
    expect(nativeOperatorIcon({ ...aggregate, type: "Pivot" })).toBe("assets/operator_images/NativePivot.png");
    expect(nativeOperatorIcon({ ...aggregate, type: "Window" })).toBe("assets/operator_images/NativeWindow.png");
    expect(nativeOperatorIcon({ ...aggregate, type: "Unpivot" })).toBe("assets/operator_images/NativeUnpivot.png");
    expect(nativeOperatorIcon(registered)).toBe("assets/operator_images/PythonUDFV2.png");
    expect(nativeOperatorIcon({ ...aggregate, type: "SomethingNew" })).toBe("assets/operator_images/PythonUDFV2.png");
  });

  it("names a scan's file and kind for its box, and marks a function that draws", () => {
    const scan: NativeOperatorDefinition = {
      type: "Scan",
      inputs: [],
      properties: { files: "/texera/sf-airbnb/v1/listings.csv" },
    };
    expect(nativeScanFiles(scan)).toEqual(["listings.csv"]);
    expect(nativeScanFileLabel(scan)).toBe("listings.csv");
    expect(nativeScanFileKind(scan)).toBe("CSV");
    const many = { ...scan, properties: { files: ["data/2024.parquet", "data/2025.parquet", "data/2026.parquet"] } };
    expect(nativeScanFileLabel(many)).toBe("2024.parquet +2 more");
    expect(nativeScanFileKind(many)).toBe("PARQUET");
    expect(nativeScanFileKind({ ...scan, properties: { files: "export/2024-dump.csv.gz" } })).toBe("CSV");
    expect(nativeScanFileKind({ ...scan, properties: { files: "README" } })).toBe("FILE");
    expect(nativeScanFileLabel({ ...scan, properties: {} })).toBe("");
    const drawing = {
      ...registered,
      properties: { registered: { ...registered.properties["registered"], visualization: true } },
    };
    expect(isVisualizationOperator(drawing)).toBe(true);
    expect(isVisualizationOperator(registered)).toBe(false);
    expect(nativeOperatorIcon(drawing)).toBe("assets/operator_images/BarChart.png");
  });

  it("names the native type, or the registered function an operator calls", () => {
    expect(nativeOperatorTypeName(aggregate)).toBe("Aggregate");
    expect(nativeOperatorTypeName(registered)).toBe("widen");
  });

  it("summarizes a box by its doc, else by what its statement computes", () => {
    expect(nativeStatementBody("set top5: limit(ranked, n=5)")).toBe("limit(ranked, n=5)");
    expect(
      nativeOperatorSummary(operator("top5", { ...aggregate, source: "set top5: limit(ranked, n=5)" }) as any)
    ).toBe("limit(ranked, n=5)");
    expect(nativeOperatorSummary(operator("agg", { ...aggregate, doc: "Counts rides per station." }) as any)).toBe(
      "Counts rides per station."
    );
  });

  it("labels arguments readably, by operator where the keyword alone is ambiguous", () => {
    expect(nativeArgumentLabel("aggregate", "by")).toBe("Group by");
    expect(nativeArgumentLabel("sort", "by")).toBe("Sort by");
    expect(nativeArgumentLabel("window", "partition_by")).toBe("Partition by");
    expect(nativeArgumentLabel("widen", "min_orders")).toBe("Min orders");
    expect(nativePositionalLabel("filter", 0)).toBe("Condition");
    expect(nativePositionalLabel("map", 0)).toBe("Row function");
  });

  it("writes Python string literals the way repr does", () => {
    expect(pythonString("inner")).toBe("'inner'");
    expect(pythonString("it's")).toBe('"it\'s"');
    expect(pythonString("both ' and \"")).toBe("'both \\' and \"'");
    expect(pythonString("a\\b\nc")).toBe("'a\\\\b\\nc'");
  });

  it("keeps an unchanged argument as written and spells a changed literal in Python", () => {
    const n = { kind: "number" as const, source: "3.0", value: 3 };
    expect(nativeFieldSource({ ...n }, n)).toBe("3.0");
    expect(nativeFieldSource({ ...n, value: 5 }, n)).toBe("5");
    const columns = { kind: "strings" as const, source: "['a']", value: ["a"] };
    expect(nativeFieldSource({ ...columns, value: ["a", "b"] }, columns)).toBe("['a', 'b']");
    expect(nativeFieldSource({ kind: "boolean", source: "True", value: false })).toBe("False");
    expect(nativeFieldSource({ kind: "string", source: "'x'", value: "left" })).toBe("'left'");
    expect(nativeFieldSource({ kind: "lambda", source: "lambda row: row['n'] > 1" })).toBe("lambda row: row['n'] > 1");
  });

  it("assembles a statement from inputs, positional arguments, keywords and a doc", () => {
    expect(
      assembleNativeStatement({
        id: "kept",
        op: "filter",
        inputs: ["records"],
        positional: ["lambda row: row['value'] > 25"],
        keywords: [],
        doc: "Rows above 25",
      })
    ).toBe("set kept: filter(records, lambda row: row['value'] > 25, doc='Rows above 25')");
    expect(
      assembleNativeStatement({
        id: "agg",
        op: "aggregate",
        inputs: ["joined"],
        positional: [],
        keywords: [
          { name: "by", source: "['station']" },
          { name: "", source: "ignored" },
          { name: "outputs", source: "{'n': count()}" },
        ],
      })
    ).toBe("set agg: aggregate(joined, by=['station'], outputs={'n': count()})");
    expect(assembleNativeStatement({ id: "records", op: "make_table", inputs: [], positional: [], keywords: [] })).toBe(
      "set records: make_table()"
    );
  });
});
