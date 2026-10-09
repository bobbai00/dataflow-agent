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
import { AgentMode, ContextMode } from "../../../types/agent";
import { buildDossier } from "../summarize/dossier";
import { applySummarizeParamsPatch, mapLegacyToParams, resolveOperatorParams } from "../summarize/params";
import { buildScenario, makeInfo, makeWorkflow } from "../summarize/fixtures";
import { extractFeatures } from "./features";
import { applyRolePolicy, parseRolePolicyConfig } from "./role-policy";

/** src (DataLoading) -> clean -> agg -> answer. The 4-op chain is deliberate:
 *  it settles `clean` into the "interior" role, so the lean side of the policy
 *  is actually exercised (a 3-op chain only yields source/near-frontier/frontier). */
function chainDossier() {
  const ops = ["src", "clean", "agg", "answer"];
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    ...ops.map((operatorId, i) => ({
      id: `a${i + 1}`,
      stepId: i + 1,
      role: "agent" as const,
      messageId: "m",
      parentId: i === 0 ? "u" : `a${i}`,
      content: operatorId,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: `t${i}`, input: { operatorId } }],
      toolResults: [{ toolCallId: `t${i}`, output: "ok", isError: false }],
    })),
  ]);
  const rows = [100, 40, 10, 1];
  for (let i = 0; i < ops.length; i++) {
    const present = ops.slice(0, i + 1);
    scenario.storage.createSnapshot(
      `a${i + 1}`,
      makeWorkflow(
        present.map((id, j) =>
          j === 0 ? { id, type: "DataLoading" } : { id, type: "DataProcessing", numInputPorts: 1 }
        ),
        present.slice(1).map((id, j) => [present[j], id] as [string, string])
      )
    );
    scenario.storage.setOperatorResult(`a${i + 1}`, ops[i], makeInfo(rows[i]));
  }
  return buildDossier(scenario.steps, scenario.storage);
}

function latestBase() {
  return mapLegacyToParams(ContextMode.LATEST, {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    schemaInResult: true,
  });
}

describe("role policy (Rule A: rich source / lean interior)", () => {
  test("spends the render budget on sources and trims the interior", () => {
    const dossier = chainDossier();
    const config = parseRolePolicyConfig({ sourceSampleRows: 12, interiorSampleRows: 3 });
    const out = applyRolePolicy(latestBase(), dossier, config);

    const roles = new Map([...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f.role]));
    // The fixture must exercise BOTH sides of the policy — assert, don't assume.
    expect(roles.get("src")).toBe("source");
    const leanIds = [...roles].filter(([, r]) => r === "interior" || r === "terminal").map(([id]) => id);
    expect(leanIds.length).toBeGreaterThan(0);

    const src = resolveOperatorParams(out, "src");
    expect(src.result.latest.detail).toBe("sample");
    expect(src.result.latest.tuple.sampleRows).toBe(12);
    expect(Object.hasOwn(src.result.latest.column ?? {}, "stats")).toBe(false);
    expect(Object.hasOwn(src.result.latest.column ?? {}, "structuralHints")).toBe(false);

    // Any non-source, non-frontier operator is rendered lean.
    for (const [opId, role] of roles) {
      if (role === "interior" || role === "terminal") {
        const lean = resolveOperatorParams(out, opId);
        expect(lean.result.latest.tuple.sampleRows).toBe(3);
        expect(Object.hasOwn(lean.result.latest.column ?? {}, "stats")).toBe(false);
      }
    }
  });

  test("source rows exceed interior rows (the asymmetry is the rule)", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({}));
    const src = resolveOperatorParams(out, "src").result.latest.tuple.sampleRows;
    const roles = new Map([...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f.role]));
    for (const [opId, role] of roles) {
      if (role === "interior" || role === "terminal") {
        expect(src).toBeGreaterThan(resolveOperatorParams(out, opId).result.latest.tuple.sampleRows);
      }
    }
  });

  test("no-op on an interleaved (DELTA) trajectory — per-op policy cannot bind", () => {
    const dossier = chainDossier();
    const deltaBase = mapLegacyToParams(ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      schemaInResult: true,
    });
    expect(applyRolePolicy(deltaBase, dossier, parseRolePolicyConfig({}))).toBe(deltaBase);
  });

  test("interiorSampleRows=0 renders the interior as shape only", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({ interiorSampleRows: 0 }));
    const roles = new Map([...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f.role]));
    for (const [opId, role] of roles) {
      if (role === "interior" || role === "terminal") {
        expect(resolveOperatorParams(out, opId).result.latest.detail).toBe("shape");
      }
    }
  });

  test("REGRESSION: a source feeding the frontier still gets the rich treatment", () => {
    // Short 2-op pipeline (load -> answer): features.ts labels the load
    // "near-frontier" (role priority), NOT "source". An earlier role-keyed
    // version was therefore a silent no-op on exactly this shape, which is the
    // common case on this benchmark. Classify structurally via isSource.
    const scenario = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "load",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        messageId: "m",
        parentId: "a1",
        content: "answer",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "answer" } }],
        toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "src", type: "DataLoading" }]));
    scenario.storage.setOperatorResult("a1", "src", makeInfo(100));
    scenario.storage.createSnapshot(
      "a2",
      makeWorkflow(
        [
          { id: "src", type: "DataLoading" },
          { id: "answer", type: "DataProcessing", numInputPorts: 1 },
        ],
        [["src", "answer"]]
      )
    );
    scenario.storage.setOperatorResult("a2", "answer", makeInfo(1));
    const dossier = buildDossier(scenario.steps, scenario.storage);

    const feats = extractFeatures(dossier).operators;
    // Precondition: the load is NOT labelled "source" here — that is the trap.
    expect(feats.get("src")!.role).not.toBe("source");
    expect(feats.get("src")!.isSource).toBe(true);

    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({ sourceSampleRows: 12 }));
    const src = resolveOperatorParams(out, "src");
    expect(src.result.latest.tuple.sampleRows).toBe(12);
    expect(Object.hasOwn(src.result.latest.column ?? {}, "stats")).toBe(false);
  });
});

