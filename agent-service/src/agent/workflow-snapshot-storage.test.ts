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

import { describe, expect, test } from "bun:test";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";

function makeOperatorInfo(opId: string, rows: number): OperatorInfo {
  return {
    operatorID: opId,
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows,
    inputPortShapes: undefined,
    totalRowCount: rows,
    result: undefined,
  } as unknown as OperatorInfo;
}

function emptyWorkflow(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

function makeWorkflow(operatorIds: string[]): WorkflowContent {
  return {
    operators: operatorIds.map(
      id =>
        ({
          operatorID: id,
          operatorType: "TestOp",
          operatorVersion: "1",
          operatorProperties: {},
          inputPorts: [],
          outputPorts: [],
          showAdvanced: false,
        }) as any
    ),
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

// ReAct tree: A → B → C   and   A → D (sibling of B).
function makeAbcdPath() {
  return (stepId: string): string[] => {
    const parents: Record<string, string> = { A: "", B: "A", C: "B", D: "A" };
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = parents[cur] || undefined;
    }
    return chain;
  };
}

describe("WorkflowSnapshotStorage — snapshot tree shape", () => {
  test("the first createSnapshot lands under the empty root and is indexed under its ReAct step", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    const rootId = s.getRootSnapshotId();
    const snap = s.createSnapshot("A", makeWorkflow(["op1"]));

    expect(snap.parentId).toBe(rootId);
    expect(snap.reactStepId).toBe("A");
    expect(snap.workflow.operators[0]?.operatorID).toBe("op1");
    expect(s.hasSnapshotFor("A")).toBe(true);
    expect(s.getSnapshotById(snap.id)?.reactStepId).toBe("A");
  });

  test("createSnapshot on a descendant action-bearing step points its parentId at the nearest action-bearing ancestor", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    const a = s.createSnapshot("A", makeWorkflow(["op1"]));
    // B is action-less in this scenario (no snapshot created at B), so C's
    // parent snapshot is A — not the missing snapshot at B.
    const c = s.createSnapshot("C", makeWorkflow(["op1", "op2"]));

    expect(c.parentId).toBe(a.id);
    expect(s.hasSnapshotFor("B")).toBe(false);
  });

  test("siblings each get their own snapshot rooted at the shared ancestor", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    const a = s.createSnapshot("A", makeWorkflow(["op1"]));
    const b = s.createSnapshot("B", makeWorkflow(["op1", "op_b"]));
    const d = s.createSnapshot("D", makeWorkflow(["op1", "op_d"]));

    expect(b.parentId).toBe(a.id);
    expect(d.parentId).toBe(a.id);
    expect(b.id).not.toBe(d.id);
  });

  test("createSnapshot twice on the same step throws", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", makeWorkflow(["op1"]));
    expect(() => s.createSnapshot("A", makeWorkflow(["op2"]))).toThrow(/already exists/);
  });
});

describe("WorkflowSnapshotStorage — operator results (snapshot-resolved)", () => {
  test("an action-less step inherits its ancestor snapshot's results", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", emptyWorkflow());
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 1));

    // B and C own no snapshot — their associated snapshot is A's.
    expect(s.getOperatorResult("A", "op1")?.totalRowCount).toBe(1);
    expect(s.getOperatorResult("B", "op1")?.totalRowCount).toBe(1);
    expect(s.getOperatorResult("C", "op1")?.totalRowCount).toBe(1);
  });

  test("a child snapshot inherits its parent's results and can override them per-op", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", emptyWorkflow());
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 1));
    s.createSnapshot("B", emptyWorkflow());
    s.setOperatorResult("B", "op1", makeOperatorInfo("op1", 99)); // override

    expect(s.getOperatorResult("A", "op1")?.totalRowCount).toBe(1); // parent untouched
    expect(s.getOperatorResult("B", "op1")?.totalRowCount).toBe(99);
    expect(s.getOperatorResult("C", "op1")?.totalRowCount).toBe(99); // inherited via B
  });

  test("results on a sibling branch are invisible from the other branch", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", emptyWorkflow());
    s.createSnapshot("D", emptyWorkflow());
    s.setOperatorResult("D", "op1", makeOperatorInfo("op1", 42));

    // C is on A→B→C. The branch contains no write for op1.
    expect(s.getOperatorResult("C", "op1")).toBeUndefined();
    expect(s.getOperatorResult("D", "op1")?.totalRowCount).toBe(42);
  });

  test("setOperatorResult on a step without a snapshot throws", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    expect(() => s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 1))).toThrow(/no snapshot owned by this step/);
  });

  test("getResolvedOperatorResult preserves the originating step through inheritance", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", emptyWorkflow());
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 7));
    s.createSnapshot("B", emptyWorkflow()); // B inherits op1 from A by reference

    const fromB = s.getResolvedOperatorResult("B", "op1");
    expect(fromB?.value.totalRowCount).toBe(7);
    expect(fromB?.sourceStepId).toBe("A"); // earned at A, even when read from B

    const fromC = s.getResolvedOperatorResult("C", "op1");
    expect(fromC?.sourceStepId).toBe("A"); // also via the action-less C → B → A walk
  });

  test("getAllVisibleResults emits the merged map of the associated snapshot", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", emptyWorkflow());
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 1));
    s.createSnapshot("B", emptyWorkflow());
    s.setOperatorResult("B", "op2", makeOperatorInfo("op2", 2));
    s.setOperatorResult("B", "op1", makeOperatorInfo("op1", 99)); // shadows A's op1

    const visible = s.getAllVisibleResults("C");
    expect(visible.size).toBe(2);
    expect(visible.get("op1")?.totalRowCount).toBe(99);
    expect(visible.get("op2")?.totalRowCount).toBe(2);
  });
});

