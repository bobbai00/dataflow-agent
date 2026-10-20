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

import { expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import { renderAnswer } from "./answer";
import { parseTurn } from "./turn-syntax";

const table = (columns: string[], rows: unknown[][], extra: Partial<OperatorInfo> = {}): OperatorInfo => ({
  state: "Completed",
  inputTuples: 0,
  outputTuples: rows.length,
  totalRowCount: rows.length,
  resultMode: "table",
  result: rows.map(row => Object.fromEntries(columns.map((column, i) => [column, row[i]]))),
  resultSchema: columns.map(name => ({ name, type: "string", encoding: "" })),
  ...extra,
});

const results: Record<string, OperatorInfo> = {
  count: table(["counties"], [[39]]),
  leaders: table(["county", "score"], [["East Carroll", 2.2635], ["Issaquena", 2.0355]]),
  summary: table(["feeder", "non_feeder"], [[31.8, 93.05]]),
  big: table(["id"], [[1], [2]], { totalRowCount: 500, truncated: true }),
  failed: { ...table(["x"], []), state: "Failed", error: "boom" },
};
const answer = (statements: string) => {
  const parsed = parseTurn({ python: "", statements }, { views: ["sample", "full"], answer: true });
  if (!parsed.ok) return parsed.error;
  const statement = parsed.turn.statements.find(item => item.kind === "answer")!;
  return renderAnswer({ ids: statement.ids!, ...statement.answer! }, id => results[id]);
};

test("an answer renders each table by its shape: a value, an object, or every row", () => {
  expect(answer("answer count")).toEqual({ ok: true, text: "39" });
  expect(answer("answer summary")).toEqual({ ok: true, text: '{"feeder":31.8,"non_feeder":93.05}' });
  expect(answer("answer leaders")).toEqual({
    ok: true,
    text: '[{"county":"East Carroll","score":2.2635},{"county":"Issaquena","score":2.0355}]',
  });
  expect(answer("answer intersection_count=count, leaders=leaders")).toEqual({
    ok: true,
    text: '{"intersection_count":39,"leaders":[{"county":"East Carroll","score":2.2635},{"county":"Issaquena","score":2.0355}]}',
  });
  expect(answer("answer count, format=text")).toEqual({ ok: true, text: "39" });
});

test("an answer refuses a table it cannot render whole or that has no result", () => {
  expect(answer("answer big")).toEqual({
    ok: false,
    error: "`big` has 500 rows and an answer renders every row (2 are held); aggregate or limit it to the rows the request asks for.",
  });
  expect(answer("answer failed")).toEqual({
    ok: false,
    error: "`failed` has no current result (its execution failed); fix and run it first.",
  });
  expect(answer("answer missing")).toEqual({ ok: false, error: "`missing` has no current result; fix and run it first." });
});

test("answer statements parse only when the session uses them, and malformed ones say how to write them", () => {
  const parsed = parseTurn({ python: "", statements: "answer count" }, { views: ["sample", "full"], answer: true });
  expect(parsed.ok && parsed.turn.statements[0]).toMatchObject({ kind: "answer", ids: ["count"], answer: { keys: [null], format: "json" } });
  expect(parsed.ok && parsed.turn.actions).toEqual([{ type: "execute", operator_ids: ["count"] }]);
  // Without the setting the line is not a statement, as before.
  const off = parseTurn({ python: "", statements: "answer count" }, { views: ["sample", "full"] });
  expect(off.ok).toBe(false);
  expect(answer("answer count, leaders")).toBe(
    "line 1: an answer with several tables names a key for each: `answer <key>=<id>, <key>=<id>`."
  );
  expect(answer("answer a=count, a=leaders")).toBe('line 1: the answer key "a" is used twice.');
  expect(answer("answer count, format=xml")).toBe("line 1: the answer format is json or text.");
  expect(answer("answer: 39")).toBe(
    "line 1: write the answer as `answer <id>`, or `answer <key>=<id>, <key>=<id>` for several tables, without a colon."
  );
});
