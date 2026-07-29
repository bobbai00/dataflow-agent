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
import { mapLegacyToParams, resolveOperatorParams } from "../summarize/params";
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
        present.map((id, j) => (j === 0 ? { id, type: "DataLoading" } : { id, type: "DataProcessing", numInputPorts: 1 })),
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
    columnStats: true,
  });
}

describe("role policy (Rule A: rich source / lean interior)", () => {
  test("spends the render budget on sources and trims the interior", () => {
    const dossier = chainDossier();
    const config = parseRolePolicyConfig({ sourceSampleRows: 12, interiorSampleRows: 3 });
    const out = applyRolePolicy(latestBase(), dossier, config);

    const roles = new Map(
      [...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f.role])
    );
    // The fixture must exercise BOTH sides of the policy — assert, don't assume.
    expect(roles.get("src")).toBe("source");
    const leanIds = [...roles].filter(([, r]) => r === "interior" || r === "terminal").map(([id]) => id);
    expect(leanIds.length).toBeGreaterThan(0);

    const src = resolveOperatorParams(out, "src");
    expect(src.result.latest.detail).toBe("sample");
    expect(src.result.latest.tuple.sampleRows).toBe(12);
    expect(src.result.latest.column.stats).toBe(true);
    expect(src.result.latest.column.structuralHints).toBe(true);

    // Any non-source, non-frontier operator is rendered lean.
    for (const [opId, role] of roles) {
      if (role === "interior" || role === "terminal") {
        const lean = resolveOperatorParams(out, opId);
        expect(lean.result.latest.tuple.sampleRows).toBe(3);
        expect(lean.result.latest.column.stats).toBe(false);
      }
    }
  });

  test("source rows exceed interior rows (the asymmetry is the rule)", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({}));
    const src = resolveOperatorParams(out, "src").result.latest.tuple.sampleRows;
    const roles = new Map(
      [...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f.role])
    );
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
      columnStats: true,
    });
    expect(applyRolePolicy(deltaBase, dossier, parseRolePolicyConfig({}))).toBe(deltaBase);
  });

  test("interiorSampleRows=0 renders the interior as shape only", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({ interiorSampleRows: 0 }));
    const roles = new Map(
      [...extractFeatures(dossier).operators.values()].map(f => [f.operatorId, f.role])
    );
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
        id: "a1", stepId: 1, role: "agent", messageId: "m", parentId: "u", content: "load",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2", stepId: 2, role: "agent", messageId: "m", parentId: "a1", content: "answer",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "answer" } }],
        toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "src", type: "DataLoading" }]));
    scenario.storage.setOperatorResult("a1", "src", makeInfo(100));
    scenario.storage.createSnapshot("a2", makeWorkflow(
      [{ id: "src", type: "DataLoading" }, { id: "answer", type: "DataProcessing", numInputPorts: 1 }],
      [["src", "answer"]]
    ));
    scenario.storage.setOperatorResult("a2", "answer", makeInfo(1));
    const dossier = buildDossier(scenario.steps, scenario.storage);

    const feats = extractFeatures(dossier).operators;
    // Precondition: the load is NOT labelled "source" here — that is the trap.
    expect(feats.get("src")!.role).not.toBe("source");
    expect(feats.get("src")!.isSource).toBe(true);

    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({ sourceSampleRows: 12 }));
    const src = resolveOperatorParams(out, "src");
    expect(src.result.latest.tuple.sampleRows).toBe(12);
    expect(src.result.latest.column.stats).toBe(true);
  });
});

describe("applyRolePolicy — sourceStatsDensity", () => {
  test("default keeps full density on sources (existing arms unchanged)", () => {
    const out = applyRolePolicy(latestBase(), chainDossier(), parseRolePolicyConfig({}));
    const src = out.operators.overrides["src"];
    expect(src?.result?.latest?.column?.stats).toBe(true);
    expect(src?.result?.latest?.column?.statsDensity).toBe("full");
  });

  test("anomaly density propagates into the source override", () => {
    const out = applyRolePolicy(latestBase(), chainDossier(), parseRolePolicyConfig({ sourceStatsDensity: "anomaly" }));
    expect(out.operators.overrides["src"]?.result?.latest?.column?.statsDensity).toBe("anomaly");
  });

  test("stats can be switched off entirely (the A3 arm)", () => {
    const out = applyRolePolicy(latestBase(), chainDossier(), parseRolePolicyConfig({ sourceStats: false }));
    expect(out.operators.overrides["src"]?.result?.latest?.column?.stats).toBe(false);
  });
});

describe("applyRolePolicy — hintsOnly isolation (A6)", () => {
  test("emits ONLY structuralHints on sources; no rows, no stats, no interior trim", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({ hintsOnly: true }));
    const src = out.operators.overrides["src"];
    expect(src?.result?.latest?.column?.structuralHints).toBe(true);
    // every other dimension must be absent so the base preset governs it
    expect(src?.result?.latest?.detail).toBeUndefined();
    expect(src?.result?.latest?.tuple).toBeUndefined();
    expect(src?.result?.latest?.column?.stats).toBeUndefined();
  });

  test("hintsOnly touches sources exclusively — interior/terminal get no override", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(latestBase(), dossier, parseRolePolicyConfig({ hintsOnly: true }));
    expect(Object.keys(out.operators.overrides)).toEqual(["src"]);
  });

  test("hintsOnly ignores the rows/stats knobs even when they are set", () => {
    const dossier = chainDossier();
    const out = applyRolePolicy(
      latestBase(),
      dossier,
      parseRolePolicyConfig({ hintsOnly: true, sourceSampleRows: 12, sourceStats: true, interiorSampleRows: 3 })
    );
    const src = out.operators.overrides["src"];
    expect(src?.result?.latest?.tuple).toBeUndefined();
    expect(src?.result?.latest?.column?.stats).toBeUndefined();
    expect(Object.keys(out.operators.overrides)).toEqual(["src"]);
  });
});
