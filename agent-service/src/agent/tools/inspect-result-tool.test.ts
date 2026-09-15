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
import { createInspectResultTool } from "./inspect-result-tool";
import { WorkflowState } from "../workflow-state";
import type { OperatorInfo } from "../../types/execution";

function info(rows: Record<string, any>[]): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows.length,
    resultMode: "table",
    totalRowCount: rows.length,
    result: rows,
  } as OperatorInfo;
}

function toolFor(rowsByOp: Record<string, OperatorInfo | undefined>) {
  const ws = new WorkflowState();
  return createInspectResultTool({ getResult: (id: string) => rowsByOp[id], workflowState: ws });
}

const SALES = info([
  { __row_index__: 0, region: "West", amount: "1,204", note: "ok" },
  { __row_index__: 1, region: "East", amount: "980", note: "ok" },
  { __row_index__: 2, region: "West", amount: "N/A", note: "" },
  { __row_index__: 3, region: "North", amount: "1,530", note: "late" },
  { __row_index__: 4, region: "East", amount: "1,102", note: "ok" },
]);

describe("inspectResult tool", () => {
  test("basic inspect renders the table with a header + schema", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales" });
    expect(out).toContain("Inspection of `sales`");
    expect(out).toContain("region");
    expect(out).toContain("Schema (");
  });

  test("stats:true adds the column stats block (from result headers)", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales", stats: true });
    // No worker columnStats on this fixture, so the block is schema-only; the
    // Schema line must still enumerate every column.
    expect(out).toContain("Schema (3 cols): region, amount, note");
  });

  test("where nonnumeric:amount surfaces only the contaminant row", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales", where: "nonnumeric:amount" });
    expect(out).toContain("where nonnumeric:amount");
    expect(out).toContain("N/A");
    // rows that ARE numeric are filtered out
    expect(out).not.toContain("1,204");
    expect(out).toContain("1 of 1 matching"); // exactly one non-numeric row
  });

  test("where nulls:note surfaces the empty-note row", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales", where: "nulls:note" });
    expect(out).toContain("where nulls:note");
    expect(out).toContain("matching");
  });

  test("where distinct:region collapses to one row per region", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales", where: "distinct:region" });
    expect(out).toContain("3 of 3 matching"); // West/East/North
  });

  test("columns projection limits the rendered columns", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales", columns: ["region"] });
    expect(out).toContain("columns: region");
    expect(out).toContain("Schema (1 cols): region");
  });

  test("requested columns scope worker schema and statistics without changing the cached result", async () => {
    const cached: OperatorInfo = {
      ...SALES,
      totalRowCount: 100,
      truncated: true,
      columnStats: {
        region: '(str): null=0, distinct=3, top_5={"West"=40,"East"=40,"North"=20}',
        amount: "(str): null=0, distinct=95",
        note: "(str): null=10, distinct=2",
      },
    };
    const original = JSON.stringify(cached);
    const t = toolFor({ sales: cached });
    for (const stats of [true, false]) {
      const out: string = await (t as any).execute({ operatorId: "sales", columns: ["region"], stats });
      expect(out).toContain("Schema (1 cols): region (str)");
      expect(out).not.toContain("amount");
      expect(out).not.toContain("note");
      if (stats) {
        expect(out).toContain("distinct=3");
        expect(out).toContain("full operator output");
      } else expect(out).not.toContain("distinct=3");
    }
    const noRows: string = await (t as any).execute({
      operatorId: "sales",
      columns: ["region"],
      where: "nulls:region",
      stats: true,
    });
    expect(noRows).toContain("0 of 0 matching sampled row(s)");
    expect(noRows).toContain("Schema (1 cols): region (str)");
    expect(noRows).toContain("distinct=3");
    expect(noRows).not.toContain("amount");
    expect(JSON.stringify(cached)).toBe(original);
  });

  test("missing operator → [ERROR] result, no throw", async () => {
    const t = toolFor({});
    const out: string = await (t as any).execute({ operatorId: "ghost" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("no computed result");
  });
});
