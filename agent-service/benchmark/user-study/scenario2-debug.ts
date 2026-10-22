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
 * Scenario 2 debugging on BobFlow, through the chat as a participant would do it:
 * first a question about the analysis, which the agent must answer without
 * changing anything; then feedback naming the fix, after which the agent must
 * make attach_violations join on business_id and date, rerun what depends on it,
 * and report the corrected answers (1,057 floors; 630 businesses without violations).
 *
 *   AGENT_BASE=http://localhost:3002 AGENT_ID=agent-xxxx \
 *     bun run benchmark/user-study/scenario2-debug.ts
 *
 * AGENT_ID is the agent scenario2-bobflow.ts replayed the analysis into.
 */
import { login } from "../../src/api";
import { studyLogin } from "./study";
import { agentApi } from "./bobflow";

const agentId = process.env.AGENT_ID;
if (!agentId) throw new Error("AGENT_ID names the replayed agent (scenario2-bobflow.ts prints it)");

const QUESTION =
  "Business 2862 shows 5 violations in violations_per_business. Which inspection dates do those violations come from, " +
  "and what was its latest 2016 inspection date?";
const FEEDBACK =
  "attach_violations joins on business_id only, so it attaches violations from every inspection a business ever had, " +
  "not just its latest 2016 one. Join on business_id and date instead, rerun what depends on it, and give me the new answers.";

const token = await studyLogin(login);
const api = agentApi(token);

interface State {
  join: string;
  joinRows: number | undefined;
  answer: string;
  operators: string[];
}

async function state(): Promise<State> {
  const workflow = await api.get(`/${agentId}/workflow`);
  const results = (await api.get(`/${agentId}/operator-results`)).results ?? {};
  const operators: any[] = workflow.workflow?.operators ?? [];
  const rows = (id: string) => results[id]?.totalRowCount ?? results[id]?.outputTuples;
  const join = operators.find(op => op.operatorID === "attach_violations");
  return {
    join: join?.nativeOp?.source ?? JSON.stringify(join?.nativeOp?.properties ?? null),
    joinRows: rows("attach_violations"),
    answer: JSON.stringify(results["answer"]?.sampleRecords ?? []),
    operators: operators.map(op => {
      const r = results[op.operatorID];
      const status = r ? (r.error ? "FAILED" : `${rows(op.operatorID)} rows`) : "no result";
      return `${op.operatorID} [${op.nativeOp?.type}] ${status}`;
    }),
  };
}

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};

const before = await state();
console.log(`before: ${before.join} (${before.joinRows} rows)`);

for (const [turn, content] of [QUESTION, FEEDBACK].entries()) {
  const started = Date.now();
  const reply = await api.post(`/${agentId}/message`, { content });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const answer: string = reply.answer ?? JSON.stringify(reply);
  console.log(
    `\nturn ${turn + 1} (${seconds} s, ${reply.steps} model steps): ${answer.replace(/\s+/g, " ").slice(0, 900)}`
  );
  const after = await state();
  for (const line of after.operators) console.log(`  ${line}`);
  if (turn === 0) {
    check("the question left the join alone", after.join === before.join, after.join);
    check(
      "the question left the answers alone",
      after.answer === before.answer,
      `answer rows: ${after.answer.slice(0, 120)}`
    );
    check(
      "the agent answered with dates",
      /2016|201\d-\d\d-\d\d|\d\d\/\d\d\/20\d\d/.test(answer),
      "dates in the reply"
    );
  } else {
    check("the join now uses the date too", /date/.test(after.join) && after.join !== before.join, after.join);
    check(
      "attach_violations shrank to one inspection per business",
      (after.joinRows ?? 0) < 21434 && (after.joinRows ?? 0) > 4191,
      `${after.joinRows} rows`
    );
    check(
      "the corrected floors count 1,057 is in the results",
      /\b1057\b/.test(after.answer),
      after.answer.slice(0, 200)
    );
    check("630 businesses without violations is in the results", /\b630\b/.test(after.answer), "");
    check("the reply reports 1,057 and 630", /1,?057/.test(answer) && /\b630\b/.test(answer), "");
  }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : "\nall checks passed");
process.exit(failed.length ? 1 : 0);
