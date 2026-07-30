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
import { densifyStatsLine } from "../decorate/data/column-stats";
import { summarize, type SummarizeInput } from "./summarize";
import { deltaPreset, latestPreset, parseSummarizeParams } from "./params";
import { buildRichScenario, buildScenario, makeInfo, makeWorkflow } from "./fixtures";

function richInput(): SummarizeInput {
  const { steps, storage, workflowState } = buildRichScenario();
  return { visibleSteps: steps, workflowState, snapshotStorage: storage, compilationResult: null };
}

function latestWith(patch: object) {
  const base = latestPreset();
  const merge = (a: any, b: any): any => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v;
    }
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

describe("densifyStatsLine — drop the default healthy state, keep surprises", () => {
  test("null=0 is dropped; a non-zero null count survives", () => {
    expect(densifyStatsLine("(str): null=0, distinct=890, format=currency", 1000)).toBe(
      "(str): distinct=890, format=currency"
    );
    expect(densifyStatsLine("(numeric): null=12, mean=52.3, min=0.5", 1000)).toBe(
      "(numeric): null=12, mean=52.3, min=0.5"
    );
  });

  test("all-distinct collapses to `unique` (shorter than the count it replaces)", () => {
    const out = densifyStatsLine("(str): null=0, distinct=15", 15);
    expect(out).toBe("(str): unique");
    expect(out.length).toBeLessThan("(str): null=0, distinct=15".length);
  });

  test("`unique` still fires when nulls shrink the non-null population", () => {
    // 20 rows, 5 null ⇒ 15 non-null, 15 distinct ⇒ every present value differs.
    expect(densifyStatsLine("(str): null=5, distinct=15", 20)).toBe("(str): null=5, unique");
  });

  test("single-valued column collapses to `constant`", () => {
    expect(densifyStatsLine("(str): null=0, distinct=1", 400)).toBe("(str): constant");
  });

  test("an informative distinct count is kept verbatim", () => {
    expect(densifyStatsLine("(str): null=0, distinct=4, top_5={West=300}", 1000)).toBe(
      "(str): distinct=4, top_5={West=300}"
    );
  });

  test("never empties a line — the type tag always survives", () => {
    expect(densifyStatsLine("(str): null=0", 100)).toBe("(str)");
  });

  test("unparseable / unknown shapes pass through untouched", () => {
    expect(densifyStatsLine("no type tag here", 10)).toBe("no type tag here");
    expect(densifyStatsLine("(str): distinct=notanumber", 10)).toBe("(str): distinct=notanumber");
  });

  test("rows=0 (unknown population) never invents `unique`", () => {
    expect(densifyStatsLine("(str): null=0, distinct=7", 0)).toBe("(str): distinct=7");
  });
});

describe("summarize — statsDensity:anomaly at the render level", () => {
  test('default "full" keeps the worker string verbatim (parity)', () => {
    const text = summarize(richInput(), latestWith({
      operators: { defaults: { result: { latest: { column: { stats: true } } } } },
    })).text;
    expect(text).toContain("null=0, distinct=4");
    expect(text).toContain("null=0, distinct=890, format=currency");
  });

  test("anomaly density drops null=0 across every column of a sampled table", () => {
    const text = summarize(richInput(), latestWith({
      operators: { defaults: { result: { latest: { column: { stats: true, statsDensity: "anomaly" } } } } },
    })).text;
    const sales = text.slice(text.indexOf("### Operator `sales`"), text.indexOf("### Operator `orphan_load`"));
    expect(sales).toContain("Column Schema and stats:");
    expect(sales).not.toContain("null=0");
    expect(sales).toContain("distinct=4");
    expect(sales).toContain("null=12"); // the anomaly is retained
    expect(sales).toContain("format=currency");
  });

  test("anomaly density drops the Schema echo the stats block already carries", () => {
    const withEcho = summarize(richInput(), latestWith({
      operators: { defaults: { result: { latest: { column: { schema: true, stats: true } } } } },
    })).text;
    const densified = summarize(richInput(), latestWith({
      operators: { defaults: { result: { latest: { column: { schema: true, stats: true, statsDensity: "anomaly" } } } } },
    })).text;
    expect(withEcho).toContain("Schema (4 cols):");
    expect(densified).not.toContain("Schema (4 cols):");
    // the columns themselves are still named — by the stats block
    expect(densified).toContain('- "region"');
    expect(densified).toContain('- "price_display"');
    expect(densified.length).toBeLessThan(withEcho.length);
  });

  test("stats block is suppressed once the sample proves every row is visible", () => {
    // 7 rows held, 7 rows rendered, nothing truncated — the exact shape that
    // rendered `null=0, distinct=7` beneath all seven values in production.
    const rows = Array.from({ length: 7 }, (_, i) => ({ sheet_name: `S${i}` }));
    const { steps, storage, workflowState } = buildScenario([
      { id: "a1", stepId: 1, role: "agent" },
    ]);
    storage.createSnapshot("a1", makeWorkflow([{ id: "sheets", type: "DataLoading" }]));
    storage.setOperatorResult("a1", "sheets", makeInfo(7, {
      sampleRows: rows,
      truncated: false,
      columnStats: { sheet_name: "(str): null=0, distinct=7" },
    }));
    const inp: SummarizeInput = {
      visibleSteps: steps, workflowState, snapshotStorage: storage, compilationResult: null,
    };

    const full = summarize(inp, latestWith({
      operators: { defaults: { result: { latest: { column: { stats: true } } } } },
    })).text;
    const anomaly = summarize(inp, latestWith({
      operators: { defaults: { result: { latest: { column: { stats: true, statsDensity: "anomaly" } } } } },
    })).text;

    // Suppression-on-proof is now the DEFAULT (not an anomaly-density feature),
    // because it cannot lose a fact: all 7 rows are on screen. Both render paths
    // therefore drop the block here; anomaly density owns the other three trims.
    expect(full).not.toContain("Column Schema and stats:");
    expect(anomaly).not.toContain("Column Schema and stats:");
    // the data itself is untouched — only the redundant annotation left
    expect(anomaly).toContain("sheet_name");
  });

  test("anomaly density is inert on a DELTA core (no snapshot to shape)", () => {
    const base = deltaPreset();
    const params = parseSummarizeParams({
      ...base,
      operators: {
        defaults: {
          ...base.operators.defaults,
          result: {
            ...base.operators.defaults.result,
            latest: {
              ...base.operators.defaults.result.latest,
              column: { ...base.operators.defaults.result.latest.column, statsDensity: "anomaly" },
            },
          },
        },
        overrides: {},
      },
    });
    expect(() => summarize(richInput(), params)).not.toThrow();
  });
});

