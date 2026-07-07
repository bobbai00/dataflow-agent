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
import type { OperatorInfo } from "../../../../types/execution";
import { formatSchemaLine } from "./schema";
import { formatTableHints } from "./structural-profile";
import { formatValueFormatHints } from "./value-format";
import { formatReservedDiag, formatJoinTelemetry } from "./diagnostics";
import { JOIN_TELEMETRY_KEY, COERCION_TELEMETRY_KEY, TABLE_HINTS_KEY, RESERVED_STATS_KEYS } from "./reserved-keys";

const mk = (columnStats: Record<string, string>, extra: Partial<OperatorInfo> = {}): OperatorInfo =>
  ({ columnStats, ...extra }) as unknown as OperatorInfo;

/* ---- schema (data L1) -------------------------------------------------- */
describe("formatSchemaLine", () => {
  test("renders name (type) from columnStats, complete (not truncated)", () => {
    const s = formatSchemaLine(mk({ a: "(numeric): null=0", b: "(str): null=1" }));
    expect(s).toBe("Schema (2 cols): a (numeric), b (str)");
  });
  test("falls back to result headers (names only) without columnStats", () => {
    const s = formatSchemaLine(mk({}, { result: [{ x: 1, y: 2, __row_index__: 0 }] } as any));
    expect(s).toBe("Schema (2 cols): x, y");
  });
  test("filters reserved keys", () => {
    const s = formatSchemaLine(mk({ a: "(numeric): null=0", [TABLE_HINTS_KEY]: "grain: key=id" }));
    expect(s).toBe("Schema (1 cols): a (numeric)");
  });
  test("undefined when no columns", () => {
    expect(formatSchemaLine(mk({}))).toBeUndefined();
  });
});

/* ---- structural profile (data L2 — the win) ---------------------------- */
describe("formatTableHints", () => {
  test("splits worker hints into an Output Table profile block", () => {
    const s = formatTableHints(
      mk({
        [TABLE_HINTS_KEY]:
          'duplicate rows: 34 of 153 (22%) || headers: 2 of 12 columns are unnamed ("Unnamed: 3", "Unnamed: 7")',
      })
    );
    expect(s).toBe(
      'Output Table profile:\n- duplicate rows: 34 of 153 (22%)\n- headers: 2 of 12 columns are unnamed ("Unnamed: 3", "Unnamed: 7")'
    );
  });
  test("undefined when no hint published", () => {
    expect(formatTableHints(mk({ a: "(numeric): null=0" }))).toBeUndefined();
    expect(formatTableHints(mk({ [TABLE_HINTS_KEY]: "" }))).toBeUndefined();
  });
});

/* ---- value-format (data L3) -------------------------------------------- */
describe("formatValueFormatHints", () => {
  test("flags currency / thousands / percent / accounting / numeric-as-text", () => {
    expect(formatValueFormatHints(mk({ amt: "(str): format=currency" }))).toContain("strip $");
    expect(formatValueFormatHints(mk({ n: "(str): format=thousands" }))).toContain("strip commas");
    expect(formatValueFormatHints(mk({ p: "(str): format=percent" }))).toContain("strip %");
    expect(formatValueFormatHints(mk({ x: "(str): format=accounting" }))).toContain("leading minus");
    expect(formatValueFormatHints(mk({ v: "(str): format=numeric-as-text" }))).toContain("strip punctuation");
  });
  test("undefined for clean columns", () => {
    expect(formatValueFormatHints(mk({ c: "(str): distinct=2" }))).toBeUndefined();
    expect(formatValueFormatHints(mk({ x: "(numeric): mean=1.5" }))).toBeUndefined();
  });
});

/* ---- diagnostics (join/coercion) --------------------------------------- */
describe("reserved diagnostics", () => {
  test("formatReservedDiag splits ' || ' into lines", () => {
    expect(formatReservedDiag(mk({ [COERCION_TELEMETRY_KEY]: "a || b" }), COERCION_TELEMETRY_KEY)).toBe("a\nb");
  });
  test("formatJoinTelemetry reads the join key", () => {
    expect(formatJoinTelemetry(mk({ [JOIN_TELEMETRY_KEY]: "Join check ⚠ on state: 0% matched" }))).toContain("Join check");
  });
  test("undefined when absent / empty", () => {
    expect(formatJoinTelemetry(mk({}))).toBeUndefined();
    expect(formatReservedDiag(mk({ [COERCION_TELEMETRY_KEY]: "" }), COERCION_TELEMETRY_KEY)).toBeUndefined();
  });
});

/* ---- reserved keys ----------------------------------------------------- */
describe("reserved keys", () => {
  test("the three diagnostic keys are reserved", () => {
    expect(RESERVED_STATS_KEYS.has(JOIN_TELEMETRY_KEY)).toBe(true);
    expect(RESERVED_STATS_KEYS.has(COERCION_TELEMETRY_KEY)).toBe(true);
    expect(RESERVED_STATS_KEYS.has(TABLE_HINTS_KEY)).toBe(true);
    expect(RESERVED_STATS_KEYS.has("real_column")).toBe(false);
  });
});
