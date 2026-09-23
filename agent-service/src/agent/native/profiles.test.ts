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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mergeTableProfiles } from "./profiles";

const expected = { operatorId: "source", operatorRevision: "0123456789abcdef", expectedWorkers: 1 };
function worker(values: (number | null)[], id = "worker-0") {
  const nonnull = values.filter((v): v is number => v !== null);
  const unique = [...new Set(nonnull)];
  const scalar = (v: number) => ({ type: "int64", value: String(v) });
  const counts = unique.map(v => ({ value: scalar(v), count: nonnull.filter(n => n === v).length }));
  return {
    protocol: "texera.table-profile",
    version: 1,
    workerId: id,
    producerId: createHash("sha256").update(id).digest("hex").slice(0, 32),
    operatorId: expected.operatorId,
    operatorRevision: expected.operatorRevision,
    status: "available",
    coverage: { scope: "worker", complete: true, rowsProcessed: values.length, yields: 1 },
    rowCount: values.length,
    columnCount: 1,
    schema: [{ name: "x", type: "int64", dtype: "Int64" }],
    schemaComplete: true,
    columns: {
      x: {
        type: "int64",
        rowsProcessed: values.length,
        nullCount: values.length - nonnull.length,
        nonnullCount: nonnull.length,
        nullRatio: values.length ? (values.length - nonnull.length) / values.length : null,
        distinctCount: unique.length,
        uniquenessRatio: nonnull.length ? unique.length / nonnull.length : null,
        min: nonnull.length ? scalar(Math.min(...nonnull)) : null,
        max: nonnull.length ? scalar(Math.max(...nonnull)) : null,
        frequencies: { values: counts, otherCount: 0, truncated: false },
        mergeValues: counts,
        omissions: [] as string[],
      },
    },
    native: null,
    structure: {
      duplicateRows: values.length - new Set(values).size,
      allNullRows: values.length - nonnull.length,
      allNullColumns: nonnull.length || !values.length ? [] : ["x"],
    },
    algorithm: {
      name: "bounded-exact-v1",
      rowSelection: "prefix",
      distinctLimit: 256,
      rowDistinctLimit: 4096,
      topK: 8,
    },
    omissions: [] as string[],
    cost: { collectionMs: 0.1, cellsProcessed: values.length, payloadBytes: 0 },
  };
}
function payload(...workers: unknown[]) {
  return Object.fromEntries(workers.map((w: any, i) => [String(i), JSON.stringify(w)]));
}

test("single worker counts, ratios and exact values are preserved", () => {
  const result = mergeTableProfiles(payload(worker([1, 1, null])), expected);
  expect(result.status).toBe("available");
  expect(result.coverage.complete).toBe(true);
  expect(result.rowCount).toBe(3);
  expect(result.columns.x).toMatchObject({ nullCount: 1, distinctCount: 1, uniquenessRatio: 0.5 });
  expect(result.structure.duplicateRows).toBe(1);
});

test("disjoint worker partitions sum counts but union distinct values", () => {
  const result = mergeTableProfiles(payload(worker([1, 2, null]), worker([2, 3, null], "w1")), {
    ...expected,
    expectedWorkers: 2,
  });
  expect(result.coverage.complete).toBe(true);
  expect(result.rowCount).toBe(6);
  expect(result.columns.x).toMatchObject({ nullCount: 2, nonnullCount: 4, distinctCount: 3, uniquenessRatio: 0.75 });
  expect(result.columns.x.frequencies?.values[0]).toEqual({ value: { type: "int64", value: "2" }, count: 2 });
  expect(result.structure.duplicateRows).toBeNull(); // cross-worker row identity was not shipped
  expect(result.omissions).toContain("cross_worker_duplicates_unavailable");
});

test("missing worker and unfinished yield cannot claim a full table", () => {
  const result = mergeTableProfiles(payload(worker([1])), { ...expected, expectedWorkers: 2 });
  expect(result.status).toBe("partial");
  expect(result.rowCount).toBeNull();
  expect(result.coverage.complete).toBe(false);
  const unfinished = worker([1]);
  unfinished.coverage.complete = false;
  expect(mergeTableProfiles(payload(unfinished), expected).coverage.complete).toBe(false);
});

test("distinct overflow or omitted merge dictionaries stay unknown across workers", () => {
  const overflow = worker([1, 2]) as any;
  overflow.columns.x.mergeValues = null;
  overflow.columns.x.frequencies = null;
  overflow.columns.x.distinctCount = null;
  overflow.columns.x.uniquenessRatio = null;
  overflow.columns.x.omissions = ["distinct_limit"];
  const result = mergeTableProfiles(payload(overflow, worker([2], "w1")), { ...expected, expectedWorkers: 2 });
  expect(result.columns.x.distinctCount).toBeNull();
  expect(result.columns.x.frequencies).toBeNull();
});

test("a worker-local exact distinct count is not enough to merge without its values", () => {
  const limited = worker([1]) as any;
  limited.columns.x.mergeValues = null;
  const result = mergeTableProfiles(payload(limited, worker([1], "w1")), { ...expected, expectedWorkers: 2 });
  expect(result.columns.x.distinctCount).toBeNull();
  expect(mergeTableProfiles(payload(limited), expected).columns.x.distinctCount).toBe(1);
});

