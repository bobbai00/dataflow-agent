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
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";

// Keep query, inputs and arithmetic fixed; vary only intervening task history.
// Debug execution calls the real compiler/engine without a model or a judge.
const out = resolve(process.argv[2] ?? `/tmp/texera-analysis-state/distance-${Date.now()}`);
mkdirSync(out, { recursive: true });
const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeTaskRestore: false,
  nativeAnalysisState: true,
  nativeTaskMemoryChars: 8000,
});
const rows = (result: any, id: string) => result.snapshot.results[id]?.sampleRecords;
const checks: Array<Record<string, unknown>> = [];
let task = 0;
const request = async (text: string) => {
  await session.debug(text);
  task++;
};
try {
  await request("Keep original measurements and formulas available. Initial coefficient is two.");
  const initial = await session.debug({
    edits: `measurements = parameters(id=1, value=10)
policy = parameters(weight=2)
def score(data, p):
    return data.assign(score=data.value * p.weight.iloc[0])
scored = process(measurements, policy, fn=score, doc="One score per measurement id")`,
    observe: ["scored"],
  });
  assert.equal(rows(initial, "scored")?.[0].score, 20);
  await request("Double the shared score formula and change the current coefficient to three.");
  const revised = await session.debug({
    edits: `policy = parameters(weight=3)
def score(data, p):
    return data.assign(score=data.value * p.weight.iloc[0] * 2)`,
    observe: ["scored"],
  });
  assert.equal(rows(revised, "scored")?.[0].score, 60);
  for (const distance of [2, 8, 32, 128]) {
    while (task < distance) {
      await request(
        `Unrelated review ${task + 1}: record this discussion without changing the measurements or scoring rules.`
      );
    }
    const query =
      "Read the original task-one score and rerun its original formula with the current coefficient; preserve the current score.";
    await request(query);
    assert.equal(task - 1, distance);
    const branch = `original_formula_${distance}`;
    const started = performance.now();
    const result = await session.debug({
      edits: 'saved = project(at(scored, task=1), keep=["score"])',
      fork: [{ operator: "scored", as: branch, task: 1, bindings: { policy: "policy" } }],
      recall: [1],
      observe: ["saved", branch, "scored"],
    });
    const values = {
      originalValue: rows(result, "saved")?.[0].score,
      originalFormulaCurrentParameter: rows(result, branch)?.[0].score,
      currentValue: rows(result, "scored")?.[0].score,
    };
    assert.deepEqual(values, { originalValue: 20, originalFormulaCurrentParameter: 30, currentValue: 60 });
    assert.match(result.serviceContext, /Initial coefficient is two/);
    await Bun.write(`${out}/distance-${distance}.json`, JSON.stringify(result, null, 2));
    checks.push({ distance, query, ...values, seconds: (performance.now() - started) / 1000 });
    console.log(JSON.stringify(checks.at(-1)));
  }
  await Bun.write(`${out}/summary.json`, JSON.stringify({ passed: true, modelCalls: 0, checks }, null, 2));
} finally {
  await session.close();
}
