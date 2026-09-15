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
import { NativeRecipeStore } from "./recipes";
import type { NativeOpView } from "./catalog";

const graph = (): Map<string, NativeOpView> =>
  new Map([
    ["source", { type: "Scan", properties: { files: "v1.csv" }, inputs: [] }],
    ["cohort", { type: "Filter", properties: { predicate: "orders >= 12" }, inputs: ["source"] }],
    ["metric", { type: "Compute", properties: { columns: { net: "gross - refunds" } }, inputs: ["cohort"] }],
    ["total", { type: "Aggregate", properties: { aggregations: [{ fn: "sum", col: "net" }] }, inputs: ["metric"] }],
  ]);

test("rebind clones only the required suffix and preserves a frozen definition", () => {
  const live = graph();
  const store = new NativeRecipeStore();
  store.save("initial", live);
  live.get("cohort")!.properties.predicate = "orders >= 5";
  live.set("new_cohort", { ...live.get("cohort")!, inputs: ["source"] });
  const result = store.expand(
    { recipe: "initial", targets: ["total"], bind: { cohort: "new_cohort" }, prefix: "local" },
    live
  );
  expect(result.operators.map(op => op.id)).toEqual(["local_metric", "local_total"]);
  expect(result.operators[0].input).toBe("new_cohort");
  expect(result.targets).toEqual(["local_total"]);
  expect(live.has("local_total")).toBe(false);
  const restored = store.expand({ recipe: "initial", targets: ["total"], bind: {}, prefix: "old" }, live);
  expect(restored.operators.map(op => op.id)).toEqual(["old_cohort", "old_metric", "old_total"]);
  expect(restored.operators[0].predicate).toBe("orders >= 12");
});

test("a matching subgraph is reused; dead or irrelevant bindings are rejected", () => {
  const live = graph(),
    store = new NativeRecipeStore();
  store.save("v1", live);
  expect(store.expand({ recipe: "v1", targets: ["total"], bind: {}, prefix: "same" }, live).operators).toEqual([]);
  expect(() =>
    store.expand({ recipe: "v1", targets: ["total"], bind: { cohort: "missing" }, prefix: "bad" }, live)
  ).toThrow("missing");
  expect(() =>
    store.expand({ recipe: "v1", targets: ["cohort"], bind: { total: "source" }, prefix: "bad" }, live)
  ).toThrow("unused");
  expect(() => store.save("v1", live)).toThrow("already");
});

test("collisions and graph cycles fail before any mutation", () => {
  const live = graph(),
    store = new NativeRecipeStore();
  store.save("v1", live);
  live.set("fresh", { type: "Scan", properties: { files: "v2.csv" }, inputs: [] });
  live.set("local_cohort", live.get("cohort")!);
  expect(() =>
    store.expand({ recipe: "v1", targets: ["total"], bind: { source: "fresh" }, prefix: "local" }, live)
  ).toThrow("exists");
  const bad = graph();
  bad.get("source")!.inputs = ["total"];
  expect(() => store.save("cycle", bad)).toThrow("cycle");
});

test("opaque UDF code keeps its exact source and gets a positional adapter", async () => {
  const live = graph(),
    store = new NativeRecipeStore();
  const source = 'def process(cohort):\n    label = "cohort"\n    return cohort.assign(label=label)';
  live.set("custom", { type: "UDF", properties: { code: source }, inputs: ["cohort"] });
  store.save("v1", live);
  const result = store.expand({ recipe: "v1", targets: ["custom"], bind: { cohort: "metric" }, prefix: "new" }, live);
  const code = String(result.operators[0].code);
  const child = Bun.spawn(
    [
      "python",
      "-c",
      code + '\nclass Frame:\n    def assign(self, **kw): return kw\nassert process(Frame()) == {"label": "cohort"}',
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
  expect(result.operators[0].inputs).toEqual(["metric"]);
});
