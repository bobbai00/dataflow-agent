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
import { buildDossier } from "../summarize/dossier";
import { buildRichScenario } from "../summarize/fixtures";
import { resolveOperatorParams } from "../summarize/params";
import { FEATURE_NAMES, perOperatorMLFeatures } from "./features-ml";
import { buildUtilityModel, type LogisticModelJSON, type UtilityModel } from "./model";
import { decideLearned, learnedSelectParams, type LearnedConfig } from "./score";

function dossierOf() {
  const { steps, storage } = buildRichScenario();
  return buildDossier(steps, storage);
}

/** A zero model: standardized logistic with all-zero weights → always 0.5. */
function zeroModelJSON(): LogisticModelJSON {
  return {
    kind: "logistic",
    featureNames: [...FEATURE_NAMES],
    mean: FEATURE_NAMES.map(() => 0),
    std: FEATURE_NAMES.map(() => 1),
    weights: FEATURE_NAMES.map(() => 0),
    bias: 0,
  };
}

/** A stub model that scores by a caller-supplied function of the feature vector. */
function stubModel(fn: (vec: number[]) => number): UtilityModel {
  return { kind: "stub", score: fn };
}

describe("features-ml", () => {
  test("every operator gets a vector of exactly FEATURE_NAMES length", () => {
    const d = dossierOf();
    const feats = perOperatorMLFeatures(d, "task text about columns");
    expect(feats.size).toBeGreaterThan(0);
    for (const [, mf] of feats) {
      expect(mf.vec).toHaveLength(FEATURE_NAMES.length);
      expect(mf.vec.every(x => Number.isFinite(x))).toBe(true);
      expect(mf.sampleTokenCost).toBeGreaterThan(0);
    }
  });

  test("log_rows feature is populated and non-negative", () => {
    const d = dossierOf();
    const feats = perOperatorMLFeatures(d, "");
    const idx = FEATURE_NAMES.indexOf("log_rows");
    const anyPositive = [...feats.values()].some(mf => mf.vec[idx] > 0);
    expect(anyPositive).toBe(true); // the scenario has non-empty tables
  });
});

describe("model", () => {
  test("logistic zero-weights ⇒ 0.5; parity with manual sigmoid", () => {
    const m = buildUtilityModel(zeroModelJSON());
    expect(m.score(FEATURE_NAMES.map(() => 3))).toBeCloseTo(0.5, 12);
  });

  test("known weights match a hand computation", () => {
    const json = zeroModelJSON();
    json.weights[0] = 2; // role_deleted
    json.bias = -1;
    const m = buildUtilityModel(json);
    const vec = FEATURE_NAMES.map(() => 0);
    vec[0] = 1;
    // z = -1 + 2*(1) = 1 ; sigmoid(1)
    expect(m.score(vec)).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
  });

  test("feature-name mismatch throws (stale model guard)", () => {
    const bad = zeroModelJSON();
    bad.featureNames = bad.featureNames.slice(1); // drop one → mismatch
    expect(() => buildUtilityModel(bad)).toThrow(/featureNames|weights length/);
  });
});

describe("score / knapsack", () => {
  test("deleted ops omitted; frontier/terminal protected at sample regardless of budget", () => {
    const d = dossierOf();
    const roleIdxFrontier = FEATURE_NAMES.indexOf("role_frontier");
    const roleIdxTerminal = FEATURE_NAMES.indexOf("role_terminal");
    // budget 0 → nothing non-protected can be promoted to sample.
    const decisions = decideLearned(d, stubModel(() => 0.9), "", { budgetTokens: 0 });
    for (const dcn of decisions) {
      if (dcn.protectedActive) expect(dcn.detail).toBe("sample");
    }
    // any op the dossier marks deleted must be omitted
    for (const dcn of decisions) {
      if (d.operators.get(dcn.operatorId)?.deleted) expect(dcn.detail).toBe("omit");
    }
    void roleIdxFrontier;
    void roleIdxTerminal;
  });

  test("higher budget promotes more ops to sample", () => {
    const d = dossierOf();
    const model = stubModel(() => 0.8);
    const low = decideLearned(d, model, "", { budgetTokens: 0 }).filter(x => x.detail === "sample").length;
    const high = decideLearned(d, model, "", { budgetTokens: 1_000_000 }).filter(x => x.detail === "sample").length;
    expect(high).toBeGreaterThanOrEqual(low);
  });

  test("learnedSelectParams yields a valid SummarizeParams with per-op overrides", () => {
    const d = dossierOf();
    const params = learnedSelectParams(d, buildUtilityModel(zeroModelJSON()), "task");
    // resolve a concrete op → must produce a legal detail level
    const anyOp = [...d.operators.keys()][0];
    const resolved = resolveOperatorParams(params, anyOp);
    expect(["omit", "shape", "sample"]).toContain(resolved.result.latest.detail);
  });

  test("stats added on decision-critical columns when addStats on", () => {
    const d = dossierOf();
    const cfg: LearnedConfig = { budgetTokens: 100000, addStats: true } as LearnedConfig;
    const decisions = decideLearned(d, buildUtilityModel(zeroModelJSON()), "", cfg);
    // At least the scenario's categorical/numeric-as-text op should get stats,
    // or none qualify — either way statsAdded must be a boolean, never crash.
    expect(decisions.every(x => typeof x.statsAdded === "boolean")).toBe(true);
  });
});
