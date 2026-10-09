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

import { z } from "zod";
import type { Dossier } from "../summarize/dossier";
import {
  applySummarizeParamsPatch,
  resolveOperatorParams,
  type OperatorParamsOverride,
  type SummarizeParams,
} from "../summarize/params";
import { extractFeatures } from "./features";

/**
 * Conservative overlay for a legacy context preset. Unlike selectParams(),
 * this preserves the baseline mode, decorations, and active-operator detail;
 * it only trims stable, consumed operators outside the active frontier.
 */
export const FrontierDecayConfigSchema = z.object({
  /** First+last row budget retained on a decayed result. */
  sampleRows: z.number().int().min(1).default(3),
  /** Grace period after the operator's latest edit. */
  minStepsSinceEdit: z.number().int().min(0).default(1),
  /** Grace period after its sole consumer's latest edit. */
  minConsumerStepsSinceEdit: z.number().int().min(0).default(1),
  /** Require a healthy consumer result from an earlier event. */
  minConsumerStepsSinceHealthy: z.number().int().min(1).default(1),
});

export type FrontierDecayConfig = z.infer<typeof FrontierDecayConfigSchema>;

export function parseFrontierDecayConfig(raw: unknown): FrontierDecayConfig {
  return FrontierDecayConfigSchema.parse(raw ?? {});
}

export function applyFrontierDecay(
  base: SummarizeParams,
  dossier: Dossier,
  config: FrontierDecayConfig
): SummarizeParams {
  if (base.trajectory.events !== "none" || !base.currentSnapshot) return base;

  const features = extractFeatures(dossier);
  const overrides: Record<string, OperatorParamsOverride> = {};
  const operatorIds = new Set(dossier.leafSnapshot.workflow.operators.map(operator => operator.operatorID));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const operatorId of operatorIds) children.set(operatorId, []);
  for (const operatorId of operatorIds) parents.set(operatorId, []);
  for (const link of dossier.leafSnapshot.workflow.links) {
    const sourceId = link.source.operatorID;
    const targetId = link.target.operatorID;
    if (operatorIds.has(sourceId) && operatorIds.has(targetId)) {
      children.get(sourceId)!.push(targetId);
      parents.get(targetId)!.push(sourceId);
    }
  }

  const latestEditEvent = (operatorId: string): number => {
    const operator = dossier.operators.get(operatorId);
    return operator ? Math.max(0, ...operator.codeVersions.map(version => version.eventIndex)) : 0;
  };

  const latestFrontierEdit = Math.max(0, ...[...operatorIds].map(latestEditEvent));
  const frontier = new Set<string>();
  for (const operatorId of operatorIds) {
    const currentInfo = dossier.leafSnapshot.results.get(operatorId)?.info;
    if (latestEditEvent(operatorId) === latestFrontierEdit || currentInfo?.error) frontier.add(operatorId);
  }
  const nearFrontier = new Set<string>();
  for (const operatorId of frontier) {
    for (const parentId of parents.get(operatorId) ?? []) nearFrontier.add(parentId);
  }

  for (const [operatorId, feature] of features.operators) {
    const active = frontier.has(operatorId) || nearFrontier.has(operatorId);
    const protectedResult = feature.role === "terminal" || feature.role === "blocked" || feature.role === "deleted";
    const stable = feature.stepsSinceEdit >= config.minStepsSinceEdit;
    const consumers = children.get(operatorId) ?? [];
    const soleConsumer = consumers.length === 1 ? consumers[0] : undefined;
    const currentInfo = dossier.leafSnapshot.results.get(operatorId)?.info;
    const currentConsumerInfo = soleConsumer ? dossier.leafSnapshot.results.get(soleConsumer)?.info : undefined;
    const consumerStable =
      soleConsumer !== undefined &&
      features.trajectory.currentEventIndex - latestEditEvent(soleConsumer) >= config.minConsumerStepsSinceEdit;
    const consumerHealthyBeforeCurrent =
      soleConsumer !== undefined &&
      (dossier.operators.get(soleConsumer)?.resultVersions ?? []).some(
        version =>
          !version.info.error &&
          version.eventIndex >= Math.max(latestEditEvent(operatorId), latestEditEvent(soleConsumer)) &&
          version.eventIndex <= features.trajectory.currentEventIndex - config.minConsumerStepsSinceHealthy
      );
    const baseOperator = resolveOperatorParams(base, operatorId);

    if (
      active ||
      protectedResult ||
      !currentInfo ||
      !!currentInfo.error ||
      feature.dirtyLoad ||
      consumers.length !== 1 ||
      !currentConsumerInfo ||
      !!currentConsumerInfo.error ||
      !consumerStable ||
      !consumerHealthyBeforeCurrent ||
      baseOperator.result.latest.detail !== "sample" ||
      !stable
    ) {
      continue;
    }

    const baseRows = baseOperator.result.latest.tuple.sampleRows;
    const sampleRows = baseRows > 0 ? Math.min(baseRows, config.sampleRows) : config.sampleRows;
    if (sampleRows === baseRows) continue;

    overrides[operatorId] = {
      result: {
        latest: {
          tuple: { sampleRows },
          column: {},
        },
      },
    };
  }

  return applySummarizeParamsPatch(base, { operators: { overrides } });
}
