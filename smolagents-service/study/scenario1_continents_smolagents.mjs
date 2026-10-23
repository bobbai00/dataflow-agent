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

// A one-question Scenario 1 on the script agent: a fresh account, the three
// Olympic files, and the three continents with the most golds at the Winter and
// at the Summer Games of 2008–2014. Prints the answer, how long it took, the run's
// steps, and the check against the key; exits 1 when the answer misses it.
//
//   node study/scenario1_continents_smolagents.mjs BASE_URL STUDY_DIR OUT_DIR
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
const QUESTION =
  "Which three continents won the most gold medals at the Winter Games, and which three at the Summer Games, between 2008 and 2014? Give the number of gold medals for each.";

// The key (team golds counted once, codes and names both joined, the Games of 2008–2014):
// Winter Europe 123, North America 42, Asia 18; Summer Europe 258, Asia 169, North America 112.
function checkContinents(answer) {
  const expected = [
    ["Europe", /europe/i],
    ["North America", /north america/i],
    ["Asia", /asia/i],
    ["Winter Europe 123", /\b123\b/],
    ["Winter North America 42", /\b42\b/],
    ["Winter Asia 18", /\b18\b/],
    ["Summer Europe 258", /\b258\b/],
    ["Summer Asia 169", /\b169\b/],
    ["Summer North America 112", /\b112\b/],
  ];
  const missing = expected
    .filter(([, pattern]) => !pattern.test(answer))
    .map(([name]) => name);
  const hints = [];
  if (/\b(181|392)\b/.test(answer))
    hints.push("counted all six Games instead of 2008–2014");
  if (/\b(79|201)\b/.test(answer))
    hints.push(
      "joined by ISO3 code only, losing Germany and 23 more countries",
    );
  if (/\b(200|148|569|336)\b/.test(answer))
    hints.push("counted athlete rows, not medals");
  return { pass: missing.length === 0, missing, hints };
}

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 1100 } })
).newPage();
try {
  await register(page, base, `study_s1c_${Date.now().toString(36)}`);
  for (const name of files)
    await upload(
      page,
      `${studyDir}/scenario-1/${name}`,
      "the agent hears about it with your next message",
    );
  const turn = {
    ...(await ask(page, `${INTRO}\nQuestion: ${QUESTION}`)),
    answer: await lastAnswer(page),
  };
  await page.screenshot({ path: `${out}/answer.png`, fullPage: true });
  const transcript = await lastMessages(page);
  const runs = await (await page.request.get(`${base}/api/runs`)).json();
  const details = await Promise.all(
    runs.map(async (run) =>
      (await page.request.get(`${base}/api/runs/${run.id}`)).json(),
    ),
  );
  writeFileSync(
    `${out}/result.json`,
    JSON.stringify({ turn, transcript, runs: details }, null, 2),
  );
  console.log(
    `answer (${turn.seconds.toFixed(0)} s): ${turn.answer.replace(/\s+/g, " ")}`,
  );
  console.log(
    "runs:",
    details
      .map(
        (run) =>
          `${run.steps?.length ?? "?"} steps, ${run.python_execs?.length ?? "?"} code runs`,
      )
      .join(" | "),
  );
  const check = checkContinents(turn.answer);
  console.log(
    check.pass
      ? "PASS the answer matches the key"
      : `FAIL the answer misses: ${check.missing.join(", ")}`,
  );
  for (const hint of check.hints) console.log(`HINT ${hint}`);
  process.exit(check.pass ? 0 : 1);
} catch (error) {
  await page
    .screenshot({ path: `${out}/failed.png`, fullPage: true })
    .catch(() => {});
  console.error("failed:", error);
  process.exit(2);
} finally {
  await browser.close();
}
