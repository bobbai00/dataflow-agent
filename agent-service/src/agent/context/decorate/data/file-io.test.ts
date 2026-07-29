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
import { formatTableHints, formatFileIo } from "./structural-profile";
import { formatColumnStats } from "./column-stats";
import { RESERVED_STATS_KEYS, FILE_IO_KEY } from "./reserved-keys";
import type { OperatorInfo } from "../../../../types/execution";

const info = (columnStats: Record<string, string>): OperatorInfo =>
  ({ columnStats, totalRowCount: 100, outputTuples: 100 } as unknown as OperatorInfo);

describe("A7 __file_io__ — multi-file load provenance", () => {
  test("renders on its OWN rung, not inside the structural profile", () => {
    const out = formatFileIo(info({ __file_io__: "files read: 53 [ALABAMA.csv, ALASKA.csv, … (+51)]" }));
    expect(out).toBe("Files read: 53 [ALABAMA.csv, ALASKA.csv, … (+51)]");
  });

  test("INDEPENDENT of structuralHints — a schema-only arm can carry it", () => {
    // The two best arms on this benchmark (LATEST 5k+code, LATEST 1k+code) are
    // schema-only. Coupling the IO fact to the stats rung locked them out.
    const i = info({ __file_io__: "files read: 3 [a.csv, b.csv, c.csv]" });
    expect(formatFileIo(i)).toContain("Files read: 3");
    expect(formatTableHints(i)).toBeUndefined(); // no table hints published
  });

  test("table hints render independently of the file fact", () => {
    const i = info({ __table_hints__: "duplicate rows: 359 of 764 (47%)" });
    expect(formatTableHints(i)).toBe("Output Table profile:\n- duplicate rows: 359 of 764 (47%)");
    expect(formatFileIo(i)).toBeUndefined();
  });

  test("is NEVER rendered as a column — the key is reserved", () => {
    expect(RESERVED_STATS_KEYS.has(FILE_IO_KEY)).toBe(true);
    const block = formatColumnStats(info({
      region: "(str): null=0, distinct=4",
      __file_io__: "files read: 3 [a.csv, b.csv, c.csv]",
    }));
    expect(block).toContain('- "region"');
    expect(block).not.toContain("__file_io__");
    expect(block).not.toContain("files read");
  });

  test("absent key ⇒ nothing rendered on either rung", () => {
    expect(formatFileIo(info({ region: "(str): null=0" }))).toBeUndefined();
    expect(formatTableHints(info({ region: "(str): null=0" }))).toBeUndefined();
  });
});

describe("stats -> fileIoFacts coupling", () => {
  const resolve = (patch: object) => {
    const { latestPreset, parseSummarizeParams, resolveOperatorParams } = require("../../summarize/params");
    const base = latestPreset();
    const merge = (a: any, b: any): any => {
      const o = { ...a };
      for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v;
      return o;
    };
    const p = parseSummarizeParams({
      ...base,
      operators: { defaults: merge(base.operators.defaults, (patch as any).defaults ?? {}), overrides: {} },
    });
    return resolveOperatorParams(p, "any-op").result.latest.column;
  };

  test("stats ON implies the file fact", () => {
    expect(resolve({ defaults: { result: { latest: { column: { stats: true } } } } }).fileIoFacts).toBe(true);
  });

  test("stats OFF leaves it off", () => {
    expect(resolve({ defaults: { result: { latest: { column: { stats: false } } } } }).fileIoFacts).toBeFalsy();
  });

  test("an explicit false still wins over the coupling", () => {
    expect(
      resolve({ defaults: { result: { latest: { column: { stats: true, fileIoFacts: false } } } } }).fileIoFacts
    ).toBe(false);
  });

  test("a schema-only operator can still opt in explicitly", () => {
    expect(
      resolve({ defaults: { result: { latest: { column: { stats: false, fileIoFacts: true } } } } }).fileIoFacts
    ).toBe(true);
  });
});
