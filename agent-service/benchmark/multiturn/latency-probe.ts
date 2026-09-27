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
/** Engine latency on a wide table, through the real engine: scan the Kaggle
 * 2022 survey (about 24,000 rows by 296 columns), then new operators that read
 * the cached wide table, then an operator on a narrow table. Prints the wall
 * time of each call; the same calls before and after an engine change measure
 * it. No model calls. Usage: bun latency-probe.ts <outdir> */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";

const out = resolve(process.argv[2] ?? `/tmp/texera-registry/latency-probe-${Date.now()}`);
mkdirSync(out, { recursive: true });
const SURVEY = "data/longds/community/kaggle-survey-2022/task1/data/kaggle-survey-2022/kaggle_survey_2022_responses.csv";
const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeAnalysisState: true,
  nativeTaskEfficiency: true,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  dataflowReasoning: false,
});
const steps: Array<[string, Record<string, unknown>]> = [
  ["scan the wide survey", { edits: `survey = scan("${SURVEY}")`, observe: ["survey[Q2,Q3]"] }],
  ["project 2 columns of the cached survey", { edits: 'two = project(survey, keep=["Q2", "Q3"])', observe: ["two"] }],
  ["filter the cached survey", { edits: 'young = filter(survey, lambda row: row["Q2"] == "18-21", doc="Respondents aged 18-21")', observe: ["young[Q2,Q3]"] }],
  ["aggregate the narrow table", { edits: 'by_age = aggregate(two, by=["Q2"], n=count())', observe: ["by_age"] }],
  ["process over the cached survey", {
    edits: [
      "def share_men(survey):",
      '    """Share of respondents who answered Man."""',
      "    import pandas as pd",
      '    return pd.DataFrame({"share": [float((survey["Q3"] == "Man").mean())]})',
      'men = process(survey, fn=share_men, doc="Share of respondents who answered Man")',
    ].join("\n"),
    observe: ["men"],
  }],
];
const timings: Array<{ step: string; seconds: number; statuses: string[] }> = [];
try {
  await session.debug("Task 1: latency probe.");
  for (const [label, args] of steps) {
    const started = performance.now();
    const result: any = await session.debug(args);
    const seconds = (performance.now() - started) / 1000;
    const statuses = (result.step?.toolResults?.[0]?.output?.operators ?? []).map((o: any) => `${o.id}:${o.status}`);
    timings.push({ step: label, seconds: Math.round(seconds * 10) / 10, statuses });
    console.log(`${seconds.toFixed(1).padStart(7)} s  ${label}  ${statuses.join(" ")}`);
    // The observed values, to check an engine change end to end as well.
    await Bun.write(
      `${out}/step-${timings.length}.json`,
      JSON.stringify({ observation: result.observation, results: result.snapshot?.results }, null, 2)
    );
  }
  await Bun.write(`${out}/timings.json`, JSON.stringify(timings, null, 2));
} finally {
  await session.close();
}
