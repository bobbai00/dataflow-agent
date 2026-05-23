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

import { useMemo } from "react";
import type { SnapshotTreeNode, SnapshotTreeResponse } from "../types";

/**
 * Hierarchical view of `WorkflowSnapshotStorage`. Each row is a snapshot;
 * the empty root sits at depth 0, and step-owned snapshots descend from it
 * in `parentId` order. Clicking a row uses the snapshot's `reactStepId`
 * (or `"head"` for the empty root) to drive the same selection state the
 * linear list uses, so the right-pane DAG + detail follow along.
 */
export function SnapshotTree({
  tree,
  selectedStepId,
  onSelect,
}: {
  tree: SnapshotTreeResponse | null;
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
}) {
  const rows = useMemo(() => (tree ? layoutTree(tree) : []), [tree]);
  if (!tree) return <div className="muted" style={{ padding: "1rem" }}>No tree available.</div>;
  if (rows.length === 0) return <div className="muted" style={{ padding: "1rem" }}>Empty.</div>;

  return (
    <div className="snap-tree">
      {rows.map(({ node, depth }) => {
        const isRoot = !node.parentId;
        const stepHandle = node.reactStepId ?? "head";
        const isActive = node.reactStepId === selectedStepId;
        return (
          <div
            key={node.id}
            className={`snap-tree-node ${isActive ? "active" : ""}`}
            style={{ marginLeft: depth * 14 }}
            onClick={() => onSelect(stepHandle)}
            title={`snapshot ${node.id}`}
          >
            <div>
              {"".padStart(depth, "·")} {isRoot ? "root" : node.reactStepId}
            </div>
            <div className="meta">
              ops {node.operatorCount} · results {node.resultCount}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Row {
  node: SnapshotTreeNode;
  depth: number;
}

/**
 * Depth-first walk from the root. Children are sorted by their snapshot
 * id, which is monotonically increasing (`snap-<n>-<ts>`) — close enough
 * to creation order to make branches read top-to-bottom in the order they
 * were taken.
 */
function layoutTree(tree: SnapshotTreeResponse): Row[] {
  const byParent = new Map<string | undefined, SnapshotTreeNode[]>();
  for (const n of tree.nodes) {
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.id.localeCompare(b.id));

  const out: Row[] = [];
  const stack: Array<{ node: SnapshotTreeNode; depth: number }> = [];
  const roots = byParent.get(undefined) ?? [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 0 });
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    out.push({ node, depth });
    const children = byParent.get(node.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: depth + 1 });
    }
  }
  return out;
}
