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
import { login, retrieveWorkflow } from "../../src/api";

const out = resolve(process.argv[2] ?? `/tmp/texera-analysis-state/smoke-${Date.now()}`);
mkdirSync(out, { recursive: true });
const source = `${out}/source.csv`;
writeFileSync(source, "id,value\n1,10\n2,20\n3,30\n");
const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeTaskRestore: false,
  nativeAnalysisState: true,
  nativeTaskMemoryChars: 8000,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
});
let requests = 0;
const run = async (args: Record<string, unknown>): Promise<any> => {
  const result = await session.debug(args);
  await Bun.write(`${out}/${++requests}.json`, JSON.stringify(result, null, 2));
  return result;
};
const rows = (result: any, id: string) => result.snapshot.results[id]?.sampleRecords;
const score = (factor: number) => `def score(data, p):
    assert data.id.is_unique, "duplicate ids"
    assert p.weight.iloc[0] >= 0, "negative weight"
    return data.assign(score=data.value * p.weight.iloc[0] * ${factor})`;
try {
  assert.equal((await session.settings()).nativeAnalysisState, true);
  await session.debug("Initial convention: use unique ids and nonnegative weights. Establish the default scores.");
  const first = await run({
    edits: [
      `def load_source():\n    import pandas as pd\n    return pd.read_csv(${JSON.stringify(source)})`,
      'raw = process(fn=load_source, doc="Loads source.csv with one row per measurement id")',
      "p = parameters(weight=2, active=True, label='base', missing=None)",
      score(1),
      'scored = process(raw, p, fn=score, doc="Weighted score with checked keys and coefficient")',
      'other = process(raw, p, fn=score, doc="A second consumer of the same score function")',
      'total = aggregate(scored, total=sum("score"))',
      'other_total = aggregate(other, total=sum("score"))',
    ].join("\n"),
    observe: ["total", "other_total", "p"],
  });
  assert.deepEqual(rows(first, "total"), [{ total: 120 }]);
  assert.deepEqual(rows(first, "p"), [{ weight: 2, active: true, label: "base", missing: null }]);

  await session.debug("Correct the shared scaling rule and compare a temporary weight without changing the default.");
  const fixed = await run({ edits: score(2), observe: ["total", "other_total"] });
  assert.deepEqual(rows(fixed, "total"), [{ total: 240 }]);
  assert.deepEqual(rows(fixed, "other_total"), [{ total: 240 }]);
  const branch = await run({
    edits: "p_trial = parameters(weight=3)",
    fork: [{ operator: "total", as: "trial", bindings: { p: "p_trial" } }],
    observe: ["trial", "total"],
  });
  assert.deepEqual(rows(branch, "trial"), [{ total: 360 }]);
  assert.deepEqual(rows(branch, "total"), [{ total: 240 }]);
  const version = branch.snapshot.results.total?.resultVersion;
  await session.debug("Explain the saved score function without changing the analysis.");
  const inspected = await run({ inspect: ["score"], recall: [1], observe: [] });
  assert.match(inspected.serviceContext, /def score\(data, p\)/);
  assert.match(inspected.serviceContext, /Initial convention: use unique ids/);
  assert.match(inspected.step.toolResults[0].output.inspection.join("\n"), /Initial convention: use unique ids/);
  assert.deepEqual(inspected.snapshot.results.total?.resultVersion, version);

  await session.debug("Use the initial formula with a current coefficient, and retain its initial values.");
  const history = await run({
    edits: 'saved = project(at(total, task=1), keep=["total"])',
    fork: [{ operator: "total", as: "old_formula", task: 1, bindings: { p: "p_trial" } }],
    observe: ["saved", "old_formula"],
  });
  assert.deepEqual(rows(history, "saved"), [{ total: 120 }]);
  assert.deepEqual(rows(history, "old_formula"), [{ total: 180 }]);
  const revised = await run({ edits: score(4), observe: ["total", "other_total", "trial", "old_formula", "saved"] });
  assert.deepEqual(rows(revised, "total"), [{ total: 480 }]);
  assert.deepEqual(rows(revised, "other_total"), [{ total: 480 }]);
  assert.deepEqual(rows(revised, "trial"), [{ total: 360 }]);
  assert.deepEqual(rows(revised, "old_formula"), [{ total: 180 }]);
  assert.deepEqual(rows(revised, "saved"), [{ total: 120 }]);
  const invalid = await run({ edits: "p = parameters(weight=-1)", observe: ["total", "other_total"] });
  assert.ok(invalid.snapshot.results.scored?.error);
  assert.ok(invalid.snapshot.results.total?.error);
  assert.ok(invalid.snapshot.results.other_total?.error);
  assert.deepEqual(rows(invalid, "saved"), [{ total: 120 }]);
  const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const persistedWeight = (workflow: Awaited<ReturnType<typeof retrieveWorkflow>>) =>
    (
      workflow.content.operators.find(op => op.operatorID === "p")?.nativeOp?.properties.values as
        | { weight?: number }
        | undefined
    )?.weight;
  let persisted;
  // Persistence is debounced and indexing a generated workflow is asynchronous.
  // Under concurrent benchmark load it can take longer than a tool execution.
  for (let attempt = 0; attempt < 120; attempt++) {
    persisted = await retrieveWorkflow(token, session.workflowId);
    if (persistedWeight(persisted) === -1) break;
    await Bun.sleep(500);
  }
  assert.equal(persistedWeight(persisted!), -1);
  assert.match(persisted!.content.operators.find(op => op.operatorID === "scored")!.nativeOp!.functions!.score, /\* 4/);
  assert.equal(
    persisted!.content.operators.find(op => op.operatorID === "trial__scored")!.nativeOp!.analysisBranch?.root,
    "trial"
  );
  const summary = {
    passed: true,
    requests,
    service: session.baseUrl,
    checks: [
      "parameter scalar types",
      "zero-input reusable loader",
      "two shared consumers recompute",
      "temporary branch preserves default",
      "inspection and recall reach model context without execution",
      "historical formula with current parameter",
      "shared corrections preserve branch functions and historical values",
      "assertions block dependents",
      "backend persistence preserves the latest parameters and branch definitions",
    ],
  };
  await Bun.write(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await session.close();
}
