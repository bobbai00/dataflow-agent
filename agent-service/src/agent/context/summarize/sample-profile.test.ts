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
import { formatSampleDuplicates, formatSampleFds } from "./sample-profile";
import { filterStatsLine } from "../decorate/data/column-stats";

describe("formatSampleDuplicates", () => {
  test("reports duplicate rows", () => {
    const rows = [
      { a: 1, b: "x" },
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    const line = formatSampleDuplicates(rows)!;
    expect(line).toContain("1 duplicate row");
    expect(line).toContain("over 3 sampled rows");
  });

  test("reports identical column pairs", () => {
    const rows = [
      { id: 1, id_copy: 1, v: "a" },
      { id: 2, id_copy: 2, v: "b" },
    ];
    const line = formatSampleDuplicates(rows)!;
    expect(line).toContain("identical columns: `id` = `id_copy`");
  });

  test("silent when nothing duplicates", () => {
    const rows = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    expect(formatSampleDuplicates(rows)).toBeUndefined();
  });

  test("__row_index__ is ignored (rows differing only by index are duplicates)", () => {
    const rows = [
      { __row_index__: 0, a: 1 },
      { __row_index__: 5, a: 1 },
    ];
    expect(formatSampleDuplicates(rows)!).toContain("1 duplicate row");
  });
});

describe("formatSampleFds", () => {
  test("detects a real dependency and suppresses trivial ones", () => {
    const rows = [
      { city: "SF", state: "CA", temp: 60 },
      { city: "LA", state: "CA", temp: 75 },
      { city: "NYC", state: "NY", temp: 50 },
      { city: "SF", state: "CA", temp: 61 },
    ];
    const line = formatSampleFds(rows)!;
    expect(line).toContain("`city` → `state`");
    // temp is unique per row on the sample… wait, temp has 4 distinct over 4 rows
    // → near-unique A suppressed; state → city does NOT hold (CA → SF|LA).
    expect(line).not.toContain("`state` → `city`");
    expect(line).not.toContain("`temp` →");
  });

  test("silent on tiny samples", () => {
    expect(
      formatSampleFds([
        { a: 1, b: 2 },
        { a: 1, b: 2 },
      ])
    ).toBeUndefined();
  });

  test("constant columns can't be determined targets", () => {
    const rows = [
      { k: "a", c: 1 },
      { k: "b", c: 1 },
      { k: "a", c: 1 },
    ];
    expect(formatSampleFds(rows)).toBeUndefined();
  });
});

describe("filterStatsLine", () => {
  const numeric = "(numeric): null=12, mean=52.3, min=0.5, max=999.9, top_10={1=5, 2=3}";

  test("'all' returns verbatim", () => {
    expect(filterStatsLine(numeric, "all")).toBe(numeric);
  });

  test("subsets metric families, brace-aware", () => {
    expect(filterStatsLine(numeric, ["min", "max"])).toBe("(numeric): min=0.5, max=999.9");
    expect(filterStatsLine(numeric, ["top"])).toBe("(numeric): top_10={1=5, 2=3}");
    expect(filterStatsLine(numeric, ["null"])).toBe("(numeric): null=12");
  });

  test("unknown families (format tag) always survive", () => {
    const s = "(str): null=0, distinct=890, format=currency";
    expect(filterStatsLine(s, ["min"])).toBe("(str): format=currency");
  });

  test("bool + items families", () => {
    expect(filterStatsLine("(bool): null=0, true=5, false=3", ["true", "false"])).toBe("(bool): true=5, false=3");
    expect(filterStatsLine("(list): null=0, items_min=1, items_max=9", ["items"])).toBe(
      "(list): items_min=1, items_max=9"
    );
  });

  test("empty selection keeps just the type tag", () => {
    expect(filterStatsLine(numeric, [])).toBe("(numeric)");
  });

  test("unparseable lines return verbatim", () => {
    expect(filterStatsLine("weird stuff", ["min"])).toBe("weird stuff");
  });
});
