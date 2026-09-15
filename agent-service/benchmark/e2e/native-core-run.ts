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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeTestSession } from "./native-test-session";

const directory = mkdtempSync(join(tmpdir(), "native-v2-core-"));
const files = Object.fromEntries(
  Object.entries({
    first: "g,v\na,1\nb,2\nb,2\n",
    second: "g,v\nb,3\n,7\n",
    revised: "g,v\nb,10\n,7\n",
    labels: "g,label\na,A\nb,B\n,NULL_LABEL\n",
    duplicate: "g,label\nb,B\nb,Duplicate\n",
  }).map(([name, content]) => {
    const path = join(directory, `${name}.csv`);
    writeFileSync(path, content);
    return [name, path];
  })
);
const reports: unknown[] = [];
try {
  for (const contextMode of ["delta", "latest"] as const) {
    const session = await nativeTestSession({ contextMode });
    try {
      const first = await session.debug({
        operators: [
          { op: "limit", id: "answer", input: "ordered", n: 2 },
          { op: "sort", id: "ordered", input: "labeled", by: [{ col: "total", desc: true }] },
          {
            op: "join",
            id: "labeled",
            left: "totals",
            right: "labels",
            on: "g",
            type: "left",
            validate: "many_to_one",
          },
          {
            op: "aggregate",
            id: "totals",
            input: "dedup",
            groupBy: ["g"],
            aggregations: [
              { fn: "sum", col: "v", as: "total" },
              { fn: "count", as: "n" },
            ],
          },
          { op: "distinct", id: "dedup", input: "combined" },
          { op: "union", id: "combined", inputs: ["first", "second"] },
          { op: "scan", id: "labels", files: files.labels },
          { op: "scan", id: "first", files: files.first },
          { op: "scan", id: "second", files: files.second },
        ],
        observe: ["answer"],
      });
      // The existing result-display API renders missing cells as "NULL".
      // These fixture columns contain no literal "NULL" values. Do not use
      // this normalization on arbitrary user data; verify actual worker nulls
      // with a downstream predicate as well.
      const displayNull = (value: unknown) => (value === "NULL" ? null : (value ?? null));
      const answer = (result: any) =>
        result.results.answer?.sampleRecords?.map((row: any) => [
          displayNull(row.g),
          row.total,
          displayNull(row.label),
        ]);
      assert.ok(
        first.results.answer?.sampleRecords?.length,
        JSON.stringify({
          results: first.results,
          toolResults: first.step.toolResults,
          observation: first.observation,
        }).slice(0, 12000)
      );
      assert.deepEqual(
        answer(first),
        [
          [null, 7, null],
          ["b", 5, "B"],
        ],
        JSON.stringify(first.results)
      );
      assert.ok(!first.observation.includes("NULL_LABEL"), "unrequested source content leaked");
      const changed = await session.debug({
        operators: [
          { op: "project", id: "new_branch", input: "answer", keep: ["total"] },
          { op: "scan", id: "second", files: files.revised },
        ],
        observe: [],
      });
      assert.deepEqual(answer(changed), [
        ["b", 12, "B"],
        [null, 7, null],
      ]);
      assert.equal(changed.results.new_branch?.sampleRecords[0].total, 12);
      assert.match(changed.observation, /totals.*re-executed/);
      assert.ok(!changed.latest.split("# Inspections")[0].includes("Output Table:"));
      const before = await session.snapshot();
      await session.debug({ operators: [], observe: ["answer"] });
      assert.deepEqual((await session.snapshot()).results, before.results);

      const failed = await session.debug({
        operators: [{ op: "scan", id: "labels", files: files.duplicate }],
        observe: [],
      });
      assert.ok(failed.results.labeled?.error, JSON.stringify(failed.results));
      assert.match(failed.observation, /JOIN_CARDINALITY/);
      assert.match(failed.latest, /JOIN_CARDINALITY/);
      const repaired = await session.debug({
        operators: [{ op: "scan", id: "labels", files: files.labels }],
        observe: ["answer"],
      });
      assert.deepEqual(answer(repaired), [
        ["b", 12, "B"],
        [null, 7, null],
      ]);
      assert.ok(repaired.delta.includes(failed.observation), "repair rewrote historical diagnostics");

      const edge = await session.debug({
        operators: [
          { op: "join", id: "self_join", left: "totals", right: "totals", on: "g", validate: "one_to_one" },
          { op: "filter", id: "empty", input: "first", columns: [], func: "def apply(row):\n    return False" },
          {
            op: "aggregate",
            id: "empty_total",
            input: "empty",
            aggregations: [
              { fn: "count", as: "n" },
              { fn: "sum", col: "v", as: "total" },
            ],
          },
          {
            op: "aggregate",
            id: "empty_groups",
            input: "empty",
            groupBy: ["g"],
            aggregations: [{ fn: "count", as: "n" }],
          },
          { op: "join", id: "crossed", left: "answer", right: "empty_total", type: "cross" },
          {
            op: "filter",
            id: "actual_nulls",
            input: "answer",
            columns: ["g", "label"],
            func: "def apply(row):\n    return row['g'] is None and row['label'] is None",
          },
          {
            op: "udf",
            id: "large_ids",
            code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'id': pd.Series([9007199254740993, None], dtype='Int64'), 'flag': pd.Series([True, None], dtype='boolean')})",
          },
          {
            op: "derive",
            id: "typed_ids",
            input: "large_ids",
            columns: [
              {
                as: "text",
                inputs: ["id", "flag"],
                dtype: "str",
                func: "def apply(row):\n    return str(row['id']) + '/' + str(row['flag'])",
              },
            ],
          },
          { op: "project", id: "exact_ids", input: "typed_ids", keep: ["text"] },
        ],
        observe: ["self_join", "empty_total", "empty_groups", "crossed", "exact_ids"],
      });
      assert.equal(edge.results.self_join?.sampleRecords.length, 2, JSON.stringify(edge.results));
      assert.deepEqual(
        edge.results.self_join.sampleRecords.map((row: any) => [row.total, row.total_right]).sort(),
        [
          [1, 1],
          [12, 12],
        ].sort()
      );
      assert.ok(
        edge.results.empty_total?.sampleRecords?.length,
        JSON.stringify({
          empty: edge.results.empty,
          emptyTotal: edge.results.empty_total,
          emptyGroups: edge.results.empty_groups,
          observation: edge.observation,
        }).slice(0, 12000)
      );
      assert.equal(edge.results.empty_total.sampleRecords[0].n, 0);
      assert.equal(displayNull(edge.results.empty_total?.sampleRecords[0].total), null);
      assert.equal(edge.results.empty_groups?.totalRowCount, 0);
      assert.ok(!edge.results.empty_groups?.error);
      assert.equal(edge.results.crossed?.sampleRecords.length, 2);
      assert.equal(
        edge.results.actual_nulls?.totalRowCount,
        1,
        "worker nulls were converted into display strings between operators"
      );
      assert.deepEqual(
        edge.results.exact_ids?.sampleRecords?.map((row: any) => row.text),
        ["9007199254740993/True", "None/None"],
        "nullable int64/bool types changed between workers"
      );
      reports.push({
        contextMode,
        passed: true,
        workflowId: session.workflowId,
        computingUnitId: session.computingUnitId,
        steps: (await session.trace()).steps.length,
        checks: [
          "nine-operator reversed core chain",
          "nullable grouping/join transport",
          "same-shape revision through existing descendants",
          "explicit visibility and cached observe",
          "cardinality failure despite hidden results",
          "repair with frozen DELTA diagnostic",
          "self-join logical ports",
          "empty grouped/ungrouped aggregate",
          "cross join",
          "exact nullable int64 and boolean worker handoff",
        ],
      });
    } finally {
      await session.close();
    }
  }
  console.log(JSON.stringify({ passed: true, reports }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
