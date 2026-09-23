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
import { AgentMode, ContextMode } from "../../../types/agent";
import {
  deepMerge,
  deltaPreset,
  latestPreset,
  mapLegacyToParams,
  parseSummarizeParams,
  resolveOperatorParams,
  SummarizeParamsSchema,
} from "./params";
import { needsExtras } from "./summarize";

describe("SummarizeParams schema", () => {
  test("empty object parses to full defaults (every knob has a neutral default)", () => {
    const p = parseSummarizeParams({});
    expect(p.trajectory.events).toBe("none");
    expect(p.trajectory.observations).toBe("delta");
    expect(p.currentSnapshot).toBe(true);
    expect(p.operators.defaults.result.latest.detail).toBe("sample");
    expect(Object.hasOwn(p.operators.defaults.result.latest.column ?? {}, "statsMetrics")).toBe(false);
    expect(p.operators.defaults.result.history.lastK).toBe(0);
    expect(p.operators.defaults.property.includeCode).toBe(false);
    expect(p.operators.overrides).toEqual({});
  });

  test("invalid values are rejected", () => {
    expect(() => parseSummarizeParams({ trajectory: { events: "bogus" } })).toThrow();
    expect(() => parseSummarizeParams({ operators: { defaults: { result: { latest: { detail: "x" } } } } })).toThrow();
    expect(() =>
      parseSummarizeParams({ operators: { defaults: { result: { latest: { column: { stats: true } } } } } })
    ).toThrow();
  });

  test("per-operator overrides deep-merge onto defaults", () => {
    const p = SummarizeParamsSchema.parse({
      operators: {
        defaults: { result: { latest: { detail: "sample", tuple: { sampleRows: 10 } } } },
        overrides: {
          noisy_op: { result: { latest: { detail: "shape" } } },
        },
      },
    });
    const noisy = resolveOperatorParams(p, "noisy_op");
    expect(noisy.result.latest.detail).toBe("shape");
    // untouched knobs inherit the defaults
    expect(noisy.result.latest.tuple.sampleRows).toBe(10);
    // other operators keep pure defaults
    expect(resolveOperatorParams(p, "other").result.latest.detail).toBe("sample");
  });

  test("deepMerge never mutates inputs and replaces arrays", () => {
    const base = { a: { b: 1, arr: [1, 2] }, c: 3 };
    const merged = deepMerge(base, { a: { arr: [9] } });
    expect(merged).toEqual({ a: { b: 1, arr: [9] }, c: 3 });
    expect(base.a.arr).toEqual([1, 2]);
  });
});

describe("mapLegacyToParams — the presets", () => {
  test("LATEST maps to events:none + currentSnapshot", () => {
    const p = latestPreset();
    expect(p.trajectory.events).toBe("none");
    expect(p.currentSnapshot).toBe(true);
    expect(p.trajectory.reasoningReplayK).toBe(10); // server default thoughtReplay on
    expect(p.maxCellChars).toBe(2000);
  });

  test("DELTA maps to events:interleaved without a currentSnapshot section", () => {
    const p = deltaPreset();
    expect(p.trajectory.events).toBe("interleaved");
    expect(p.currentSnapshot).toBe(false);
    expect(p.trajectory.observations).toBe("delta");
  });

  test("legacy-mapped params never trigger the extras path (parity guarantee)", () => {
    expect(needsExtras(latestPreset())).toBe(false);
    expect(needsExtras(deltaPreset())).toBe(false);
    // …including with every legacy knob turned on:
    const maxed = mapLegacyToParams(ContextMode.LATEST, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      thoughtReplay: true,
      agentTurns: true,
      errorReflection: true,
      attemptReflection: true,
      maxResultRows: 5,
      contextWindowTokens: 1000,
    });
    expect(needsExtras(maxed)).toBe(false);
  });
});
