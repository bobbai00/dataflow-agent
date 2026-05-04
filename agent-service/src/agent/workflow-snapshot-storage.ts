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

import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";

/**
 * A resolved (workflow OR operator-result) entry, augmented with the step
 * that *earned* it. Returned by lookup methods when callers need provenance
 * (e.g. "this result is from N steps ago" / "the workflow last changed at
 * step X"). For the common get-the-info case use the plain `getWorkflow` /
 * `getOperatorResult` returns.
 */
export interface ResolvedSnapshotEntry<T> {
  value: T;
  sourceStepId: string;
}

/**
 * Per-step snapshot record. `workflow` is OPTIONAL: the absence of an entry
 * means "the step did not change the DAG" — readers fall back to the nearest
 * ancestor's workflow. `results` is partial: only operators whose result was
 * earned at this step.
 *
 * Both shapes use the same ancestor-walk lookup, so an operator result that
 * stays unchanged across many steps lives on storage exactly once.
 */
interface SnapshotEntry {
  workflow?: WorkflowContent;
  results: Map<string, OperatorInfo>;
}

/**
 * Versioned per-step snapshot of the workflow + operator execution results.
 *
 * Both axes follow the same rule: a write is keyed under the step that
 * produced the change; a read walks the current ancestor path leaf→root and
 * returns the most recent entry on that branch. Branching is free (each
 * branch sees its own ancestors), and unchanged values are not duplicated.
 *
 * The path walker is supplied at construction so the storage can stay
 * agnostic to how the step tree is maintained.
 */
export class WorkflowSnapshotStorage {
  private snapshots = new Map<string, SnapshotEntry>();

  /**
   * @param getAncestorPath returns the chain of step ids from root → leaf
   *   for the given step. Used by all readers to resolve through ancestors.
   */
  constructor(private getAncestorPath: (stepId: string) => string[]) {}

  // ── writers ──────────────────────────────────────────────────────────

  /** Record the workflow at `stepId`. Subsequent reads at this step or any
   *  descendant will resolve to this content (until overridden). */
  setWorkflow(stepId: string, content: WorkflowContent): void {
    this.entry(stepId).workflow = content;
  }

  /** Record one operator's result earned by `stepId`. */
  setOperatorResult(stepId: string, operatorId: string, info: OperatorInfo): void {
    this.entry(stepId).results.set(operatorId, info);
  }

  // ── readers ──────────────────────────────────────────────────────────

  /** Workflow visible at `stepId` (own snapshot, else nearest ancestor's). */
  getWorkflow(stepId: string): WorkflowContent | undefined {
    return this.getResolvedWorkflow(stepId)?.value;
  }

  /** Workflow visible at `stepId`, plus the step it came from. */
  getResolvedWorkflow(stepId: string): ResolvedSnapshotEntry<WorkflowContent> | undefined {
    const path = this.getAncestorPath(stepId);
    for (let i = path.length - 1; i >= 0; i--) {
      const snap = this.snapshots.get(path[i]);
      if (snap?.workflow) return { value: snap.workflow, sourceStepId: path[i] };
    }
    return undefined;
  }

  /** Operator result visible at `stepId` for `operatorId`. */
  getOperatorResult(stepId: string, operatorId: string): OperatorInfo | undefined {
    return this.getResolvedOperatorResult(stepId, operatorId)?.value;
  }

  /** Operator result + the step that earned it. */
  getResolvedOperatorResult(
    stepId: string,
    operatorId: string,
  ): ResolvedSnapshotEntry<OperatorInfo> | undefined {
    const path = this.getAncestorPath(stepId);
    for (let i = path.length - 1; i >= 0; i--) {
      const info = this.snapshots.get(path[i])?.results.get(operatorId);
      if (info) return { value: info, sourceStepId: path[i] };
    }
    return undefined;
  }

  /** Map of every operator's most-recent result on the branch ending at
   *  `stepId`. Keyed by operatorId. */
  getAllVisibleResults(stepId: string): Map<string, OperatorInfo> {
    const out = new Map<string, OperatorInfo>();
    const path = this.getAncestorPath(stepId);
    for (let i = path.length - 1; i >= 0; i--) {
      const snap = this.snapshots.get(path[i]);
      if (!snap) continue;
      for (const [opId, info] of snap.results) {
        if (!out.has(opId)) out.set(opId, info);
      }
    }
    return out;
  }

  // ── housekeeping ─────────────────────────────────────────────────────

  /** Drop everything. */
  clear(): void {
    this.snapshots.clear();
  }

  /** Drop snapshots whose stepId is not in `liveStepIds`. Use after step-tree
   *  pruning (e.g. abandoning a branch) to bound memory. */
  pruneOrphans(liveStepIds: Set<string>): void {
    for (const id of this.snapshots.keys()) {
      if (!liveStepIds.has(id)) this.snapshots.delete(id);
    }
  }

  // ── internal ─────────────────────────────────────────────────────────

  private entry(stepId: string): SnapshotEntry {
    let e = this.snapshots.get(stepId);
    if (!e) {
      e = { results: new Map() };
      this.snapshots.set(stepId, e);
    }
    return e;
  }
}
