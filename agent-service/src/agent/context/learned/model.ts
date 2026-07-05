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

/**
 * The learned utility model, served in TypeScript. The Python trainer
 * (training/ml/train.py) exports a JSON that this module evaluates. v1 is a
 * standardized logistic regression (linear headline per the action plan: "start
 * GBDT + logistic baseline; feature sufficiency, not capacity, is the
 * contribution"). A GBDT export slots in behind the same `UtilityModel`
 * interface later without touching callers.
 *
 * The feature-name list in the export MUST equal FEATURE_NAMES (features-ml.ts);
 * loadUtilityModel throws on mismatch so a stale model can never be scored
 * against a shifted feature vector.
 */

import { FEATURE_NAMES } from "./features-ml";

export interface LogisticModelJSON {
  kind: "logistic";
  featureNames: string[];
  /** Standardization (z-score) applied before the linear term. */
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  /** Optional metadata for provenance / audit. */
  meta?: Record<string, unknown>;
}

export type ModelJSON = LogisticModelJSON;

export interface UtilityModel {
  /** P(load-bearing) ∈ [0,1] for one feature vector (FEATURE_NAMES order). */
  score(vec: number[]): number;
  readonly kind: string;
  readonly meta?: Record<string, unknown>;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

class LogisticModel implements UtilityModel {
  readonly kind = "logistic";
  readonly meta?: Record<string, unknown>;
  constructor(private m: LogisticModelJSON) {
    this.meta = m.meta;
  }
  score(vec: number[]): number {
    const { mean, std, weights, bias } = this.m;
    let z = bias;
    for (let i = 0; i < weights.length; i++) {
      const s = std[i] === 0 ? 1 : std[i];
      z += weights[i] * ((vec[i] - mean[i]) / s);
    }
    return sigmoid(z);
  }
}

/** Validate feature-name parity and build an evaluator. Throws on mismatch. */
export function buildUtilityModel(json: ModelJSON): UtilityModel {
  if (!json || json.kind !== "logistic") {
    throw new Error(`unsupported model kind: ${(json as any)?.kind}`);
  }
  const got = json.featureNames;
  if (got.length !== FEATURE_NAMES.length || got.some((n, i) => n !== FEATURE_NAMES[i])) {
    throw new Error(
      `model featureNames mismatch: model has ${got.length} names, code expects ${FEATURE_NAMES.length}; ` +
        `first divergence at index ${got.findIndex((n, i) => n !== FEATURE_NAMES[i])}`
    );
  }
  if (json.weights.length !== FEATURE_NAMES.length) {
    throw new Error(`weights length ${json.weights.length} != features ${FEATURE_NAMES.length}`);
  }
  return new LogisticModel(json);
}

/** Parse + build from a JSON string (e.g. a bundled model.json). */
export function loadUtilityModelFromString(s: string): UtilityModel {
  return buildUtilityModel(JSON.parse(s) as ModelJSON);
}
