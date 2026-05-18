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

import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, OperatorLink } from "../../types/workflow";

/**
 * One independent execution group. The execution layer turns each group
 * into its own sync request, so a failure inside one group cannot stop
 * execution of another (Amber's controller stops *all* sibling workers
 * on any worker failure — `AllForOneStrategy` in Controller.scala — so
 * the only way to keep independent ops alive on failure is to issue
 * them in separate workflow executions).
 */
export interface PartitionGroup {
  /** The subset of the caller's opsToView that belong to this group. */
  opsToView: string[];
  /**
   * The merged upstream-closure across `opsToView`. This is the set of
   * operators (+ links) the backend must execute in order to produce
   * results for every member of `opsToView`. Multiple group members
   * share upstreams *only* when those upstreams are necessary for at
   * least one of them — that's precisely the "shared" condition that
   * forced them into the same group.
   */
  subDAG: { operators: OperatorPredicate[]; links: OperatorLink[] };
}

/**
 * Partition a set of "ops to view" into independent execution groups.
 *
 * Two ops belong to the same group iff their upstream closures (as
 * returned by `WorkflowState.getSubDAG`) intersect — i.e. they share
 * at least one ancestor operator. Sharing an ancestor means the
 * backend must run that ancestor regardless, and the two ops cannot
 * be split without re-executing the shared work; equally important,
 * if the shared ancestor errors, both ops are blocked anyway, so the
 * partition wouldn't buy independence in the first place.
 *
 * If two ops have completely disjoint upstream closures, they can be
 * scheduled as separate workflow executions; the worker-supervisor
 * scope in Amber is per-controller, so distinct executions tolerate
 * each other's failures.
 *
 * Algorithm:
 *   1. Compute each op's upstream-closure (as a Set of operator IDs).
 *   2. Union-find merge for every pair whose closures intersect.
 *   3. Per group, take the union of member closures (operators dedup
 *      by `operatorID`, links dedup by their endpoints).
 *
 * Edge cases:
 *   - `opsToView` empty → returns `[]`.
 *   - `opsToView` has 1 entry → returns one group with that op's
 *     own subDAG (preserves the existing single-op execution path).
 *   - Op id not present in the workflow → silently skipped (matches
 *     the behavior in `buildLogicalPlan` which filters unknown ids
 *     against the operator list).
 */
export function partitionOpsByIndependence(
  workflowState: WorkflowState,
  opsToView: string[]
): PartitionGroup[] {
  if (opsToView.length === 0) return [];

  // Resolve each op's upstream-closure once. `getSubDAG` walks
  // upstream from the target, returning every reachable enabled
  // operator and the links connecting them.
  const closures = new Map<string, { operators: OperatorPredicate[]; links: OperatorLink[]; ids: Set<string> }>();
  const validOps: string[] = [];
  for (const opId of opsToView) {
    if (!workflowState.getOperator(opId)) continue; // unknown id
    const sub = workflowState.getSubDAG(opId);
    closures.set(opId, {
      operators: sub.operators,
      links: sub.links,
      ids: new Set(sub.operators.map(o => o.operatorID)),
    });
    validOps.push(opId);
  }
  if (validOps.length === 0) return [];

  // Union-find. Path-compress on read; union by destination.
  const parent = new Map<string, string>();
  for (const op of validOps) parent.set(op, op);
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    // Path compression
    let walker = x;
    while (parent.get(walker) !== cur) {
      const next = parent.get(walker)!;
      parent.set(walker, cur);
      walker = next;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < validOps.length; i++) {
    for (let j = i + 1; j < validOps.length; j++) {
      const a = validOps[i];
      const b = validOps[j];
      // Already in the same group — skip the intersection check.
      if (find(a) === find(b)) continue;
      const idsA = closures.get(a)!.ids;
      const idsB = closures.get(b)!.ids;
      // Iterate the smaller set for O(min) intersection check.
      const [smaller, larger] = idsA.size <= idsB.size ? [idsA, idsB] : [idsB, idsA];
      let touched = false;
      for (const id of smaller) {
        if (larger.has(id)) {
          touched = true;
          break;
        }
      }
      if (touched) union(a, b);
    }
  }

  // Bucket members by their group root, preserving the caller's
  // original order so the partition is deterministic.
  const buckets = new Map<string, string[]>();
  for (const op of validOps) {
    const root = find(op);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root)!.push(op);
  }

  // Each group: union of member closures, deduplicated.
  const groups: PartitionGroup[] = [];
  for (const opsInGroup of buckets.values()) {
    const operators = new Map<string, OperatorPredicate>();
    const links = new Map<string, OperatorLink>();
    for (const op of opsInGroup) {
      const c = closures.get(op)!;
      for (const o of c.operators) operators.set(o.operatorID, o);
      for (const l of c.links) {
        // Key on (linkID) when available, else on the (src,srcPort,tgt,tgtPort)
        // quad — the linkID is unique within a workflow, but defensive in case
        // a getSubDAG impl returns synthesized link objects.
        const key =
          l.linkID ||
          `${l.source.operatorID}:${l.source.portID}->${l.target.operatorID}:${l.target.portID}`;
        if (!links.has(key)) links.set(key, l);
      }
    }
    groups.push({
      opsToView: opsInGroup,
      subDAG: {
        operators: [...operators.values()],
        links: [...links.values()],
      },
    });
  }
  return groups;
}
