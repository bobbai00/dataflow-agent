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
 * make `parse_price` strip the comma as well as the dollar sign, rerun what
 * depends on it, and report the corrected answer (`priced` keeps 5,691 listings;
 * Pacific Heights leads at $858).
 *
 *   AGENT_BASE=http://localhost:3002 AGENT_ID=agent-xxxx \
 *     bun run benchmark/user-study/scenario2-debug.ts
 *
 * AGENT_ID is the agent scenario2-bobflow.ts replayed the analysis into.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { login } from "../../src/api";
import { STUDY, studyLogin } from "./study";
import { agentApi } from "./bobflow";

const agentId = process.env.AGENT_ID;
if (!agentId) throw new Error("AGENT_ID names the replayed agent (scenario2-bobflow.ts prints it)");

// The two messages the doc's rehearsal section names.
const QUESTION = "Why does the analysis contain no listing above $999?";
const FEEDBACK =
  "The price parse strips the $ but not the comma, so prices of $1,000 or more fail to convert and get dropped. " +
  "Strip both, rerun what depends on it, and give me the new answer.";

interface Bug {
  operator: string;
  planted_numbers: { [key: string]: number | [string, number] };
  fixed_numbers: { [key: string]: number | [string, number] };
}
const spec = JSON.parse(readFileSync(join(STUDY.dir, "scenario-2", "dataflow", "bobflow_steps.json"), "utf8")) as {
  steps: Array<{ statements: string }>;
  bug: Bug;
};
const answerOperator = [...spec.steps.at(-1)!.statements.matchAll(/^set (\w+):/gm)].at(-1)?.[1] ?? "";
const numbersOf = (numbers: Bug["planted_numbers"]) => ({
  rows: Object.entries(numbers).filter(([, v]) => typeof v === "number") as Array<[string, number]>,
  top: Object.values(numbers).find(Array.isArray) as [string, number] | undefined,
});
const planted = numbersOf(spec.bug.planted_numbers);
const fixed = numbersOf(spec.bug.fixed_numbers);

const token = await studyLogin(login);
const api = agentApi(token);

interface State {
  operators: string[];
  rows: (operator: string) => number | undefined;
  top: { text?: string; number?: number };
  /** The registered Python of the faulty operator, when the dataflow still carries one by that name. */
  faultyCode: string;
}

/** The registered Python of `name`, wherever the namespace keeps it: the first text holding its def. */
function sourceOf(value: unknown, name: string): string {
  if (typeof value === "string") return value.includes(`def ${name}(`) ? value : "";
  if (value && typeof value === "object")
    for (const inner of Object.values(value as Record<string, unknown>)) {
      const found = sourceOf(inner, name);
      if (found) return found;
    }
  return "";
}

async function state(): Promise<State> {
  const workflow = await api.get(`/${agentId}/workflow`);
  const results = (await api.get(`/${agentId}/operator-results`)).results ?? {};
  const operators: any[] = workflow.workflow?.operators ?? [];
  const rows = (id: string) => results[id]?.totalRowCount ?? results[id]?.outputTuples;
  const top = results[answerOperator]?.sampleRecords?.[0] ?? {};
  const faulty = sourceOf(workflow.workflow?.nativeNamespace, spec.bug.operator);
  return {
    operators: operators.map(op => {
      const r = results[op.operatorID];
      const status = r ? (r.error ? "FAILED" : `${rows(op.operatorID)} rows`) : "no result";
      return `${op.operatorID} [${op.nativeOp?.type}] ${status}`;
    }),
    rows,
    top: {
      text: Object.values(top).find(value => typeof value === "string") as string | undefined,
      number: Object.values(top).find(value => typeof value === "number") as number | undefined,
    },
    faultyCode: faulty,
  };
}

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};
const matches = (s: State, numbers: ReturnType<typeof numbersOf>) =>
  numbers.rows.every(([key, expected]) => s.rows(key.replace(/_rows$/, "")) === expected) &&
  (!numbers.top || (s.top.text === numbers.top[0] && s.top.number === numbers.top[1]));
const describe = (s: State) =>
  `${planted.rows.map(([key]) => `${key.replace(/_rows$/, "")}=${s.rows(key.replace(/_rows$/, ""))}`).join(", ")}; ${answerOperator} starts ${s.top.text} ${s.top.number}`;

const before = await state();
console.log(`before: ${describe(before)}`);
check("the planted analysis is in place", matches(before, planted), describe(before));

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
    check("the question left the analysis alone", matches(after, planted), describe(after));
    check(
      "the agent answered",
      answer.trim().length > 0 && !/\b858\b/.test(answer),
      "a reply, not the corrected answer"
    );
  } else {
    check("the fix gives the corrected numbers", matches(after, fixed), describe(after));
    check(
      "the reply reports the corrected answer",
      !!fixed.top && answer.includes(fixed.top[0]) && new RegExp(`\\b${fixed.top[1]}\\b`).test(answer),
      fixed.top ? `${fixed.top[0]} ${fixed.top[1]}` : "no top row named"
    );
    if (after.faultyCode) console.log(`\n${spec.bug.operator} now reads:\n${after.faultyCode.trim()}`);
  }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : "\nall checks passed");
process.exit(failed.length ? 1 : 0);
