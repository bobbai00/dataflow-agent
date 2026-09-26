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
/** Real-engine check: a call of the model's own operator whose function fails
 * at runtime (NameError) must come back as an error observation, and the next
 * call must proceed. On 2026-09-26 the first two v4c sessions stalled after
 * exactly this situation. */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";
import { runAgentTurn } from "../../src/api";

const out = resolve(process.argv[2] ?? `/tmp/texera-registry/registered-failure-${Date.now()}`);
mkdirSync(out, { recursive: true });
const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeTaskRestore: false,
  nativeAnalysisState: true,
  nativeTaskEfficiency: true,
  nativeDefinitionRegistry: true,
  nativeAnswerFrom: true,
  nativeRegisteredOperators: true,
  nativeContractFlags: true,
  nativeLeanContext: true,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  dataflowReasoning: false,
});
const loader = [
  "def load_rows():",
  "    import pandas as pd",
  '    return pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})',
].join("\n");
const bad = [
  "def bad_report(T, column):",
  '    """Counts of {column}."""',
  "    return pd.DataFrame({\"n\": [len(T)]})",
].join("\n");
const good = [
  "def good_report(T, column):",
  '    """Counts of {column}."""',
  "    import pandas as pd",
  '    return pd.DataFrame({"n": [len(T)], "column": [column]})',
].join("\n");
const timed = async <T>(label: string, work: Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label}: no result after 180 s`)), 180_000))]);
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return result;
};
try {
  await session.debug("Task 1: load rows and report.");
  const t1: any = await timed("loader", session.debug({ edits: `${loader}\nrows = process(fn=load_rows, doc="Three rows")`, observe: ["rows"] }));
  await Bun.write(`${out}/t1.json`, JSON.stringify(t1, null, 2));
  const t2: any = await timed("failing own operator", session.debug({ edits: `${bad}\nreport = bad_report(rows, column="a")`, observe: ["report"] }));
  await Bun.write(`${out}/t2.json`, JSON.stringify(t2, null, 2));
  const receipt = t2.step.toolResults[0].output;
  console.log(JSON.stringify(receipt.operators));
  const c2 = String(t2.serviceContext);
  assert.ok(/NameError|CALLBACK_RUNTIME|failed/.test(c2), `the failure must reach the observation:\n${c2.slice(-2500)}`);
  // The repaired def fails at the output contract (a column mixing ints and strings).
  const mixed = [
    "def bad_report(T, column):",
    '    """Counts of {column}."""',
    "    import pandas as pd",
    '    return pd.DataFrame({"section": ["shape", "unique"], "value": [len(T), "x"]})',
  ].join("\n");
  const t2b: any = await timed("contract failure after repair (own operator)", session.debug({ edits: mixed, observe: ["report"] }));
  await Bun.write(`${out}/t2b.json`, JSON.stringify(t2b, null, 2));
  console.log("  state:", t2b.snapshot.results.report?.state, "error:", String(t2b.snapshot.results.report?.error ?? "").slice(0, 120));
  // The same contract failure through a plain process(fn=).
  const plainBad = [
    "def plain_bad(T):",
    "    import pandas as pd",
    '    return pd.DataFrame({"section": ["shape", "unique"], "value": [len(T), "x"]})',
  ].join("\n");
  const t2c: any = await timed("contract failure (plain process)", session.debug({ edits: `${plainBad}\nplain = process(rows, fn=plain_bad, doc="Mixed column")`, observe: ["plain"] }));
  console.log("  state:", t2c.snapshot.results.plain?.state, "error:", String(t2c.snapshot.results.plain?.error ?? "").slice(0, 120));
  // A real model turn on this state: prepareStep (compile + context) and the
  // model call must both return; the stalled v4c BI session sat exactly here.
  const turn: any = await timed(
    "model turn after the contract failure",
    runAgentTurn(session.agentId, "How many rows does `rows` have? Answer in one line.", { baseUrl: session.baseUrl, timeoutMs: 240_000 })
  );
  await Bun.write(`${out}/turn.json`, JSON.stringify(turn, null, 2));
  console.log("  completed:", turn.completed, "errors:", JSON.stringify(turn.errors).slice(0, 300), "answer:", String(turn.finalAnswer ?? "").slice(0, 120));
  const t3: any = await timed("fixed own operator", session.debug({ edits: `${good}\nreport = good_report(rows, column="a")`, observe: ["report"] }));
  await Bun.write(`${out}/t3.json`, JSON.stringify(t3, null, 2));
  assert.equal(t3.snapshot.results.report?.sampleRecords?.[0]?.n, 3);
  console.log("registered failure check OK");
} finally {
  await session.close();
}
