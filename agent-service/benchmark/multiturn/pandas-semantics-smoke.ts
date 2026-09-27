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
/** Real-engine smoke of the pandas-compatible semantics and the answer
 * precision contract: repeated headers renamed as pandas names them, pandas'
 * missing-value tokens read as missing and counted, null group keys dropped,
 * row labels kept through a filter and handed to a pandas function as the
 * index (through the engine's storage, never shown to the model), and one real
 * model turn whose composed answer must state its rounding. */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";
import { runAgentTurn } from "../../src/api";

const out = resolve(process.argv[2] ?? `/tmp/texera-registry/pandas-smoke-${Date.now()}`);
mkdirSync(out, { recursive: true });
const loader = [
  "def load_people():",
  "    import pandas as pd",
  '    return pd.DataFrame({"id": [10, 11, 12, 13, 14], "country": ["IN", None, "US", "IN", "US"], "score": [1.5, 2.25, 3.125, 4.0, 5.5]})',
].join("\n");
const pick = [
  "def pick_clean(people, cleaned):",
  '    """The ids of the cleaned rows, picked from people by index."""',
  '    return people.loc[cleaned.index, ["id"]]',
].join("\n");
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
const plain = (text: string) => text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
const contains = (text: string, needle: string, what: string) =>
  assert.ok(plain(text).includes(needle), `${what}: expected ${JSON.stringify(needle)} in\n${plain(text).slice(0, 8000)}`);
try {
  await session.debug("Task 1: read the files and pick the respondents with a country.");
  const t1: any = await session.debug({
    edits: [
      loader,
      pick,
      'vuln = scan("data/longds/geoscience/phase-ii-widsdatathon2022/task2/data/covid_19_vulnerability/vulnerability.csv")',
      'codes = scan("data/longds/community/kaggle-survey-2019/task2/data/data-jobs-listings-glassdoor/country_names_2_digit_codes.csv")',
      'track = scan("data/longds/sports/nfl_big_data_bowl_2023/task1/data/play1_trackingdf.csv")',
      'people = process(fn=load_people, doc="Five respondents with id, country and score")',
      'cleaned = filter(people, lambda row: row["country"] is not None, doc="Respondents with a country")',
      'picked = pick_clean(people, cleaned)',
      'by_country = aggregate(people, by=["country"], n=count())',
    ].join("\n"),
    observe: ["vuln", "codes", "track", "cleaned", "picked", "by_country"],
  });
  await Bun.write(`${out}/task1.json`, JSON.stringify(t1, null, 2));
  const receipt = t1.step.toolResults[0].output;
  const failed = receipt.operators.filter((o: any) => !["added", "modified", "unchanged"].includes(o.status));
  assert.deepEqual(failed, [], `operators failed: ${JSON.stringify(failed)}`);
  const c1 = t1.serviceContext as string;
  contains(c1, "renamed repeated header names as pandas does", "repeated headers");
  contains(c1, 'read 1 cell ("NA" 1)', "Namibia's code NA read as missing, and said so");
  assert.ok(!plain(c1).includes('("None" 80)'), "the tracking data's None events stay values");
  contains(c1, "Aggregate dropped 1/5 rows whose group key is null", "null group key");
  assert.ok(!plain(c1).includes("__index_level_0__"), "the row-label column reached the model's context");
  const results = t1.snapshot.results;
  assert.deepEqual(results.picked.sampleRecords.map((r: any) => r.id), [10, 12, 13, 14], "labels survive the engine's storage");
  for (const name of ["cleaned", "picked"])
    for (const row of results[name].sampleRecords) assert.ok(!("__index_level_0__" in row), `${name} sample shows the label column`);
  assert.deepEqual(results.by_country.sampleRecords.map((r: any) => [r.country, r.n]), [["IN", 2], ["US", 2]]);

  // One real model turn: a mean with decimals must be composed with a stated rounding.
  const turn = await runAgentTurn(
    session.agentId,
    "Task 2: what is the mean score of the respondents that have a country, rounded to 2 decimal places? Report the answer as a single-line JSON object with the key mean_score. Your last line MUST BE: **Final Answer: <single-line JSON>**",
    { baseUrl: session.baseUrl, timeoutMs: 600_000 }
  );
  await Bun.write(`${out}/turn2.json`, JSON.stringify(turn, null, 2));
  assert.equal(turn.completed, true, `turn 2 did not complete: ${turn.errors.join("; ")}`);
  contains(turn.finalAnswer, "3.53", "mean score of the cleaned respondents, rounded");
  assert.ok(!turn.finalAnswer.includes("3.53125"), `unrounded answer: ${turn.finalAnswer}`);
  const answerFrom = turn.steps.flatMap(s => s.toolCalls ?? []).map(c => (c.input as any)?.answer_from).filter(Boolean);
  const last = [...turn.steps].reverse().find(s => s.role === "agent")!;
  console.log(JSON.stringify({ out, answerFrom, composed: !last.usage, finalAnswer: turn.finalAnswer }));
  console.log("pandas semantics smoke OK");
} finally {
  await session.close();
}
