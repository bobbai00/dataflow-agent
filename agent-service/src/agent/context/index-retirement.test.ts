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
 * Index retirement: which operators keep a full entry.
 *
 * Both of the failure modes pinned here were found by running the benchmark,
 * not by reading the code, and each cost a multi-hour pool to see. They are the
 * two directions the previous age-based rule (`indexRecentTurns`) failed in
 * SIMULTANEOUSLY, with the same constant, because a turn count says nothing
 * about how much state it admits:
 *
 *   starvation — passnyc, 31 operators. At 3 turns the model saw 4 result
 *                tables out of ~23 live operators from turn 5 on, and scored
 *                40.0% against a 63.3% same-era baseline.
 *   flooding   — nfl (277 operators) and uber (381). At 12 turns the context
 *                reached 360-600 kB and turn after turn burned the entire
 *                40-step budget to return an empty answer.
 */

import { describe, expect, test } from "bun:test";
import { selectDetailedOperators } from "../../server";

/** `n` operators, oldest first, one per turn. */
function touches(n: number, prefix = "op"): Map<string, number> {
  return new Map(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, i]));
}

describe("index retirement", () => {
  test("a small DAG keeps everything — no starvation", () => {
    // passnyc's shape: 31 operators, well under any sane cap.
    const keep = selectDetailedOperators([], [], touches(31), 40);
    expect(keep.size).toBe(31);
  });

  test("a large DAG is bounded — no flood", () => {
    // nfl/uber's shape. The old rule admitted "everything touched in 12 turns",
    // which on these tasks is most of the DAG.
    const keep = selectDetailedOperators([], [], touches(381), 40);
    expect(keep.size).toBe(40);
  });

  test("what survives is the most RECENTLY touched", () => {
    const keep = selectDetailedOperators([], [], touches(100), 3);
    expect([...keep].sort()).toEqual(["op97", "op98", "op99"]);
  });

  test("the turn's own work is never evicted, even past the cap", () => {
    // A turn that cannot see the operators it is editing rebuilds them, which
    // is the feedback loop that grows the operator count in the first place.
    const frontier = ["a", "b", "c", "d", "e"];
    const keep = selectDetailedOperators(frontier, [], touches(100), 3);
    for (const id of frontier) expect(keep.has(id)).toBe(true);
    expect(keep.size).toBeGreaterThanOrEqual(frontier.length);
  });

  test("the turn's inputs are never evicted either", () => {
    const keep = selectDetailedOperators(["f"], ["up1", "up2"], touches(100), 1);
    expect(keep.has("f")).toBe(true);
    expect(keep.has("up1")).toBe(true);
    expect(keep.has("up2")).toBe(true);
  });

  test("frontier and history do not double-count against the budget", () => {
    // `op99` is both the newest touch and this turn's work; it must occupy one
    // slot, not two, or the effective budget silently shrinks on active turns.
    const keep = selectDetailedOperators(["op99"], [], touches(100), 3);
    expect(keep.size).toBe(3);
    expect(keep.has("op99")).toBe(true);
  });

  test("a cap of zero still keeps the turn's own work", () => {
    const keep = selectDetailedOperators(["f"], ["u"], touches(50), 0);
    expect([...keep].sort()).toEqual(["f", "u"]);
  });
});