describe("applyRolePolicy — char-budget mode (C9/C10)", () => {
  const cfg = { sourceMaxChars: 5000, nonSourceMaxChars: 1000 };

  test("sources get the rich budget + stats; every non-source gets the lean budget + no stats", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig(cfg));
    const roles = new Map([...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f]));
    for (const [id, f] of roles) {
      const o = out.operators.overrides[id];
      expect(o).toBeDefined();
      if (f.isSource) {
        expect(o?.result?.latest?.tuple?.maxChars).toBe(5000);
        expect(Object.hasOwn(o?.result?.latest?.column ?? {}, "stats")).toBe(false);
      } else {
        expect(o?.result?.latest?.tuple?.maxChars).toBe(1000);
        expect(Object.hasOwn(o?.result?.latest?.column ?? {}, "stats")).toBe(false);
      }
    }
  });

  test("covers frontier/near-frontier too — every operator is assigned a budget", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig(cfg));
    const all = [...extractFeatures(dossier).operators.values()].map(f => f.operatorId).sort();
    expect(Object.keys(out.operators.overrides).sort()).toEqual(all);
  });

  test("both budgets 0 ⇒ mode inert, the rows/stats legs govern", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(
      latestBase(),
      dossier,
      parseRolePolicyConfig({ sourceSampleRows: 12, interiorSampleRows: 3 })
    );
    const src = out.operators.overrides["src"];
    expect(src?.result?.latest?.tuple?.maxChars).toBeUndefined();
    expect(src?.result?.latest?.tuple?.sampleRows).toBe(12);
  });
});

describe("applyRolePolicy — char-budget mode binds on DELTA", () => {
  test("an interleaved trajectory still receives per-operator budgets", () => {
    const dossier = chainDossier();
    const deltaBase = mapLegacyToParams(ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      schemaInResult: true,
    });
    // the rows/stats legs must still no-op on DELTA...
    const rowsLeg = applyRolePolicy(deltaBase, dossier, parseRolePolicyConfig({ sourceSampleRows: 12 }));
    expect(Object.keys(rowsLeg.operators.overrides)).toHaveLength(0);
    // ...while the char-budget leg binds
    const charLeg = applyRolePolicy(
      deltaBase,
      dossier,
      parseRolePolicyConfig({ sourceMaxChars: 5000, nonSourceMaxChars: 1000 })
    );
    expect(Object.keys(charLeg.operators.overrides).length).toBeGreaterThan(0);
    expect(charLeg.operators.overrides["src"]?.result?.latest?.tuple?.maxChars).toBe(5000);
  });
});

