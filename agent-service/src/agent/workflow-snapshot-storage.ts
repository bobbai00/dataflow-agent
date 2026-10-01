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

import { isDeepStrictEqual } from "node:util";
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";
import { bindResultVersion, freezeSnapshotValue, producingExecution } from "./native/result-versions";
import { selectNativeObservation, type NativeObservation, type NativeObservationOptions } from "./native/evidence";
import {
  captureNativeDiagnostic,
  diagnosticSummary,
  renderNativeErrorInspection,
  type NativeDiagnosticRecord,
} from "./native/diagnostic-record";
import type { NativeErrorQuery, NativeErrorSummary } from "./native/diagnostics";
import { resolveNativeDiagnostic } from "./native/diagnostics";

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
  /** Successful explicit observations earned by this event, never inherited.
   * Undefined marks pre-feature/imported snapshots without an exposure record. */
  nativeObservations?: Readonly<Record<string, NativeObservation>>;
  /** Private event-owned diagnostics. Never inherited or added to the ordinary
   * unauthenticated snapshot response; expanded reads use inspectError. */
  nativeDiagnostics?: Readonly<Record<string, NativeDiagnosticRecord>>;
  /** Unrepaired rejected definitions are control state, not result evidence.
   * Upstream result invalidation must not silently forgive a syntax rejection. */
  nativeRejectedEdits?: Readonly<Record<string, NativeErrorSummary>>;
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
 *
 * **Tight-accuracy invariant.** Inheritance is *selective*: a parent
 * result entry is dropped during `createSnapshot` whenever its operator —
 * or any operator transitively upstream of it in the child's DAG — has
 * been modified between parent and child. This makes every snapshot's
 * results map tightly bound to that snapshot's specific workflow version,
 * so a downstream cached value can never silently outlive a change to one
 * of its inputs. The writer (post-step execution) then re-fills entries
 * that the backend can materialize; entries the backend can't materialize
 * stay absent and the renderer omits the `Result:` block — the agent
 * sees a clear "not yet executed in this state" signal instead of a
 * stale value.
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
  constructor(
    private getAncestorPath: (reactStepId: string) => string[],
    private getWorkflowId?: () => number | undefined,
    private getDiagnosticSecrets?: () => readonly string[]
  ) {
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

  /** Finalize the successful observation frame after execution (including a
   * cached observe with no execution). DELTA replays this exact selection even
   * after settings, downstream relevance, or the current DAG have changed. */
  captureNativeObservations(
    reactStepId: string,
    ids: Iterable<string>,
    options: NativeObservationOptions,
    recorded?: ReadonlyMap<string, NativeObservation>
  ): void {
    const snapshotId = this.snapshotByReactStepId.get(reactStepId);
    if (!snapshotId) throw new Error(`No snapshot owned by ReAct step ${reactStepId}`);
    const snapshot = this.snapshots.get(snapshotId)!;
    if (snapshot.nativeObservations !== undefined) return;
    const observations: Array<[string, NativeObservation]> = [];
    for (const id of new Set(ids)) {
      const op = snapshot.workflow.operators.find(o => o.operatorID === id);
      const info = snapshot.results.get(id)?.info;
      if (!op?.nativeOp || !info || info.error) continue;
      observations.push([
        id,
        recorded?.get(id) ??
          selectNativeObservation({
            ...options,
            op,
            info,
            workflow: snapshot.workflow,
            resolveInput: input => snapshot.results.get(input)?.info,
          }),
      ]);
    }
    snapshot.nativeObservations = freezeSnapshotValue(Object.fromEntries(observations));
  }

  /**
   * Create a snapshot owned by `reactStepId`. The parent snapshot is the
   * nearest ReAct-ancestor of `reactStepId` that owns a snapshot; if no
   * such ancestor exists, the parent is the empty root.
   *
   * The new snapshot **selectively** inherits the parent's results map —
   * each entry is carried forward only when neither the entry's operator
   * nor any transitive upstream ancestor in the child's DAG was modified
   * between parent and child. Stale entries (under that rule) are
   * dropped, preserving the tight-accuracy invariant described in the
   * class-level docstring.
   *
   * When the parent or child workflow has no operators (e.g. the empty
   * root, or "phantom-op" test setups that write results without a real
   * DAG), the invalidation set is empty and every parent entry is
   * inherited — preserving backward compatibility with callers that
   * exercise results storage in isolation.
   *
   * @throws if a snapshot already exists for `reactStepId`.
   */
  createSnapshot(reactStepId: string, workflow: WorkflowContent): SnapshotData {
    if (this.snapshotByReactStepId.has(reactStepId)) {
      throw new Error(`Snapshot already exists for ReAct step ${reactStepId}`);
    }
    const parentSnapshotId = this.findParentSnapshotId(reactStepId);
    const parentSnap = this.snapshots.get(parentSnapshotId)!;

    const stale = computeStaleResultOps(parentSnap.workflow, workflow);
    const inherited = new Map<string, ResultEntry>();
    for (const [opId, entry] of parentSnap.results) {
      if (stale.has(opId)) continue;
      inherited.set(opId, entry);
    }

    const id = this.generateSnapshotId();
    const ownedWorkflow = copyWorkflow(workflow, parentSnap.workflow);
    if (ownedWorkflow.operators.some(op => op.nativeOp)) freezeSnapshotValue(ownedWorkflow);
    const snapshot: SnapshotData = {
      id,
      parentId: parentSnapshotId,
      reactStepId,
      workflow: ownedWorkflow,
      // Entries are carried forward by reference — ResultEntry is
      // immutable; overrides replace the entry, never mutate in place.
      results: inherited,
      ...(parentSnap.nativeRejectedEdits
        ? {
            nativeRejectedEdits: freezeSnapshotValue(
              Object.fromEntries(
                Object.entries(parentSnap.nativeRejectedEdits).filter(([opId]) => {
                  const old = parentSnap.workflow.operators.find(op => op.operatorID === opId)?.nativeOp?.revision;
                  const current = workflow.operators.find(op => op.operatorID === opId)?.nativeOp?.revision;
                  return old === current;
                })
              )
            ),
          }
        : {}),
    };
    this.snapshots.set(id, snapshot);
    this.snapshotByReactStepId.set(reactStepId, id);
    this.restoreNativeRejectedEdits(reactStepId);
    return snapshot;
  }

  /** Advance the owning snapshot while an ordered action batch is running.
   * Only the unfinished leaf may change. Previously returned action outputs
   * are separate frozen values; ancestors are never rewritten. */
  updatePendingWorkflow(reactStepId: string, workflow: WorkflowContent): void {
    const id = this.snapshotByReactStepId.get(reactStepId);
    if (!id) throw new Error(`No snapshot owned by ReAct step ${reactStepId}`);
    const snapshot = this.snapshots.get(id)!;
    if (snapshot.nativeObservations !== undefined || [...this.snapshots.values()].some(s => s.parentId === id))
      throw new Error("Cannot change a completed snapshot");
    const stale = computeStaleResultOps(snapshot.workflow, workflow);
    const present = new Set(workflow.operators.map(op => op.operatorID));
    for (const operatorId of snapshot.results.keys())
      if (stale.has(operatorId) || !present.has(operatorId)) snapshot.results.delete(operatorId);
    const owned = copyWorkflow(workflow, snapshot.workflow);
    snapshot.workflow = freezeSnapshotValue(owned);
    if (snapshot.nativeRejectedEdits)
      snapshot.nativeRejectedEdits = freezeSnapshotValue(
        Object.fromEntries(
          Object.entries(snapshot.nativeRejectedEdits).filter(([operatorId]) => present.has(operatorId))
        )
      );
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
    const snapshot = this.snapshots.get(snapshotId)!;
    // A run aborts at its first failure and hands every unfinished operator the
    // same payload. A bystander that does not read from the failed operator
    // keeps the result it already has for its current definition: that result
    // is still valid, and observing it must not wait on an unrelated repair.
    const definition = snapshot.workflow.operators.find(op => op.operatorID === operatorId);
    const kept = snapshot.results.get(operatorId)?.info;
    if (
      info.error &&
      definition?.nativeOp?.revision &&
      kept &&
      !kept.error &&
      kept.resultVersion?.complete &&
      kept.resultVersion.operatorRevision === definition.nativeOp.revision
    ) {
      const root = resolveNativeDiagnostic(definition, info.error, id =>
        snapshot.workflow.operators.find(op => op.operatorID === id)
      ).operatorId;
      if (root !== operatorId && !upstreamOf(snapshot.workflow, operatorId).has(root)) return;
    }
    const current = new Map([...snapshot.results].map(([id, entry]) => [id, entry.info]));
    const snapshots = this.snapshots;
    const historicalResults = function* () {
      for (const candidate of snapshots.values()) {
        const entry = candidate.results.get(operatorId);
        if (entry) yield entry.info;
      }
    };
    const bound = bindResultVersion(
      snapshot.workflow,
      operatorId,
      structuredClone(info),
      current,
      this.getWorkflowId?.(),
      historicalResults
    );
    if (!bound) return;
    delete bound.nativeError;
    const nativeOp = snapshot.workflow.operators.find(op => op.operatorID === operatorId);
    if (bound.error && nativeOp?.nativeOp) {
      bound.nativeError = this.recordNativeFailure(snapshot, nativeOp, bound);
      bound.error = "NATIVE_ERROR_V2:" + JSON.stringify(bound.nativeError.diagnostic);
    }
    if (bound.resultVersion || snapshot.workflow.operators.find(o => o.operatorID === operatorId)?.nativeOp) {
      const invalidate = (root: string, includeRoot = false) => {
        if (includeRoot) snapshot.results.delete(root);
        const pending = [root];
        const seen = new Set(pending);
        for (const id of pending)
          for (const link of snapshot.workflow.links) {
            if (link.source.operatorID !== id || seen.has(link.target.operatorID)) continue;
            seen.add(link.target.operatorID);
            pending.push(link.target.operatorID);
            snapshot.results.delete(link.target.operatorID);
          }
      };
      for (const input of bound.executionContext?.inputs ?? []) {
        const old = producingExecution(current.get(input.operatorId));
        if (old && input.executionId && old !== input.executionId) invalidate(input.operatorId, true);
      }
      const previous = current.get(operatorId);
      // A fresh materialization (even without an edit) supersedes downstream
      // results tied to the old input. Historical snapshots are never changed.
      if (bound.error || previous?.resultVersion?.id !== bound.resultVersion?.id) invalidate(operatorId);
      freezeSnapshotValue(bound);
    }
    // Descendants share immutable entries, never a caller's mutable response.
    snapshot.results.set(operatorId, { info: bound, sourceStepId: reactStepId });
  }

  private recordNativeFailure(
    snapshot: SnapshotData,
    op: OperatorPredicate,
    info: OperatorInfo,
    phase: NativeErrorSummary["phase"] = "execution"
  ): NativeErrorSummary {
    const record = freezeSnapshotValue(
      captureNativeDiagnostic({
        stepId: snapshot.reactStepId!,
        op,
        workflow: snapshot.workflow,
        info,
        phase,
        resolveInput: id => snapshot.results.get(id)?.info,
        secrets: this.getDiagnosticSecrets?.(),
      })
    );
    snapshot.nativeDiagnostics = freezeSnapshotValue({ ...snapshot.nativeDiagnostics, [record.diagnosticId]: record });
    return freezeSnapshotValue(diagnosticSummary(record));
  }

  /** Record a rejected submitted definition without putting it in the DAG.
   * Current successes from this operator/descendants must not masquerade as
   * the rejected computation. Historical snapshots remain untouched. */
  captureNativeAttemptDiagnostic(reactStepId: string, attempted: OperatorPredicate, error: string): NativeErrorSummary {
    const snapshotId = this.snapshotByReactStepId.get(reactStepId);
    if (!snapshotId) throw new Error(`No snapshot owned by ReAct step ${reactStepId}`);
    const snapshot = this.snapshots.get(snapshotId)!;
    const info: OperatorInfo = { state: "Failed", resultMode: "table", inputTuples: 0, outputTuples: 0, error };
    const summary = this.recordNativeFailure(snapshot, attempted, info, "attempt");
    snapshot.nativeRejectedEdits = freezeSnapshotValue({
      ...snapshot.nativeRejectedEdits,
      [attempted.operatorID]: summary,
    });
    info.nativeError = summary;
    // Keep only sanitized diagnostic text in the normal result API. The private
    // record owns its bounded raw traceback and submitted-source context.
    info.error = "NATIVE_ERROR_V2:" + JSON.stringify(summary.diagnostic);
    snapshot.results.set(attempted.operatorID, { info: freezeSnapshotValue(info), sourceStepId: reactStepId });
    const pending = [attempted.operatorID],
      seen = new Set(pending);
    for (const id of pending)
      for (const link of snapshot.workflow.links) {
        const child = link.target.operatorID;
        if (link.source.operatorID !== id || seen.has(child)) continue;
        seen.add(child);
        pending.push(child);
        const previous = snapshot.results.get(child);
        if (previous?.sourceStepId === reactStepId && previous.info.nativeError?.phase === "attempt") continue;
        const op = snapshot.workflow.operators.find(item => item.operatorID === child);
        if (!op?.nativeOp) {
          snapshot.results.delete(child);
          continue;
        }
        const blocked: OperatorInfo = {
          state: "Blocked",
          resultMode: "table",
          inputTuples: 0,
          outputTuples: 0,
          error:
            "NATIVE_ERROR_V2:" +
            JSON.stringify({
              version: 1,
              operatorId: child,
              operatorRevision: op.nativeOp.revision ?? "unversioned",
              code: "UPSTREAM_FAILED",
              stage: "dependency",
              message: `Not executed: upstream ${attempted.operatorID} revision ${summary.operatorRevision} was rejected; previous values are unavailable until repair.`,
            }),
        };
        blocked.nativeError = this.recordNativeFailure(snapshot, op, blocked);
        snapshot.results.set(child, { info: freezeSnapshotValue(blocked), sourceStepId: reactStepId });
      }
    return summary;
  }

  /** An accepted explicit resubmission also repairs a rejected attempt when
   * it deliberately restores the unchanged stored definition. It earns no
   * successful result until execution completes. */
  clearNativeRejectedEdits(reactStepId: string, acceptedIds: Iterable<string>): void {
    const snapshotId = this.snapshotByReactStepId.get(reactStepId);
    if (!snapshotId) return;
    const snapshot = this.snapshots.get(snapshotId)!;
    if (!snapshot.nativeRejectedEdits) return;
    const remaining = { ...snapshot.nativeRejectedEdits };
    for (const id of acceptedIds) {
      if (!Object.hasOwn(remaining, id)) continue;
      delete remaining[id];
      const pending = [id],
        seen = new Set(pending);
      for (const root of pending) {
        snapshot.results.delete(root);
        for (const link of snapshot.workflow.links)
          if (link.source.operatorID === root && !seen.has(link.target.operatorID)) {
            seen.add(link.target.operatorID);
            pending.push(link.target.operatorID);
          }
      }
    }
    snapshot.nativeRejectedEdits = freezeSnapshotValue(remaining);
  }

  /** A new input materialization can invalidate cached outputs, not the fact
   * that a submitted definition was rejected. Reuse that event's immutable
   * diagnostic identity/source; do not invent a fresh execution or error. */
  restoreNativeRejectedEdits(reactStepId: string): void {
    const snapshotId = this.snapshotByReactStepId.get(reactStepId);
    if (!snapshotId) return;
    const snapshot = this.snapshots.get(snapshotId)!;
    for (const [id, summary] of Object.entries(snapshot.nativeRejectedEdits ?? {})) {
      // Edits can add a new consumer while a rejected definition is pending.
      // Give that consumer the same explicit dependency failure as existing ones.
      const pending = [id],
        seen = new Set(pending);
      for (const parent of pending)
        for (const link of snapshot.workflow.links) {
          const child = link.target.operatorID;
          if (link.source.operatorID !== parent || seen.has(child)) continue;
          seen.add(child);
          pending.push(child);
          if (snapshot.results.has(child)) continue;
          const op = snapshot.workflow.operators.find(item => item.operatorID === child);
          if (!op?.nativeOp) continue;
          const blocked: OperatorInfo = {
            state: "Blocked",
            resultMode: "table",
            inputTuples: 0,
            outputTuples: 0,
            error:
              "NATIVE_ERROR_V2:" +
              JSON.stringify({
                version: 1,
                operatorId: child,
                operatorRevision: op.nativeOp.revision,
                code: "UPSTREAM_FAILED",
                stage: "dependency",
                message: `Not executed: upstream ${id} revision ${summary.operatorRevision} was rejected; repair it before executing this consumer.`,
              }),
          };
          blocked.nativeError = this.recordNativeFailure(snapshot, op, blocked);
          snapshot.results.set(child, { info: freezeSnapshotValue(blocked), sourceStepId: reactStepId });
        }
      const info: OperatorInfo = {
        state: "Failed",
        resultMode: "table",
        inputTuples: 0,
        outputTuples: 0,
        error: "NATIVE_ERROR_V2:" + JSON.stringify(summary.diagnostic),
        nativeError: summary,
      };
      snapshot.results.set(id, { info: freezeSnapshotValue(info), sourceStepId: summary.stepId });
    }
  }

  inspectNativeError(
    reactStepId: string | undefined,
    query: NativeErrorQuery
  ): {
    found: boolean;
    text: string;
    summary?: NativeErrorSummary;
  } {
    const rejected = this.getAssociatedSnapshot(reactStepId).nativeRejectedEdits;
    const current =
      (rejected && Object.hasOwn(rejected, query.operatorId) ? rejected[query.operatorId] : undefined) ??
      this.getOperatorResult(reactStepId, query.operatorId)?.nativeError;
    let selected: NativeDiagnosticRecord | undefined;
    const matches = (record: NativeDiagnosticRecord) =>
      record.operatorId === query.operatorId &&
      (query.revision === undefined || record.operatorRevision === query.revision);
    if (query.diagnosticId || (!query.revision && current)) {
      const id = query.diagnosticId ?? current!.diagnosticId;
      for (const snapshot of this.snapshots.values()) {
        const record = snapshot.nativeDiagnostics?.[id];
        if (record && matches(record)) {
          selected = record;
          break;
        }
      }
    } else if (query.revision && reactStepId) {
      // Revision-only lookup follows the active branch. An explicit diagnostic
      // ID can identify another retained branch without ambiguous rerun lookup.
      for (const stepId of [...this.getAncestorPath(reactStepId)].reverse()) {
        const owned = this.snapshotByReactStepId.get(stepId);
        if (!owned) continue;
        selected = Object.values(this.snapshots.get(owned)!.nativeDiagnostics ?? {})
          .reverse()
          .find(matches);
        if (selected) break;
      }
    }
    if (!selected)
      return {
        found: false,
        text: "[ERROR] No matching retained diagnostic. Without revision/diagnosticId, only the current error is inspected; repaired results do not imply a current failure.",
      };
    return {
      found: true,
      text: renderNativeErrorInspection(selected, selected.diagnosticId !== current?.diagnosticId),
      summary: diagnosticSummary(selected),
    };
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

  /**
   * Tree shape of every snapshot — used by the dashboard's snapshot-tree
   * view to render branches without pulling the full workflow / results
   * payload for each node. Returns the empty root and every step-owned
   * snapshot; callers can fetch the full body of a node lazily through
   * `getResolvedWorkflow` / `getAllVisibleResults`.
   */
  getSnapshotTreeNodes(): Array<{
    id: string;
    parentId: string | undefined;
    reactStepId: string | undefined;
    operatorCount: number;
    resultCount: number;
  }> {
    const out: Array<{
      id: string;
      parentId: string | undefined;
      reactStepId: string | undefined;
      operatorCount: number;
      resultCount: number;
    }> = [];
    for (const snap of this.snapshots.values()) {
      out.push({
        id: snap.id,
        parentId: snap.parentId,
        reactStepId: snap.reactStepId,
        operatorCount: snap.workflow.operators.length,
        resultCount: snap.results.size,
      });
    }
    return out;
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

  /**
   * Re-establish the full-state inheritance invariant across the whole tree.
   *
   * Live execution keeps it automatically: each snapshot inherits its
   * parent's results at `createSnapshot` time, before any descendant exists.
   * The import path can't — it creates every snapshot first (when the
   * parents' result maps are still empty) and only afterwards attributes the
   * recovered per-operator results to each owning snapshot. As a result,
   * descendants never receive their ancestors' results, and the deepest
   * snapshot (whose owning step is described by no later step's context) can
   * end up with no results at all — so a checkout to HEAD shows no operator
   * state even though every intermediate snapshot has it.
   *
   * This walks the tree parent-before-child and fills each child with any of
   * its parent's result entries that the child doesn't already define and
   * that aren't stale under `computeStaleResultOps(parent.workflow,
   * child.workflow)` — exactly the rule `createSnapshot` applies live, but
   * after the fact. A child's own (directly-attributed) entries always win.
   * Idempotent; intended to be called once after an import.
   */
  propagateInheritedResults(): void {
    const childrenByParent = new Map<string, SnapshotData[]>();
    for (const snap of this.snapshots.values()) {
      if (snap.parentId === undefined) continue;
      const list = childrenByParent.get(snap.parentId) ?? [];
      list.push(snap);
      childrenByParent.set(snap.parentId, list);
    }
    const queue: string[] = [this.rootSnapshotId];
    while (queue.length > 0) {
      const parent = this.snapshots.get(queue.shift()!)!;
      for (const child of childrenByParent.get(parent.id) ?? []) {
        const stale = computeStaleResultOps(parent.workflow, child.workflow);
        for (const [opId, entry] of parent.results) {
          if (stale.has(opId)) continue;
          if (!child.results.has(opId)) child.results.set(opId, entry);
        }
        queue.push(child.id);
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
    // Short, human-friendly, incremental ids. The empty root is allocated
    // first and becomes "S0"; each subsequent step-owned snapshot is "S1",
    // "S2", … in creation order. The counter is monotonic for the lifetime of
    // the storage and is NOT reset by clear(), so a re-allocated root after a
    // clear gets a fresh "S<n>" rather than reusing "S0" — preserving the
    // "clear() yields a new root id" invariant.
    return `S${this.snapshotCounter++}`;
  }
}

/** Native snapshots freeze definitions. Share an unchanged frozen operator
 * instead of duplicating its generated Python runtime at every ReAct step.
 * Each graph still owns its edges, positions and mutable incoming definitions. */
function copyWorkflow(workflow: WorkflowContent, previous: WorkflowContent): WorkflowContent {
  const prior = new Map(previous.operators.map(op => [op.operatorID, op]));
  return {
    ...structuredClone({ ...workflow, operators: [] }),
    operators: workflow.operators.map(op => {
      const saved = prior.get(op.operatorID);
      return saved && Object.isFrozen(saved) && isDeepStrictEqual(saved, op) ? saved : structuredClone(op);
    }),
  };
}

// ── tight-accuracy helpers ─────────────────────────────────────────────

/**
 * Operators that should NOT inherit their parent-snapshot result entry
 * when transitioning from `prev` workflow to `curr` workflow.
 *
 * An operator id `X` is "stale" — and therefore excluded from inheritance —
 * if any of the following hold in `curr`:
 *
 *   1. `X` is new (not present in `prev`).
 *   2. `X` exists in `prev` but its execution-affecting predicate fields
 *      differ between `prev` and `curr` (operatorType, operatorVersion,
 *      operatorProperties, inputPorts, outputPorts, isDisabled).
 *   3. The set of incoming links targeting `X` differs between `prev` and
 *      `curr` (e.g. a link was rewired so `X` now reads from a different
 *      upstream).
 *   4. Some ancestor of `X` in `curr`'s DAG is itself stale.
 *
 * Returns the union as a Set. Operators present in `prev` but absent in
 * `curr` are not in the result — they cannot contribute to a `curr`
 * snapshot's results map anyway, so explicit invalidation is unnecessary.
 *
 * If `prev` or `curr` has no operators the result is empty, preserving
 * the unconditional-inheritance behaviour the storage uses in phantom-op
 * tests and the empty-root → first-snapshot transition.
 *
 * Exported so unit tests can exercise the predicate / link / transitivity
 * branches in isolation; `createSnapshot` is the sole production caller.
 */
export function computeStaleResultOps(prev: WorkflowContent, curr: WorkflowContent): Set<string> {
  const stale = new Set<string>();
  if (curr.operators.length === 0 || prev.operators.length === 0) return stale;

  const prevOps = new Map<string, OperatorPredicate>();
  for (const op of prev.operators) prevOps.set(op.operatorID, op);

  // (1)+(2): direct predicate changes or freshly-added operators.
  for (const op of curr.operators) {
    const before = prevOps.get(op.operatorID);
    if (!before || !operatorPredicateEqual(before, op)) {
      stale.add(op.operatorID);
    }
  }

  // (3): incoming-link set differs even though the operator itself is
  // unchanged. The cached result was produced against a different upstream
  // topology and would no longer reflect this snapshot.
  const prevIn = collectIncomingEdgeKeys(prev);
  const currIn = collectIncomingEdgeKeys(curr);
  for (const op of curr.operators) {
    if (stale.has(op.operatorID)) continue;
    const a = prevIn.get(op.operatorID);
    const b = currIn.get(op.operatorID);
    if (!sortedArrayEqual(a, b)) stale.add(op.operatorID);
  }

  // (4): transitive descendants in `curr`'s DAG.
  if (stale.size === 0) return stale;
  const childrenOf = new Map<string, string[]>();
  for (const link of curr.links) {
    const list = childrenOf.get(link.source.operatorID) ?? [];
    list.push(link.target.operatorID);
    childrenOf.set(link.source.operatorID, list);
  }
  const queue: string[] = [...stale];
  while (queue.length > 0) {
    const opId = queue.shift()!;
    for (const downstream of childrenOf.get(opId) ?? []) {
      if (!stale.has(downstream)) {
        stale.add(downstream);
        queue.push(downstream);
      }
    }
  }
  return stale;
}

/**
 * Equality predicate over the fields of `OperatorPredicate` that affect
 * execution. UI-only fields (`customDisplayName`, `viewResult`,
 * `markedForReuse`, `showAdvanced`) are intentionally ignored — toggling
 * them on the dashboard should not blow away a perfectly good cached
 * result. Uses `JSON.stringify` deep-compare on the nested shape fields;
 * the agent constructs these objects programmatically so key ordering is
 * deterministic in practice (matches the pattern in `context-utils.ts`'s
 * `computeDelta`).
 */
function operatorPredicateEqual(a: OperatorPredicate, b: OperatorPredicate): boolean {
  if (a.operatorType !== b.operatorType) return false;
  if (a.operatorVersion !== b.operatorVersion) return false;
  if (!!a.isDisabled !== !!b.isDisabled) return false;
  if (JSON.stringify(a.operatorProperties) !== JSON.stringify(b.operatorProperties)) return false;
  if (JSON.stringify(a.inputPorts) !== JSON.stringify(b.inputPorts)) return false;
  if (JSON.stringify(a.outputPorts) !== JSON.stringify(b.outputPorts)) return false;
  if (JSON.stringify(a.nativeOp) !== JSON.stringify(b.nativeOp)) return false;
  return true;
}

function collectIncomingEdgeKeys(wf: WorkflowContent): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const link of wf.links) {
    const key = `${link.source.operatorID}:${link.source.portID}→${link.target.portID}`;
    const list = m.get(link.target.operatorID) ?? [];
    list.push(key);
    m.set(link.target.operatorID, list);
  }
  for (const list of m.values()) list.sort();
  return m;
}

function sortedArrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const av = a ?? [];
  const bv = b ?? [];
  if (av.length !== bv.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

/** Every operator `operatorId` reads from, directly or through its inputs. */
function upstreamOf(workflow: WorkflowContent, operatorId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [operatorId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const link of workflow.links)
      if (link.target.operatorID === id && !seen.has(link.source.operatorID)) {
        seen.add(link.source.operatorID);
        stack.push(link.source.operatorID);
      }
  }
  return seen;
}
