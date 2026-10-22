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

import { SnapshotTreeNode } from "../../../../service/agent/agent.service";
import {
  dataflowChips,
  dataflowFailure,
  shownVersion,
  stepVersions,
  versionLabel,
  versionNodes,
} from "./dataflow-versions";

/** A step whose dataflow call made two versions, then ran and showed `kept` (two more). */
const built = {
  toolCalls: [{ toolName: "dataflow", toolCallId: "c1", input: {} }],
  toolResults: [
    {
      toolCallId: "c1",
      output: {
        kind: "dataflow-actions",
        actions: [
          {
            action: { type: "edit" },
            status: "ok",
            output: {
              versions: [
                {
                  version: 1,
                  snapshotId: "S2",
                  kind: "add",
                  operatorId: "records",
                  op: "make_table",
                  functions: ["make_table"],
                  author: "agent",
                },
                { version: 2, snapshotId: "S3", kind: "add", operatorId: "kept", op: "filter", author: "agent" },
              ],
            },
          },
          {
            action: { type: "execute", operator_ids: ["kept"] },
            status: "ok",
            output: {
              operators: [],
              version: { version: 3, snapshotId: "S4", kind: "run", operatorIds: ["kept"], author: "agent" },
            },
          },
          {
            action: { type: "retrieve", operator_ids: ["kept"] },
            status: "ok",
            output: {
              results: [],
              version: { version: 4, snapshotId: "S5", kind: "show", operatorIds: ["kept"], author: "agent" },
            },
          },
        ],
      },
    },
  ],
};

const node = (id: string, parentId: string | undefined, version?: number, action?: object): SnapshotTreeNode =>
  ({
    id,
    parentId,
    reactStepId: `step-${id}`,
    operatorCount: 0,
    resultCount: 0,
    version,
    action,
    owned: true,
  }) as SnapshotTreeNode;

const step = (actions: object[], extra: object = {}) => ({
  toolCalls: [{ toolName: "dataflow", toolCallId: "c" }],
  toolResults: [{ toolCallId: "c", output: { kind: "dataflow-actions", actions, ...extra } }],
});

describe("dataflow versions in the chat", () => {
  it("lists only what a step changed, each edit with the version it made", () => {
    expect(dataflowChips(built)!.map(chip => [chip.kind, chip.label, chip.version])).toEqual([
      ["add", "add records", 1],
      ["add", "add kept", 2],
    ]);
    expect(dataflowChips(built)![0].title).toBe("v1: add records (make_table) · defines make_table");
    // Its run and show are versions too, though no chip lists them.
    expect(stepVersions(built).map(version => [version.version, version.kind])).toEqual([
      [1, "add"],
      [2, "add"],
      [3, "run"],
      [4, "show"],
    ]);
    expect(dataflowFailure(built)).toBeUndefined();
  });

  it("calls an update a modify", () => {
    const modified = step([
      {
        action: { type: "edit" },
        status: "ok",
        output: { versions: [{ version: 7, snapshotId: "S9", kind: "update", operatorId: "kept", author: "user" }] },
      },
    ]);
    expect(dataflowChips(modified)!.map(chip => [chip.label, chip.title])).toEqual([
      ["modify kept", "v7: modify kept · by you"],
    ]);
  });

  it("shows a pending edit, and reports a rejected call or a failed action as the step's failure", () => {
    expect(dataflowChips(step([{ action: { type: "edit" }, status: "pending" }]))).toEqual([
      { kind: "pending", label: "editing…" },
    ]);
    expect(dataflowChips(step([], { error: "Line 1: bad. No actions ran." }))).toEqual([]);
    expect(dataflowFailure(step([], { error: "Line 1: bad. No actions ran." }))).toBe("Line 1: bad. No actions ran.");
    expect(
      dataflowFailure(
        step([
          { action: { type: "edit" }, status: "ok", output: { versions: [] } },
          { action: { type: "execute" }, status: "error", output: "engine failed" },
          { action: { type: "retrieve", operator_ids: ["x"] }, status: "skipped" },
        ])
      )
    ).toBe("run failed: engine failed");
    expect(
      dataflowFailure(
        step([
          {
            action: { type: "retrieve", operator_ids: ["x", "y"] },
            status: "error",
            output: { results: [{ status: "ok" }, { status: "error", error: "RESULT_NOT_RUN: y has no result." }] },
          },
        ])
      )
    ).toBe("show x, y failed: RESULT_NOT_RUN: y has no result.");
    expect(dataflowChips({ toolCalls: [{ toolName: "createOrModifyOperator" }] })).toBeUndefined();
  });

  it("keeps versions in the tree, each under its nearest version, and finds the version a snapshot shows", () => {
    const nodes = [
      node("S1", "S0", 0, { kind: "start", author: "agent" }),
      node("S2", "S1", 1, { kind: "add", operatorId: "records", author: "agent" }),
      node("S3", "S2", 2, { kind: "run", author: "agent" }),
      // A restore continues from a version without being one.
      node("S4", "S3"),
      node("S5", "S4", 3, { kind: "update", operatorId: "records", author: "user" }),
    ];
    expect(versionNodes(nodes).map(n => [n.id, n.parentId])).toEqual([
      ["S1", undefined],
      ["S2", "S1"],
      ["S3", "S2"],
      ["S5", "S3"],
    ]);
    expect(shownVersion(nodes, "S4")).toBe("S3");
    expect(shownVersion(nodes, "S5")).toBe("S5");
    // A service without versions keeps every snapshot.
    const plain = [node("S1", "S0"), node("S2", "S1")];
    expect(versionNodes(plain)).toEqual(plain);
    expect(shownVersion(plain, "S2")).toBe("S2");
  });

  it("labels a version by its verb and what it acted on", () => {
    expect(versionLabel(node("S1", "S0", 0, { kind: "start", author: "agent" }))).toEqual({
      label: "v0 start",
      title: "v0: start",
    });
    expect(
      versionLabel(node("S5", "S4", 3, { kind: "update", operatorId: "kept", op: "filter", author: "user" }))
    ).toEqual({ label: "v3 modify kept", title: "v3: modify kept (filter) · by you" });
    expect(versionLabel(node("S6", "S5", 4, { kind: "define", functions: ["clean"], author: "agent" }))).toEqual({
      label: "v4 define clean",
      title: "v4: define clean",
    });
    expect(versionLabel(node("S7", "S6", 5, { kind: "run", author: "agent" })).label).toBe("v5 run all");
    expect(
      versionLabel({ ...node("S8", "S7", 6, { kind: "run", operatorIds: ["kept"], author: "agent" }), failed: true })
    ).toEqual({ label: "v6 run kept", title: "v6: run kept · failed" });
    expect(versionLabel(node("S9", "S8", 7, { kind: "show", operatorIds: ["kept"], author: "agent" })).label).toBe(
      "v7 show kept"
    );
    expect(versionLabel(node("S10", "S9", 8, { kind: "edit", operatorIds: ["a", "b"], author: "agent" })).label).toBe(
      "v8 edit 2 operators"
    );
    expect(versionLabel(node("S11", "S10"))).toEqual({ label: "S11", title: "S11" });
  });
});
