// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Scenario 1 of the user study on the script agent, as a participant would do it:
// a fresh account, the three Olympic files, then the task card's two questions one
// after the other (the top gold winners per season, then location against golds).
// Prints what the agent answered and how long each turn took, checks both answers
// against the key in scenario-1/scenario1_plan.md, and exits 1 when one misses it.
//
//   node study/scenario1_smolagents.mjs BASE_URL STUDY_DIR OUT_DIR
import { mkdirSync, writeFileSync } from "node:fs";

import {
  ask,
  chromium,
  lastAnswer,
  lastMessages,
  register,
  upload,
} from "../tests/e2e/browser.mjs";

const [base, studyDir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const files = [
  "athlete_events_2006_2016.csv",
  "noc_regions.csv",
  "country_geo.csv",
];
const INTRO =
  "You have three files: every athlete entry at the six Olympic Games from 2006 to 2016, a lookup from country codes to country names, and each country's location (latitude, longitude, continent, elevation).";
const QUESTIONS = [
  "Which five countries won the most gold medals at the Winter Games, and which five at the Summer Games? Say which years each answer covers.",
  "Does where a country sits on the map, its latitude and longitude, relate to how many gold medals it wins? Look at the Winter and the Summer Games separately.",
];
// The facilitator's follow-up when the second answer looked only at gold-winning countries (both agents did on 2026-10-22).
const PROBE =
  "Your correlations use only the countries that won a gold. Include every country that competed in that season, with zero golds where it won none, and tell me again whether latitude and longitude relate to golds.";

// The key: the ten countries and the span of years, team golds counted once (Sweden only enters when athletes are counted).
function checkTopFive(answer) {
  const expected = [
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
  const missing = expected
    .filter(([, pattern]) => !pattern.test(answer))
    .map(([name]) => name);
  if (/sweden/i.test(answer))
    missing.push("no Sweden (team golds counted once)");
  return { pass: missing.length === 0, missing };
}
// The key: latitude discussed for both seasons with numbers, and longitude addressed. The note flags
// the winners-only artifact (a −0.4 Winter correlation with longitude, "western countries win more"),
// which the facilitator's probe about the countries that won nothing resolves.
function checkLocation(answer) {
  const expected = [
    ["latitude", /latitude|\blat\b|_lat\b/i],
    ["longitude", /longitude|\blon\b|_lon\b/i],
    ["Winter", /winter/i],
    ["Summer", /summer/i],
    ["a number", /\d/],
  ];
  const missing = expected
    .filter(([, pattern]) => !pattern.test(answer))
    .map(([name]) => name);
  const artifact =
    /-\s?0\.[3-5]\d?\b/.test(answer) ||
    /(further|farther|more)\s+west/i.test(answer);
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

// The key after the probe: with every competing country, golds rise with distance from the equator
// (Spearman 0.48 Winter, 0.46 Summer; Pearson 0.35 / 0.28) and longitude shows nothing (≈ 0).
function checkCorrected(answer) {
  const expected = [
    ["latitude", /latitude|equator|\blat\b|_lat\b/i],
    ["longitude", /longitude|\blon\b|_lon\b/i],
    [
      "a latitude correlation between 0.25 and 0.55",
      /(?<!-\s?)\b0\.(2[5-9]|[34]\d|5[0-5])\b/,
    ],
  ];
  const missing = expected
    .filter(([, pattern]) => !pattern.test(answer))
    .map(([name]) => name);
  return { pass: missing.length === 0, missing };
}

const turns = [];
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 1100 } })
).newPage();
try {
  await register(page, base, `study_s1_${Date.now().toString(36)}`);
  for (const name of files)
    await upload(
      page,
      `${studyDir}/scenario-1/${name}`,
      "the agent hears about it with your next message",
    );
  for (const [i, question] of [...QUESTIONS, PROBE].entries()) {
    const content = i === 0 ? `${INTRO}\nQuestion: ${question}` : question;
    turns.push({
      ...(await ask(page, content)),
      answer: await lastAnswer(page),
    });
    await page.screenshot({ path: `${out}/turn${i + 1}.png`, fullPage: true });
  }
  const transcript = await lastMessages(page);
  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  const details = await Promise.all(
    runs.map(async (run) =>
      (await page.request.get(`${base}/api/runs/${run.id}`)).json(),
    ),
  );
  writeFileSync(
    `${out}/result.json`,
    JSON.stringify({ turns, transcript, runs: details }, null, 2),
  );
  for (const [i, turn] of turns.entries())
    console.log(
      `turn ${i + 1} (${turn.seconds.toFixed(0)} s): ${turn.answer.replace(/\s+/g, " ").slice(0, 900)}`,
    );
  const steps = details.map(
    (run) =>
      `${run.steps?.length ?? "?"} steps, ${run.python_execs?.length ?? "?"} code runs`,
  );
  console.log("runs:", steps.join(" | "));
  const top = checkTopFive(turns[0].answer);
  const location = checkLocation(turns[1]?.answer ?? "");
  console.log(
    top.pass
      ? "PASS turn 1 names the ten countries and the years, with team golds counted once"
      : `FAIL turn 1 misses: ${top.missing.join(", ")}`,
  );
  console.log(
    location.pass
      ? "PASS turn 2 speaks of latitude and longitude for both seasons, with numbers"
      : `FAIL turn 2 misses: ${location.missing.join(", ")}`,
  );
  if (location.note) console.log(`NOTE turn 2: ${location.note}`);
  const corrected = checkCorrected(turns[2]?.answer ?? "");
  console.log(
    corrected.pass
      ? "PASS turn 3 finds the latitude relation once every competing country counts"
      : `FAIL turn 3 misses: ${corrected.missing.join(", ")}`,
  );
  process.exit(top.pass && location.pass && corrected.pass ? 0 : 1);
} catch (error) {
  await page
    .screenshot({ path: `${out}/failed.png`, fullPage: true })
    .catch(() => {});
  console.error("failed:", error);
  process.exit(2);
} finally {
  await browser.close();
}
