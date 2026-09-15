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
import { AnalyticalStateStore } from "./analytical-state";
import type { NativeOpView } from "./catalog";
const graph = () =>
  new Map<string, NativeOpView>([
    ["source", { version: "v2", type: "UDF", inputs: [], properties: { code: "def load():\n    return None" } }],
    ["metric", { version: "v2", type: "Derive", inputs: ["source"], properties: { columns: [] } }],
    [
      "total",
      {
        version: "v2",
        type: "Aggregate",
        inputs: ["metric"],
        properties: { aggregations: [{ fn: "sum", col: "net", as: "total" }] },
      },
    ],
    [
      "regional",
      {
        version: "v2",
        type: "Aggregate",
        inputs: ["metric"],
        properties: { groupBy: ["region"], aggregations: [{ fn: "sum", col: "net", as: "total" }] },
      },
    ],
    [
      "independent",
      {
        version: "v2",
        type: "Aggregate",
        inputs: ["source"],
        properties: { aggregations: [{ fn: "count", as: "n" }] },
      },
    ],
  ]);
function finish(store: any, p: any, live: any, failed?: string) {
  for (const [id, v] of p.planned) live.set(id, v);
  const results = new Map(
    [...live.keys()].map(id => [
      id,
      {
        state: "Completed",
        result: [],
        resultMode: "data",
        inputTuples: 0,
        outputTuples: 0,
        ...(id === failed ? { error: "failed" } : {}),
        resultVersion: { complete: true, operatorId: id, operatorRevision: live.get(id)?.revision },
      },
    ])
  );
  store.finish(p.receipt, live, results);
}
function initial() {
  const store = new AnalyticalStateStore(),
    live = graph();
  const p = store.prepare(
    {
      publish: {
        name: "report",
        inputs: { values: "source" },
        outputs: { total: "total", regional: "regional", independent: "independent" },
      },
    },
    live
  );
  expect(store.catalog().active).toEqual({});
  finish(store, p, live);
  expect(p.receipt.status).toBe("committed");
  return { store, live };
}
test("correction clones all dependent outputs and shares independent work", () => {
  const { store, live } = initial();
  const p = store.prepare(
    { revise: { analysis: "report", scope: "active", overrides: { metric: { replace: true } } } },
    live
  );
  expect(p.operators.map((x: any) => x.op)).toEqual(["derive", "aggregate", "aggregate"]);
  expect(p.receipt.outputs.independent).toBe("independent");
  finish(store, p, live);
  expect(store.catalog().active.report).toBe("report@2");
  expect(store.catalog().versions[0].outputs.total).toBe("total");
  expect(() => store.assertWritable(["source"])).toThrow("immutable");
});
test("temporary fork leaves active analysis unchanged and failed update cannot publish", () => {
  const { store, live } = initial();
  live.set("fresh", { ...live.get("source")!, properties: { code: "def load():\n    return 2" } });
  const p = store.prepare({ revise: { analysis: "report", scope: "temporary", bindings: { values: "fresh" } } }, live);
  finish(store, p, live);
  expect(store.catalog().active.report).toBe("report@1");
  const next = store.prepare(
    { revise: { analysis: "report", scope: "active", overrides: { metric: { replace: true } } } },
    live
  );
  expect([...next.planned.values()].find(v => v.type === "Derive")?.inputs).toEqual(["source"]);
  finish(store, next, live, next.receipt.outputs.total);
  expect(next.receipt.status).toBe("failed");
  expect(store.catalog().active.report).toBe("report@1");
});
test("membership supplies distinct keys while the value table supplies metrics", () => {
  const { store, live } = initial();
  live.set("fresh", live.get("source")!);
  live.set("members", live.get("source")!);
  const p = store.prepare(
    {
      revise: {
        analysis: "report",
        scope: "temporary",
        bindings: { values: { operator: "fresh", membership: { operator: "members", keys: ["id"] } } },
      },
    },
    live
  );
  expect(p.operators.slice(0, 3).map((x: any) => x.op)).toEqual(["project", "distinct", "join"]);
  expect(p.operators[0].keep).toEqual(["id"]);
  expect(p.operators[2].left).toBe("fresh");
  expect(p.operators[2].validate).toBe("many_to_one");
});
test("unknown roles and overrides of bound inputs are rejected", () => {
  const { store, live } = initial();
  expect(() =>
    store.prepare({ revise: { analysis: "report", scope: "active", bindings: { missing: "source" } } }, live)
  ).toThrow("input");
  expect(() =>
    store.prepare(
      {
        revise: {
          analysis: "report",
          scope: "active",
          bindings: { values: "source" },
          overrides: { source: { code: "bad" } },
        },
      },
      live
    )
  ).toThrow("bound");
  expect(() => store.prepare({ revise: { analysis: "absent", scope: "active" } }, live)).toThrow("Unknown");
});

test("wrong or incomplete result version cannot advance active state", () => {
  const { store, live } = initial();
  for (const complete of [false, true]) {
    const p = store.prepare(
      { revise: { analysis: "report", scope: "active", overrides: { metric: { replace: true } } } },
      live
    );
    for (const [id, node] of p.planned) live.set(id, node);
    const results = new Map(
      Object.values(p.receipt.outputs).map(id => [
        id,
        { result: [], resultVersion: { complete, operatorId: id, operatorRevision: "stale" } },
      ])
    );
    store.finish(p.receipt, live, results as any);
    expect(p.receipt.status).toBe("failed");
    expect(store.catalog().active.report).toBe("report@1");
  }
});
test("out-of-band graph edits are detected before revision", () => {
  const { store, live } = initial();
  live.set("metric", { ...live.get("metric")!, properties: { columns: [], replace: true } });
  expect(() => store.prepare({ revise: { analysis: "report", scope: "active" } }, live)).toThrow(
    "Pinned graph changed"
  );
});