test("duplicate contributions and wrong revisions are unavailable, never counted twice", () => {
  const w = worker([1]);
  expect(mergeTableProfiles(payload(w, w), { ...expected, expectedWorkers: 2 }).status).toBe("unavailable");
  expect(mergeTableProfiles(payload(w), { ...expected, operatorRevision: "fedcba9876543210" }).omissions).toContain(
    "profile_identity_mismatch"
  );
});

test("malformed, oversized and unsafe counts fail only the optional profile", () => {
  const bad = worker([1]);
  bad.rowCount = Number.MAX_SAFE_INTEGER + 1;
  expect(mergeTableProfiles(payload(bad), expected).status).toBe("unavailable");
  expect(mergeTableProfiles({ one: "not JSON" }, expected).status).toBe("unavailable");
  expect(mergeTableProfiles({ one: "x".repeat(65537) }, expected).omissions).toContain("metadata_payload_budget");
  expect(mergeTableProfiles(undefined, expected).omissions).toContain("profile_missing");
});

test("inconsistent full counts, dictionaries and schema are rejected", () => {
  const cases = [worker([1]), worker([1]), worker([1])];
  cases[0].coverage.rowsProcessed = 0;
  cases[1].columns.x.mergeValues[0].count = 2;
  cases[2].schema[0].name = "other";
  for (const w of cases) expect(mergeTableProfiles(payload(w), expected).status).toBe("unavailable");
});

test("empty outputs keep typed schema with undefined ratios", () => {
  const result = mergeTableProfiles(payload(worker([])), expected);
  expect(result.coverage.complete).toBe(true);
  expect(result.schema).toEqual([{ name: "x", type: "int64", dtype: "Int64" }]);
  expect(result.columns.x.nullRatio).toBeNull();
  expect(result.columns.x.uniquenessRatio).toBeNull();
});

test("exact int64 range ordering does not round through a JS number", () => {
  const a = worker([1]),
    b = worker([1], "w1");
  for (const [w, value] of [
    [a, "9007199254740993"],
    [b, "9007199254740992"],
  ] as const) {
    w.columns.x.min!.value = value;
    w.columns.x.max!.value = value;
    w.columns.x.mergeValues[0].value.value = value;
  }
  const result = mergeTableProfiles(payload(a, b), { ...expected, expectedWorkers: 2 });
  expect(result.columns.x.min?.value).toBe("9007199254740992");
  expect(result.columns.x.max?.value).toBe("9007199254740993");
  expect(result.columns.x.distinctCount).toBe(2);
});

test("merge order is deterministic and caller mutation cannot change stored evidence", () => {
  const a = worker([1]),
    b = worker([2], "w1");
  const config = { ...expected, expectedWorkers: 2 };
  expect(mergeTableProfiles(payload(a, b), config)).toEqual(mergeTableProfiles(payload(b, a), config));
  const result = mergeTableProfiles(payload(a), expected);
  a.columns.x.nullCount = 100;
  expect(result.columns.x.nullCount).toBe(0);
});

test("reserved-looking user column names remain ordinary profile keys", () => {
  const w = worker([1]);
  w.schema[0].name = "__proto__";
  (w as any).columns = Object.fromEntries([["__proto__", w.columns.x]]);
  const result = mergeTableProfiles(payload(w), expected);
  expect(result.status).toBe("available");
  expect(Object.hasOwn(result.columns, "__proto__")).toBe(true);
  expect(result.columns.__proto__.distinctCount).toBe(1);
});

test("overflow in merged row counts cannot leave a full-coverage result", () => {
  const a = worker([]),
    b = worker([], "w1");
  a.rowCount = b.rowCount = Number.MAX_SAFE_INTEGER;
  a.coverage.complete = b.coverage.complete = false;
  const result = mergeTableProfiles(payload(a, b), { ...expected, expectedWorkers: 2 });
  expect(result.status).toBe("unavailable");
  expect(result.coverage.complete).toBe(false);
  expect(result.rowCount).toBeNull();
  expect(result.omissions).toContain("profile_count_overflow");
});

test("a reversed range is not accepted as valid evidence", () => {
  const w = worker([1, 2]);
  w.columns.x.min!.value = "3";
  expect(mergeTableProfiles(payload(w), expected).status).toBe("unavailable");
});

test("the real Python collector interoperates with the TypeScript decoder", () => {
  const python = fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
  const amber = fileURLToPath(new URL("../../../../amber/src/main/python", import.meta.url));
  const run = Bun.spawnSync(
    [
      python,
      "-c",
      `
import pandas as pd
from core.util.table_profile import ProfileAccumulator
p = ProfileAccumulator('w', {'operatorId': 'source', 'operatorRevision': '0123456789abcdef'})
p.add(pd.DataFrame({'x': pd.Series([9007199254740993, None], dtype='Int64')}))
p.finish()
print(p.encode())
`,
    ],
    { env: { ...process.env, PYTHONPATH: amber } }
  );
  expect(run.exitCode).toBe(0);
  const result = mergeTableProfiles({ one: run.stdout.toString().trim() }, expected);
  expect(result.status).toBe("available");
  expect(result.columns.x.min?.value).toBe("9007199254740993");
  expect(result.cost.payloadBytes).toBeGreaterThan(0);
});
