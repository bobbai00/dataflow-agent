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

const directory = mkdtempSync(join(tmpdir(), "native-v2-profile-"));
const file = join(directory, "source.csv");
writeFileSync(file, "key,value\na,1\nb,2\n");
const reports: unknown[] = [];
try {
  for (const contextMode of ["delta", "latest"] as const) {
    let enabledData: unknown;
    for (const nativeProfileCollection of [true, false]) {
      const session = await nativeTestSession({ contextMode, nativeProfileCollection });
      try {
        const start = performance.now();
        const first = await session.debug({
          operators: [
            { op: "aggregate", id: "answer", input: "kept", aggregations: [{ fn: "count", as: "count" }] },
            {
              op: "filter",
              id: "kept",
              input: "source",
              columns: ["value"],
              func: "def apply(row):\n    return row['value'] > 1",
            },
            { op: "scan", id: "source", files: file },
            {
              op: "udf",
              id: "scalars",
              code: `def load():\n    import pandas as pd\n    # ${directory}\n    return pd.DataFrame({'big': pd.Series([9007199254740993, None], dtype='Int64'), 'text': ['NULL', None], 'flag': pd.Series([True, None], dtype='boolean')})`,
            },
            { op: "filter", id: "empty", input: "scalars", columns: [], func: "def apply(row):\n    return False" },
          ],
          observe: ["answer"],
        });
        const firstElapsedMs = performance.now() - start;
        const snapshot = await session.snapshot();
        const results = snapshot.results as Record<string, any>;
        assert.deepEqual(
          results.answer?.sampleRecords?.map((row: any) => row.count),
          [1],
          JSON.stringify(results)
        );
        assert.deepEqual(
          results.scalars.sampleRecords.map((row: any) => [row.big, row.text, row.flag]),
          [
            ["9007199254740993", "NULL", true],
            [null, null, null],
          ]
        );
        assert.equal(results.empty.outputColumns, 3, "empty schema lost at summary boundary");
        assert.ok(!first.observation.includes("9007199254740993"), "hidden successful scalar content leaked");
        assert.ok(!first.observation.includes("table-profile"), "raw metadata leaked into observation");
        for (const [id, result] of Object.entries(results)) {
          assert.ok(!result.error, `${id}: ${result.error}`);
          assert.equal(result.resultVersion?.complete, true, `${id}: ${JSON.stringify(result.resultVersion)}`);
          if (nativeProfileCollection) {
            assert.equal(result.tableProfile?.status, "available", `${id}: ${JSON.stringify(result.tableProfile)}`);
            assert.equal(result.tableProfile.resultVersion, result.resultVersion.id);
            assert.equal(result.tableProfile.coverage.complete, true);
          } else assert.equal(result.tableProfile, undefined);
        }
        if (nativeProfileCollection) {
          assert.equal(results.scalars.tableProfile.columns.big.max.value, "9007199254740993");
          assert.equal(results.scalars.tableProfile.columns.big.nullCount, 1);
          assert.equal(results.empty.tableProfile.rowCount, 0);
          assert.equal(results.source.resultVersion.sourceFingerprints[0].path, file);
          assert.equal(results.answer.resultVersion.inputs[0].resultVersion, results.kept.resultVersion.id);
        }
        const data = Object.fromEntries(Object.entries(results).map(([id, result]) => [id, result.sampleRecords]));
        if (nativeProfileCollection) enabledData = data;
        else assert.deepEqual(data, enabledData, "collection setting changed result data");

        await session.debug({ operators: [], observe: ["scalars", "empty"] });
        assert.deepEqual(
          (await session.snapshot()).results,
          snapshot.results,
          "cached observe created a new execution/profile"
        );
        const beforeId = results.answer.resultVersion.id;
        const changed = await session.debug({
          operators: [
            { op: "project", id: "new_branch", input: "answer", keep: ["count"] },
            {
              op: "filter",
              id: "kept",
              input: "source",
              columns: ["value"],
              func: "def apply(row):\n    return row['value'] > 0",
            },
          ],
          observe: [],
        });
        const revised = (await session.snapshot()).results as Record<string, any>;
        assert.equal(revised.answer.sampleRecords[0].count, 2);
        assert.notEqual(revised.answer.resultVersion.id, beforeId);
        assert.equal(revised.answer.resultVersion.inputs[0].resultVersion, revised.kept.resultVersion.id);
        if (nativeProfileCollection)
          assert.equal(revised.answer.tableProfile.status, "available", JSON.stringify(revised.answer));
        assert.ok(
          !changed.latest.split("# Inspections")[0].includes("Output Table:"),
          "empty observe leaked results in LATEST"
        );
        assert.ok(changed.delta.includes(first.observation), "DELTA rewrote the first observation");
        const pinned = await session.request(`/${session.agentId}/snapshots/${first.step.id}`);
        assert.ok(pinned.ok);
        assert.deepEqual(
          (await pinned.json() as { results: Record<string, unknown> }).results,
          snapshot.results,
          "historical API snapshot changed after revision"
        );
        const failed = await session.debug({
          operators: [
            {
              op: "filter",
              id: "kept",
              input: "source",
              columns: ["value"],
              func: "def apply(row):\n    return 'bad'",
            },
          ],
          observe: [],
        });
        const broken = (await session.snapshot()).results as Record<string, any>;
        assert.match(broken.kept.error, /requires bool/);
        assert.equal(broken.kept.tableProfile, undefined);
        assert.equal(broken.answer.tableProfile, undefined);
        assert.match(failed.observation, /requires bool/);
        const repaired = await session.debug({
          operators: [
            {
              op: "filter",
              id: "kept",
              input: "source",
              columns: ["value"],
              func: "def apply(row):\n    return row['value'] > 0",
            },
          ],
          observe: ["answer"],
        });
        const recovered = (await session.snapshot()).results as Record<string, any>;
        assert.equal(recovered.answer.sampleRecords[0].count, 2);
        if (nativeProfileCollection)
          assert.equal(recovered.answer.tableProfile.status, "available", JSON.stringify(recovered.answer));
        assert.ok(repaired.delta.includes(failed.observation), "repair rewrote historical errors");
        reports.push({
          contextMode,
          nativeProfileCollection,
          workflowId: results.source.resultVersion.workflowId,
          firstElapsedMs: Math.round(firstElapsedMs),
          steps: (await session.trace()).steps.length,
          profileCost: nativeProfileCollection
            ? Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.tableProfile.cost]))
            : null,
        });
      } finally {
        await session.close();
      }
    }
  }
  console.log(JSON.stringify({ suite: "native-v2-profile", reports, cleanup: "complete" }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
