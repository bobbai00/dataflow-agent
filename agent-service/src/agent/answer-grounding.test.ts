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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Answer grounding: the properties that make the check safe.
 *
 * The cost model is asymmetric — a missed nudge is the status quo, a false
 * nudge wastes a feedback round — so most of these tests pin the DON'T-fire
 * cases: rounded values must ground against full-precision cells, recalled
 * text must count as grounding, partial grounding must be left alone, and
 * answers with too few substantive numbers must never trigger.
 */

import { describe, expect, test } from "bun:test";
import type { OperatorInfo } from "../types/execution";
import {
  extractSubstantiveNumbers,
  finalAnswerPayload,
  groundingReport,
  numbersMatch,
  shouldNudge,
} from "./answer-grounding";

function info(rows: Record<string, unknown>[]): OperatorInfo {
  return { state: "Completed", result: rows } as unknown as OperatorInfo;
}

describe("finalAnswerPayload / extractSubstantiveNumbers", () => {
  test("pulls the payload off the marker line, markdown or not", () => {
    expect(finalAnswerPayload('thinking...\n**Final Answer: {"a": 1}**')).toBe('{"a": 1}');
    expect(finalAnswerPayload('Final answer: {"a": 1}')).toBe('{"a": 1}');
    expect(finalAnswerPayload("no marker here")).toBeUndefined();
  });

  test("small integers are not substantive; decimals and big values are", () => {
    const n = extractSubstantiveNumbers('{"rank": 3, "count": 7, "mean": 0.2821, "total": 483126}');
    expect(n).toContain(0.2821);
    expect(n).toContain(483126);
    expect(n).not.toContain(3);
    expect(n).not.toContain(7);
  });
});

describe("numbersMatch", () => {
  test("a rounded answer grounds against the full-precision cell", () => {
    // The task contracts round to 4 decimals; tables hold full precision.
    expect(numbersMatch(0.2821, 0.282088291685892)).toBe(true);
    expect(numbersMatch(2662.6182, 2662.6182215621907)).toBe(true);
  });

  test("a genuinely different value does not", () => {
    expect(numbersMatch(0.2821, 0.2827)).toBe(false);
    expect(numbersMatch(1500, 1501)).toBe(false);
  });
});

describe("groundingReport / shouldNudge", () => {
  const results = new Map<string, OperatorInfo>([
    ["means", info([{ feature: "ph", mean: 7.0808, gap: 0.282088291685892 }])],
    ["counts", info([{ year: "2016", total_issues: "5200985" }])], // numbers inside strings
  ]);

  test("an answer read off the tables grounds fully — no nudge", () => {
    const r = groundingReport([7.0808, 0.2821, 5200985], results);
    expect(r.unmatched).toEqual([]);
    expect(shouldNudge(r)).toBe(false);
  });

  test("an invented answer grounds nowhere — nudge", () => {
    const r = groundingReport([123.4567, 99999], results);
    expect(r.matched).toEqual([]);
    expect(shouldNudge(r)).toBe(true);
  });

  test("partial grounding is ambiguous (sampled rows hide values) — no nudge", () => {
    const r = groundingReport([7.0808, 42424.42], results);
    expect(shouldNudge(r)).toBe(false);
  });

  test("one substantive number is too little evidence — no nudge", () => {
    const r = groundingReport([42424.42], results);
    expect(shouldNudge(r)).toBe(false);
  });

  test("recalled text counts as grounding — comparisons against old state are legitimate", () => {
    const recalled = "Result (as of turn 4):\n  score\t0.9755\n";
    const r = groundingReport([0.9755, 77.77], new Map(), [recalled]);
    expect(r.matched).toEqual([0.9755]);
    expect(shouldNudge(r)).toBe(false); // partial again — recalled half grounds it
  });
});
