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
 * The compact pipeline MANIFEST sent to the context tuner.
 *
 * It is deliberately cheap — a one-line-per-operator digest of the SAME
 * features the rule selector uses (role, edit/error state, result shape,
 * data-shape flags) plus each operator's summary and its upstreams. It never
 * includes raw result tables (that would cost as much as the context we are
 * trying to shrink). The tuner reasons over this digest, not the data.
 */

import type { Dossier } from "../summarize/dossier";
import { extractFeatures, type SelectorFeatures } from "../selector/features";

export interface TunerManifest {
  text: string;
  /** Operator ids present in the leaf snapshot, in manifest order — the exact
   *  set the tuner must return decisions for. */
  operatorIds: string[];
  features: SelectorFeatures;
}

/**
 * Build the manifest from the dossier + the task text. Uses the leaf snapshot's
 * operator order (roughly construction order) so the tuner reads the pipeline
 * front-to-back.
 */
export function buildTunerManifest(dossier: Dossier, taskText: string): TunerManifest {
  const features = extractFeatures(dossier);
  const wf = dossier.leafSnapshot.workflow;

  // upstream ids per operator (for the "feeds / fed-by" relevance judgement).
  const parents = new Map<string, string[]>();
  for (const link of wf.links) {
    const arr = parents.get(link.target.operatorID) ?? [];
    arr.push(link.source.operatorID);
    parents.set(link.target.operatorID, arr);
  }

  const operatorIds: string[] = [];
  const lines: string[] = [];
  for (const op of wf.operators) {
    const id = op.operatorID;
    operatorIds.push(id);
    const f = features.operators.get(id);
    const info = dossier.operators.get(id)?.resultVersions.at(-1)?.info;
    const rows = info?.totalRowCount ?? info?.outputTuples;
    const shape = f && f.columns > 0 && typeof rows === "number" ? `${rows}×${f.columns}` : info?.error ? "ERROR" : "—";
    const flags: string[] = [];
    if (f?.dirtyLoad) flags.push("dirty-load");
    if (f?.categoricalLowCard) flags.push("categorical");
    if (f?.numericAsText) flags.push("numeric-as-text");
    if (f?.wide) flags.push("wide");
    const ups = parents.get(id) ?? [];
    const state = [
      f?.role ?? "?",
      f && f.editCount > 0 ? `${f.editCount} edit${f.editCount === 1 ? "" : "s"}` : undefined,
      info?.error ? "ERRORING" : f?.hasResult ? "ok" : "no-result",
      f?.hasHealthyConsumer ? "consumed" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `- \`${id}\` (${op.operatorType}) [${state}] result=${shape}${flags.length ? ` flags=${flags.join("/")}` : ""}` +
        (ups.length ? ` <- ${ups.map(u => `\`${u}\``).join(", ")}` : "") +
        `\n    summary: ${op.customDisplayName || id}`
    );
  }

  const text = [
    "# Task the agent is solving",
    "",
    taskText.trim() || "(no task text available)",
    "",
    "# Current pipeline (operators in build order)",
    "",
    lines.length ? lines.join("\n") : "(no operators yet)",
    "",
    "# Instruction",
    "",
    `Return a detail level ("omit" | "shape" | "sample" | "rich") for EACH of these ${operatorIds.length} operator id(s): ${operatorIds.map(i => `\`${i}\``).join(", ")}. ` +
      "Also return reasoningReplayK (0-20): how many recent reasoning steps to replay to the agent. Keep the total lean; escalate only where the next step or the answer needs it.",
  ].join("\n");

  return { text, operatorIds, features };
}