/** `latestBase()` leaves `property.includeCode` at its `false` default; the real
 *  code-on path is server.ts setting `defaults.property.includeCode = true` when
 *  `enableCodeInSnapshot` is set. The code leg only ever SUBTRACTS code (it must
 *  never force code on over a code-off arm), so its tests need that base. */
function codeOnBase() {
  return applySummarizeParamsPatch(latestBase(), {
    operators: { defaults: { property: { includeCode: true } } },
  });
}

describe("role policy — CODE budget leg (P-series)", () => {
  /** `Code:` blocks are 27-39% of the rendered dataflow and no other knob touches
   *  them; 73.4% of those bytes sit on operators the agent has already settled. */
  test("settled operators lose their Code: block, the working set keeps it", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(
      codeOnBase(),
      dossier,
      parseRolePolicyConfig({ codeBudget: true, codeKeepSources: false })
    );
    const feats = [...extractFeatures(dossier).operators.values()];
    const roles = new Map(feats.map(f => [f.operatorId, f.role]));

    // The fixture must actually contain both sides, or this test proves nothing.
    expect([...roles.values()]).toContain("interior");
    expect([...roles.values()]).toContain("frontier");

    for (const [opId, role] of roles) {
      const got = resolveOperatorParams(out, opId).property.includeCode;
      const shouldKeep = role === "frontier" || role === "near-frontier";
      expect(got).toBe(shouldKeep);
    }
  });

  test("codeKeepSources retains load code even when the source is settled", () => {
    const dossier = chainDossier();
    const feats = [...extractFeatures(dossier).operators.values()];
    const srcIds = feats.filter(f => f.isSource).map(f => f.operatorId);
    expect(srcIds.length).toBeGreaterThan(0);

    const kept = applyRolePolicy(
      codeOnBase(),
      dossier,
      parseRolePolicyConfig({ codeBudget: true, codeKeepSources: true })
    );
    const dropped = applyRolePolicy(
      codeOnBase(),
      dossier,
      parseRolePolicyConfig({ codeBudget: true, codeKeepSources: false })
    );
    for (const id of srcIds) {
      expect(resolveOperatorParams(kept, id).property.includeCode).toBe(true);
      // only meaningful for a source that is not also in the working set
      const role = feats.find(f => f.operatorId === id)!.role;
      if (role !== "frontier" && role !== "near-frontier") {
        expect(resolveOperatorParams(dropped, id).property.includeCode).toBe(false);
      }
    }
  });

  /** Exclusivity is the whole point: an arm that claims to isolate code must not
   *  quietly also be a rows+stats arm, since those legs' defaults are not neutral
   *  (sourceSampleRows 12, sourceStats true). */
  test("the code leg is EXCLUSIVE — it emits no rows/stats overrides", () => {
    const dossier = chainDossier();
    const base = codeOnBase();
    const out = applyRolePolicy(
      base,
      dossier,
      parseRolePolicyConfig({ codeBudget: true, sourceSampleRows: 12, interiorSampleRows: 3 })
    );
    for (const f of extractFeatures(dossier).operators.values()) {
      const before = resolveOperatorParams(base, f.operatorId);
      const after = resolveOperatorParams(out, f.operatorId);
      expect(after.result.latest.tuple.sampleRows).toBe(before.result.latest.tuple.sampleRows);
      expect(Object.hasOwn(after.result.latest.column ?? {}, "stats")).toBe(false);
      expect(after.result.latest.detail).toBe(before.result.latest.detail);
    }
  });

  test("codeBudget off changes nothing about includeCode", () => {
    const dossier = chainDossier();
    const base = codeOnBase();
    const out = applyRolePolicy(base, dossier, parseRolePolicyConfig({ codeBudget: false }));
    for (const f of extractFeatures(dossier).operators.values()) {
      expect(resolveOperatorParams(out, f.operatorId).property.includeCode).toBe(
        resolveOperatorParams(base, f.operatorId).property.includeCode
      );
    }
  });
});
