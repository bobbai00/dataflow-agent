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
import { dataflowChips, shownVersion, stepVersions, versionLabel, versionNodes } from "./dataflow-versions";

/** A step whose dataflow call made two versions, then ran and showed `kept`. */
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
                  snapshotId: "S3",
                  kind: "add",
                  operatorId: "records",
                  op: "make_table",
                  functions: ["make_table"],
                  author: "agent",
                },
                { version: 2, snapshotId: "S2", kind: "add", operatorId: "kept", op: "filter", author: "agent" },
              ],
            },
          },
          { action: { type: "execute", operator_ids: ["kept"] }, status: "ok" },
          { action: { type: "retrieve", operator_ids: ["kept"] }, status: "ok" },
        ],
      },
    },
  ],
};

const node = (id: string, parentId: string | undefined, version?: number, edit?: object): SnapshotTreeNode =>
  ({
    id,
    parentId,
    reactStepId: `step-${id}`,
    operatorCount: 0,
    resultCount: 0,
    version,
    edit,
    owned: true,
  }) as SnapshotTreeNode;

describe("dataflow versions in the chat", () => {
  it("lists a step's edits with the versions they made, then what it ran and read", () => {
    expect(dataflowChips(built)!.map(chip => [chip.kind, chip.label, chip.version])).toEqual([
      ["add", "add records", 1],
      ["add", "add kept", 2],
      ["run", "run kept", undefined],
      ["show", "show kept", undefined],
    ]);
    expect(dataflowChips(built)![0].title).toBe("v1: add records (make_table) · defines make_table");
    expect(stepVersions(built).map(version => version.version)).toEqual([1, 2]);
  });

  it("marks a rejected call, a failed edit, a failed run and actions still pending", () => {
    const step = (actions: object[], extra: object = {}) => ({
      toolCalls: [{ toolName: "dataflow", toolCallId: "c" }],
      toolResults: [{ toolCallId: "c", output: { kind: "dataflow-actions", actions, ...extra } }],
    });
    expect(dataflowChips(step([], { error: "Line 1: bad. No actions ran." }))).toEqual([
      { kind: "error", label: "call rejected", title: "Line 1: bad. No actions ran." },
    ]);
    expect(
      dataflowChips(
        step([
          { action: { type: "edit" }, status: "error", output: "boom" },
          { action: { type: "execute" }, status: "error", output: "engine failed" },
          { action: { type: "retrieve", operator_ids: ["x"] }, status: "skipped" },
          { action: { type: "retrieve", operator_ids: ["y"] }, status: "pending" },
        ])
      )
    ).toEqual([
      { kind: "error", label: "edit failed", title: "boom" },
      { kind: "error", label: "run all failed", title: "engine failed" },
      { kind: "pending", label: "retrieve…" },
    ]);
    expect(dataflowChips({ toolCalls: [{ toolName: "createOrModifyOperator" }] })).toBeUndefined();
  });

  it("keeps versions in the tree, each under its nearest version, and finds the version a snapshot shows", () => {
    const nodes = [
      node("S1", "S0", 0, { kind: "start", author: "agent" }),
      node("S3", "S1", 1, { kind: "add", operatorId: "records", author: "agent" }),
      node("S2", "S3", 2, { kind: "add", operatorId: "kept", author: "agent" }),
      // A step that only ran the dataflow made no version.
      node("S4", "S2"),
      node("S5", "S4", 3, { kind: "update", operatorId: "kept", author: "user" }),
    ];
    expect(versionNodes(nodes).map(n => [n.id, n.parentId])).toEqual([
      ["S1", undefined],
      ["S3", "S1"],
      ["S2", "S3"],
      ["S5", "S2"],
    ]);
    expect(shownVersion(nodes, "S4")).toBe("S2");
    expect(shownVersion(nodes, "S5")).toBe("S5");
    // A service without versions keeps every snapshot.
    const plain = [node("S1", "S0"), node("S2", "S1")];
    expect(versionNodes(plain)).toEqual(plain);
    expect(shownVersion(plain, "S2")).toBe("S2");
  });

  it("labels a version by what it changed", () => {
    expect(versionLabel(node("S1", "S0", 0, { kind: "start", author: "agent" }))).toEqual({
      label: "v0 · start",
      title: "v0: start",
    });
    expect(
      versionLabel(node("S5", "S4", 3, { kind: "update", operatorId: "kept", op: "filter", author: "user" }))
    ).toEqual({ label: "v3 · kept", title: "v3: update kept (filter) · by you" });
    expect(versionLabel(node("S6", "S5", 4, { kind: "define", functions: ["clean"], author: "agent" }))).toEqual({
      label: "v4 · clean",
      title: "v4: define clean",
    });
    expect(versionLabel(node("S9", "S8"))).toEqual({ label: "S9", title: "S9" });
  });
});
