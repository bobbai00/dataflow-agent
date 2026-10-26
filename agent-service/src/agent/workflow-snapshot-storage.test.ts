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
import { WorkflowSnapshotStorage, computeStaleResultOps } from "./workflow-snapshot-storage";
import type { OperatorInfo } from "../types/execution";
import type { OperatorLink, WorkflowContent } from "../types/workflow";

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

describe("immutable native definitions across snapshots", () => {
  function nativeWorkflow() {
    const workflow = makeWorkflow(["source", "summary"]);
    for (const op of workflow.operators) {
      op.operatorProperties.code = `# ${op.operatorID}\n${"# generated runtime\n".repeat(6000)}`;
      (op as any).nativeOp = {
        type: "Scan",
        source: `scan("${op.operatorID}.csv")`,
        revision: op.operatorID,
        properties: {},
      } as any;
    }
    return workflow;
  }

  test("unchanged native definitions are shared while caller-owned graphs stay independent", () => {
    const store = new WorkflowSnapshotStorage(makeAbcdPath());
    const input = nativeWorkflow();
    const first = store.createSnapshot("A", input);
    const secondInput = {
      ...structuredClone(input),
      operatorPositions: { source: { x: 100, y: 200 } },
    };
    const second = store.createSnapshot("B", secondInput);
    expect(second.workflow).toEqual(secondInput);
    expect(second.workflow).not.toBe(first.workflow);
    for (let i = 0; i < input.operators.length; i++) {
      expect(second.workflow.operators[i] === first.workflow.operators[i]).toBe(true);
      expect(Object.isFrozen(first.workflow.operators[i].operatorProperties)).toBe(true);
      expect(first.workflow.operators[i]).not.toBe(input.operators[i]);
    }
    secondInput.operators[0].operatorProperties.code = "caller mutation";
    secondInput.operatorPositions.source.x = 999;
    expect(second.workflow.operators[0].operatorProperties.code).not.toBe("caller mutation");
    expect(second.workflow.operatorPositions.source.x).toBe(100);
    expect(first.workflow.operatorPositions).toEqual({});
  });

  test("changed definitions get their own immutable copy on creation and during a pending edit", () => {
    const store = new WorkflowSnapshotStorage(makeAbcdPath());
    const input = nativeWorkflow();
    const first = store.createSnapshot("A", input);
    const original = JSON.stringify(first.workflow);
    const edited = structuredClone(input);
    edited.operators[0].operatorProperties.code = "changed source";
    edited.operators[0].nativeOp!.revision = "source-v2";
    const second = store.createSnapshot("B", edited);
    expect(second.workflow).toEqual(edited);
    expect(second.workflow.operators[0]).not.toBe(first.workflow.operators[0]);
    expect(second.workflow.operators[1] === first.workflow.operators[1]).toBe(true);
    const secondSource = second.workflow.operators[0];
    edited.operators[1].operatorProperties.code = "changed summary";
    edited.operators[1].nativeOp!.revision = "summary-v2";
    store.updatePendingWorkflow("B", edited);
    expect(second.workflow).toEqual(edited);
    expect(second.workflow.operators[0] === secondSource).toBe(true);
    expect(second.workflow.operators[1]).not.toBe(first.workflow.operators[1]);
    expect(JSON.stringify(first.workflow)).toBe(original);
    expect(() => {
      first.workflow.operators[1].operatorProperties.code = "illegal mutation";
    }).toThrow();
    edited.operators[1].operatorProperties.code = "later caller mutation";
    expect(second.workflow.operators[1].operatorProperties.code).toBe("changed summary");
  });

  test("mutable legacy definitions are never shared between snapshots", () => {
    const store = new WorkflowSnapshotStorage(makeAbcdPath());
    const input = makeWorkflow(["source"]);
    const first = store.createSnapshot("A", input);
    const second = store.createSnapshot("B", input);
    expect(second.workflow.operators[0]).not.toBe(first.workflow.operators[0]);
    first.workflow.operators[0].operatorProperties.code = "legacy mutation";
    expect(second.workflow.operators[0].operatorProperties.code).toBeUndefined();
  });
});

