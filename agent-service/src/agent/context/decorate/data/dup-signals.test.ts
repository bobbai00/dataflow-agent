/**
 * duplicate_values: exact per-column arithmetic (nonNull − distinct) appended to
 * a (str) column's stats line whenever it is > 0 — presence, not a threshold
 * band, and no alarms (raw-facts-only contract: judgment lives in the prompt/
 * model, not the renderer). Shapes reconstruct legal-hard-15's real data.
 */

/**
 * Non-passive near-key duplicate signal mined from the gpt-5.2 KramaBench
 * failure analysis (docs/compaction-case-analysis-gpt52.md): legal-hard-15's
 * `distinct=401` on 452 rows was rendered but passive → the agent double-counted
 * cross-state MSAs. `duplicate_values=` makes the arithmetic explicit (exact, from the
 * worker's own distinct/null counts — no heuristics); the ⚠ alarm names the
 * dedupe question on near-key columns. Tests reconstruct the REAL failing shape.
 */

import { describe, expect, test } from "bun:test";
import { formatColumnStats } from "./column-stats";
import type { OperatorInfo } from "../../../../types/execution";

function info(partial: Partial<OperatorInfo>): OperatorInfo {
  return { state: "Completed", inputTuples: 0, outputTuples: 0, resultMode: "table", ...partial } as OperatorInfo;
}

describe("duplicate_values (exact, presence-only)", () => {
  const msaClean = info({
    totalRowCount: 452,
    outputTuples: 452,
    columnStats: {
      source_path: "(str): null=0, distinct=52",
      metropolitan_area: "(str): null=0, distinct=401",
      reports: "(numeric): null=0, mean=1200.5, min=8, max=98000",
    },
  });

  test("appends duplicate_values on the real msa_clean shape (no alarm — raw facts only)", () => {
    const block = formatColumnStats(msaClean)!;
    expect(block).toContain('"metropolitan_area" (str): null=0, distinct=401, duplicate_values=51');
    expect(block).not.toContain("⚠");
    // the "source_path" categorical (52 distinct / 452 rows) gets the same exact fact
    expect(block).toContain('"source_path" (str): null=0, distinct=52, duplicate_values=400');
  });

  test("categoricals get the same exact fact — uniform, no special-casing", () => {
    const cat = info({
      totalRowCount: 63160,
      columnStats: { Violation: "(str): null=0, distinct=4, top_5={No=44000, Yes=2000}" },
    });
    const block = formatColumnStats(cat)!;
    expect(block).toContain('"Violation" (str): null=0, distinct=4, top_5={No=44000, Yes=2000}, duplicate_values=63156');
    expect(block).not.toContain("⚠");
  });

  test("display-format columns get duplicate_values like any other (str) column", () => {
    const fmt = info({
      totalRowCount: 1000,
      columnStats: { price_display: "(str): null=0, distinct=890, format=currency" },
    });
    const block = formatColumnStats(fmt)!;
    expect(block).toContain("duplicate_values=110");
    expect(block).not.toContain("⚠");
  });

  test("fully-unique columns are untouched", () => {
    const uniq = info({ totalRowCount: 100, columnStats: { id: "(str): null=0, distinct=100" } });
    const block = formatColumnStats(uniq)!;
    expect(block).not.toContain("duplicate_values");
  });
});
