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
 * SELECT stage — fold resolved operator revisions (the rank-3 static rule from
 * the Delta-vs-Latest cost audit).
 *
 * DELTA's interleaved trajectory carries every superseded revision of every
 * operator verbatim: the old `code:` block inside the submitting event's
 * Action, and the old result/error payload inside that event's Observation.
 * Once a LATER revision of the same operator has (a) executed successfully,
 * (b) been consumed by its sole consumer with a healthy result, and (c) a
 * grace period has elapsed, those prior payloads are decision-dead — the
 * agent itself rejected and replaced them. This module computes, per rendered
 * event, a one-line RESOLUTION FACT that replaces each such payload (the
 * anti-thrash record: what failed stays named, its bytes do not).
 *
 * The predicate is a function of HISTORICAL facts only (submission / execution
 * / consumption event indices), so a fold LATCHES: once an old revision folds
 * it stays folded on every later render — re-opening the operator supersedes
 * more history, it never un-folds settled history (prefix-cache friendly).
 * The current revision (and everything the trajectory shows about it) always
 * renders raw.
 */

import { z } from "zod";
import type { Dossier, OperatorDossier } from "../summarize/dossier";

export const FoldResolvedRevisionsConfigSchema = z.object({
  /** Events that must elapse after the resolution (later revision executed +
   *  consumed healthily) before prior revisions fold. */
  graceEvents: z.number().int().min(0).default(1),
});

export type FoldResolvedRevisionsConfig = z.infer<typeof FoldResolvedRevisionsConfigSchema>;

export function parseFoldResolvedRevisionsConfig(raw: unknown): FoldResolvedRevisionsConfig {
  return FoldResolvedRevisionsConfigSchema.parse(raw ?? {});
}

/** Per-event, per-operator fold facts consumed by the DELTA renderers.
 *  `actions` replaces the Action's `code:` block of a superseded submission;
 *  `observations` replaces the Observation's result body earned under a
 *  superseded revision. Keys: eventIndex → operatorId → fact line. */
export interface RevisionFolds {
  actions: Map<number, Map<string, string>>;
  observations: Map<number, Map<string, string>>;
}

/** True when the fold maps carry no entries (renderers can skip lookups). */
export function hasNoFolds(folds: RevisionFolds): boolean {
  return folds.actions.size === 0 && folds.observations.size === 0;
}

function firstLine(text: string, cap = 160): string {
  const line = text.split("\n")[0].replace(/\s+/g, " ").trim();
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

function set(map: Map<number, Map<string, string>>, eventIndex: number, opId: string, fact: string): void {
  let byOp = map.get(eventIndex);
  if (!byOp) {
    byOp = new Map();
    map.set(eventIndex, byOp);
  }
  byOp.set(opId, fact);
}

/** The op's sole consumer in the leaf DAG, or undefined when it has 0 or >1. */
function soleLeafConsumer(dossier: Dossier, opId: string): string | undefined {
  const present = new Set(dossier.leafSnapshot.workflow.operators.map(op => op.operatorID));
  const consumers = new Set<string>();
  for (const link of dossier.leafSnapshot.workflow.links) {
    if (link.source.operatorID === opId && present.has(link.target.operatorID)) {
      consumers.add(link.target.operatorID);
    }
  }
  return consumers.size === 1 ? [...consumers][0] : undefined;
}

/** Earliest healthy own-result event at/after `from`; undefined when none. */
function firstHealthyResultAtOrAfter(d: OperatorDossier | undefined, from: number): number | undefined {
  if (!d) return undefined;
  for (const rv of d.resultVersions) {
    if (rv.eventIndex >= from && !rv.info.error) return rv.eventIndex;
  }
  return undefined;
}

/**
 * Compute the fold maps for one dossier. Pure; call on every render — the
 * result depends only on the trajectory, so repeated calls are stable.
 *
 * Per operator with exactly one leaf consumer, a revision at position i folds
 * iff a later landed ("ok") revision exists whose submission was followed by a
 * healthy own execution and then a healthy consumer execution, and
 * `graceEvents` have elapsed since that consumption. Rejected submissions
 * (tool-level [ERROR], never landed) fold under the same resolution — their
 * code never even ran.
 */
export function computeRevisionFolds(dossier: Dossier, config: FoldResolvedRevisionsConfig): RevisionFolds {
  const folds: RevisionFolds = { actions: new Map(), observations: new Map() };
  const currentEventIndex =
    dossier.path.length > 0 ? Math.max(...dossier.path.map(node => node.eventIndex)) : 0;

  for (const [opId, d] of dossier.operators) {
    if (d.codeVersions.length < 2) continue;
    // Deleted / never-landed operators keep their raw trajectory: their events
    // may be the only record of why the op went away.
    if (d.deleted || !d.currentPredicate) continue;
    const consumerId = soleLeafConsumer(dossier, opId);
    if (consumerId === undefined) continue;
    const consumer = dossier.operators.get(consumerId);

    const versions = d.codeVersions;
    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      // The resolving revision: the first LANDED submission strictly after
      // this one. Same-event batches (rare) never fold — the fold key is
      // (event, op) and would hit the resolver's own payload.
      const resolver = versions.find(v => v.status === "ok" && v.eventIndex > version.eventIndex);
      if (!resolver) continue;
      const execEvent = firstHealthyResultAtOrAfter(d, resolver.eventIndex);
      if (execEvent === undefined) continue;
      const consumedEvent = firstHealthyResultAtOrAfter(consumer, execEvent);
      if (consumedEvent === undefined) continue;
      if (currentEventIndex < consumedEvent + config.graceEvents) continue;

      const resolvedAt = `resolved by the revision at Event ${resolver.eventIndex}`;
      set(
        folds.actions,
        version.eventIndex,
        opId,
        version.status === "rejected"
          ? `(folded — rejected submission${version.statusLine ? `: ${firstLine(version.statusLine)}` : ""}; ${resolvedAt})`
          : `(folded — superseded revision; ${resolvedAt})`
      );

      // Results earned while THIS revision was active: from its submission up
      // to (not including) the resolving submission. Later revisions between
      // the two (all rejected, else `resolver` would sit earlier) never
      // changed the active code.
      if (version.status === "ok") {
        const nextLanded = resolver.eventIndex;
        for (const rv of d.resultVersions) {
          if (rv.eventIndex < version.eventIndex || rv.eventIndex >= nextLanded) continue;
          const fact = rv.info.error
            ? `(folded superseded attempt — failed: ${firstLine(rv.info.error)}; ${resolvedAt})`
            : `(folded superseded attempt — output was ${rv.info.totalRowCount ?? rv.info.outputTuples} rows; ${resolvedAt})`;
          set(folds.observations, rv.eventIndex, opId, fact);
        }
      }
    }
  }
  return folds;
}
