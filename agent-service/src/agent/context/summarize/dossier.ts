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
 * The DOSSIER layer of summarize(): a pure, render-free derivation of every
 * per-operator fact the trajectory + snapshot tree carry, keyed by the SAME
 * 1-based event indices the rendered context shows the model (`Agent Event N`
 * / `Step N`). It is the single "data parameters" input of summarize() —
 * the options schema then selects how much of it to render.
 *
 * Per operator:
 *   - code versions   — every `createOrModifyOperator` submission along the
 *     path (event index, code, summary, tool-level ok/rejected status);
 *   - result versions — every execution result the operator EARNED along the
 *     path (event index + OperatorInfo), recovered from each snapshot's
 *     entries whose `sourceStepId` equals that snapshot's owning step. This is
 *     the code↔result correspondence: the result at event N was produced by
 *     the operator's code as of event N.
 *   - the current predicate (present iff the op is in the leaf snapshot) and
 *     a `deleted` flag for ops that were removed and never re-created.
 *
 * Everything derives from `(visibleSteps, snapshotStorage)` — no live state,
 * no I/O — so a recorded trace re-renders offline under any params.
 */

import type { ReActStep } from "../../../types/agent";
import type { OperatorInfo } from "../../../types/execution";
import type { OperatorPredicate } from "../../../types/workflow";
import type { SnapshotData, WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import { buildPath, type PathNode } from "../../util/context-utils";

export interface CodeVersion {
  /** 1-based event index (matches the rendered `Agent Event N` numbering). */
  eventIndex: number;
  code: string;
  summary?: string;
  /** Tool-level outcome of the submission: "ok" (landed) or "rejected"
   *  (the tool returned an [ERROR]; the workflow did not change). */
  status: "ok" | "rejected";
  /** First line of the [ERROR] tool output when status === "rejected". */
  statusLine?: string;
  /** Agent-declared result-view preference for THIS version (render-prefs):
   *  how many output rows to show. Absent ⇒ the render default. */
  outputSummary?: "minimal" | "standard";
}

export interface ResultVersion {
  /** Event whose action earned this result (0 = the hidden init baseline). */
  eventIndex: number;
  info: OperatorInfo;
}

export interface OperatorDossier {
  operatorId: string;
  /** The operator as it exists in the LEAF snapshot; undefined when the op
   *  is not part of the current workflow (deleted, or never landed). */
  currentPredicate?: OperatorPredicate;
  /** Chronological code submissions (create + modifies, incl. rejected). */
  codeVersions: CodeVersion[];
  /** Chronological earned results (init baseline first when present). */
  resultVersions: ResultVersion[];
  /** True when the op was deleted along the path and never re-created. */
  deleted: boolean;
}

export interface Dossier {
  operators: Map<string, OperatorDossier>;
  /** The leaf (current) snapshot of the path; falls back to the init
   *  snapshot, then the storage's empty root. */
  leafSnapshot: SnapshotData;
  /** Visible events (init excluded), chronological — same array the
   *  renderers consume. */
  path: PathNode[];
  /** The hidden init step's snapshot, when the path carried one. */
  initSnapshot: SnapshotData | undefined;
}

function firstErrorLine(output: unknown): string | undefined {
  const txt = typeof output === "string" ? output : output ? JSON.stringify(output) : "";
  const m = /\[ERROR\][^\n]*/.exec(txt);
  return m ? m[0].replace(/\s+/g, " ").trim() : undefined;
}

function getOrCreate(map: Map<string, OperatorDossier>, opId: string): OperatorDossier {
  let d = map.get(opId);
  if (!d) {
    d = { operatorId: opId, codeVersions: [], resultVersions: [], deleted: false };
    map.set(opId, d);
  }
  return d;
}

/**
 * Build the dossier from the agent's visible steps + snapshot storage.
 * Pure and synchronous; safe to call on every prepareStep.
 */
export function buildDossier(visibleSteps: ReActStep[], storage: WorkflowSnapshotStorage): Dossier {
  const { path, initSnapshot } = buildPath(visibleSteps, storage);
  const operators = new Map<string, OperatorDossier>();

  // Init baseline results are version 0 — earned by the hidden init step.
  if (initSnapshot) {
    for (const [opId, info] of collectEarnedResults(initSnapshot)) {
      getOrCreate(operators, opId).resultVersions.push({ eventIndex: 0, info });
    }
  }

  for (const node of path) {
    const step = node.step;
    if (step.role !== "agent") continue;
    const calls = step.toolCalls ?? [];
    const trs = step.toolResults ?? [];

    calls.forEach((tc, i) => {
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
      if (!opId) return;
      if (tc.toolName === "createOrModifyOperator") {
        const d = getOrCreate(operators, opId);
        const tr = trs[i];
        const errLine = firstErrorLine(tr?.output);
        const rejected = !!(tr as any)?.isError || errLine !== undefined;
        d.codeVersions.push({
          eventIndex: node.eventIndex,
          code: typeof inp.code === "string" ? inp.code : "",
          summary: typeof inp.summary === "string" ? inp.summary : undefined,
          status: rejected ? "rejected" : "ok",
          statusLine: rejected ? (errLine ?? "[ERROR] (unspecified)") : undefined,
          outputSummary:
            inp.outputSummary === "minimal" || inp.outputSummary === "standard"
              ? (inp.outputSummary as "minimal" | "standard")
              : undefined,
        });
        d.deleted = false; // a (re-)create resurrects the op
      } else if (tc.toolName === "deleteOperator") {
        getOrCreate(operators, opId).deleted = true;
      }
    });

    // Results EARNED at this event: snapshot entries sourced by this step.
    if (node.snapshot) {
      for (const [opId, info] of collectEarnedResults(node.snapshot)) {
        getOrCreate(operators, opId).resultVersions.push({ eventIndex: node.eventIndex, info });
      }
    }
  }

  // Leaf snapshot + current predicates.
  const leafSnapshot = lastSnapshotOfPath(path) ?? initSnapshot ?? storage.getRootSnapshot();
  const inLeaf = new Set<string>();
  for (const op of leafSnapshot.workflow.operators) {
    inLeaf.add(op.operatorID);
    getOrCreate(operators, op.operatorID).currentPredicate = op;
  }
  // An op absent from the leaf but never explicitly deleted (e.g. dropped by
  // checkout/branching) still reads as not-current; keep `deleted` as the
  // explicit-delete signal only.
  for (const d of operators.values()) {
    if (!inLeaf.has(d.operatorId)) d.currentPredicate = undefined;
  }

  return { operators, leafSnapshot, path, initSnapshot };
}

/** Entries of `snapshot.results` earned BY its owning step (not inherited). */
function collectEarnedResults(snapshot: SnapshotData): Array<[string, OperatorInfo]> {
  const out: Array<[string, OperatorInfo]> = [];
  if (snapshot.reactStepId === undefined) return out;
  for (const [opId, entry] of snapshot.results) {
    if (entry.sourceStepId === snapshot.reactStepId) out.push([opId, entry.info]);
  }
  return out;
}

function lastSnapshotOfPath(path: PathNode[]): SnapshotData | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].snapshot) return path[i].snapshot;
  }
  return undefined;
}
