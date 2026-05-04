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
        }) as any,
    ),
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

describe("WorkflowSnapshotStorage — operator results (ancestor walk)", () => {
  // Tree: A → B → C   and   A → D (sibling of B).
  const path = (stepId: string): string[] => {
    const parents: Record<string, string> = { A: "", B: "A", C: "B", D: "A" };
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = parents[cur] || undefined;
    }
    return chain;
  };

  test("walks ancestors leaf→root and returns the most recent visible result", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 1));
    s.setOperatorResult("B", "op1", makeOperatorInfo("op1", 99)); // newer on this branch

    expect(s.getOperatorResult("A", "op1")?.totalRowCount).toBe(1);
    expect(s.getOperatorResult("B", "op1")?.totalRowCount).toBe(99);
    expect(s.getOperatorResult("C", "op1")?.totalRowCount).toBe(99); // inherited via B
  });

  test("results on a sibling branch are invisible", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setOperatorResult("D", "op1", makeOperatorInfo("op1", 42)); // sibling-only write

    // C is on the A-B-C branch; it should NOT see D's result.
    expect(s.getOperatorResult("C", "op1")).toBeUndefined();
    expect(s.getOperatorResult("D", "op1")?.totalRowCount).toBe(42);
  });

  test("returns undefined for unknown operators", () => {
    const s = new WorkflowSnapshotStorage(path);
    expect(s.getOperatorResult("A", "missing")).toBeUndefined();
  });

  test("getResolvedOperatorResult exposes the source step", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 7));
    const resolved = s.getResolvedOperatorResult("C", "op1");
    expect(resolved?.value.totalRowCount).toBe(7);
    expect(resolved?.sourceStepId).toBe("A"); // earned at A, inherited at C
  });

  test("getAllVisibleResults emits one entry per operator on the branch", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setOperatorResult("A", "op1", makeOperatorInfo("op1", 1));
    s.setOperatorResult("B", "op2", makeOperatorInfo("op2", 2));
    s.setOperatorResult("B", "op1", makeOperatorInfo("op1", 99)); // shadows A's op1

    const visible = s.getAllVisibleResults("C");
    expect(visible.size).toBe(2);
    expect(visible.get("op1")?.totalRowCount).toBe(99);
    expect(visible.get("op2")?.totalRowCount).toBe(2);
  });
});

describe("WorkflowSnapshotStorage — workflow content (ancestor walk)", () => {
  const path = (stepId: string): string[] => {
    const parents: Record<string, string> = { A: "", B: "A", C: "B", D: "A" };
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = parents[cur] || undefined;
    }
    return chain;
  };

  test("absent workflow at leaf falls back to the nearest ancestor", () => {
    const s = new WorkflowSnapshotStorage(path);
    const wfA = makeWorkflow(["op1"]);
    s.setWorkflow("A", wfA);

    // B and C never recorded a workflow; they inherit A's.
    expect(s.getWorkflow("B")?.operators.length).toBe(1);
    expect(s.getWorkflow("C")?.operators.length).toBe(1);
  });

  test("nearer ancestors override farther ones on the same branch", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setWorkflow("A", makeWorkflow(["op1"]));
    s.setWorkflow("B", makeWorkflow(["op1", "op2"])); // override on path

    expect(s.getWorkflow("A")?.operators.length).toBe(1);
    expect(s.getWorkflow("B")?.operators.length).toBe(2);
    expect(s.getWorkflow("C")?.operators.length).toBe(2); // inherits from B
  });

  test("a workflow stored on a sibling branch is invisible", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setWorkflow("A", makeWorkflow(["op1"]));
    s.setWorkflow("D", makeWorkflow(["op1", "op2", "op3"])); // sibling branch

    expect(s.getWorkflow("C")?.operators.length).toBe(1); // sees A only
    expect(s.getWorkflow("D")?.operators.length).toBe(3);
  });

  test("getResolvedWorkflow exposes the source step", () => {
    const s = new WorkflowSnapshotStorage(path);
    s.setWorkflow("A", makeWorkflow(["op1"]));
    const r = s.getResolvedWorkflow("C");
    expect(r?.value.operators.length).toBe(1);
    expect(r?.sourceStepId).toBe("A");
  });

  test("getWorkflow returns undefined when no ancestor recorded one", () => {
    const s = new WorkflowSnapshotStorage(path);
    expect(s.getWorkflow("C")).toBeUndefined();
  });
});

