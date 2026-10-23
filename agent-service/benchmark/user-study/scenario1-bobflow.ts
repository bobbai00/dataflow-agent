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

/**
 * Scenario 1 of the user study on BobFlow, as a participant would do it: a new
 * workflow and agent, then the task card's two questions one after the other
 * (the top gold winners per season, then location against golds). Prints each
 * answer and how long it took, the dataflow the agent built, and the checks
 * against the key in scenario-1/scenario1_plan.md; exits 1 when the first
 * answer misses the key. The workflow stays for inspection.
 *
 *   AGENT_BASE=http://localhost:3002 PROBE_MODEL=claude-haiku-5.5 bun run benchmark/user-study/scenario1-bobflow.ts
 */
import { login } from "../../src/api";
import { datasetPath, STUDY, studyLogin } from "./study";
import { createStudyAgent, studyWorkflowUrl } from "./bobflow";

const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";
// The task card, as the doc shows it, with the files listed under it.
const INTRO =
  "You have three files: every athlete entry at the six Olympic Games from 2006 to 2016, a lookup from country codes to country names, and each country's location (latitude, longitude, continent, elevation).";
export const QUESTIONS = [
  "Which five countries won the most gold medals at the Winter Games, and which five at the Summer Games? Say which years each answer covers.",
  "Does where a country sits on the map, its latitude and longitude, relate to how many gold medals it wins? Look at the Winter and the Summer Games separately.",
];
/** The facilitator's follow-up when the second answer looked only at gold-winning countries (both agents did on 2026-10-22). */
export const PROBE =
  "Your correlations use only the countries that won a gold. Include every country that competed in that season, with zero golds where it won none, and tell me again whether latitude and longitude relate to golds.";
const TASK = [
  INTRO,
  `Question: ${QUESTIONS[0]}`,
  "",
  "The files:",
  ...STUDY.files[1].map(file => datasetPath(1, file)),
].join("\n");

/** The key: the ten countries and the span of years, team golds counted once (Sweden only enters when athletes are counted). */
export function checkTopFive(answer: string): { pass: boolean; missing: string[] } {
  const expected: Array<[string, RegExp]> = [
    ["Canada", /canada/i],
    ["Germany", /germany/i],
    ["United States", /\b(usa|u\.s\.a?\.?|united states|america)\b/i],
    ["Russia", /russia/i],
    ["Norway", /norway/i],
    ["China", /china/i],
    ["Great Britain", /\b(great britain|united kingdom|uk|britain|gbr)\b/i],
    ["2006", /\b2006\b/],
    ["2016", /\b2016\b/],
  ];
  const missing = expected.filter(([, pattern]) => !pattern.test(answer)).map(([name]) => name);
  if (/sweden/i.test(answer)) missing.push("no Sweden (team golds counted once)");
  return { pass: missing.length === 0, missing };
}

/**
 * The key: latitude discussed for both seasons with numbers, and longitude addressed. The note flags
 * the winners-only artifact (a −0.4 Winter correlation with longitude, "western countries win more"),
 * which the facilitator's probe about the countries that won nothing resolves.
 */
export function checkLocation(answer: string): { pass: boolean; missing: string[]; note?: string } {
  const expected: Array<[string, RegExp]> = [
    ["latitude", /latitude|\blat\b|_lat\b/i],
    ["longitude", /longitude|\blon\b|_lon\b/i],
    ["Winter", /winter/i],
    ["Summer", /summer/i],
    ["a number", /\d/],
  ];
  const missing = expected.filter(([, pattern]) => !pattern.test(answer)).map(([name]) => name);
  const artifact = /-\s?0\.[3-5]\d?\b/.test(answer) || /(further|farther|more)\s+west/i.test(answer);
  return {
    pass: missing.length === 0,
    missing,
    ...(artifact
      ? {
          note: "the answer reads longitude off the gold winners alone (the −0.4 Winter artifact); probe with the countries that won nothing",
        }
      : {}),
  };
}

/**
 * The key after the probe: with every competing country, golds rise with distance from the equator
 * (Spearman 0.48 Winter, 0.46 Summer; Pearson 0.35 / 0.28) and longitude shows nothing (≈ 0).
 */
export function checkCorrected(answer: string): { pass: boolean; missing: string[] } {
  const expected: Array<[string, RegExp]> = [
    ["latitude", /latitude|equator|\blat\b|_lat\b/i],
    ["longitude", /longitude|\blon\b|_lon\b/i],
    ["a latitude correlation between 0.25 and 0.55", /(?<!-\s?)\b0\.(2[5-9]|[34]\d|5[0-5])\b/],
  ];
  const missing = expected.filter(([, pattern]) => !pattern.test(answer)).map(([name]) => name);
  return { pass: missing.length === 0, missing };
}

if (import.meta.main) {
  const token = await studyLogin(login);
  const { api, agent, wid } = await createStudyAgent(token, {
    name: `S1 test ${new Date().toISOString().slice(0, 16)}`,
    model: MODEL,
  });
  console.log(`agent ${agent.id} on workflow ${wid}: ${studyWorkflowUrl(wid)}`);

  const answers: string[] = [];
  for (const [i, content] of [TASK, QUESTIONS[1], PROBE].entries()) {
    const started = Date.now();
    const reply = await api.post(`/${agent.id}/message`, { content });
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    answers.push(reply.answer ?? "");
    console.log(
      `\nturn ${i + 1} (${seconds} s, ${reply.steps} model steps): ${(reply.answer ?? JSON.stringify(reply)).replace(/\s+/g, " ").slice(0, 900)}`
    );
    const workflow = await api.get(`/${agent.id}/workflow`);
    const results = (await api.get(`/${agent.id}/operator-results`)).results ?? {};
    for (const op of workflow.workflow?.operators ?? []) {
      const r = results[op.operatorID];
      const rows = r ? (r.error ? "FAILED" : `${r.totalRowCount ?? r.outputTuples} rows`) : "no result";
      console.log(
        `  ${op.operatorID} [${op.nativeOp?.type}] ${rows}${op.nativeOp?.doc ? ` — ${op.nativeOp.doc}` : ""}`
      );
    }
  }
  const top = checkTopFive(answers[0]);
  const location = checkLocation(answers[1] ?? "");
  console.log(
    top.pass
      ? "\nPASS turn 1 names the ten countries and the years, with team golds counted once"
      : `\nFAIL turn 1 misses: ${top.missing.join(", ")}`
  );
  console.log(
    location.pass
      ? "PASS turn 2 speaks of latitude and longitude for both seasons, with numbers"
      : `FAIL turn 2 misses: ${location.missing.join(", ")}`
  );
  if (location.note) console.log(`NOTE turn 2: ${location.note}`);
  const corrected = checkCorrected(answers[2] ?? "");
  console.log(
    corrected.pass
      ? "PASS turn 3 finds the latitude relation once every competing country counts"
      : `FAIL turn 3 misses: ${corrected.missing.join(", ")}`
  );
  process.exit(top.pass && location.pass && corrected.pass ? 0 : 1);
}