describe("WorkflowSnapshotStorage — workflow content", () => {
  test("an action-less step reads its associated snapshot's workflow", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", makeWorkflow(["op1"]));

    // B and C own no snapshot — they read A's.
    expect(s.getWorkflow("A")?.operators.length).toBe(1);
    expect(s.getWorkflow("B")?.operators.length).toBe(1);
    expect(s.getWorkflow("C")?.operators.length).toBe(1);
  });

  test("a nearer snapshot overrides a farther one on the same branch", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", makeWorkflow(["op1"]));
    s.createSnapshot("B", makeWorkflow(["op1", "op2"]));

    expect(s.getWorkflow("A")?.operators.length).toBe(1);
    expect(s.getWorkflow("B")?.operators.length).toBe(2);
    expect(s.getWorkflow("C")?.operators.length).toBe(2); // inherits from B
  });

  test("a snapshot on a sibling branch is invisible", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", makeWorkflow(["op1"]));
    s.createSnapshot("D", makeWorkflow(["op1", "op2", "op3"]));

    expect(s.getWorkflow("C")?.operators.length).toBe(1); // A only
    expect(s.getWorkflow("D")?.operators.length).toBe(3);
  });

  test("getResolvedWorkflow returns the owning snapshot's reactStepId", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    s.createSnapshot("A", makeWorkflow(["op1"]));
    const r = s.getResolvedWorkflow("C");
    expect(r?.value.operators.length).toBe(1);
    expect(r?.sourceStepId).toBe("A");
  });

  test("getWorkflow returns the empty root's workflow when no action-bearing ancestor exists", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    // Reads are total. With no snapshots created, the associated snapshot
    // of any step is the empty root.
    expect(s.getWorkflow("C").operators).toEqual([]);
    const resolved = s.getResolvedWorkflow("C");
    expect(resolved.value.operators).toEqual([]);
    expect(resolved.sourceStepId).toBeUndefined(); // root has no owning step
  });
});

describe("WorkflowSnapshotStorage — empty root", () => {
  test("a fresh storage already contains a root snapshot with empty workflow + empty results", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    const root = s.getRootSnapshot();
    expect(root.parentId).toBeUndefined();
    expect(root.reactStepId).toBeUndefined();
    expect(root.workflow.operators).toEqual([]);
    expect(root.results.size).toBe(0);
    expect(s.getRootSnapshotId()).toBe(root.id);
  });

  test("the first action-bearing step's snapshot points its parentId at the empty root", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    const root = s.getRootSnapshot();
    const a = s.createSnapshot("A", makeWorkflow(["op1"]));
    expect(a.parentId).toBe(root.id);
  });

  test("reading at undefined returns the empty root", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    expect(s.getWorkflow(undefined).operators).toEqual([]);
    expect(s.getAllVisibleResults(undefined).size).toBe(0);
  });

  test("clear() re-allocates a fresh empty root with a new id", () => {
    const s = new WorkflowSnapshotStorage(makeAbcdPath());
    const firstRootId = s.getRootSnapshotId();
    s.createSnapshot("A", makeWorkflow(["op1"]));
    s.clear();
    const secondRootId = s.getRootSnapshotId();
    expect(secondRootId).not.toBe(firstRootId);
    // Step-owned data is gone; reads still resolve to the new root.
    expect(s.hasSnapshotFor("A")).toBe(false);
    expect(s.getWorkflow("A").operators).toEqual([]);
  });
});

