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
import { WorkflowState } from "../workflow-state";
import { partitionOpsByIndependence } from "./subdag-partition";
import type { OperatorPredicate, OperatorLink } from "../../types/workflow";

/* ============================================================================
 *  Fixtures
 * ========================================================================= */

function makeOp(id: string, type = "TestOp", inPorts = 1, outPorts = 1): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: type,
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: Array.from({ length: inPorts }, (_, i) => ({ portID: `input-${i}`, displayName: `Input ${i}` })),
    outputPorts: Array.from({ length: outPorts }, (_, i) => ({ portID: `output-${i}`, displayName: `Output ${i}` })),
    showAdvanced: false,
  } as OperatorPredicate;
}

function makeLink(linkID: string, source: string, target: string, targetPortIdx = 0): OperatorLink {
  return {
    linkID,
    source: { operatorID: source, portID: "output-0" },
    target: { operatorID: target, portID: `input-${targetPortIdx}` },
  };
}

/** Build a WorkflowState containing the given operator IDs and the given
 *  source→target links. All operators get the default 1-in/1-out port shape. */
function buildState(opIds: string[], links: Array<[string, string]>): WorkflowState {
  const state = new WorkflowState();
  for (const id of opIds) state.addOperator(makeOp(id));
  links.forEach(([s, t], i) => state.addLink(makeLink(`l${i}`, s, t)));
  return state;
}

/** Compare PartitionGroup outputs by their members and subDAG IDs only —
 *  link arrays may be in any order. */
function groupShape(group: ReturnType<typeof partitionOpsByIndependence>[number]) {
  return {
    opsToView: [...group.opsToView].sort(),
    subDagOps: [...group.subDAG.operators.map(o => o.operatorID)].sort(),
  };
}

/* ============================================================================
 *  Tests
 * ========================================================================= */

describe("partitionOpsByIndependence", () => {
  test("empty input returns no groups", () => {
    const state = buildState([], []);
    expect(partitionOpsByIndependence(state, [])).toEqual([]);
  });

  test("single op returns one group with its own subDAG", () => {
    // Workflow: source → midOp. Asking to view `midOp` produces one group
    // whose subDAG is the entire upstream-closure of midOp.
    const state = buildState(["source", "midOp"], [["source", "midOp"]]);
    const groups = partitionOpsByIndependence(state, ["midOp"]);
    expect(groups).toHaveLength(1);
    expect(groupShape(groups[0])).toEqual({
      opsToView: ["midOp"],
      subDagOps: ["midOp", "source"],
    });
  });

  test("two independent ops split into two groups", () => {
    // Workflow: two disjoint loaders. The archeology trace's symptom case.
    //   loaderA  (no upstream)
    //   loaderB  (no upstream)
    // Viewing both should yield two single-op groups, each with no
    // shared ancestry.
    const state = buildState(["loaderA", "loaderB"], []);
    const groups = partitionOpsByIndependence(state, ["loaderA", "loaderB"]);
    expect(groups).toHaveLength(2);
    const shapes = groups.map(groupShape).sort((a, b) => a.opsToView[0].localeCompare(b.opsToView[0]));
    expect(shapes).toEqual([
      { opsToView: ["loaderA"], subDagOps: ["loaderA"] },
      { opsToView: ["loaderB"], subDagOps: ["loaderB"] },
    ]);
  });

  test("two ops sharing a common upstream collapse into one group", () => {
    // Workflow: source → midA, source → midB. Viewing midA + midB shares
    // `source` as a common ancestor, so they MUST run in the same execution
    // (otherwise `source` would run twice, and a failure in source would
    // block both anyway — entanglement is logically correct here).
    const state = buildState(["source", "midA", "midB"], [["source", "midA"], ["source", "midB"]]);
    const groups = partitionOpsByIndependence(state, ["midA", "midB"]);
    expect(groups).toHaveLength(1);
    expect(groupShape(groups[0])).toEqual({
      opsToView: ["midA", "midB"],
      subDagOps: ["midA", "midB", "source"],
    });
  });

  test("transitive sharing through an intermediate ancestor", () => {
    // Workflow: root → l1, root → l2 → consumer. View `consumer` and `l1`.
    // l1's closure = {l1, root}. consumer's closure = {consumer, l2, root}.
    // They share `root` → one group covering both branches.
    const state = buildState(
      ["root", "l1", "l2", "consumer"],
      [["root", "l1"], ["root", "l2"], ["l2", "consumer"]]
    );
    const groups = partitionOpsByIndependence(state, ["l1", "consumer"]);
    expect(groups).toHaveLength(1);
    expect(groupShape(groups[0])).toEqual({
      opsToView: ["consumer", "l1"],
      subDagOps: ["consumer", "l1", "l2", "root"],
    });
  });

  test("three ops: two share, one is independent → two groups", () => {
    // Workflow:
    //   shared → a → leafA
    //   shared → b → leafB
    //   isolated
    // Viewing [leafA, leafB, isolated] — leafA & leafB share `shared`,
    // `isolated` is on its own.
    const state = buildState(
      ["shared", "a", "b", "leafA", "leafB", "isolated"],
      [
        ["shared", "a"],
        ["shared", "b"],
        ["a", "leafA"],
        ["b", "leafB"],
      ]
    );
    const groups = partitionOpsByIndependence(state, ["leafA", "leafB", "isolated"]);
    expect(groups).toHaveLength(2);
    const shapes = groups.map(groupShape).sort((a, b) => a.opsToView[0].localeCompare(b.opsToView[0]));
    expect(shapes).toEqual([
      { opsToView: ["isolated"], subDagOps: ["isolated"] },
      { opsToView: ["leafA", "leafB"], subDagOps: ["a", "b", "leafA", "leafB", "shared"] },
    ]);
  });

  test("op ids absent from the workflow are silently skipped", () => {
    // Defensive: callers may pass stale ids (e.g. an op deleted between
    // tool invocation and execution). Filtering here matches the
    // behavior of buildLogicalPlan, which intersects opsToView with the
    // operator set.
    const state = buildState(["a"], []);
    const groups = partitionOpsByIndependence(state, ["a", "ghost"]);
    expect(groups).toHaveLength(1);
    expect(groupShape(groups[0])).toEqual({ opsToView: ["a"], subDagOps: ["a"] });
  });

  test("dedupes operators and links across overlapping member closures", () => {
    // Workflow: root → a, root → b. View [a, b] — both closures include
    // `root` and its outgoing links. The merged group must NOT double-list
    // operators or links.
    const state = buildState(["root", "a", "b"], [["root", "a"], ["root", "b"]]);
    const groups = partitionOpsByIndependence(state, ["a", "b"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].subDAG.operators).toHaveLength(3);
    expect(groups[0].subDAG.links).toHaveLength(2);
  });

  test("archeology shape — two independent loaders → two groups", () => {
    // Mirror the archeology-hard-1 trace: a batch creates two independent
    // loaders (radiocarbonDatabaseRegional and climateMeasurements). Today
    // they get serialized into one execution; if one errors the other's
    // result is lost. Partitioning splits them so independent failures
    // don't entangle.
    const state = buildState(
      ["radiocarbonDatabaseRegional", "climateMeasurements"],
      []
    );
    const groups = partitionOpsByIndependence(state, [
      "radiocarbonDatabaseRegional",
      "climateMeasurements",
    ]);
    expect(groups).toHaveLength(2);
    const opsByGroup = groups.map(g => g.opsToView).flat().sort();
    expect(opsByGroup).toEqual(["climateMeasurements", "radiocarbonDatabaseRegional"]);
  });
});
