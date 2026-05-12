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
 * that *earned* it. `sourceStepId` may be `undefined` when the resolved
 * value comes from the empty root snapshot — that snapshot has no owning
 * ReAct step.
 */
export interface ResolvedSnapshotEntry<T> {
  value: T;
  sourceStepId: string | undefined;
}

/**
 * One per-operator result inside a snapshot. `sourceStepId` is the ReAct
 * step whose action originally produced this value — preserved as the
 * entry is copied forward through descendant snapshots, so
 * `getResolvedOperatorResult` reports provenance regardless of how many
 * inherit hops the entry has travelled. Only `setOperatorResult` writes
 * entries, and only on snapshots owned by a real ReAct step, so the field
 * is always a real id (the root snapshot's results map is empty).
 */
interface ResultEntry {
  info: OperatorInfo;
  sourceStepId: string;
}

/**
 * A node in the snapshot tree. Every snapshot carries the full state — the
 * DAG (`workflow`) and a complete map of operator results — so a read is a
 * single map lookup once the right snapshot is located. Snapshots inherit
 * their parent's results on creation, then writes during the owning step
 * override entries on top.
 *
 * `reactStepId` is `undefined` only for the synthetic empty root.
 */
export interface SnapshotData {
  /** Unique snapshot ID. */
  id: string;
  /** Parent snapshot ID in the snapshot tree. `undefined` only for the
   *  empty root. */
  parentId: string | undefined;
  /** The ReAct step whose actions produced this snapshot. `undefined` for
   *  the empty root. */
  reactStepId: string | undefined;
  workflow: WorkflowContent;
  results: Map<string, ResultEntry>;
}

