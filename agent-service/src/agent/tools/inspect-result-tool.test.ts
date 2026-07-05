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

  test("dtype anomaly surfaces automatically on a numeric-as-text column", async () => {
    const t = toolFor({ sales: SALES });
    const out: string = await (t as any).execute({ operatorId: "sales" });
    expect(out).toContain("Type anomaly");
    expect(out).toContain("`amount` is text but");
  });

  test("missing operator → [ERROR] result, no throw", async () => {
    const t = toolFor({});
    const out: string = await (t as any).execute({ operatorId: "ghost" });
    expect(out).toContain("[ERROR]");
    expect(out).toContain("no computed result");
  });
});