describe("stats block bounds — column slicing and line clamp", () => {
  const opInfo = (colCount: number, statLine = "(numeric): null=0, mean=1") =>
    makeInfo(100, {
      sampleRows: [Object.fromEntries(Array.from({ length: colCount }, (_, i) => [`c${i}`, i]))],
      truncated: true, // keep completeness unproven so the block renders
      columnStats: Object.fromEntries(Array.from({ length: colCount }, (_, i) => [`c${i}`, statLine])),
    });

  function render(info: ReturnType<typeof makeInfo>) {
    const { steps, storage, workflowState } = buildScenario([{ id: "a1", stepId: 1, role: "agent" }]);
    storage.createSnapshot("a1", makeWorkflow([{ id: "wide", type: "DataLoading" }]));
    storage.setOperatorResult("a1", "wide", info);
    return summarize(
      { visibleSteps: steps, workflowState, snapshotStorage: storage, compilationResult: null },
      latestWith({ operators: { defaults: { result: { latest: { column: { stats: true } } } } } })
    ).text;
  }

  test("60 columns: keeps BOTH ends (25 head + 25 tail), matching TSV/Schema", () => {
    const text = render(opInfo(60));
    expect(text).toContain('- "c0"');
    expect(text).toContain('- "c24"'); // last of the head half
    expect(text).toContain('- "c59"'); // last column survives
    expect(text).toContain('- "c35"'); // first of the tail half
    expect(text).not.toContain('- "c30"'); // middle is what gets dropped
    expect(text).toContain("(10 more columns omitted)");
  });

  test("the omitted marker sits between the halves, preserving column order", () => {
    const text = render(opInfo(60));
    const head = text.indexOf('- "c24"');
    const marker = text.indexOf("more columns omitted");
    const tail = text.indexOf('- "c35"');
    expect(head).toBeLessThan(marker);
    expect(marker).toBeLessThan(tail);
  });

  test("<=50 columns renders every column with no marker (byte-identical path)", () => {
    const text = render(opInfo(50));
    expect(text).toContain('- "c0"');
    expect(text).toContain('- "c49"');
    expect(text).not.toContain("more columns omitted");
  });

  test("a long top_N line is clamped, and the core metrics survive the cut", () => {
    const buckets = Array.from({ length: 5 }, (_, i) => `"${"data/very/long/path/file".repeat(3)}${i}.csv"=1`).join(", ");
    const text = render(opInfo(1, `(str): null=3, distinct=5, top_5={${buckets}}`));
    const line = text.split("\n").find(l => l.trim().startsWith('- "c0"'))!;
    expect(line.length).toBeLessThanOrEqual(220); // 200 budget + the `- "c0" ` wrapper
    expect(line).toContain("null=3"); // anomaly metric never sacrificed
    expect(line).toContain("distinct=5");
  });

  test("a line already inside budget is untouched", () => {
    const text = render(opInfo(1, "(numeric): null=0, mean=52.3, min=0.5, max=999.9"));
    expect(text).toContain('- "c0" (numeric): null=0, mean=52.3, min=0.5, max=999.9');
  });
});
