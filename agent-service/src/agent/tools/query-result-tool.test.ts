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

import { describe, expect, test } from "bun:test";
import {
  createQueryResultTool,
  QUERY_CALLS_PER_TURN,
} from "./query-result-tool";
import type { OperatorInfo } from "../../types/execution";

function makeInfo(rows: Record<string, unknown>[]): OperatorInfo {
  return { operatorId: "t", state: "Completed", inputTuples: rows.length, outputTuples: rows.length, result: rows } as any;
}

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  code: `R${String(i).padStart(3, "0")}`,
  score: i * 0.5,
  group: i % 2 === 0 ? "Weekday" : "Weekend",
}));

function makeTool(overrides: Partial<Record<string, OperatorInfo>> = {}, turnKey = "m1") {
  const results: Record<string, OperatorInfo> = { pressure: makeInfo(ROWS), ...overrides } as any;
  return createQueryResultTool({
    getResult: id => results[id],
    listOperators: () => Object.keys(results),
    getCurrentTurnKey: () => turnKey,
  });
}

async function run(t: any, input: any): Promise<string> {
  return String(await t.execute(input, { toolCallId: "x", messages: [] }));
}

describe("queryResult — the one query primitive", () => {
  test("a real expression returns the printed value with provenance header", async () => {
    const out = await run(makeTool(), { operatorId: "pressure", expr: "df.shape" });
    expect(out).toContain("# queryResult: pressure (40 rows, the operator's whole result)");
    expect(out).toContain("(40, 3)");
  });

  test("a PARTIAL table says so — the held rows are not the table", async () => {
    // 297-col survey table: the char budget leaves ONE row held of 21,879, and
    // `value_counts()` over it looks exactly like the real inventory. Measured
    // on kaggle turn 1, where that inventory decides a mapping dict.
    const wide = { ...makeInfo([{ band: "$0-999" }]), totalRowCount: 21879 } as any;
    const out = await run(makeTool({ survey: wide }), {
      operatorId: "survey",
      expr: "df['band'].value_counts()",
    });
    expect(out).toContain("[PARTIAL]");
    expect(out).toContain("1 row(s) the service holds");
    expect(out).toContain("21879 rows");
    expect(out).toContain("Column Schema and stats");
    // and a complete table must NOT carry the warning
    expect(await run(makeTool(), { operatorId: "pressure", expr: "df.shape" })).not.toContain("[PARTIAL]");
  });

  test("safe builtins are available — any/len/sorted are pandas idiom", async () => {
    const out = await run(makeTool(), {
      operatorId: "pressure",
      expr: "sorted([c for c in df.columns if any(k in c for k in ['sc', 'gr'])])",
    });
    expect(out).not.toContain("[ERROR]");
    expect(out).toContain("group");
    expect(out).toContain("score");
    // introspection stays blocked
    expect(await run(makeTool(), { operatorId: "pressure", expr: "eval('1+1')" })).toContain("[ERROR]");
  });

  test("top-N beyond any render clamp — the clipped-table fix", async () => {
    const out = await run(makeTool(), { operatorId: "pressure", expr: "df.nlargest(3, 'score')" });
    expect(out).toContain("R039");
    expect(out).toContain("19.5");
  });

  test("filters and groupbys work — no sampling policy needed", async () => {
    expect(await run(makeTool(), { operatorId: "pressure", expr: "df[df.code == 'R007']" })).toContain("3.5");
    const g = await run(makeTool(), { operatorId: "pressure", expr: "df.groupby('group')['score'].mean()" });
    expect(g).toContain("Weekday");
    expect(g).toContain("Weekend");
  });

  test("forbidden constructs get a teaching error, not a python traceback", async () => {
    for (const expr of ["__import__('os')", "open('/etc/passwd')", "df.to_csv('x')", "import os"]) {
      const out = await run(makeTool(), { operatorId: "pressure", expr });
      expect(out).toContain("[ERROR]");
      expect(out).toContain("read-only pandas expression");
    }
  });

  test("a raising expression returns the exception line", async () => {
    const out = await run(makeTool(), { operatorId: "pressure", expr: "df['no_such_col'].sum()" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("no_such_col");
  });

  test("unknown operator teaches what IS queryable", async () => {
    const out = await run(makeTool(), { operatorId: "ghost", expr: "df.shape" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("pressure");
  });

  test("an errored operator refuses with the error line, not stale rows", async () => {
    const bad = makeInfo(ROWS);
    (bad as any).error = "ZeroDivisionError: division by zero";
    const out = await run(makeTool({ broken: bad } as any), { operatorId: "broken", expr: "df.shape" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("ZeroDivisionError");
  });

  test("oversized output is clipped with a narrowing hint", async () => {
    const wide = makeInfo(
      Array.from({ length: 3000 }, (_, i) => ({ a: i, blob: `x`.repeat(40) }))
    );
    const out = await run(makeTool({ big: wide } as any), { operatorId: "big", expr: "df" });
    expect(out.length).toBeLessThan(6000);
    expect(out).toContain("clipped at");
  });

  test("the per-turn ceiling is overridable — the tail-trimming knob", async () => {
    const results: Record<string, any> = { pressure: makeInfo(ROWS) };
    const t = createQueryResultTool({
      getResult: id => results[id],
      listOperators: () => Object.keys(results),
      getCurrentTurnKey: () => "m1",
      callsPerTurn: 2,
    });
    expect(await run(t, { operatorId: "pressure", expr: "df.shape" })).not.toContain("[ERROR]");
    expect(await run(t, { operatorId: "pressure", expr: "df.shape" })).not.toContain("[ERROR]");
    const third = await run(t, { operatorId: "pressure", expr: "df.shape" });
    expect(third).toContain("[ERROR]");
    expect(third).toContain("(2 calls)");
  });

  test("the per-turn budget stops a loop and resets on a new turn", async () => {
    let key = "m1";
    const results: Record<string, OperatorInfo> = { pressure: makeInfo(ROWS) } as any;
    const t = createQueryResultTool({
      getResult: id => results[id],
      listOperators: () => Object.keys(results),
      getCurrentTurnKey: () => key,
    });
    for (let i = 0; i < QUERY_CALLS_PER_TURN; i++) {
      expect(await run(t, { operatorId: "pressure", expr: "df.shape" })).toContain("40 rows");
    }
    expect(await run(t, { operatorId: "pressure", expr: "df.shape" })).toContain("budget");
    key = "m2";
    expect(await run(t, { operatorId: "pressure", expr: "df.shape" })).toContain("40 rows");
  });
});
