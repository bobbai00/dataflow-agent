/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * ANSWER GROUNDING — a final answer must trace to computed state.
 *
 * A dataflow agent's results are materialized tables, which makes a property
 * checkable that is unverifiable in a plain notebook transcript: every number
 * the agent reports should exist somewhere it can point to — an operator's
 * output, or state it explicitly recalled this turn. An answer whose numbers
 * appear NOWHERE in that corpus was not read off the analysis; it was
 * remembered, restated, or invented.
 *
 * That failure is measured, not hypothetical: on the 42-turn NFL pilot, turns
 * 29, 32 and 42 answered in ~1 step by restating an earlier turn's answer, and
 * LongDS-Bench (arXiv 2605.30434, Fig. 6d) finds agent steps per turn DROP by
 * 4.3 across a session — verification collapses exactly where accuracy does.
 *
 * The check is deliberately conservative, because its cost model is asymmetric:
 * a missed nudge costs nothing (status quo), a false nudge costs a wasted
 * feedback round. So it fires only when the answer contains at least
 * MIN_SUBSTANTIVE substantive numbers and NONE of them ground. Substantive =
 * carries a decimal point or |x| >= 10 — filtering out ranks, small counts and
 * boolean-ish values whose collisions make matching meaningless.
 *
 * Pure functions; the agent wires them behind `enableAnswerGrounding`
 * (default off — control arms keep byte-identical behavior).
 */

import type { OperatorInfo } from "../types/execution";

/** Substantive numbers required before the check can fire at all. */
export const MIN_SUBSTANTIVE = 2;

/** Feedback rounds per turn. One: the nudge either works or it will not. */
export const GROUNDING_NUDGES_PER_TURN = 1;

const FINAL_ANSWER_RE = /(?:\*\*\s*)?final answer:\s*(.+?)(?:\s*\*\*)?\s*$/is;
const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export interface GroundingReport {
  /** Substantive numbers found in the final answer. */
  numbers: number[];
  /** The subset that traced to a result cell or recalled text. */
  matched: number[];
  /** The subset that traced to nothing. */
  unmatched: number[];
}

/** The `Final Answer:` payload, or undefined when the marker is absent. */
export function finalAnswerPayload(text: string): string | undefined {
  const m = FINAL_ANSWER_RE.exec(text ?? "");
  return m?.[1];
}

/**
 * Substantive numbers in the answer payload, deduped.
 *
 * Small integers (0..9) are excluded: they collide with ranks, indices and
 * counts in any table, so a match proves nothing and a mismatch means nothing.
 */
export function extractSubstantiveNumbers(payload: string): number[] {
  const out = new Set<number>();
  for (const m of payload.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const substantive = raw.includes(".") || Math.abs(v) >= 10;
    if (substantive) out.add(v);
  }
  return [...out];
}

/** Decimal places the answer printed the number with (0 for integers). */
function printedDecimals(v: number): number {
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Does `answer` match `cell` at the precision the ANSWER was printed with?
 *
 * The answer is the rounded rendering (task contracts round to fixed decimal
 * places); the cell holds full precision. So the cell is rounded to the
 * answer's printed precision and compared — 0.2821 matches 0.282088291685892.
 * Integers must match exactly.
 */
export function numbersMatch(answer: number, cell: number): boolean {
  if (!Number.isFinite(cell)) return false;
  if (answer === cell) return true;
  const d = printedDecimals(answer);
  if (d === 0) return false;
  return Math.abs(cell - answer) < 0.5 * Math.pow(10, -d) + 1e-12;
}

function cellNumbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "string") {
    return [...value.matchAll(NUMBER_RE)].map(m => Number(m[0])).filter(Number.isFinite);
  }
  return [];
}

/**
 * Trace each substantive answer number to the visible state.
 *
 * Corpus = every operator's materialized (sampled) result rows at HEAD, plus
 * any extra texts the turn pulled into view (recallState / inspectResult
 * outputs) — "state you can point to", in the same sense the render uses.
 */
export function groundingReport(
  numbers: number[],
  results: Map<string, OperatorInfo>,
  extraTexts: string[] = []
): GroundingReport {
  const cells: number[] = [];
  for (const info of results.values()) {
    if (!Array.isArray(info.result)) continue;
    for (const row of info.result as Record<string, unknown>[]) {
      for (const v of Object.values(row ?? {})) cells.push(...cellNumbers(v));
    }
  }
  for (const t of extraTexts) cells.push(...cellNumbers(t));

  const matched: number[] = [];
  const unmatched: number[] = [];
  for (const n of numbers) {
    (cells.some(c => numbersMatch(n, c)) ? matched : unmatched).push(n);
  }
  return { numbers, matched, unmatched };
}

/**
 * Fire only on total failure: enough substantive numbers to be meaningful,
 * and not one of them grounds. Partial grounding is ambiguous (sampled rows
 * legitimately hide some values) and is left alone.
 */
export function shouldNudge(report: GroundingReport): boolean {
  return report.numbers.length >= MIN_SUBSTANTIVE && report.matched.length === 0;
}

/** The feedback message. States the property, the evidence, and the way out. */
export function buildGroundingNudge(report: GroundingReport): string {
  const sample = report.unmatched.slice(0, 5).join(", ");
  return (
    `None of the values in your answer (${sample}) appear in any operator's computed result ` +
    "or in anything you recalled this turn. An answer must be read off computed state, not " +
    "reconstructed from memory — that is how earlier numbers drift. Build or run the operator " +
    "that computes these quantities (or recall the turn that already did), read the values " +
    "from its output table, and then give the final answer."
  );
}
