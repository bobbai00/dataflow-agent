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
import { WorkflowState } from "../workflow-state";
import { compileNativeOp } from "./codegen";
import { NATIVE_OPERATORS, nativeCatalogText } from "./catalog";
import { selectResultShapes } from "./selection";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import type { OperatorInfo } from "../../types/execution";

describe("native codegen", () => {
  test("Scan compiles to a DataLoading load() over read_csv", () => {
    const r = compileNativeOp({
      type: "Scan",
      inputs: [],
      properties: { files: "data/x/*.csv", skipLines: 3, header: false, columns: ["a", "b"], allText: true },
    });
    expect(r.operatorType).toBe("DataLoading");
    expect(r.code).toContain("def load():");
    expect(r.code).toContain("read_csv(");
    expect(r.code).toContain("skip=3");
    expect(r.code).toContain("header=false");
    expect(r.code).toContain("names=[\\'a\\', \\'b\\']");
    expect(r.code).toContain("all_varchar=true");
  });

  test("Filter embeds the predicate as a Python string literal", () => {
    const r = compileNativeOp({ type: "Filter", inputs: ["t0"], properties: { predicate: `"Beach Name" = 'Wollaston' AND x IS NOT NULL` } });
    expect(r.operatorType).toBe("DataProcessing");
    expect(r.code.startsWith("def process(t0):")).toBe(true);
    expect(r.code).toContain(`SELECT * FROM t WHERE (`);
    expect(r.code).toContain(`\\"Beach Name\\" = 'Wollaston' AND x IS NOT NULL`);
  });

  test("Aggregate quotes identifiers and maps functions", () => {
    const r = compileNativeOp({
      type: "Aggregate",
      inputs: ["src"],
      properties: { groupBy: ["state"], aggregations: [{ fn: "sum", col: "reports", as: "total" }, { fn: "count" }, { fn: "count_distinct", col: "area" }] },
    });
    expect(r.code).toContain(`SELECT \\"state\\", SUM(\\"reports\\") AS \\"total\\", COUNT(*) AS \\"count\\", COUNT(DISTINCT \\"area\\") AS \\"count_distinct_area\\" FROM t GROUP BY \\"state\\"`);
  });

  test("Join and Union take their inputs in order", () => {
    const j = compileNativeOp({ type: "Join", inputs: ["l", "r"], properties: { on: [["k", "key"]], type: "left" } });
    expect(j.code).toContain("def process(l, r):");
    expect(j.code).toContain(`l.merge(r, left_on=["k"], right_on=["key"], how="left"`);
    const u = compileNativeOp({ type: "Union", inputs: ["a", "b", "c"], properties: {} });
    expect(u.code).toContain("pd.concat([a, b, c]");
    const x = compileNativeOp({ type: "Join", inputs: ["num", "den"], properties: {} });
    expect(x.code).toContain("how='cross'");
    // self-join: one parameter used on both sides
    const s = compileNativeOp({ type: "Join", inputs: ["rates", "rates"], properties: { on: [["year_prev", "year"]] } });
    expect(s.code).toContain("def process(rates):");
    expect(s.code).toContain("rates.merge(rates,");
  });

  test("UDF parameters must match the input ids", () => {
    expect(() =>
      compileNativeOp({ type: "UDF", inputs: ["x"], properties: { code: "def process(y):\n    return y" } })
    ).toThrow(/must equal the input operator ids/);
    const ok = compileNativeOp({ type: "UDF", inputs: ["x"], properties: { code: "def process(x):\n    return x" } });
    expect(ok.operatorType).toBe("DataProcessing");
    const loader = compileNativeOp({ type: "UDF", inputs: [], properties: { code: "def load():\n    return pd.DataFrame()" } });
    expect(loader.operatorType).toBe("DataLoading");
  });

  test("arity and identifier errors are explicit", () => {
    expect(() => compileNativeOp({ type: "Filter", inputs: [], properties: { predicate: "1=1" } })).toThrow(/exactly one input/);
    expect(() => compileNativeOp({ type: "Join", inputs: ["a"], properties: { on: [["k", "k"]] } })).toThrow(/two inputs/);
    expect(() => compileNativeOp({ type: "Union", inputs: ["a", "a"], properties: {} })).toThrow(/distinct/);
    expect(() => compileNativeOp({ type: "Filter", inputs: ["bad-id"], properties: { predicate: "1=1" } })).toThrow(/identifier/);
  });

  test("catalog text lists every type once", () => {
    const text = nativeCatalogText();
    for (const d of NATIVE_OPERATORS) expect(text).toContain(d.type + " ");
  });
});

