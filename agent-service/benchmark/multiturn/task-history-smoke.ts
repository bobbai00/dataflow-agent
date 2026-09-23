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
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";
import { TASK_SOURCE_PREFIX } from "../../src/agent/native/task-reference";

const out = resolve(process.argv[2] ?? "/tmp/texera-task-history/smoke");
mkdirSync(out, { recursive: true });
const old = out + "/old.csv",
  fresh = out + "/fresh.csv";
const csv = (multiplier: number) =>
  "id,value\n" + Array.from({ length: 2000 }, (_, i) => `${i},${i * multiplier}`).join("\n") + "\n";
writeFileSync(old, csv(2));
writeFileSync(fresh, csv(10));
const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  maxOperatorResultCharLimit: 1000,
});
let count = 0;
const run = async (args: any) => {
  const result: any = await session.debug(args);
  await Bun.write(`${out}/${++count}.json`, JSON.stringify(result, null, 2));
  return result;
};
const rows = (result: any, id: string) => result.snapshot.results[id]?.sampleRecords;
const filter = (cutoff: number) => `eligible = filter(source, lambda row: row["id"] >= ${cutoff})`;
const aggregate = (id: string, input: string) => `${id} = aggregate(${input}, n=count(), total=sum("value"))`;
const scan = (path: string) => `source = scan(${JSON.stringify(path)})`;
const program = (...lines: string[]) => lines.join("\n");
try {
  assert.equal((await session.settings()).nativeTaskHistory, true);
  await session.debug("Establish the initial cohort and total.");
  const first = await run({
    program: program(scan(old), filter(1000), aggregate("total", "eligible")),
    observe: ["total"],
  });
  assert.deepEqual(rows(first, "total"), [{ n: 1000, total: 2999000 }]);
  await session.debug("Change source and eligibility."); // seals task 1 before any mutation
  writeFileSync(old, "id,value\n0,999\n");
  const changed = await run({
    program: program(scan(fresh), filter(1800)),
    observe: ["total"],
  });
  assert.deepEqual(rows(changed, "total"), [{ n: 200, total: 3799000 }]);
  const currentVersion = changed.snapshot.results.total?.resultVersion;
  await session.debug("Combine original membership with new values and recover original total.");
  const mixed = await run({
    program: program(
      'original_ids = project(at(eligible, task=1), keep=["id"])',
      'new_values = join(source, original_ids, on="id", validate="one_to_one")',
      aggregate("mixed_total", "new_values"),
      aggregate("original_total", "at(eligible, task=1)"),
      "def pick(original):",
      '    return original.iloc[[234]][["id", "value"]]',
      "old_udf = process(at(eligible, task=1), fn=pick)"
    ),
    observe: ["mixed_total", "original_total", "old_udf"],
  });
  assert.deepEqual(rows(mixed, "mixed_total"), [{ n: 1000, total: 14995000 }]);
  assert.deepEqual(rows(mixed, "original_total"), [{ n: 1000, total: 2999000 }]);
  assert.deepEqual(rows(mixed, "old_udf"), [{ id: 1234, value: 2468 }]);
  assert.deepEqual(mixed.snapshot.results.total?.resultVersion, currentVersion);
  assert.ok(!mixed.serviceContext.includes("/retained-results/"), "archive storage paths leaked into model context");
  assert.ok(!mixed.serviceContext.includes(TASK_SOURCE_PREFIX), "internal archive ids leaked into model context");
  assert.match(mixed.serviceContext, /inputs: at\(eligible, task=1\)/);
  await session.debug("Submit a failed current revision.");
  const cached = await run({
    program: aggregate("original_total", "at(eligible, task=1)"),
    observe: ["original_total"],
  });
  assert.equal(cached.snapshot.results.original_total?.state, "CompletedFromCache");
  const failed = await run({
    program: 'eligible = filter(source, lambda row: row["missing"] > 0)',
    observe: ["total"],
  });
  assert.ok(failed.snapshot.results.eligible?.error);
  assert.ok(failed.snapshot.results.total?.error);
  assert.deepEqual(
    failed.snapshot.results.original_total?.resultVersion,
    cached.snapshot.results.original_total?.resultVersion
  );
  assert.equal(
    cached.snapshot.results.original_total?.materialization.executionId,
    mixed.snapshot.results.original_total?.materialization.executionId
  );
  await session.debug("Verify missing historical success cannot bind to current data.");
  const denied = await run({ program: aggregate("bad_history", "at(eligible, task=4)") });
  assert.match(JSON.stringify(denied.step.toolResults), /unavailable/);
  assert.ok(!denied.snapshot.workflow?.operators.some((op: any) => op.operatorID === "bad_history"));
  const recovered = await run({ program: "", observe: ["original_total"] });
  assert.deepEqual(rows(recovered, "original_total"), [{ n: 1000, total: 2999000 }]);
  const cachedHistory = await run({
    program: 'cached_history = project(at(original_total, task=4), keep=["n", "total"])',
    observe: ["cached_history"],
  });
  assert.deepEqual(rows(cachedHistory, "cached_history"), [{ n: 1000, total: 2999000 }]);
  const summary = {
    passed: true,
    requests: count,
    service: session.baseUrl,
    checks: [
      "all 1000 original rows retained beyond sample",
      "old file replacement and current cache invalidation do not affect history",
      "original membership plus current values",
      "historical UDF positional binding",
      "failed current revision blocks descendants",
      "failed task has no successful history binding",
      "historical dependency remains unchanged",
      "cache hits retain their original producing execution and can be task inputs",
      "archive paths and internal archive ids hidden",
    ],
  };
  await Bun.write(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await session.close();
}
