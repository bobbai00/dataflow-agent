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
/** Real-engine smoke of the react-lean arm's mechanisms: contract flags raised
 * from the whole-table profile and inherited downstream, `expect` checks, a
 * registered operator called by name across tasks, column projections in
 * `observe`, lean entries, and (through one real model turn) `answer_from`
 * ending the turn with a composed final answer. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";
import { runAgentTurn } from "../../src/api";

const out = resolve(process.argv[2] ?? `/tmp/texera-registry/lean-smoke-${Date.now()}`);
mkdirSync(out, { recursive: true });
// The evaluation engine runs UDFs in a sandbox that sees only the benchmark
// data, so the fixture is built in a zero-input loader rather than scanned.
// It carries the traps the flags are for: "nan" tokens in a text column and a
// numeric column stored as text with a header row repeated inside the data.
const loader = [
  "def load_learners():",
  "    import pandas as pd",
  "    return pd.DataFrame({",
  '        "name": ["ann", "bob", "cid", "dee", "eve", "fay"],',
  '        "age": [20, 30, 40, 50, 60, 70],',
  '        "band": ["young", "nan", "old", "old", "nan", "young"],',
  '        "score_text": ["80", "70", "score_text", "90", "65", "72"],',
  '        "composite": [80.0, 70.0, 60.0, 90.0, 65.0, 72.0],',
  "    })",
].join("\n");
const rank = [
  "def rank_by_score(scores, top=10, key=\"composite\"):",
  '    """One row per learner in the top ranks by the chosen score column, with rank."""',
  "    ranked = scores.sort_values(key, ascending=False).head(top).reset_index(drop=True)",
  "    return ranked.assign(rank=range(1, len(ranked) + 1))",
].join("\n");
writeFileSync(`${out}/fixture.py`, `${loader}\n\n${rank}\n`);
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
let requests = 0;
const run = async (args: Record<string, unknown>): Promise<any> => {
  const result = await session.debug(args);
  await Bun.write(`${out}/${++requests}.json`, JSON.stringify(result, null, 2));
  return result;
};
// The service context embeds tool results as JSON text; read it as the model
// does after decoding the escapes.
const plain = (text: string) => text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
const contains = (text: string, needle: string, what: string) =>
  assert.ok(plain(text).includes(needle), `${what}: expected ${JSON.stringify(needle)} in\n${plain(text).slice(0, 6000)}`);
try {
  const settings = await session.settings();
  for (const key of ["nativeAnswerFrom", "nativeRegisteredOperators", "nativeContractFlags", "nativeLeanContext"] as const)
    assert.equal(settings[key], true, key);

  // Task 1: the loader raises encoding flags; a registered operator ranks; a
  // projection shows two columns of the learners; expectations are checked.
  await session.debug("Task 1: load the learners and rank the top three by composite.");
  const t1 = await run({
    edits: [loader, rank, 'learners = process(fn=load_learners, doc="Loads the six learners with age, band, a text score and the composite")', "top3 = rank_by_score(learners, top=3)"].join("\n"),
    observe: ["learners[name,band]", "top3"],
    expect: { learners: { rows: 6, nonnull: ["age"], unique: ["name"] }, top3: { rows: [1, 2] } },
  });
  const receipt = t1.step.toolResults[0].output;
  assert.deepEqual(
    receipt.operators.map((o: any) => [o.id, o.op, o.status]),
    [["learners", "process", "added"], ["top3", "rank_by_score", "added"]]
  );
  assert.deepEqual(receipt.observeColumns, { learners: ["name", "band"] });
  const c1 = t1.serviceContext as string;
  contains(c1, 'column "band" holds the text "nan" in 2 rows: text, not a missing value (null cells in "band": 0)', "literal missing flag");
  contains(c1, 'column "score_text" contains its own name as a value in 1 row: a header row repeated inside the data', "header flag");
  contains(c1, 'column "score_text" holds numbers as text', "numeric text flag");
  contains(c1, "(from learners)", "flags inherited by top3");
  contains(c1, "✓ expectation met: rows=6, unique name, nonnull age", "expectation met");
  contains(c1, "⚠ expectation failed: rows=3, expected 1-2", "expectation failed");
  contains(c1, "Complete table (all rows; 2 of 5 columns):", "column projection");
  assert.equal(t1.snapshot.results.top3.sampleRecords.length, 3);

  // Task 2: the index lists the operator and the flags; the operator is called
  // by name with other settings without resending its code; the lean entry of
  // task 1 kept a one-line probe and no rows for tables the answer did not use.
  await session.debug("Task 2: also rank the top two.");
  const t2 = await run({ edits: "top2 = rank_by_score(learners, top=2)", observe: ["top2[name,rank]"] });
  const c2 = t2.serviceContext as string;
  contains(c2, "Your operators (defs called by name", "operators index");
  contains(c2, 'rank_by_score(scores, top=10, key="composite") "One row per learner in the top ranks', "operator signature and doc");
  // The index is frozen at the start of the task: top2 does not exist yet.
  contains(c2, "— used by top3", "operator consumers");
  contains(c2, "learners: 6 rows, not shown here", "lean entry keeps no rows for a table the answer did not use");
  contains(c2, '⚠ learners: column "band" holds the text "nan" in 2 rows', "index flag alert");
  contains(c2, "## Task 1", "entry of task 1");
  assert.deepEqual(t2.step.toolResults[0].output.operators.map((o: any) => [o.id, o.status]), [["top2", "added"]]);
  assert.deepEqual(t2.snapshot.results.top2.sampleRecords.map((r: any) => r.name), ["dee", "ann"]);
  contains(c2, "Complete table (all rows; 2 of 6 columns):", "projection of the registered call's output");

  // Task 3: one real model turn. The answer is a one-row table, so the model
  // may set answer_from; either way the turn must end with a final answer.
  const turn = await runAgentTurn(
    session.agentId,
    "Task 3: what is the mean composite of the six learners, rounded to 2 decimals? Report the answer as a single-line JSON object with the key mean_composite. Your last line MUST BE: **Final Answer: <single-line JSON>**",
    { baseUrl: session.baseUrl, timeoutMs: 600_000 }
  );
  await Bun.write(`${out}/turn3.json`, JSON.stringify(turn, null, 2));
  assert.equal(turn.completed, true, `turn 3 did not complete: ${turn.errors.join("; ")}`);
  contains(turn.finalAnswer, "Final Answer:", "final answer marker");
  contains(turn.finalAnswer, "72.83", "mean composite");
  const last = [...turn.steps].reverse().find(s => s.role === "agent")!;
  const composed = !last.usage && (last.content ?? "").startsWith("**Final Answer:");
  const answerFromCalls = turn.steps.flatMap(s => s.toolCalls ?? []).filter(c => typeof (c.input as any)?.answer_from === "string").length;
  console.log(
    JSON.stringify({
      out,
      task3: { composed, answerFromCalls, llmCalls: turn.steps.filter(s => s.role === "agent" && (s.usage?.inputTokens ?? 0) > 0).length, finalAnswer: turn.finalAnswer },
    })
  );
  console.log("lean smoke OK");
} finally {
  await session.close();
}