function op(id: string, type: string, inputs: string[], properties: Record<string, unknown> = {}): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: type === "Scan" ? "DataLoading" : "DataProcessing",
    operatorVersion: "N/A",
    operatorProperties: { code: "" },
    inputPorts: inputs.map((_, i) => ({ portID: `input-${i}`, displayName: "", allowMultiInputs: false, isDynamicPort: false })) as any,
    outputPorts: [{ portID: "output-0", displayName: "", allowMultiInputs: false, isDynamicPort: false }] as any,
    showAdvanced: false,
    nativeOp: { type, properties, inputs },
  };
}

function links(ops: OperatorPredicate[]): OperatorLink[] {
  const out: OperatorLink[] = [];
  for (const o of ops) {
    (o.nativeOp?.inputs ?? []).forEach((up, i) => {
      out.push({ linkID: `${up}-->${o.operatorID}`, source: { operatorID: up, portID: "output-0" }, target: { operatorID: o.operatorID, portID: `input-${i}` } });
    });
  }
  return out;
}

function info(rows: number, columnStats?: Record<string, string>): OperatorInfo {
  return { state: "COMPLETED", inputTuples: 0, outputTuples: rows, totalRowCount: rows, resultMode: "tsv", result: [{ a: 1 }], columnStats };
}

describe("result selection rule", () => {
  test("legal-hard-15 chain: scan full, filter count, compute header, aggregate input full, aggregate full", () => {
    const ops = [
      op("identity_theft", "Scan", []),
      op("non_blank", "Filter", ["identity_theft"], { predicate: "x IS NOT NULL" }),
      op("reports_num", "Compute", ["non_blank"], { columns: { reports: "TRY_CAST(reports AS INTEGER)" } }),
      op("cross_state", "Filter", ["reports_num"], { predicate: "regexp_matches(a, 'x')" }),
      op("total", "Aggregate", ["cross_state"], { aggregations: [{ fn: "sum", col: "reports" }] }),
    ];
    const infos: Record<string, OperatorInfo> = {
      identity_theft: info(660),
      non_blank: info(452, { reports: "(str): null=0, distinct=342" }),
      reports_num: info(452, { reports: "(numeric): null=0, distinct=342, mean=1" }),
      cross_state: info(94),
      total: info(1),
    };
    const shapes = selectResultShapes(ops, links(ops), id => infos[id]);
    expect(shapes.get("identity_theft")?.shape).toBe("full");
    expect(shapes.get("non_blank")?.shape).toBe("count");
    expect(shapes.get("reports_num")?.shape).toBe("header");
    expect(shapes.get("cross_state")?.shape).toBe("full"); // input of an Aggregate
    expect(shapes.get("total")?.shape).toBe("full"); // frontier + aggregate
  });

  test("a Compute whose null count moved gets a count line with the moved fact", () => {
    const ops = [
      op("src", "Scan", []),
      op("cast", "Compute", ["src"], { columns: { v: "TRY_CAST(v AS INTEGER)" } }),
      op("keep", "Filter", ["cast"], { predicate: "v > 0" }),
    ];
    const infos: Record<string, OperatorInfo> = {
      src: info(100, { v: "(str): null=0, distinct=90" }),
      cast: info(100, { v: "(numeric): null=12, distinct=80" }),
      keep: info(50),
    };
    const shapes = selectResultShapes(ops, links(ops), id => infos[id]);
    expect(shapes.get("cast")?.shape).toBe("count");
    expect(shapes.get("cast")?.note).toContain("null 0 → 12");
    expect(shapes.get("keep")?.shape).toBe("full"); // frontier
  });

  test("modify re-materializes every descendant, not only the sinks", () => {
    // scan -> filter -> compute -> aggregate, plus a second branch filter -> distinct
    const ws = new WorkflowState();
    const chain = [op("scan", "Scan", []), op("f", "Filter", ["scan"]), op("c", "Compute", ["f"]), op("agg", "Aggregate", ["c"]), op("d", "Distinct", ["f"])];
    for (const o of chain) ws.addOperator(o);
    for (const l of links(chain)) ws.addLink(l);
    expect(ws.getDownstreamSinks("f").sort()).toEqual(["agg", "d"]);
    expect(ws.getDownstreamOperators("f").sort()).toEqual(["agg", "c", "d"]);
    expect(ws.getDownstreamOperators("agg")).toEqual([]);
  });

  test("errors, non-native operators and unexecuted operators stay full", () => {
    const plain: OperatorPredicate = { ...op("u", "UDF", ["s"]), nativeOp: undefined };
    const ops = [op("s", "Scan", []), plain];
    const shapes = selectResultShapes(ops, links([op("u", "UDF", ["s"])]), id => (id === "s" ? info(10) : undefined));
    expect(shapes.get("s")?.shape).toBe("full"); // consumed by a non-native operator
    expect(shapes.get("u")?.shape).toBe("full");
  });
});