describe("WorkflowSnapshotStorage — DAG-staleness behavior", () => {
  // Linear branch S2 → S3 → S5 (S1 and S4 are stand-ins for "no snapshot here").
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

  test("middle-op rewrite without re-executing downstream leaves a STALE downstream result visible (writer-enforced consistency, by design)", () => {
    // DAG semantics A → B → C. At S3 we have a clean run for all three; at S5
    // the agent rewrites only B's result. C's snapshot at S3 is now logically
    // outdated, but the storage has no DAG awareness — it inherits C from S3.
    const s = new WorkflowSnapshotStorage(linearPath);
    s.setOperatorResult("S3", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("S3", "B", makeOperatorInfo("B", 1));
    s.setOperatorResult("S3", "C", makeOperatorInfo("C", 1));
    s.setOperatorResult("S5", "B", makeOperatorInfo("B", 999));

    const visible = s.getAllVisibleResults("S5");
    expect(visible.get("A")?.totalRowCount).toBe(1); // upstream — correctly inherited
    expect(visible.get("B")?.totalRowCount).toBe(999); // freshly written at S5
    expect(visible.get("C")?.totalRowCount).toBe(1); // STALE: inherited from S3
    // The storage trusts the writer (TexeraAgent.runPostStepExecution) to keep
    // the DAG consistent by re-executing every descendant. This test pins
    // that invariant: if the writer skips a descendant, the read is stale.
  });

  test("writer also refreshes downstream → no stale result visible", () => {
    const s = new WorkflowSnapshotStorage(linearPath);
    s.setOperatorResult("S3", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("S3", "B", makeOperatorInfo("B", 1));
    s.setOperatorResult("S3", "C", makeOperatorInfo("C", 1));
    // Same as above, but now S5 also writes a fresh C — mirrors what
    // runPostStepExecution does when it walks downstream sinks.
    s.setOperatorResult("S5", "B", makeOperatorInfo("B", 999));
    s.setOperatorResult("S5", "C", makeOperatorInfo("C", 9999));

    const visible = s.getAllVisibleResults("S5");
    expect(visible.get("A")?.totalRowCount).toBe(1);
    expect(visible.get("B")?.totalRowCount).toBe(999);
    expect(visible.get("C")?.totalRowCount).toBe(9999); // refreshed → consistent
  });
});

describe("WorkflowSnapshotStorage — housekeeping", () => {
  test("clear() drops everything", () => {
    const s = new WorkflowSnapshotStorage(() => ["X"]);
    s.setWorkflow("X", makeWorkflow(["op1"]));
    s.setOperatorResult("X", "op1", makeOperatorInfo("op1", 5));
    s.clear();
    expect(s.getWorkflow("X")).toBeUndefined();
    expect(s.getOperatorResult("X", "op1")).toBeUndefined();
  });

  test("pruneOrphans drops snapshots whose stepId is no longer live", () => {
    const s = new WorkflowSnapshotStorage(() => ["X", "Y"]);
    s.setWorkflow("X", makeWorkflow(["op1"]));
    s.setWorkflow("Y", makeWorkflow(["op2"]));
    s.setWorkflow("Z", makeWorkflow(["op3"])); // orphan

    s.pruneOrphans(new Set(["X", "Y"]));

    // Use the same walker for these reads — Y returns Y's, X returns X's, Z is gone.
    const walkerY = new WorkflowSnapshotStorage((id: string) => (id === "Y" ? ["X", "Y"] : [id]));
    walkerY.setWorkflow("X", makeWorkflow(["op1"]));
    walkerY.setWorkflow("Y", makeWorkflow(["op2"]));
    walkerY.setWorkflow("Z", makeWorkflow(["op3"]));
    walkerY.pruneOrphans(new Set(["X", "Y"]));

    expect(walkerY.getWorkflow("Z")).toBeUndefined();
    expect(walkerY.getWorkflow("Y")?.operators.length).toBe(1); // op2's snapshot kept
    expect(walkerY.getWorkflow("X")?.operators.length).toBe(1);
  });
});
