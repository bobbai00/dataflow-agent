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
 * Execution telemetry on rendered results: the `Lineage:` fact and the
 * coercion-dataloss alarm, in both channels (current render and recallState).
 *
 * The case these guard: an inner join silently kept 462 of 472 rows and cost
 * thirteen downstream turns before anything visibly failed. The lineage line
 * makes that loss legible at the step it happens; the recall path carries it so
 * a later turn diagnosing a drift sees the defect recorded on the old version
 * instead of a polished table.
 */

import { describe, expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import { WorkflowState } from "../workflow-state";
import { formatOperatorResult, formatRowLineage } from "./result-formatting";
import { createRecallStateTool, type RecalledTurn, type RecallVerb } from "./recall-state-tool";
import { makeWorkflow } from "../context/summarize/fixtures";

function info(extra: Partial<OperatorInfo>): OperatorInfo {
  return {
    state: "Completed",
    resultMode: "table",
    result: [{ school: "a", score: 1.5 }],
    ...extra,
  } as unknown as OperatorInfo;
}

describe("formatRowLineage", () => {
  test("states rows in vs rows out, with the ratio", () => {
    const line = formatRowLineage(info({ inputTuples: 472, totalRowCount: 462 }));
    expect(line).toContain("472 rows in");
    expect(line).toContain("462 rows out");
    expect(line).toContain("97.9%");
  });

  test("silent on loaders — nothing was consumed, so there is no lineage", () => {
    expect(formatRowLineage(info({ inputTuples: 0, totalRowCount: 100 }))).toBeUndefined();
    expect(formatRowLineage(info({ totalRowCount: 100 }))).toBeUndefined();
  });

  test("renders in the result body only when the flag is on", () => {
    const ws = new WorkflowState();
    const i = info({ inputTuples: 472, totalRowCount: 462 });
    const on = formatOperatorResult("op", i, ws, { rowLineage: true });
    const off = formatOperatorResult("op", i, ws, {});
    expect(on).toContain("Lineage: 472 rows in");
    expect(off).not.toContain("Lineage:");
  });
});

describe("coercion diagnostics through the render", () => {
  const dirty = info({
    inputTuples: 100,
    totalRowCount: 100,
    columnStats: {
      score: "(numeric): min=1 max=9",
      __coercion_telemetry__:
        "to_numeric(coerce) nulled 3 of 12 values (e.g. ['N/A', 'No Data', 'n/a']) — these were DROPPED to NaN",
    } as any,
  });

  test("the alarm renders when gated on, and only then", () => {
    const ws = new WorkflowState();
    const on = formatOperatorResult("op", dirty, ws, { coercionTelemetry: true });
    expect(on).toContain("nulled 3 of 12");
    const off = formatOperatorResult("op", dirty, ws, {});
    expect(off).not.toContain("nulled 3 of 12");
  });

  test("the reserved key never leaks into the schema line as a column", () => {
    const ws = new WorkflowState();
    const on = formatOperatorResult("op", dirty, ws, { coercionTelemetry: true, schemaInResult: true });
    expect(on).not.toContain("__coercion_telemetry__ (");
  });
});

describe("telemetry rides along on recallState", () => {
  function tool() {
    const wf = makeWorkflow([{ id: "joined", type: "DataProcessing", numInputPorts: 1, properties: { code: "def process(a):\n    return a" } }]);
    const turns: RecalledTurn[] = [
      {
        turn: 1,
        request: "join the tables",
        answer: "{}",
        operators: ["joined"],
        verbs: new Map<string, RecallVerb>([["joined", "added"]]),
        workflow: wf,
        results: new Map([
          [
            "joined",
            info({
              inputTuples: 472,
              totalRowCount: 462,
              columnStats: { __coercion_telemetry__: "to_numeric(coerce) nulled 5 of 40 values (e.g. ['1,234'])" } as any,
            }),
          ],
        ]),
      },
      { turn: 2, request: "next", answer: "{}", operators: [], workflow: wf, results: new Map() },
    ];
    return createRecallStateTool({
      getTurns: () => turns,
      getCurrentTurnKey: () => "m",
      workflowState: new WorkflowState(),
    });
  }

  test("a recalled version carries its lineage and its recorded dataloss — even with sample=0", async () => {
    const out: string = await (tool() as any).execute({ turn: 1 });
    expect(out).toContain("Lineage: 472 rows in");
    expect(out).toContain("nulled 5 of 40");
  });
});
