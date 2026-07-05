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
import { buildDossier } from "./dossier";
import { buildRichScenario, CODE_BY_REGION_V1, CODE_BY_REGION_V2, CODE_BY_REGION_V3 } from "./fixtures";

describe("buildDossier — rich scenario", () => {
  const { steps, storage } = buildRichScenario();
  const dossier = buildDossier(steps, storage);

  test("code versions: by_region has all three submissions with event indices + statuses", () => {
    const d = dossier.operators.get("by_region")!;
    expect(d.codeVersions.map(v => v.eventIndex)).toEqual([4, 5, 6]);
    expect(d.codeVersions.map(v => v.code)).toEqual([CODE_BY_REGION_V1, CODE_BY_REGION_V2, CODE_BY_REGION_V3]);
    expect(d.codeVersions.map(v => v.status)).toEqual(["ok", "rejected", "ok"]);
    expect(d.codeVersions[1].statusLine).toContain("[ERROR] Python syntax error");
    expect(d.codeVersions[0].summary).toBe("From `sales`, sum `amount` by `region`");
  });

  test("result versions: code↔result correspondence via earned-at events", () => {
    // by_region earned an error result at event 4 (create) and event 6 (modify).
    // The rejected edit at event 5 earned nothing (its snapshot only inherits).
    const d = dossier.operators.get("by_region")!;
    expect(d.resultVersions.map(v => v.eventIndex)).toEqual([4, 6]);
    expect(d.resultVersions[0].info.error).toContain("KeyError");
    expect(d.resultVersions[1].info.error).toContain("KeyError");
  });

  test("init baseline results land as version 0", () => {
    const legacy = dossier.operators.get("legacy_data")!;
    expect(legacy.resultVersions.map(v => v.eventIndex)).toEqual([0]);
    expect(legacy.resultVersions[0].info.totalRowCount).toBe(5);
    expect(legacy.codeVersions).toHaveLength(0); // never edited by the agent
    expect(legacy.currentPredicate?.operatorType).toBe("CSVFileScan");
  });

  test("deleted operator: inspect_sales flagged deleted, no current predicate, history retained", () => {
    const d = dossier.operators.get("inspect_sales")!;
    expect(d.deleted).toBe(true);
    expect(d.currentPredicate).toBeUndefined();
    expect(d.codeVersions.map(v => v.eventIndex)).toEqual([2]);
    expect(d.resultVersions.map(v => v.eventIndex)).toEqual([2]); // its 30-row inspect result
  });

  test("blocked operator: report has a code version but no result versions", () => {
    const d = dossier.operators.get("report")!;
    expect(d.codeVersions.map(v => v.eventIndex)).toEqual([6]);
    expect(d.resultVersions).toHaveLength(0);
    expect(d.currentPredicate).toBeDefined();
  });

  test("leaf snapshot is a5's workflow", () => {
    const ids = dossier.leafSnapshot.workflow.operators.map(o => o.operatorID).sort();
    expect(ids).toEqual(["by_region", "legacy_data", "orphan_load", "report", "sales"]);
  });

  test("multiple results across events: sales earns at event 3 only (unchanged after)", () => {
    const d = dossier.operators.get("sales")!;
    expect(d.resultVersions.map(v => v.eventIndex)).toEqual([3]);
    expect(d.resultVersions[0].info.totalRowCount).toBe(1000);
  });

  test("empty path: dossier resolves to the storage's empty root", () => {
    const { storage: s2 } = buildRichScenario();
    const d2 = buildDossier([], s2);
    expect(d2.operators.size).toBe(0);
    expect(d2.leafSnapshot.workflow.operators).toHaveLength(0);
  });
});
