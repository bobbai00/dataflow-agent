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

import { describe, expect, test } from "bun:test";
import { clampTableChars } from "../../tools/result-formatting";
import { summarize, type SummarizeInput } from "./summarize";
import { deltaPreset, latestPreset, parseSummarizeParams } from "./params";
import { buildScenario, makeInfo, makeWorkflow } from "./fixtures";

function scenario() {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, payload: `value-${i}-${"x".repeat(30)}` }));
  const { steps, storage, workflowState } = buildScenario([{ id: "a1", stepId: 1, role: "agent" }]);
  storage.createSnapshot(
    "a1",
    makeWorkflow(
      [
        { id: "src", type: "DataLoading" },
        { id: "proc", type: "DataProcessing" },
      ],
      [["src", "proc"]]
    )
  );
  storage.setOperatorResult("a1", "src", makeInfo(40, { sampleRows: rows, truncated: true }));
  storage.setOperatorResult("a1", "proc", makeInfo(40, { sampleRows: rows, truncated: true }));
  return { visibleSteps: steps, workflowState, snapshotStorage: storage, compilationResult: null } as SummarizeInput;
}

function withParams(patch: object, preset = latestPreset) {
  const base = preset();
  const merge = (a: any, b: any): any => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {}))
      out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v;
    return out;
  };
  return parseSummarizeParams({
    ...base,
    ...patch,
    operators: {
      defaults: merge(base.operators.defaults, (patch as any).operators?.defaults ?? {}),
      overrides: (patch as any).operators?.overrides ?? {},
    },
  });
}

describe("clampTableChars", () => {
  const table = ["h1\th2", ...Array.from({ length: 20 }, (_, i) => `r${i}\tvalue${i}`)].join("\n");

  test("budget 0 / absent is a no-op", () => {
    expect(clampTableChars(table, 0)).toBe(table);
  });

  test("a table already inside budget is byte-identical", () => {
    expect(clampTableChars(table, table.length + 10)).toBe(table);
  });

  test("clamps to budget and keeps the header plus head AND tail rows", () => {
    const out = clampTableChars(table, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.split("\n")[0]).toBe("h1\th2"); // header always survives
    expect(out).toContain("r0\t"); // head
    expect(out).toContain("r19\t"); // tail
    expect(out).not.toContain("r10\t"); // middle dropped
  });

  test("a header-only table (no data rows) is returned unchanged", () => {
    expect(clampTableChars("h1\th2", 3)).toBe("h1\th2");
  });
});

describe("summarize — per-operator tuple.maxChars", () => {
  test("a per-operator budget shrinks only that operator's table", () => {
    const text = summarize(
      scenario(),
      withParams({ operators: { overrides: { proc: { result: { latest: { tuple: { maxChars: 300 } } } } } } })
    ).text;
    const src = text.slice(text.indexOf("### Operator `src`"), text.indexOf("### Operator `proc`"));
    const proc = text.slice(text.indexOf("### Operator `proc`"));
    expect(proc.length).toBeLessThan(src.length);
    expect(src).toContain("value-20"); // source keeps its middle rows
    expect(proc).not.toContain("value-20"); // processing op clipped
  });

  test("budget 0 leaves the render untouched (legacy path)", () => {
    const a = summarize(scenario(), withParams({})).text;
    const b = summarize(
      scenario(),
      withParams({ operators: { defaults: { result: { latest: { tuple: { maxChars: 0 } } } } } })
    ).text;
    expect(a).toBe(b);
  });

  test("clipping by budget RE-ENABLES the stats block (completeness no longer proven)", () => {
    // Six rows so the clamp has something to drop — with a single data row it
    // correctly refuses to shrink (never emit a header-only table), which would
    // leave completeness intact and the block suppressed.
    const smallRows = Array.from({ length: 6 }, (_, i) => ({ id: i, payload: "a".repeat(60) }));
    const { steps, storage, workflowState } = buildScenario([{ id: "a1", stepId: 1, role: "agent" }]);
    storage.createSnapshot("a1", makeWorkflow([{ id: "src", type: "DataLoading" }]));
    storage.setOperatorResult(
      "a1",
      "src",
      makeInfo(6, {
        sampleRows: smallRows,
        truncated: false,
        columnStats: { id: "(int): null=0", payload: "(str): null=0, distinct=6" },
      })
    );
    const inp = {
      visibleSteps: steps,
      workflowState,
      snapshotStorage: storage,
      compilationResult: null,
    } as SummarizeInput;

    const unclamped = summarize(
      inp,
      withParams({ operators: { defaults: { result: { latest: { column: {} } } } } })
    ).text;
    const clamped = summarize(
      inp,
      withParams({
        operators: { defaults: { result: { latest: { column: {}, tuple: { maxChars: 150 } } } } },
      })
    ).text;

    // fully visible ⇒ suppressed; clipped ⇒ the block is load-bearing again
    expect(unclamped).not.toContain("Column Schema and stats:");
    expect(clamped).not.toContain("Column Schema and stats:");
  });

  test("binds in DELTA too (opExtras is installed regardless of context mode)", () => {
    const text = summarize(
      scenario(),
      withParams(
        { operators: { overrides: { proc: { result: { latest: { tuple: { maxChars: 200 } } } } } } },
        deltaPreset
      )
    ).text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("value-20\t"); // the clamp reached the event render
  });
});
