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
import { strict as assert } from "node:assert";
import { nativeTestSession } from "../e2e/native-test-session";
import { NativeRecipeStore } from "../../src/agent/native/recipes";
import { validateNativeV2 } from "../../src/agent/native/codegen-v2";
import { nativeViewOf } from "../../src/agent/tools/native-typed-tools";
import type { NativeOpView } from "../../src/agent/native/catalog";

// Validate the same opaque-UDF binding under V2 without pretending that the
// shared legacy backend supports V2's transport.
const views = new Map<string, NativeOpView>([
  ["source", { type: "Scan", version: "v2", inputs: [], properties: { files: "v1.csv" } }],
  [
    "scaled",
    {
      type: "UDF",
      version: "v2",
      inputs: ["source"],
      properties: { code: "def process(source):\n    return source.assign(x=source.x * 10)" },
    },
  ],
]);
const recipes = new NativeRecipeStore();
recipes.save("initial", views);
views.set("fresh", { ...views.get("source")!, properties: { files: "v2.csv" } });
const expansion = recipes.expand(
  { recipe: "initial", targets: ["scaled"], bind: { source: "fresh" }, prefix: "local" },
  views
);
for (const { op, id, ...params } of expansion.operators)
  await validateNativeV2(nativeViewOf(String(op), { id, ...params }, "v2")!, String(id));

const session = await nativeTestSession({
  nativeCatalogVersion: "v1",
  nativeRecipes: true,
  userTaskPlacement: "chronological",
});
try {
  const initial = await session.debug({
    save_as: "initial",
    operators: [
      {
        op: "udf",
        id: "source",
        code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'x': [1.0, 2.0]})",
      },
      {
        op: "udf",
        id: "scaled",
        inputs: ["source"],
        code: "def process(source):\n    return source.assign(x=source.x * 10)",
      },
      { op: "aggregate", id: "total", input: "scaled", aggregations: [{ fn: "sum", col: "x", as: "total" }] },
    ],
    observe: ["total"],
  });
  assert.equal(initial.results.total.sampleRecords[0].total, 30);
  const branched = await session.debug({
    operators: [
      {
        op: "udf",
        id: "fresh",
        code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'x': [3.0, 4.0]})",
      },
    ],
    reuse: { recipe: "initial", targets: ["total"], bind: { source: "fresh" }, prefix: "local" },
    observe: ["total"],
  });
  assert.equal(branched.results.total.sampleRecords[0].total, 30);
  assert.equal(branched.results.local_total.sampleRecords[0].total, 70);
  const trace = await session.trace();
  assert.equal(trace.steps.filter(s => s.role === "agent" && (s.usage?.inputTokens ?? 0) > 0).length, 0);
  console.log(
    JSON.stringify({
      v2_validation: "passed",
      v1_live_execution: "passed",
      original_total: 30,
      branched_total: 70,
      llm_calls: 0,
    })
  );
} finally {
  await session.close();
}
