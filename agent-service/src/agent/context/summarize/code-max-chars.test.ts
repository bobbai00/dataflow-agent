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
import { clampCodeChars } from "../../tools/result-formatting";

/** Shaped like the real thing: signature first, return last, bulk in between. */
function udf(bodyLines: number) {
  return [
    "def process(df):",
    "    import pandas as pd",
    ...Array.from({ length: bodyLines }, (_, i) => `    df["c${i}"] = df["a"] * ${i}  # filler to add bulk`),
    "    return df",
  ].join("\n");
}

describe("clampCodeChars", () => {
  test("no budget, or code already under it, returns the input unchanged", () => {
    const code = udf(3);
    expect(clampCodeChars(code, 0)).toBe(code);
    expect(clampCodeChars(code, code.length)).toBe(code);
    expect(clampCodeChars(code, code.length + 500)).toBe(code);
  });

  test("clamps to the budget and says how many lines it dropped", () => {
    const code = udf(200);
    const out = clampCodeChars(code, 800);
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out.length).toBeLessThan(code.length);
    expect(out).toMatch(/# \.\.\. \d+ lines elided \.\.\./);
  });

  /** The reason this keeps the tail: the return statement is what tells a
   *  downstream operator what this one produces. A prefix-only truncation would
   *  drop exactly that. */
  test("keeps BOTH the signature and the return", () => {
    const out = clampCodeChars(udf(300), 600);
    expect(out.split("\n")[0]).toBe("def process(df):");
    expect(out.trimEnd().endsWith("    return df")).toBe(true);
  });

  test("holds the budget across a wide range of sizes", () => {
    for (const budget of [200, 400, 800, 1600, 3200]) {
      for (const n of [5, 50, 500]) {
        const out = clampCodeChars(udf(n), budget);
        expect(out.length).toBeLessThanOrEqual(Math.max(budget, udf(n).length >= budget ? budget : Infinity));
      }
    }
  });

  test("degenerate input does not throw or expand", () => {
    expect(clampCodeChars("", 100)).toBe("");
    expect(clampCodeChars("x".repeat(500), 100).length).toBeLessThanOrEqual(100);
    const twoLine = "def f():\n    return " + "9".repeat(400);
    expect(clampCodeChars(twoLine, 100).length).toBeLessThanOrEqual(100);
  });
});