function createEmptyWorkflow(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

/**
 * Versioned snapshot tree.
 *
 * Every storage instance owns one synthetic **empty root** snapshot
 * (`{ workflow: empty, results: {} }`) allocated eagerly in the
 * constructor and re-allocated by `clear()`. This guarantees the snapshot
 * tree is always a single-rooted tree even before any ReAct step exists.
 *
 * Each ReAct step that carries actions (tool calls) owns one snapshot;
 * an edge in the snapshot tree corresponds 1:1 to such a step. The first
 * action-bearing step's snapshot has the empty root as its `parentId`.
 *
 * ReAct steps without actions own no snapshot — their "associated
 * snapshot" is the snapshot of the nearest action-bearing ancestor on the
 * ReAct tree (found via `getAncestorPath`), falling back to the empty
 * root.
 *
 * Snapshots are full states (workflow + results), not deltas: on
 * `createSnapshot` the new node inherits the parent's results, then
 * writes during the owning step override entries on top.
 */
export class WorkflowSnapshotStorage {
  /** Every snapshot, keyed by its own id (includes the empty root). */
  private snapshots = new Map<string, SnapshotData>();
  /** ReAct stepId → snapshotId. Populated only for action-bearing steps;
   *  the empty root is NOT indexed here (it has no owning step). */
  private snapshotByReactStepId = new Map<string, string>();
  private snapshotCounter = 0;
  private rootSnapshotId: string;

  /**
   * @param getAncestorPath returns the chain of ReAct step ids from root →
   *   leaf for the given step. Used by all readers to resolve the
   *   associated snapshot through ReAct ancestors.
   */
  constructor(private getAncestorPath: (reactStepId: string) => string[]) {
    this.rootSnapshotId = this.allocateRoot();
  }

  // ── root ─────────────────────────────────────────────────────────────

  /** The empty root snapshot — always present, never owned by a ReAct
   *  step. Reads that find no action-bearing ancestor resolve here. */
  getRootSnapshot(): SnapshotData {
    return this.snapshots.get(this.rootSnapshotId)!;
  }

  getRootSnapshotId(): string {
    return this.rootSnapshotId;
  }

  private allocateRoot(): string {
    const id = this.generateSnapshotId();
    this.snapshots.set(id, {
      id,
      parentId: undefined,
      reactStepId: undefined,
      workflow: createEmptyWorkflow(),
      results: new Map(),
    });
    return id;
  }

  // ── writers ──────────────────────────────────────────────────────────

  /**
   * Create a snapshot owned by `reactStepId`. The parent snapshot is the
   * nearest ReAct-ancestor of `reactStepId` that owns a snapshot; if no
   * such ancestor exists, the parent is the empty root. The new snapshot
   * inherits the parent's results map (by reference per-entry).
   *
   * @throws if a snapshot already exists for `reactStepId`.
   */
  createSnapshot(reactStepId: string, workflow: WorkflowContent): SnapshotData {
    if (this.snapshotByReactStepId.has(reactStepId)) {
      throw new Error(`Snapshot already exists for ReAct step ${reactStepId}`);
    }
    const parentSnapshotId = this.findParentSnapshotId(reactStepId);
    const parentResults = this.snapshots.get(parentSnapshotId)!.results;

    const id = this.generateSnapshotId();
    const snapshot: SnapshotData = {
      id,
      parentId: parentSnapshotId,
      reactStepId,
      workflow,
      // Copy entries by reference — ResultEntry is immutable; overrides
      // replace the entry, never mutate it in place.
      results: new Map(parentResults),
    };
    this.snapshots.set(id, snapshot);
    this.snapshotByReactStepId.set(reactStepId, id);
    return snapshot;
  }

  /**
   * Record one operator's result earned by the action at `reactStepId`.
   * The write lands on the snapshot owned by `reactStepId`; descendant
   * snapshots that have not overridden this op continue to see this
   * value via inheritance.
   *
   * @throws if `reactStepId` does not own a snapshot (the empty root
   *   doesn't, and neither do action-less steps). Callers must
   *   `createSnapshot` first.
   */
  setOperatorResult(reactStepId: string, operatorId: string, info: OperatorInfo): void {
    const snapshotId = this.snapshotByReactStepId.get(reactStepId);
    if (snapshotId === undefined) {
      throw new Error(
        `Cannot set operator result on ReAct step ${reactStepId}: no snapshot owned by this step. ` +
          `Call createSnapshot first.`
      );
    }
    this.snapshots.get(snapshotId)!.results.set(operatorId, { info, sourceStepId: reactStepId });
  }

  // ── readers ──────────────────────────────────────────────────────────

  /** Does `reactStepId` own its own snapshot? (i.e. is it action-bearing.)
   *  Always `false` for the empty root. */
  hasSnapshotFor(reactStepId: string): boolean {
    return this.snapshotByReactStepId.has(reactStepId);
  }

  /**
   * The associated snapshot of `reactStepId`:
   *  - if `reactStepId` owns a snapshot, that one;
   *  - otherwise the snapshot of the nearest action-bearing ancestor;
   *  - otherwise the empty root.
   *
   * Always returns a value — never undefined.
   */
  getAssociatedSnapshot(reactStepId?: string): SnapshotData {
    if (reactStepId === undefined) return this.getRootSnapshot();
    const path = this.getAncestorPath(reactStepId);
    for (let i = path.length - 1; i >= 0; i--) {
      const sid = this.snapshotByReactStepId.get(path[i]);
      if (sid !== undefined) return this.snapshots.get(sid)!;
    }
    return this.getRootSnapshot();
  }

  /** Workflow visible at `reactStepId` — from its associated snapshot.
   *  Defaults to the empty root's empty workflow when nothing else
   *  resolves. */
  getWorkflow(reactStepId?: string): WorkflowContent {
    return this.getAssociatedSnapshot(reactStepId).workflow;
  }

  /** Workflow visible at `reactStepId`, plus the step it came from
   *  (`undefined` when it came from the empty root). */
  getResolvedWorkflow(reactStepId?: string): ResolvedSnapshotEntry<WorkflowContent> {
    const snap = this.getAssociatedSnapshot(reactStepId);
    return { value: snap.workflow, sourceStepId: snap.reactStepId };
  }

  /** Operator result visible at `reactStepId` for `operatorId`. */
  getOperatorResult(reactStepId: string | undefined, operatorId: string): OperatorInfo | undefined {
    return this.getAssociatedSnapshot(reactStepId).results.get(operatorId)?.info;
  }

  /** Operator result + the step that originally earned it. Provenance is
   *  preserved through inheritance — an inherited entry reports the
   *  ancestor that first wrote it, not the snapshot inheriting it.
   *  Returns `undefined` if no such result exists on the active branch. */
  getResolvedOperatorResult(
    reactStepId: string | undefined,
    operatorId: string
  ): ResolvedSnapshotEntry<OperatorInfo> | undefined {
    const entry = this.getAssociatedSnapshot(reactStepId).results.get(operatorId);
    if (!entry) return undefined;
    return { value: entry.info, sourceStepId: entry.sourceStepId };
  }

  /** Map of every operator's most-recent result visible at `reactStepId`.
   *  Trivially the associated snapshot's results, with `ResultEntry`
   *  flattened to `OperatorInfo`. */
  getAllVisibleResults(reactStepId?: string): Map<string, OperatorInfo> {
    const snap = this.getAssociatedSnapshot(reactStepId);
    const out = new Map<string, OperatorInfo>();
    for (const [opId, entry] of snap.results) out.set(opId, entry.info);
    return out;
  }

  /** Direct lookup by snapshot id (e.g. for snapshot-tree introspection). */
  getSnapshotById(snapshotId: string): SnapshotData | undefined {
    return this.snapshots.get(snapshotId);
  }

  // ── housekeeping ─────────────────────────────────────────────────────

  /** Drop every step-owned snapshot and re-allocate the empty root. The
   *  storage is never without a root. */
  clear(): void {
    this.snapshots.clear();
    this.snapshotByReactStepId.clear();
    this.rootSnapshotId = this.allocateRoot();
  }

  /** Drop snapshots whose owning step is not in `liveStepIds`. The empty
   *  root is always preserved. */
  pruneOrphans(liveStepIds: Set<string>): void {
    for (const [reactStepId, snapshotId] of [...this.snapshotByReactStepId]) {
      if (!liveStepIds.has(reactStepId)) {
        this.snapshotByReactStepId.delete(reactStepId);
        this.snapshots.delete(snapshotId);
      }
    }
  }

  // ── internal ─────────────────────────────────────────────────────────

  /** Walk ReAct ancestors of `reactStepId` (excluding the step itself) and
   *  return the nearest snapshot id. Falls back to the empty root. */
  private findParentSnapshotId(reactStepId: string): string {
    const path = this.getAncestorPath(reactStepId);
    const upper = path[path.length - 1] === reactStepId ? path.length - 2 : path.length - 1;
    for (let i = upper; i >= 0; i--) {
      const sid = this.snapshotByReactStepId.get(path[i]);
      if (sid !== undefined) return sid;
    }
    return this.rootSnapshotId;
  }

  private generateSnapshotId(): string {
    return `snap-${++this.snapshotCounter}-${Date.now()}`;
  }
}
