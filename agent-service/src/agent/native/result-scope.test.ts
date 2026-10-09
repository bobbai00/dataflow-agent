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
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { resultScope } from "./result-scope";

function fixture() {
  const ops = [
    ["orders", "Scan", [], {}],
    ["eligible", "Filter", ["orders"], {}],
    ["ranked", "Sort", ["eligible"], {}],
    ["top", "Limit", ["ranked"], { n: 5, offset: 2 }],
    ["display", "Project", ["top"], {}],
    ["total", "Aggregate", ["display"], {}],
    ["custom", "Process", ["top"], { code: "def custom(df):\n    return df" }],
    ["joined", "Join", ["orders", "display"], { type: "inner" }],
  ].map(([id, type, inputs, properties]) => ({
    operatorID: id,
    operatorType: "DataProcessing",
    nativeOp: { type, inputs, properties, revision: `revision-${id}` },
  })) as OperatorPredicate[];
  const workflow = { operators: ops, links: [] } as unknown as WorkflowContent;
  const rows = { orders: 200, eligible: 100, ranked: 100, top: 5, display: 5, total: 1, custom: 5, joined: 30 };
  const results = new Map(
    Object.entries(rows).map(([id, count]) => [
      id,
      {
        state: "Completed",
        inputTuples: 0,
        outputTuples: count,
        totalRowCount: count,
        resultMode: "table",
      } as OperatorInfo,
    ])
  );
  const op = (id: string) => ops.find(item => item.operatorID === id)!;
  const scope = (id: string) => resultScope(op(id), workflow, input => results.get(input));
  return { workflow, results, op, scope };
}

test("scope traces filters and limits through projections, sorting, and reductions without judging the selection", () => {
  const f = fixture();
  for (const id of ["top", "display", "total", "joined"]) {
    const text = f.scope(id).join("\n");
    expect(text).toContain('limit "top": n=5, offset=2');
    expect(text).toContain('input "ranked" (100 rows)');
    expect(text).toContain('filter "eligible"');
    expect(text).toContain('input "orders" (200 rows)');
    expect(text).not.toMatch(/incorrect|wrong|must|full population|working table/i);
  }
  expect(f.scope("orders")).toEqual([]);
});

test("opaque Python is a boundary, not an inferred filter or a claim about a complete population", () => {
  const f = fixture();
  const text = f.scope("custom").join("\n");
  expect(text).toContain('process "custom": row selection inside Python is unknown');
  expect(text).not.toContain('limit "top"');
  expect(text).not.toContain('filter "eligible"');
});

test("counts refer to completed results, never displayed sample length or failed/stale versions", () => {
  const f = fixture();
  f.results.get("ranked")!.result = [{ value: 1 }];
  expect(f.scope("top").join("\n")).toContain('input "ranked" (100 rows)');
  f.results.get("ranked")!.state = "Running";
  expect(f.scope("top").join("\n")).toContain('input "ranked" (unknown rows)');
  f.results.get("ranked")!.state = "Completed";
  f.results.get("ranked")!.error = "failed";
  expect(f.scope("top").join("\n")).toContain('input "ranked" (unknown rows)');
  delete f.results.get("ranked")!.error;
  f.results.get("ranked")!.resultVersion = { operatorRevision: "older-revision" } as OperatorInfo["resultVersion"];
  expect(f.scope("top").join("\n")).toContain('input "ranked" (unknown rows)');
});

test("empty and smaller eligible sets remain factual, including limits that remove no rows", () => {
  const f = fixture();
  f.results.get("ranked")!.totalRowCount = 2;
  f.results.get("top")!.totalRowCount = 0;
  const text = f.scope("top").join("\n");
  expect(text).toContain('input "ranked" (2 rows)');
  expect(text).toContain("output 0 rows");
  expect(text).not.toMatch(/failure|relax|expand|repair/i);
});

test("input counts require the producing version, not a later result with the same operator ID", () => {
  const f = fixture();
  f.results.get("ranked")!.resultVersion = {
    id: "ranked-v1",
    operatorRevision: "revision-ranked",
  } as OperatorInfo["resultVersion"];
  f.results.get("top")!.resultVersion = {
    operatorRevision: "revision-top",
    inputs: [{ operatorId: "ranked", resultVersion: "ranked-v1" }],
  } as OperatorInfo["resultVersion"];
  expect(f.scope("top").join("\n")).toContain('input "ranked" (100 rows)');
  f.results.get("ranked")!.resultVersion!.id = "ranked-v2";
  f.results.get("ranked")!.totalRowCount = 50;
  expect(f.scope("top").join("\n")).toContain('input "ranked" (unknown rows)');
  expect(f.scope("top").join("\n")).not.toContain('input "ranked" (50 rows)');
});

test("saved scopes use the supplied snapshot, preserve earlier receipts, and remap fork IDs", () => {
  const f = fixture();
  const saved = structuredClone(f.workflow);
  const savedResults = structuredClone(f.results);
  const before = resultScope(saved.operators.find(item => item.operatorID === "display")!, saved, id =>
    savedResults.get(id)
  );
  f.op("top").nativeOp!.properties.n = 1;
  f.results.get("ranked")!.totalRowCount = 20;
  expect(before.join("\n")).toContain("n=5");
  expect(before.join("\n")).toContain("100 rows");
  expect(f.scope("display").join("\n")).toContain("n=1");
  const renamed = resultScope(
    saved.operators.find(item => item.operatorID === "display")!,
    saved,
    id => savedResults.get(id),
    id => `${id}_old`
  );
  expect(renamed.join("\n")).toContain('limit "top_old"');
  expect(renamed.join("\n")).toContain('input "ranked_old" (100 rows)');
});

test("preview counts describe a preview, and long or cyclic ancestry stays bounded", () => {
  const f = fixture();
  f.op("orders").nativeOp!.properties.preview = 3;
  const preview = f.scope("orders").join("\n");
  expect(preview).toContain('preview "orders": 3-row budget per file/sheet/table');
  expect(preview).toContain("headers or metadata may add rows; not a full scan");
  expect(preview).not.toContain("at most 3 source rows");
  const chain = Array.from({ length: 100 }, (_, i) => ({
    operatorID: `f${i}`,
    nativeOp: { type: "Filter", inputs: [i ? `f${i - 1}` : "f99"], properties: {} },
  })) as OperatorPredicate[];
  const wf = { operators: chain, links: [] } as unknown as WorkflowContent;
  const text = resultScope(chain[99], wf, () => undefined).join("\n");
  expect(text.length).toBeLessThanOrEqual(600);
  expect(text).toContain("omitted");
  expect(resultScope(chain[99], wf, () => undefined)).toEqual(resultScope(chain[99], wf, () => undefined));
  const clipped = resultScope(
    chain[99],
    wf,
    () => undefined,
    id => id + "x".repeat(1000)
  ).join("\n");
  expect(clipped.length).toBeLessThanOrEqual(600);
  expect(clipped).toContain("omitted");
});
