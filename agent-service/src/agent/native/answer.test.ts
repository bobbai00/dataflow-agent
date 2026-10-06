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
import { expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import {
  composeAnswer,
  composeAnswerParts,
  parseAnswerFrom,
  parseAnswerFromParts,
  roundHalfEven,
  statedDecimals,
  type AnswerShape,
} from "./answer";

function table(rows: Array<Record<string, unknown>>, extra: Partial<OperatorInfo> = {}): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows.length,
    resultMode: "table",
    result: rows,
    totalRowCount: rows.length,
    truncated: false,
    ...extra,
  };
}

const every = (digits: number | "full"): AnswerShape[] => [{ name: "*", column: "*", digits }];

test("the answer is composed from the table by a fixed mapping", () => {
  expect(composeAnswer("t", table([{ mean_age: 34.2, n: 721, __row_index__: 0 }]), every(1))).toMatchObject({
    json: '{"mean_age":34.2,"n":721}',
  });
  expect(composeAnswer("t", table([{ region: "east", total: 10 }, { region: "west", total: 12.5 }]), every(1))).toMatchObject({
    json: '{"t":[{"region":"east","total":10},{"region":"west","total":12.5}]}',
  });
  expect(composeAnswer("t", table([{ region: "east", total: 10 }, { region: "east", total: 12 }]))).toMatchObject({
    json: '{"t":[{"region":"east","total":10},{"region":"east","total":12}]}',
  });
  expect(composeAnswer("names", table([{ name: "a" }, { name: "b" }]))).toMatchObject({ json: '{"name":["a","b"]}' });
  expect(composeAnswer("t", table([{ x: null, y: Number.NaN, z: undefined }]))).toEqual({
    reason: "every value answer_from would report from `t` is null, so the table does not hold the answer",
  });
});

test("numbers with decimals need a stated precision, and rounding follows Python's round()", () => {
  const info = table([{ share: 24.489795918367346, rate: 0.12345, n: 49 }]);
  expect("reason" in composeAnswer("t", info)).toBe(true);
  expect(parseAnswerFrom("t[:2]")).toEqual({ id: "t", shape: [{ name: "*", column: "*", digits: 2 }] });
  expect(composeAnswer("t", info, (parseAnswerFrom("t[:2]") as any).shape)).toMatchObject({ json: '{"share":24.49,"rate":0.12,"n":49}' });
  expect(composeAnswer("t", info, (parseAnswerFrom("t[share:1, rate, n, :3]") as any).shape)).toMatchObject({
    json: '{"share":24.5,"rate":0.123,"n":49}',
  });
  expect(composeAnswer("t", info, (parseAnswerFrom("t[share:full, n]") as any).shape)).toMatchObject({
    json: '{"share":24.4897959184,"n":49}',
  });
  expect("error" in parseAnswerFrom("t[:2, :3]")).toBe(true);
  for (const [value, digits, expected] of [
    [0.125, 2, 0.12],
    [0.375, 2, 0.38],
    [2.5, 0, 2],
    [3.5, 0, 4],
    [-0.125, 2, -0.12],
    [2.675, 2, 2.67],
    [24.489795918367346, 2, 24.49],
    [93.05000000000001, 2, 93.05],
  ] as Array<[number, number, number]>)
    expect([value, digits, roundHalfEven(value, digits)]).toEqual([value, digits, expected]);
});

test("a projection names the keys, picks the columns, and refuses what cannot be an answer", () => {
  expect(parseAnswerFrom("python_mean[imputation_mean=mean_python:4, imputed_rows, baseline_row_count = n]")).toEqual({
    id: "python_mean",
    shape: [
      { name: "imputation_mean", column: "mean_python", digits: 4 },
      { name: "imputed_rows", column: "imputed_rows" },
      { name: "baseline_row_count", column: "n" },
    ],
  });
  expect("error" in parseAnswerFrom("t[")).toBe(true);
  expect("error" in parseAnswerFrom("not a table id!")).toBe(true);
  expect(composeAnswer("t", undefined)).toEqual({ reason: "`t` has no result" });
  expect(composeAnswer("t", table([]))).toEqual({ reason: "`t` is empty (0 rows)" });
  const wide = table(Array.from({ length: 51 }, (_, i) => ({ i })));
  expect(composeAnswer("t", wide)).toMatchObject({ reason: expect.stringContaining("51 rows") });
  expect(composeAnswer("t", table([{ a: 1 }]), [{ name: "b", column: "b" }])).toMatchObject({
    reason: expect.stringContaining('no column "b"'),
  });
  // A precision no request stated is refused with the stated one as the hint.
  expect(composeAnswer("t", table([{ share: 24.4898 }]), every(4), { decimalRules: [2] })).toMatchObject({
    reason: expect.stringContaining("state 2 decimal places"),
  });
  expect(statedDecimals(["Round to 2 decimal places.", "Report three decimals."])).toEqual([2, 3]);
});

