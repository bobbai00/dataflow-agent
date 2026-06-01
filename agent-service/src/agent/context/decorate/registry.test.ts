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
import { RUNGS, rungsForLevel, levelsToFlags, flagToLevel } from "./registry";

describe("decorate registry", () => {
  test("levels are cumulative — data L2 includes L1 and L2, not L3", () => {
    const ids = rungsForLevel("data", 2).map(r => r.id).sort();
    expect(ids).toEqual(["data.schema", "data.structural_profile"]);
  });

  test("data L0 enables no rungs", () => {
    expect(rungsForLevel("data", 0)).toEqual([]);
    expect(rungsForLevel("flow", 0)).toEqual([]);
  });

  test("data L3 supersets L2 (the value-level tier)", () => {
    const ids = rungsForLevel("data", 3).map(r => r.id).sort();
    expect(ids).toEqual(["data.coercion", "data.schema", "data.structural_profile", "data.value_format"]);
  });

  test("flow facet rungs are independent of data facet; schema is data-only", () => {
    const flow = rungsForLevel("flow", 3).map(r => r.id);
    expect(flow.every(id => id.startsWith("flow."))).toBe(true);
    // schema belongs to the data facet, not flow
    expect(flow).not.toContain("flow.schema");
  });

  test("levelsToFlags expands the proven converge stack (flow L1 + data L1)", () => {
    // converge = loader_hint (flow L1) + schema (data L1)
    const flags = levelsToFlags(1, 1);
    expect(flags.loaderHint).toBe(true);       // flow L1
    expect(flags.schemaInResult).toBe(true);   // data L1
    // the structural-profile win (data L2) is NOT on at data L1
    expect(flags.tableStructureHint).toBeUndefined();
    expect(flags.lineageStats).toBeUndefined();
  });

  test("data L2 adds the structural-profile win on top of converge", () => {
    const flags = levelsToFlags(1, 2);
    expect(flags.schemaInResult).toBe(true);
    expect(flags.tableStructureHint).toBe(true);
    expect(flags.valueFormatFlags).toBeUndefined(); // L3
  });

  test("levelsToFlags(0,0) is empty (pure baseline)", () => {
    expect(levelsToFlags(0, 0)).toEqual({});
  });

  test("the structural-profile win sits at data L2, preemptive", () => {
    const rung = RUNGS.find(r => r.id === "data.structural_profile")!;
    expect(rung.facet).toBe("data");
    expect(rung.level).toBe(2);
    expect(rung.mode).toBe("preemptive");
    expect(rung.flag).toBe("tableStructureHint");
  });

  test("flagToLevel inverts the mapping", () => {
    expect(flagToLevel("data", "tableStructureHint")).toBe(2);
    expect(flagToLevel("data", "schemaInResult")).toBe(1);
    expect(flagToLevel("flow", "loaderHint")).toBe(1);
    expect(flagToLevel("flow", "graphAudit")).toBe(3);
  });

  test("every rung has a unique id", () => {
    const ids = RUNGS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
