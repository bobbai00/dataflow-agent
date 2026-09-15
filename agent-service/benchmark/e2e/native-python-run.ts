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

import { strict as assert } from "node:assert";
import { nativeTestSession } from "./native-test-session";

const checks: Record<string, unknown>[] = [];
for (const contextMode of ["delta", "latest"] as const) {
  const session = await nativeTestSession({ contextMode });
  try {
    assert.equal((await session.settings()).nativeCatalogVersion, "v2");
    const invalidSettings = await session.request(`/${session.agentId}/settings`, "PATCH", { nativeToolMode: "typed" });
    assert.equal(invalidSettings.status, 400, "invalid V2 combinations must be client errors, not 500s");
    assert.equal((await session.settings()).nativeToolMode, "batch", "rejected settings partially mutated the agent");
    const beforeCreate = (await (await session.request("/")).json()) as any;
    const invalidCreate = await session.request("/", "POST", {
      modelType: "gpt-5.6-luna",
      workflowId: session.workflowId,
      computingUnitId: session.computingUnitId,
      settings: { nativeCatalogVersion: "v2" },
    });
    assert.equal(invalidCreate.status, 400);
    const afterCreate = (await (await session.request("/")).json()) as any;
    assert.deepEqual(
      afterCreate.agents.map((agent: any) => agent.id).sort(),
      beforeCreate.agents.map((agent: any) => agent.id).sort(),
      "invalid creation leaked an agent"
    );
    const first = await session.debug({
      operators: [
        { op: "project", id: "answer", input: "derived", keep: ["x", "doubled"] },
        {
          op: "derive",
          id: "derived",
          input: "kept",
          columns: [
            { as: "doubled", inputs: ["x"], dtype: "float64", func: "def apply(row):\n    return 2.0 * row['x']" },
          ],
        },
        {
          op: "filter",
          id: "kept",
          input: "typed",
          columns: ["x"],
          func: "def apply(row):\n    return row['x'] is not None and row['x'] > 1",
        },
        { op: "cast", id: "typed", input: "normalized", columns: [{ column: "x", dtype: "float64" }] },
        {
          op: "transform",
          id: "normalized",
          input: "source",
          columns: [
            {
              column: "x",
              dtype: "str",
              func: "def apply(value):\n    return None if value is None else value.strip()",
            },
          ],
        },
        {
          op: "udf",
          id: "source",
          code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'x': [' 1 ', ' 3 ', None], 'hidden': ['SECRET_A', 'SECRET_B', 'SECRET_C']})",
        },
      ],
      observe: ["answer"],
    });
    assert.deepEqual(
      first.results.answer?.sampleRecords.map((row: any) => [row.x, row.doubled]),
      [[3, 6]],
      JSON.stringify(first.results)
    );
    assert.ok(!first.observation.includes("SECRET_B"));
    const prior = await session.snapshot();
    const observed = await session.debug({ operators: [], observe: ["typed"] });
    assert.deepEqual((await session.snapshot()).results, prior.results, "cached observe reran the graph");
    assert.match(observed.observation, /observed \(cached\)/);
    const changed = await session.debug({
      operators: [
        {
          op: "filter",
          id: "kept",
          input: "typed",
          columns: ["x"],
          func: "def apply(row):\n    return row['x'] is not None and row['x'] <= 1",
        },
        { op: "project", id: "new_branch", input: "answer", keep: ["doubled"] },
      ],
      observe: [],
    });
    assert.equal(changed.results.answer?.sampleRecords[0].doubled, 2);
    assert.equal(changed.results.new_branch?.sampleRecords[0].doubled, 2);
    assert.match(changed.observation, /answer.*re-executed/);
    assert.ok(!changed.latest.split("# Inspections")[0].includes("Output Table:"));

    const error = await session.debug({
      operators: [
        {
          op: "derive",
          id: "derived",
          input: "kept",
          columns: [
            {
              as: "doubled",
              inputs: ["x"],
              dtype: "float64",
              func: "def apply(row):\n    denominator = row['x'] - 1\n    return 1.0 / denominator",
            },
          ],
        },
      ],
      observe: [],
    });
    assert.ok(error.results.derived?.error, "callback failure must supersede the previous result");
    for (const context of [error.observation, error.latest]) {
      assert.match(context, /CALLBACK_RUNTIME/);
      assert.match(context, /apply line 3/);
      assert.match(context, /revision [a-f0-9]{16}/);
      assert.ok(!context.includes('exec("# Licensed'), "generated runtime leaked in the observation");
    }
    const originalDiagnostic = error.observation;
    const repair = await session.debug({
      operators: [
        {
          op: "derive",
          id: "derived",
          input: "kept",
          columns: [
            { as: "doubled", inputs: ["x"], dtype: "float64", func: "def apply(row):\n    return 4.0 * row['x']" },
          ],
        },
      ],
      observe: ["answer"],
    });
    assert.equal(repair.results.answer?.sampleRecords[0].doubled, 4);
    assert.ok(repair.delta.includes(originalDiagnostic), "DELTA rewrote the earlier callback failure after repair");
    const rejected = await session.debug({
      operators: [
        { op: "filter", id: "invalid", input: "typed", columns: [], func: "def apply(row)\n    return True" },
        { op: "project", id: "blocked", input: "invalid", keep: ["x"] },
        { op: "fill_null", id: "filled", input: "typed", values: { x: 0 } },
      ],
      observe: ["filled"],
    });
    assert.match(rejected.observation, /PYTHON_SYNTAX/);
    assert.match(rejected.observation, /blocked/);
    assert.ok(rejected.results.filled?.sampleRecords.some((row: any) => row.x === 0));
    checks.push({
      contextMode,
      passed: true,
      workflowId: session.workflowId,
      computingUnitId: session.computingUnitId,
      steps: (await session.trace()).steps.length,
      checks: [
        "invalid settings/creation return 400 without mutation or leaked agents",
        "Python chain through real workers",
        "typed/null results",
        "forward references",
        "cached observe",
        "same-shaped upstream revision and existing-DAG extension",
        "hidden successes",
        "unrequested callback error with submitted line/revision",
        "repair and pinned DELTA error",
        "syntax preflight and independent edit",
      ],
    });
  } finally {
    await session.close();
  }
}
console.log(JSON.stringify({ passed: true, checks }, null, 2));
