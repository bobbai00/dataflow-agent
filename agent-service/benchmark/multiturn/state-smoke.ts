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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeTestSession } from "../e2e/native-test-session";

const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "analytical-state-smoke-")));
mkdirSync(out, { recursive: true });
const original = join(out, "original.csv"),
  fresh = join(out, "fresh.csv");
writeFileSync(
  original,
  "id,region,gross,cost,refunds,orders\n1,A,100,40,10,10\n2,A,200,80,20,20\n3,B,300,100,30,20\n4,B,400,150,40,5\n"
);
writeFileSync(
  fresh,
  "id,region,gross,cost,refunds,orders\n1,A,120,20,5,0\n2,A,240,50,10,0\n3,B,360,60,15,0\n4,B,480,100,20,30\n"
);
const session = await nativeTestSession({
  nativeState: true,
  nativeProfileCollection: true,
  dataLevel: 1,
  flowLevel: 1,
  userTaskPlacement: "chronological",
});
let number = 0;
const run = async (args: any, tool = "dataflow") => {
  const result = await session.debug(args, tool);
  await Bun.write(join(out, `${++number}.json`), JSON.stringify(result, null, 2));
  return result;
};
const receipt = (step: any) => step.step.toolResults.find((r: any) => r.output?.kind === "native-batch")?.output;
const rows = (step: any, id: string) => step.snapshot.results[id]?.sampleRecords;
const derive = (refunds: boolean) => [
  {
    as: "net",
    inputs: refunds ? ["gross", "cost", "refunds"] : ["gross", "cost"],
    dtype: "float64",
    func: `def apply(row):\n    return row['gross'] - row['cost']${refunds ? " - row['refunds']" : ""}`,
  },
];
try {
  const first = await run({
    operators: [
      { op: "scan", id: "source", files: original },
      {
        op: "filter",
        id: "eligible",
        input: "source",
        columns: ["orders"],
        func: "def apply(row):\n    return row['orders'] >= 10",
      },
      { op: "derive", id: "metric", input: "eligible", columns: derive(true) },
      { op: "aggregate", id: "total", input: "metric", aggregations: [{ fn: "sum", col: "net", as: "total" }] },
      {
        op: "aggregate",
        id: "regional",
        input: "metric",
        groupBy: ["region"],
        aggregations: [{ fn: "sum", col: "net", as: "total" }],
      },
      { op: "aggregate", id: "independent", input: "source", aggregations: [{ fn: "count", as: "n" }] },
    ],
    publish: {
      name: "report",
      inputs: { raw: "source", values: "eligible" },
      outputs: { total: "total", regional: "regional", independent: "independent" },
    },
    state_catalog: true,
  });
  assert.equal(receipt(first).state.status, "committed", JSON.stringify(receipt(first)));
  assert.deepEqual(rows(first, "total"), [{ total: 320 }]);
  assert.deepEqual(rows(first, "independent"), [{ n: 4 }]);
  assert.match(first.serviceContext, /report@1/);
  const baseline = structuredClone(first.snapshot.results.total),
    independent = structuredClone(first.snapshot.results.independent);
  const temporary = await run({
    operators: [],
    revise: {
      analysis: "report",
      scope: "temporary",
      overrides: { eligible: { func: "def apply(row):\n    return row['orders'] >= 20" } },
    },
    state_catalog: true,
  });
  assert.equal(receipt(temporary).state.status, "committed");
  assert.deepEqual(rows(temporary, receipt(temporary).state.outputs.total), [{ total: 270 }]);
  assert.equal(receipt(temporary).analyses.active.report, "report@1");
  const correction = await run({
    operators: [],
    revise: { analysis: "report", scope: "active", overrides: { metric: { columns: derive(false) } } },
    state_catalog: true,
  });
  assert.equal(receipt(correction).state.status, "committed", JSON.stringify(receipt(correction)));
  assert.equal(receipt(correction).state.created.length, 3);
  assert.deepEqual(rows(correction, receipt(correction).state.outputs.total), [{ total: 380 }]);
  assert.deepEqual(rows(correction, receipt(correction).state.outputs.regional), [
    { region: "A", total: 180 },
    { region: "B", total: 200 },
  ]);
  assert.deepEqual(correction.snapshot.results.total, baseline);
  assert.deepEqual(correction.snapshot.results.independent, independent);
  assert.equal(receipt(correction).analyses.active.report, "report@3");
  const denied = await run({ operators: [{ op: "scan", id: "source", files: fresh }] });
  assert.match(JSON.stringify(denied.step.toolResults), /immutable/);
  const failed = await run({
    operators: [],
    revise: {
      analysis: "report",
      scope: "active",
      overrides: {
        metric: {
          columns: [
            { as: "net", inputs: ["missing"], dtype: "float64", func: "def apply(row):\n    return row['missing']" },
          ],
        },
      },
    },
    state_catalog: true,
  });
  assert.equal(receipt(failed).state.status, "failed");
  assert.equal(receipt(failed).analyses.active.report, "report@3");
  const membership = await run({
    operators: [
      { op: "scan", id: "fresh", files: fresh },
      {
        op: "udf",
        id: "members",
        inputs: ["eligible"],
        code: "def process(eligible):\n    import pandas as pd\n    return pd.concat([eligible, eligible], ignore_index=True)",
      },
    ],
    revise: {
      analysis: "report",
      scope: "temporary",
      bindings: { values: { operator: "fresh", membership: { operator: "members", keys: ["id"] } } },
    },
    state_catalog: true,
  });
  assert.equal(receipt(membership).state.status, "committed", JSON.stringify(receipt(membership)));
  assert.deepEqual(rows(membership, receipt(membership).state.outputs.total), [{ total: 590 }]);
  assert.equal(receipt(membership).analyses.active.report, "report@3");
  assert.deepEqual(membership.snapshot.results.total, baseline);
  const cached = await run({ operators: [], state_catalog: true, observe: [receipt(correction).state.outputs.total] });
  assert.deepEqual(cached.snapshot.results, membership.snapshot.results);
  assert.match(cached.serviceContext, /report@3/);
  const udf = await run({
    operators: [
      {
        op: "udf",
        id: "tax",
        inputs: ["fresh"],
        code: "def process(fresh):\n    import pandas as pd\n    return pd.DataFrame({'tax':[fresh['gross'].sum()*0.1]})",
      },
    ],
    publish: { name: "tax_report", inputs: { values: "fresh" }, outputs: { tax: "tax" } },
  });
  assert.equal(receipt(udf).state.status, "committed");
  assert.deepEqual(rows(udf, "tax"), [{ tax: 120 }]);
  const rebound = await run({
    operators: [],
    revise: { analysis: "tax_report", scope: "temporary", bindings: { values: "source" } },
  });
  assert.equal(receipt(rebound).state.status, "committed", JSON.stringify(receipt(rebound)));
  assert.deepEqual(rows(rebound, receipt(rebound).state.outputs.tax), [{ tax: 100 }]);
  assert.deepEqual(receipt(rebound).state.opaqueOperators, [receipt(rebound).state.outputs.tax]);
  writeFileSync(original, "id,region,gross,cost,refunds,orders\n1,A,999,0,0,100\n");
  const changed = await run({ operators: [], revise: { analysis: "report", scope: "active" } });
  assert.match(JSON.stringify(changed.step.toolResults), /Pinned source content changed/);
  await Bun.write(
    join(out, "summary.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "published version bound to real results",
          "temporary preserves active",
          "correction maintains two outputs",
          "baseline and independent result versions unchanged",
          "in-place edit rejected",
          "failed execution cannot promote",
          "distinct old membership with new values",
          "cached read does not execute",
          "source content drift rejected",
          "UDF input rebinding preserves callable arguments and reports opacity",
        ],
        requests: number,
        agent: session.agentId,
        service: session.baseUrl,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: true, requests: number, out }));
} finally {
  await session.close();
}