describe("WorkflowSnapshotStorage — DAG-staleness behavior", () => {
  // Linear branch S2 → S3 → S5 (S1 and S4 stand in for action-less steps).
  const linearPath = (id: string): string[] => {
    const parents: Record<string, string> = { S1: "", S2: "S1", S3: "S2", S4: "S3", S5: "S4" };
    const chain: string[] = [];
    let cur: string | undefined = id;
    while (cur) {
      chain.unshift(cur);
      cur = parents[cur] || undefined;
    }
    return chain;
  };

  test("middle-op rewrite without downstream re-execution leaves a stale downstream result visible (writer-enforced consistency, by design)", () => {
    // DAG semantics A → B → C. At S3 we have a clean run for all three; at S5
    // the agent rewrites only B's result. C's result at S5's snapshot is
    // inherited from S3 — the storage has no DAG awareness.
    const s = new WorkflowSnapshotStorage(linearPath);
    s.createSnapshot("S3", emptyWorkflow());
    s.setOperatorResult("S3", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("S3", "B", makeOperatorInfo("B", 1));
    s.setOperatorResult("S3", "C", makeOperatorInfo("C", 1));
    s.createSnapshot("S5", emptyWorkflow());
    s.setOperatorResult("S5", "B", makeOperatorInfo("B", 999));

    const visible = s.getAllVisibleResults("S5");
    expect(visible.get("A")?.totalRowCount).toBe(1); // inherited
    expect(visible.get("B")?.totalRowCount).toBe(999); // freshly written at S5
    expect(visible.get("C")?.totalRowCount).toBe(1); // STALE: inherited from S3
    // The storage trusts the writer (TexeraAgent.runPostStepExecution) to keep
    // the DAG consistent by re-executing every descendant. This test pins
    // that invariant: if the writer skips a descendant, the read is stale.
  });

  test("writer also refreshes downstream → no stale result visible", () => {
    const s = new WorkflowSnapshotStorage(linearPath);
    s.createSnapshot("S3", emptyWorkflow());
    s.setOperatorResult("S3", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("S3", "B", makeOperatorInfo("B", 1));
    s.setOperatorResult("S3", "C", makeOperatorInfo("C", 1));
    s.createSnapshot("S5", emptyWorkflow());
    s.setOperatorResult("S5", "B", makeOperatorInfo("B", 999));
    s.setOperatorResult("S5", "C", makeOperatorInfo("C", 9999));

    const visible = s.getAllVisibleResults("S5");
    expect(visible.get("A")?.totalRowCount).toBe(1);
    expect(visible.get("B")?.totalRowCount).toBe(999);
    expect(visible.get("C")?.totalRowCount).toBe(9999); // refreshed → consistent
  });
});

describe("WorkflowSnapshotStorage — housekeeping", () => {
  test("clear() drops every step-owned snapshot and unindexes every step (root is preserved as a fresh empty)", () => {
    const s = new WorkflowSnapshotStorage(() => ["X"]);
    s.createSnapshot("X", makeWorkflow(["op1"]));
    s.setOperatorResult("X", "op1", makeOperatorInfo("op1", 5));
    s.clear();
    // Reads are total — they now resolve to the freshly-allocated empty root.
    expect(s.getWorkflow("X").operators).toEqual([]);
    expect(s.getOperatorResult("X", "op1")).toBeUndefined();
    expect(s.hasSnapshotFor("X")).toBe(false);
  });

  test("pruneOrphans drops snapshots whose owning step is no longer live", () => {
    const s = new WorkflowSnapshotStorage((id: string) => (id === "Y" ? ["X", "Y"] : [id]));
    s.createSnapshot("X", makeWorkflow(["op1"]));
    s.createSnapshot("Y", makeWorkflow(["op2"]));
    s.createSnapshot("Z", makeWorkflow(["op3"])); // orphan

    s.pruneOrphans(new Set(["X", "Y"]));

    // Z no longer owns a snapshot → reads at Z resolve to the empty root.
    expect(s.hasSnapshotFor("Z")).toBe(false);
    expect(s.getWorkflow("Z").operators).toEqual([]);
    expect(s.getWorkflow("Y")?.operators.length).toBe(1); // op2's snapshot kept
    expect(s.getWorkflow("X")?.operators.length).toBe(1);
  });
});