describe("WorkflowSnapshotStorage — snapshot tree shape", () => {
  test("stored result bodies cannot be mutated through a caller-owned reference", () => {
    const storage = new WorkflowSnapshotStorage(makeAbcdPath());
    storage.createSnapshot("A", makeWorkflow(["op1"]));
    const info = { ...makeOperatorInfo("op1", 1), result: [{ x: 1 }], resultMetadata: { reserved: "frozen" } };
    storage.setOperatorResult("A", "op1", info);
    storage.createSnapshot("B", makeWorkflow(["op1"]));
    info.result[0].x = 999;
    info.resultMetadata.reserved = "changed";
    expect(storage.getOperatorResult("A", "op1")!.result![0].x).toBe(1);
    expect(storage.getOperatorResult("B", "op1")!.resultMetadata).toEqual({ reserved: "frozen" });
  });
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

/**
 * Helpers for the DAG-aware inheritance tests.
 *
 * Operators are constructed with two input ports and one output port so the
 * tests can assemble arbitrary chains via `linksFromChain` without each test
 * having to spell out port descriptions.
 */
function makeDagWorkflow(opSpecs: Array<{ id: string; props?: Record<string, any> }>, links: OperatorLink[] = []): WorkflowContent {
  return {
    operators: opSpecs.map(
      ({ id, props }) =>
        ({
          operatorID: id,
          operatorType: "TestOp",
          operatorVersion: "1",
          operatorProperties: props ?? {},
          inputPorts: [
            { portID: "in-0", displayName: "in-0", disallowMultiInputs: true, isDynamicPort: false },
            { portID: "in-1", displayName: "in-1", disallowMultiInputs: true, isDynamicPort: true },
          ],
          outputPorts: [{ portID: "out-0", displayName: "out-0" }],
          showAdvanced: false,
        }) as any
    ),
    operatorPositions: {},
    links,
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

function link(sourceOp: string, targetOp: string, targetPort: "in-0" | "in-1" = "in-0", linkId?: string): OperatorLink {
  return {
    linkID: linkId ?? `${sourceOp}-${targetOp}-${targetPort}`,
    source: { operatorID: sourceOp, portID: "out-0" },
    target: { operatorID: targetOp, portID: targetPort },
  };
}

// ReAct chain helper: parent stepId followed by child stepId. Mirrors the
// linear-branch style of the existing `linearPath` helper.
function chainPath(parent: string, child: string) {
  return (id: string): string[] => (id === child ? [parent, child] : id === parent ? [parent] : [id]);
}

describe("WorkflowSnapshotStorage — DAG-aware inheritance (tight accuracy)", () => {
  test("identical workflow → every parent result inherits", () => {
    const s = new WorkflowSnapshotStorage(chainPath("P", "C"));
    const wf = makeDagWorkflow([{ id: "A" }, { id: "B" }], [link("A", "B")]);
    s.createSnapshot("P", wf);
    s.setOperatorResult("P", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("P", "B", makeOperatorInfo("B", 2));

    s.createSnapshot("C", wf);

    expect(s.getOperatorResult("C", "A")?.totalRowCount).toBe(1);
    expect(s.getOperatorResult("C", "B")?.totalRowCount).toBe(2);
  });

  test("operator's own properties change → its entry drops; siblings inherit", () => {
    const s = new WorkflowSnapshotStorage(chainPath("P", "C"));
    // A → B; A → D. B and D are siblings (both consume A).
    const wfP = makeDagWorkflow(
      [{ id: "A" }, { id: "B", props: { code: "v1" } }, { id: "D" }],
      [link("A", "B"), link("A", "D")]
    );
    s.createSnapshot("P", wfP);
    s.setOperatorResult("P", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("P", "B", makeOperatorInfo("B", 2));
    s.setOperatorResult("P", "D", makeOperatorInfo("D", 3));

    const wfC = makeDagWorkflow(
      [{ id: "A" }, { id: "B", props: { code: "v2" } }, { id: "D" }],
      [link("A", "B"), link("A", "D")]
    );
    s.createSnapshot("C", wfC);

    expect(s.getOperatorResult("C", "A")?.totalRowCount).toBe(1);
    expect(s.getOperatorResult("C", "B")).toBeUndefined(); // own props changed
    expect(s.getOperatorResult("C", "D")?.totalRowCount).toBe(3); // unrelated sibling
  });

  test("modifying an upstream invalidates the whole transitive downstream", () => {
    const s = new WorkflowSnapshotStorage(chainPath("P", "C"));
    // A → B → C2 (named C2 to avoid colliding with the stepId "C")
    const wfP = makeDagWorkflow(
      [{ id: "A", props: { code: "v1" } }, { id: "B" }, { id: "C2" }],
      [link("A", "B"), link("B", "C2")]
    );
    s.createSnapshot("P", wfP);
    s.setOperatorResult("P", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("P", "B", makeOperatorInfo("B", 2));
    s.setOperatorResult("P", "C2", makeOperatorInfo("C2", 3));

    const wfC = makeDagWorkflow(
      [{ id: "A", props: { code: "v2" } }, { id: "B" }, { id: "C2" }],
      [link("A", "B"), link("B", "C2")]
    );
    s.createSnapshot("C", wfC);

    expect(s.getOperatorResult("C", "A")).toBeUndefined();
    expect(s.getOperatorResult("C", "B")).toBeUndefined();
    expect(s.getOperatorResult("C", "C2")).toBeUndefined();
  });

  test("legal-hard-2 shape: upstream modified, downstream sinks no longer leak stale 'Executed' entry", () => {
    // metroStats → processIdentityTheft → {findMaxRate, inspectMerged}.
    // Reproduces the precise topology of legal-hard-2 at step 21 → step 22.
    const s = new WorkflowSnapshotStorage(chainPath("S21", "S22"));
    const wfS21 = makeDagWorkflow(
      [
        { id: "metroStats", props: { code: "v1" } },
        { id: "identityTheftCSVs" },
        { id: "processIdentityTheft" },
        { id: "findMaxRate" },
        { id: "inspectMerged" },
      ],
      [
        link("metroStats", "processIdentityTheft", "in-0"),
        link("identityTheftCSVs", "processIdentityTheft", "in-1"),
        link("processIdentityTheft", "findMaxRate"),
        link("processIdentityTheft", "inspectMerged"),
      ]
    );
    s.createSnapshot("S21", wfS21);
    s.setOperatorResult("S21", "metroStats", makeOperatorInfo("metroStats", 387));
    s.setOperatorResult("S21", "identityTheftCSVs", makeOperatorInfo("identityTheftCSVs", 764));
    s.setOperatorResult("S21", "processIdentityTheft", makeOperatorInfo("processIdentityTheft", 452));
    s.setOperatorResult("S21", "findMaxRate", makeOperatorInfo("findMaxRate", 0));
    s.setOperatorResult("S21", "inspectMerged", makeOperatorInfo("inspectMerged", 4));

    // Step 22: agent rewrites metroStats (new buggy code).
    const wfS22 = makeDagWorkflow(
      [
        { id: "metroStats", props: { code: "v2-buggy" } },
        { id: "identityTheftCSVs" },
        { id: "processIdentityTheft" },
        { id: "findMaxRate" },
        { id: "inspectMerged" },
      ],
      wfS21.links as OperatorLink[]
    );
    s.createSnapshot("S22", wfS22);

    // identityTheftCSVs is on a parallel branch — survives.
    expect(s.getOperatorResult("S22", "identityTheftCSVs")?.totalRowCount).toBe(764);
    // metroStats was edited → entry dropped (writer will rewrite it).
    expect(s.getOperatorResult("S22", "metroStats")).toBeUndefined();
    // processIdentityTheft is downstream of metroStats → dropped.
    expect(s.getOperatorResult("S22", "processIdentityTheft")).toBeUndefined();
    // findMaxRate / inspectMerged are downstream of processIdentityTheft → dropped.
    expect(s.getOperatorResult("S22", "findMaxRate")).toBeUndefined();
    expect(s.getOperatorResult("S22", "inspectMerged")).toBeUndefined();
  });

  test("rewiring an in-edge invalidates the target chain even if predicates are byte-equal", () => {
    const s = new WorkflowSnapshotStorage(chainPath("P", "C"));
    // Parent: A → C2. Child: A → B → C2 (link rerouted; B added).
    const wfP = makeDagWorkflow([{ id: "A" }, { id: "C2" }], [link("A", "C2")]);
    s.createSnapshot("P", wfP);
    s.setOperatorResult("P", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("P", "C2", makeOperatorInfo("C2", 2));

    const wfC = makeDagWorkflow([{ id: "A" }, { id: "B" }, { id: "C2" }], [link("A", "B"), link("B", "C2")]);
    s.createSnapshot("C", wfC);

    expect(s.getOperatorResult("C", "A")?.totalRowCount).toBe(1); // unchanged
    expect(s.getOperatorResult("C", "B")).toBeUndefined(); // newly added
    expect(s.getOperatorResult("C", "C2")).toBeUndefined(); // in-edge changed
  });

  test("deleting an operator does not affect unrelated branches", () => {
    const s = new WorkflowSnapshotStorage(chainPath("P", "C"));
    // Parent: A → B; D standalone. Child: D only (A and B deleted, link gone).
    const wfP = makeDagWorkflow([{ id: "A" }, { id: "B" }, { id: "D" }], [link("A", "B")]);
    s.createSnapshot("P", wfP);
    s.setOperatorResult("P", "A", makeOperatorInfo("A", 1));
    s.setOperatorResult("P", "B", makeOperatorInfo("B", 2));
    s.setOperatorResult("P", "D", makeOperatorInfo("D", 3));

    const wfC = makeDagWorkflow([{ id: "D" }], []);
    s.createSnapshot("C", wfC);

    expect(s.getOperatorResult("C", "D")?.totalRowCount).toBe(3); // unrelated, kept
  });

  test("empty parent → child workflow: every freshly-added op is stale (no parent entries to inherit)", () => {
    const s = new WorkflowSnapshotStorage(chainPath("P", "C"));
    // Parent has an empty workflow (typical for the first action-bearing step
    // after the empty root).
    s.createSnapshot("P", emptyWorkflow());
    // Child introduces A → B.
    const wfC = makeDagWorkflow([{ id: "A" }, { id: "B" }], [link("A", "B")]);
    s.createSnapshot("C", wfC);

    expect(s.getOperatorResult("C", "A")).toBeUndefined();
    expect(s.getOperatorResult("C", "B")).toBeUndefined();
  });
});

describe("computeStaleResultOps — unit tests", () => {
  test("returns empty when both workflows are empty", () => {
    expect(computeStaleResultOps(emptyWorkflow(), emptyWorkflow()).size).toBe(0);
  });

  test("returns empty when workflows are identical", () => {
    const wf = makeDagWorkflow([{ id: "A" }, { id: "B" }], [link("A", "B")]);
    expect(computeStaleResultOps(wf, wf).size).toBe(0);
  });

  test("marks modified op and its transitive downstream", () => {
    const prev = makeDagWorkflow(
      [{ id: "A", props: { code: "v1" } }, { id: "B" }, { id: "C2" }],
      [link("A", "B"), link("B", "C2")]
    );
    const curr = makeDagWorkflow(
      [{ id: "A", props: { code: "v2" } }, { id: "B" }, { id: "C2" }],
      [link("A", "B"), link("B", "C2")]
    );
    expect(computeStaleResultOps(prev, curr)).toEqual(new Set(["A", "B", "C2"]));
  });

  test("does not mark siblings unrelated to the change", () => {
    const prev = makeDagWorkflow(
      [{ id: "A" }, { id: "B", props: { code: "v1" } }, { id: "D" }],
      [link("A", "B"), link("A", "D")]
    );
    const curr = makeDagWorkflow(
      [{ id: "A" }, { id: "B", props: { code: "v2" } }, { id: "D" }],
      [link("A", "B"), link("A", "D")]
    );
    const stale = computeStaleResultOps(prev, curr);
    expect(stale.has("B")).toBe(true);
    expect(stale.has("D")).toBe(false);
    expect(stale.has("A")).toBe(false);
  });

  test("ignores UI-only field changes (customDisplayName)", () => {
    const op = (extra: Record<string, any>) => ({
      operatorID: "A",
      operatorType: "TestOp",
      operatorVersion: "1",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      ...extra,
    });
    const prev: WorkflowContent = {
      operators: [op({ customDisplayName: "alpha" }) as any],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    const curr: WorkflowContent = {
      operators: [op({ customDisplayName: "beta" }) as any],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    expect(computeStaleResultOps(prev, curr).size).toBe(0);
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

describe("WorkflowSnapshotStorage — results off HEAD's path on disk", () => {
  // init → A → B on one branch, init → C on another.
  const parents: Record<string, string | undefined> = { init: undefined, A: "init", B: "A", C: "init" };
  const path = (stepId: string): string[] => {
    const chain: string[] = [];
    for (let id: string | undefined = stepId; id; id = parents[id]) chain.push(id);
    return chain.reverse();
  };
  const withRows = (opId: string, rows: number) =>
    ({
      ...makeOperatorInfo(opId, rows),
      result: Array.from({ length: rows }, (_, i) => ({ i, text: `row ${i}` })),
    }) as OperatorInfo;

  function tree() {
    const storage = new WorkflowSnapshotStorage(path);
    storage.createSnapshot("init", emptyWorkflow());
    storage.createSnapshot("A", makeWorkflow(["a"]));
    storage.setOperatorResult("A", "a", withRows("a", 3));
    storage.createSnapshot("B", makeWorkflow(["a", "b"]));
    storage.setOperatorResult("B", "b", withRows("b", 5));
    storage.createSnapshot("C", makeWorkflow(["c"]));
    storage.setOperatorResult("C", "c", withRows("c", 7));
    return storage;
  }

  test("compact keeps the path's results in memory and writes the others to disk", () => {
    const storage = tree();
    expect(storage.residencyStats()).toEqual({ resident: 3, results: 3, spilledBytes: 0 });
    storage.compact(storage.getAssociatedSnapshot("C").id);
    const stats = storage.residencyStats();
    expect(stats.resident).toBe(1);
    expect(stats.spilledBytes).toBeGreaterThan(0);
  });

  test("a result on disk reads back as it was, frozen, and its provenance stays", () => {
    const storage = tree();
    storage.compact(storage.getAssociatedSnapshot("C").id);
    const back = storage.getOperatorResult("B", "b")!;
    expect(back.result).toEqual(withRows("b", 5).result);
    expect(Object.isFrozen(back)).toBe(true);
    expect(storage.getResolvedOperatorResult("B", "a")?.sourceStepId).toBe("A");
    // Read back, it stays until the next compact decides.
    expect(storage.getOperatorResult("B", "b")).toBe(back);
    storage.compact(storage.getAssociatedSnapshot("C").id);
    expect(storage.getOperatorResult("B", "b")).not.toBe(back);
  });

  test("the version tree marks failed runs without reading results back from disk", () => {
    const storage = tree();
    storage.compact(storage.getAssociatedSnapshot("C").id);
    const resident = storage.residencyStats().resident;
    storage.getSnapshotTreeNodes();
    expect(storage.residencyStats().resident).toBe(resident);
  });

  test("moving HEAD to the other branch lets the first branch go and keeps what the new path reads", () => {
    const storage = tree();
    storage.compact(storage.getAssociatedSnapshot("B").id);
    expect(storage.residencyStats().resident).toBe(2);
    storage.compact(storage.getAssociatedSnapshot("C").id);
    // c went to disk with B's compact; pinning does not read it back, reading does, and then it stays.
    expect(storage.residencyStats().resident).toBe(0);
    expect(storage.getOperatorResult("C", "c")?.totalRowCount).toBe(7);
    storage.compact(storage.getAssociatedSnapshot("C").id);
    expect(storage.residencyStats().resident).toBe(1);
    expect(storage.getAllVisibleResults("B").get("a")?.totalRowCount).toBe(3);
  });
});

describe("WorkflowSnapshotStorage — unchanged frozen dataflow parts are shared", () => {
  test("a child snapshot reuses its parent's frozen links and positions when they did not change", () => {
    const storage = new WorkflowSnapshotStorage(stepId => (stepId === "B" ? ["A", "B"] : [stepId]));
    const native = (ids: string[]): WorkflowContent => {
      const workflow = makeWorkflow(ids);
      return {
        ...workflow,
        operators: workflow.operators.map(op => ({ ...op, nativeOp: { type: "Scan" } }) as any),
        operatorPositions: Object.fromEntries(ids.map((id, i) => [id, { x: i, y: 0 }])),
      };
    };
    const a = storage.createSnapshot("A", native(["a"]));
    const one = native(["a"]);
    const moved: WorkflowContent = {
      ...one,
      operators: [...one.operators, { ...one.operators[0], operatorID: "b" }],
      operatorPositions: { ...one.operatorPositions, b: { x: 9, y: 9 } },
    };
    const b = storage.createSnapshot("B", moved);
    expect(b.workflow.settings).toBe(a.workflow.settings);
    expect(b.workflow.links).toBe(a.workflow.links);
    expect(b.workflow.operatorPositions).not.toBe(a.workflow.operatorPositions);
    expect(b.workflow.operators[0]).toBe(a.workflow.operators[0]);
  });
});

describe("WorkflowSnapshotStorage — unchanged parts deep inside the dataflow are shared", () => {
  test("a namespace that gains a cell keeps the earlier cells; positions keep each unmoved operator's", () => {
    const storage = new WorkflowSnapshotStorage(stepId => (stepId === "B" ? ["A", "B"] : [stepId]));
    const workflow = (cells: string[], positions: Record<string, { x: number; y: number }>): WorkflowContent => {
      const base = makeWorkflow(["a"]);
      return {
        ...base,
        operators: base.operators.map(op => ({ ...op, nativeOp: { type: "Scan" } }) as any),
        operatorPositions: positions,
        nativeNamespace: {
          cells: cells.map(source => ({ source })),
          functions: {},
          bindings: {},
          revision: cells.length,
        } as any,
      };
    };
    const a = storage.createSnapshot("A", workflow(["def f(): pass"], { a: { x: 0, y: 0 } }));
    const b = storage.createSnapshot(
      "B",
      workflow(["def f(): pass", "def g(): pass"], { a: { x: 0, y: 0 }, b: { x: 5, y: 5 } })
    );
    const cells = (s: typeof a) => (s.workflow.nativeNamespace as any).cells;
    expect(cells(b)[0]).toBe(cells(a)[0]);
    expect(cells(b)).toHaveLength(2);
    expect(b.workflow.operatorPositions.a).toBe(a.workflow.operatorPositions.a);
    expect(Object.isFrozen(cells(b)[1])).toBe(true);
  });
});

describe("WorkflowSnapshotStorage — observations off HEAD's path on disk", () => {
  test("a step's observations go to disk when HEAD leaves its path and read back as they were", () => {
    const parents: Record<string, string | undefined> = { A: undefined, B: undefined };
    const storage = new WorkflowSnapshotStorage(stepId => (parents[stepId] === undefined ? [stepId] : [stepId]));
    const a = storage.createSnapshot("A", makeWorkflow(["a"]));
    storage.createSnapshot("B", makeWorkflow(["b"]));
    a.nativeObservations = Object.freeze({ a: { rows: [1, 2, 3] } as any });
    (storage as any).observed.add(a);
    expect(storage.observationsInMemory()).toHaveLength(1);
    storage.compact(storage.getAssociatedSnapshot("B").id);
    expect(storage.observationsInMemory()).toHaveLength(0);
    expect(a.nativeObservations).toEqual({ a: { rows: [1, 2, 3] } } as any);
    expect(Object.isFrozen(a.nativeObservations)).toBe(true);
    expect(storage.observationsInMemory()).toHaveLength(1);
    storage.compact(storage.getAssociatedSnapshot("A").id);
    expect(storage.observationsInMemory()).toHaveLength(1);
  });
});
