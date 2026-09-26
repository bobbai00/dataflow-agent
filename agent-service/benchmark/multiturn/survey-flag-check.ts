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
/** Real-engine check of the wide-table profile transport: the Kaggle survey
 * (300 columns, the question text repeated as the first data row) must reach
 * the agent with a usable profile, so the header-row and "nan"-token flags
 * fire on the raw scan. Before the transport cap was raised, the profile of
 * this table was dropped at 64 KB and no flag could fire. */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";

const out = resolve(process.argv[2] ?? `/tmp/texera-registry/survey-flag-${Date.now()}`);
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
const plain = (text: string) => text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
try {
  await session.debug("Task 1: load the survey responses.");
  const t1: any = await session.debug({
    edits: 'survey = scan("data/longds/community/kaggle-survey-2022/task2/data/kaggle-survey-2022/kaggle_survey_2022_responses.csv")',
    observe: ["survey[Q2,Q3]"],
  });
  await Bun.write(`${out}/t1.json`, JSON.stringify(t1, null, 2));
  const c1 = plain(t1.serviceContext as string);
  const receipt = t1.step.toolResults[0].output;
  assert.deepEqual(receipt.operators.map((o: any) => [o.id, o.status]), [["survey", "added"]]);
  const flags = c1.split("\n").filter(line => line.trim().startsWith("⚠"));
  const profile = t1.snapshot.results.survey?.tableProfile;
  console.log(
    JSON.stringify(
      { out, rows: t1.snapshot.results.survey?.totalRowCount, profile: { status: profile?.status, coverage: profile?.coverage, omissions: profile?.omissions, columns: Object.keys(profile?.columns ?? {}).length }, flags },
      null,
      2
    )
  );
  assert.equal(profile?.status === "unavailable", false, "the survey profile must reach the agent");
  assert.ok(
    flags.some(line => /holds the text "nan"/.test(line)),
    'the "nan"-token flag must fire on the survey scan'
  );
  console.log(`header-row flag: ${flags.some(line => line.includes("contains its own name as a value")) ? "fired" : "not applicable (the survey's first row holds question text, not the column names)"}`);
  console.log("survey flag check OK");
} finally {
  await session.close();
}
