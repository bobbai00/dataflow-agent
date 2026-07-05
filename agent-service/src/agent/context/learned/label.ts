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
 * TRAINING-ONLY. The `future_use` weak label (context-ml prototype's proven
 * label; pipeline §5.1 tier `y_future_use`): an operator is load-bearing iff it
 * lies in the ancestor-closure of the final answer sink of the FINAL DAG.
 *
 * Computed over the completed trajectory and applied as the label for that op at
 * every earlier step t. This is a LABEL, never a runtime feature — features read
 * state ≤ t only (features-ml.ts leakage rule); this reads the final DAG.
 */

import type { WorkflowContent } from "../../../types/workflow";

function parentsMap(wf: WorkflowContent): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const l of wf.links ?? []) {
    const s = (l as any).source?.operatorID as string | undefined;
    const t = (l as any).target?.operatorID as string | undefined;
    if (!s || !t) continue;
    (parents.get(t) ?? parents.set(t, []).get(t)!).push(s);
    (children.get(s) ?? children.set(s, []).get(s)!).push(t);
  }
  return parents;
}

function childrenMap(wf: WorkflowContent): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const l of wf.links ?? []) {
    const s = (l as any).source?.operatorID as string | undefined;
    const t = (l as any).target?.operatorID as string | undefined;
    if (!s || !t) continue;
    (children.get(s) ?? children.set(s, []).get(s)!).push(t);
  }
  return children;
}

function depthOf(op: string, parents: Map<string, string[]>, memo: Map<string, number>): number {
  if (memo.has(op)) return memo.get(op)!;
  memo.set(op, 0);
  let d = 0;
  for (const p of parents.get(op) ?? []) d = Math.max(d, 1 + depthOf(p, parents, memo));
  memo.set(op, d);
  return d;
}

/**
 * The set of load-bearing operator ids in the final workflow: the ancestor
 * closure (inclusive) of the deepest sink(s). Ties at max depth are unioned so a
 * multi-output answer isn't under-counted.
 */
export function loadBearingOps(finalWorkflow: WorkflowContent): Set<string> {
  const opIds = (finalWorkflow.operators ?? []).map(o => (o as any).operatorID as string).filter(Boolean);
  if (opIds.length === 0) return new Set();
  const parents = parentsMap(finalWorkflow);
  const children = childrenMap(finalWorkflow);

  const sinks = opIds.filter(id => (children.get(id) ?? []).length === 0);
  const pool = sinks.length > 0 ? sinks : opIds; // isolated single op → itself
  const memo = new Map<string, number>();
  let maxDepth = -1;
  for (const s of pool) maxDepth = Math.max(maxDepth, depthOf(s, parents, memo));
  const answerSinks = pool.filter(s => depthOf(s, parents, memo) === maxDepth);

  const bearing = new Set<string>();
  const stack = [...answerSinks];
  while (stack.length) {
    const n = stack.pop()!;
    if (bearing.has(n)) continue;
    bearing.add(n);
    for (const p of parents.get(n) ?? []) if (!bearing.has(p)) stack.push(p);
  }
  return bearing;
}