test("several tables compose one answer with a key per part", () => {
  const parsed = parseAnswerFromParts("leaders=top[country, score:2]; moves[country, delta:1]; n=count_row");
  expect(parsed).toEqual({
    parts: [
      { key: "leaders", id: "top", shape: [{ name: "country", column: "country" }, { name: "score", column: "score", digits: 2 }] },
      { key: "moves", id: "moves", shape: [{ name: "country", column: "country" }, { name: "delta", column: "delta", digits: 1 }] },
      { key: "n", id: "count_row" },
    ],
  });
  const tables: Record<string, OperatorInfo> = {
    top: table([{ country: "Thailand", score: 56.7577 }, { country: "Turkey", score: 53.2995 }]),
    moves: table([{ country: "Japan", delta: 2.04 }]),
    count_row: table([{ n: 15 }]),
    names: table([{ country: "a" }, { country: "b" }]),
  };
  const composed = composeAnswerParts((parsed as any).parts, id => tables[id]);
  expect(composed).toMatchObject({
    json: '{"leaders":[{"country":"Thailand","score":56.76},{"country":"Turkey","score":53.3}],"moves":{"country":"Japan","delta":2},"n":{"n":15}}',
  });
  // A single part is the plain single-table answer; a one-column part is a list.
  expect(composeAnswerParts((parseAnswerFromParts("count_row") as any).parts, id => tables[id])).toMatchObject({ json: '{"n":15}' });
  expect(composeAnswerParts((parseAnswerFromParts("top=names; n=count_row") as any).parts, id => tables[id])).toMatchObject({
    json: '{"top":["a","b"],"n":{"n":15}}',
  });
  // A refused part refuses the answer; repeated keys and empty text are errors.
  expect("reason" in composeAnswerParts((parseAnswerFromParts("top; n=count_row") as any).parts, id => tables[id])).toBe(true);
  expect("error" in parseAnswerFromParts("a; a")).toBe(true);
  expect("error" in parseAnswerFromParts(" ; ")).toBe(true);
});

test("answer cuts select from the full working table before projection and rounding", () => {
  const info = table([{ market: "b", score: 1.004 }, { market: "a", score: 1.003 }, { market: "c", score: 0.9 }]);
  const parsed = parseAnswerFromParts("leaders=scores@2[market, score:2] top 1 by score desc, market asc");
  expect("error" in parsed).toBe(false);
  expect(composeAnswerParts((parsed as any).parts, () => info)).toMatchObject({ json: '{"market":"b","score":1}' });
  const names = parseAnswerFromParts("scores@2[market] top 1 by score desc, market asc");
  expect(composeAnswerParts((names as any).parts, () => info)).toMatchObject({ json: '{"market":"b"}' });
  expect(info.result).toEqual([{ market: "b", score: 1.004 }, { market: "a", score: 1.003 }, { market: "c", score: 0.9 }]);
});

test("a boundary tie requires an explicit tie breaker and cannot depend on projected columns", () => {
  const info = table([{ market: "b", score: 2 }, { market: "a", score: 2 }, { market: "c", score: 1 }]);
  const ambiguous = parseAnswerFromParts("scores[market] top 1 by score");
  expect(composeAnswerParts((ambiguous as any).parts, () => info)).toMatchObject({ reason: expect.stringContaining("tie") });
  const resolved = parseAnswerFromParts("scores[market] top 1 by score desc, market asc");
  expect(composeAnswerParts((resolved as any).parts, () => info)).toMatchObject({ json: '{"market":"a"}' });
});
