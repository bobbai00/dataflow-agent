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
/** Real-engine smoke of the definition registry: an in-place revision and a
 * superseding table become versions; a bind evaluates a result under earlier
 * versions (restore + fork under the hood); compare diffs two versions row by
 * row; explain reads the lineage with versions; the task-start index shows it. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";

const out = resolve(process.argv[2] ?? `/tmp/texera-registry/smoke-${Date.now()}`);
mkdirSync(out, { recursive: true });
// The evaluation engine runs UDFs in a sandbox that sees only the benchmark
// data, so the fixture is built in a zero-input loader rather than scanned.
const loader = [
  "def load_learners():",
  "    import pandas as pd",
  '    return pd.DataFrame({"name": ["ann", "bob", "cid", "dee"], "age": [20, 30, 40, 50], "python": [80, 70, 60, 90], "db": [60, 90, 60, 80]})',
].join("\n");
writeFileSync(`${out}/fixture.py`, loader);
const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeTaskRestore: true,
  nativeAnalysisState: true,
  nativeTaskEfficiency: true,
  nativeDefinitionRegistry: true,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  dataflowReasoning: false,
});
let requests = 0;
const run = async (args: Record<string, unknown>): Promise<any> => {
  const result = await session.debug(args);
  await Bun.write(`${out}/${++requests}.json`, JSON.stringify(result, null, 2));
  return result;
};
const rows = (result: any, id: string) => result.snapshot.results[id]?.sampleRecords;
try {
  assert.equal((await session.settings()).nativeDefinitionRegistry, true);
  // Task 1: the baseline sample, a five-band age grouping and an equal-weight composite.
  await session.debug("Task 1: load the learners, group ages in two bands (under 35, 35 and over) and score them with the equal-weight composite.");
  const t1 = await run({
    edits: [
      loader,
      'learners = process(fn=load_learners, doc="Loads the four learners with their age and course scores")',
      'grouped = map(learners, lambda row: {**row, "band": "young" if row["age"] < 35 else "old"}, doc="Adds the first two-band age grouping")',
      'scored = map(learners, lambda row: {**row, "composite": (row["python"] + row["db"]) / 2}, doc="Adds the equal-weight composite")',
      'joined = join(grouped, scored, on="name", validate="one_to_one", suffix="_s")',
      'band_means = aggregate(joined, by=["band"], mean_composite=mean("composite"), n=count())',
    ].join("\n"),
    observe: ["band_means"],
  });
  assert.equal(rows(t1, "band_means").length, 2);
  // Task 2: revise the grouping in place and supersede the composite with a weighted one.
  await session.debug("Task 2: use three age bands from now on, and make the weighted composite (0.7 python, 0.3 db) the active one.");
  const t2 = await run({
    edits: [
      'grouped = map(learners, lambda row: {**row, "band": "young" if row["age"] < 30 else "mid" if row["age"] < 45 else "old"}, doc="Adds the active three-band age grouping")',
      'weighted = map(learners, lambda row: {**row, "composite": 0.7 * row["python"] + 0.3 * row["db"]}, doc="Adds the active weighted composite")',
      'joined = join(grouped, weighted, on="name", validate="one_to_one", suffix="_s")',
    ].join("\n"),
    supersede: { weighted: "scored" },
    observe: ["band_means"],
  });
  assert.equal(rows(t2, "band_means").length, 3);
  assert.match(t2.step.toolResults[0].output.notes.join("\n"), /`weighted` is now the active version of `scored`/);
  // Task 3: the rollback. The index must show both definitions with two versions;
  // a bind evaluates band_means under the first grouping and the equal-weight composite.
  await session.debug("Task 3: under the first two-band grouping and the equal-weight composite, what are the band means? Compare with the current ones.");
  assert.match(t2.serviceContext, /Definitions at the start of this task/);
  const t3 = await run({
    bind: [{ target: "band_means", as: "rollback_means", versions: { grouped: "v1", scored: "v1" } }],
    explain: ["rollback_means"],
    observe: ["rollback_means", "band_means"],
  });
  const receipt = t3.step.toolResults[0].output;
  assert.match(receipt.notes.join("\n"), /grouped v2 → v1 \(grouped__v1\)/);
  assert.match(receipt.notes.join("\n"), /scored v2 → v1 \(scored\)/);
  const rolled = rows(t3, "rollback_means");
  assert.equal(rolled.length, 2, JSON.stringify(rolled));
  const byBand = Object.fromEntries(rolled.map((r: any) => [r.band, r.mean_composite]));
  // young: ann (70) + bob (80) → 75; old: cid (60) + dee (85) → 72.5
  assert.equal(byBand.young, 75);
  assert.equal(byBand.old, 72.5);
  assert.equal(rows(t3, "band_means").length, 3, "the default was not touched");
  assert.match(receipt.inspection.join("\n"), /Lineage of rollback_means/);
  assert.match(receipt.inspection.join("\n"), /grouped v1, superseded by v2|grouped__v1/);
  // compare the two versions of the scored table row by row.
  const t4 = await run({
    edits: 'diff = compare(weighted, scored, keys=["name"])\nmoved = filter(diff, lambda row: row["composite_delta"] is not None and abs(row["composite_delta"]) > 0, doc="Rows whose composite changed")',
    observe: ["diff", "moved"],
  });
  const diff = rows(t4, "diff");
  assert.equal(diff.length, 4);
  assert.ok(diff.every((r: any) => r.in_a && r.in_b));
  const ann = diff.find((r: any) => r.name === "ann");
  assert.equal(ann.composite_a, 74); // 0.7*80 + 0.3*60
  assert.equal(ann.composite_b, 70);
  assert.equal(ann.composite_delta, -4);
  assert.ok(rows(t4, "moved").length >= 3);
  const summary = {
    passed: true,
    requests,
    service: session.baseUrl,
    checks: [
      "in-place revision and supersede become versions in the task-start index",
      "bind rebuilds an earlier in-place version and binds a superseded table, leaving the default untouched",
      "explain reports lineage with versions",
      "compare diffs two versions row by row with deltas",
    ],
  };
  await Bun.write(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await session.close();
}
