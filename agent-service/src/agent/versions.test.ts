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

/** Dataflow versions: one snapshot per edit (see SnapshotEdit). */
import { describe, expect, test } from "bun:test";
import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";
import { WorkflowState } from "./workflow-state";
import { WorkflowSnapshotStorage, describeChange } from "./workflow-snapshot-storage";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { editVersions, planRegisteredGraphEdit } from "./tools/graph-edits";

const info = (rows: number) =>
  ({ state: "Completed", inputTuples: 0, outputTuples: rows, totalRowCount: rows }) as unknown as OperatorInfo;
const ops = (workflow: WorkflowContent) => workflow.operators.map(op => op.operatorID);
const workflow = (ids: string[], links: Array<[string, string]> = []): WorkflowContent => ({
  operators: ids.map(id => ({ operatorID: id, operatorType: "TestOp", operatorProperties: { id } }) as any),
  operatorPositions: Object.fromEntries(ids.map((id, i) => [id, { x: i * 100, y: 0 }])),
  links: links.map(([source, target]) => ({
    linkID: `${source}->${target}`,
    source: { operatorID: source, portID: "output-0" },
    target: { operatorID: target, portID: "input-0" },
  })),
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400 },
});
// ReAct steps A → B → C.
const path = (step: string) => ["A", "B", "C"].slice(0, ["A", "B", "C"].indexOf(step) + 1);
const edit = (kind: "add" | "update" | "delete", operatorId: string) => ({
  kind,
  operatorId,
  author: "agent" as const,
});

describe("the snapshot storage keeps one version per edit", () => {
  test("a step's edits chain as versions before its own snapshot, which stays its final state", () => {
    const store = new WorkflowSnapshotStorage(path);
    const start = store.createSnapshot("A", workflow(["a"]), { edit: { kind: "start", author: "agent" } });
    store.setOperatorResult("A", "a", info(3));
    const pending = store.createSnapshot("B", workflow(["a"]));
    // A step that leaves the dataflow as it was is no version.
    expect(pending.version).toBeUndefined();

    const recorded = store.recordEdits("B", [
      { edit: edit("add", "b"), workflow: workflow(["a", "b"], [["a", "b"]]) },
      {
        edit: edit("add", "c"),
        workflow: workflow(
          ["a", "b", "c"],
          [
            ["a", "b"],
            ["b", "c"],
          ]
        ),
      },
    ]);

    expect(recorded.map(s => [s.version, s.edit?.operatorId, ops(s.workflow)])).toEqual([
      [1, "b", ["a", "b"]],
      [2, "c", ["a", "b", "c"]],
    ]);
    expect(start.version).toBe(0);
    expect(recorded[0].parentId).toBe(start.id);
    expect(recorded[1]).toBe(pending);
    expect(pending.parentId).toBe(recorded[0].id);
    expect(store.getOwnedSnapshot("B")).toBe(pending);
    expect(store.getWorkflow("B")).toBe(pending.workflow);
    // Each version carries the results still current for it.
    expect(recorded[0].results.has("a")).toBe(true);
    expect(store.getOperatorResult("B", "a")).toEqual(info(3));
    expect(
      store.getSnapshotTreeNodes().map(node => [node.version, node.edit?.kind, node.owned, node.reactStepId])
    ).toEqual([
      [undefined, undefined, false, undefined],
      [0, "start", true, "A"],
      [2, "add", true, "B"],
      [1, "add", false, "B"],
    ]);
  });

  test("a completed step's snapshot cannot take more edits; pruning and clearing drop versions", () => {
    const store = new WorkflowSnapshotStorage(path);
    store.createSnapshot("A", workflow(["a"]), { edit: { kind: "start", author: "agent" } });
    store.createSnapshot("B", workflow(["a"]));
    store.recordEdits("B", [
      { edit: edit("add", "b"), workflow: workflow(["a", "b"]) },
      { edit: edit("add", "c"), workflow: workflow(["a", "b", "c"]) },
    ]);
    store.createSnapshot("C", workflow(["a", "b", "c"]));
    expect(() => store.recordEdits("B", [{ edit: edit("delete", "c"), workflow: workflow(["a", "b"]) }])).toThrow(
      "Cannot change a completed snapshot"
    );
    store.pruneOrphans(new Set(["A"]));
    expect(store.getSnapshotTreeNodes().map(node => node.reactStepId)).toEqual([undefined, "A"]);
    store.clear();
    expect(store.createSnapshot("A", workflow(["a"]), { edit: { kind: "start", author: "agent" } }).version).toBe(0);
  });

  test("a snapshot whose dataflow changed without recorded edits describes the change", () => {
    expect(describeChange(workflow(["a"]), workflow(["a", "b"]))).toEqual({
      kind: "add",
      operatorId: "b",
      op: "TestOp",
      author: "agent",
    });
    expect(describeChange(workflow(["a", "b"]), workflow(["a"]), "user")).toMatchObject({
      kind: "delete",
      operatorId: "b",
      author: "user",
    });
    expect(describeChange(workflow(["a"]), workflow(["b", "c"]))).toEqual({
      kind: "edit",
      operatorIds: ["b", "c", "a"],
      author: "agent",
    });
    // Moving an operator is not a version.
    const moved = workflow(["a"]);
    moved.operatorPositions.a = { x: 5, y: 5 };
    expect(describeChange(workflow(["a"]), moved)).toBeUndefined();

    const store = new WorkflowSnapshotStorage(path);
    const restored = store.createSnapshot("A", workflow(["a"]), { edit: { kind: "start", author: "agent" } });
    store.createSnapshot("B", workflow(["a", "b"]));
    // A restore continues from the version it restores, without being one.
    const restore = store.createSnapshot("C", workflow(["a"]), { parentSnapshotId: restored.id });
    expect(restore.parentId).toBe(restored.id);
    expect(restore.version).toBeUndefined();
  });
});

describe("a call's edits, one version each", () => {
  const context = () => {
    const metadataStore = WorkflowSystemMetadata.getInstance();
    metadataStore.seedCodeModeDefaults();
    return { metadataStore };
  };
  const empty = () => new WorkflowState().getWorkflowContent();
  const plan = (original: WorkflowContent, changes: string, python = "") =>
    planRegisteredGraphEdit(original, python, changes, context());

  test("follow the order written, an operator after the inputs the call also changes", async () => {
    const original = empty();
    const planned = await plan(
      original,
      "set top: limit(rows, n=1)\nset rows: scan(files='a.csv')\nset kept: filter(rows, lambda row: True)"
    );
    const versions = editVersions(original, planned);
    expect(versions.map(v => [v.edit.kind, v.edit.operatorId, ops(v.workflow).sort()])).toEqual([
      ["add", "rows", ["rows"]],
      ["add", "top", ["rows", "top"]],
      ["add", "kept", ["kept", "rows", "top"]],
    ]);
    expect(versions[1].workflow.links.map(link => [link.source.operatorID, link.target.operatorID])).toEqual([
      ["rows", "top"],
    ]);
    expect(versions[2].workflow).toBe(planned.workflow);
    // Every version places its operators where the final layout does.
    expect(versions[0].workflow.operatorPositions.rows).toEqual(planned.workflow.operatorPositions.rows);
  });

  test("deletes and updates in turn, Python definitions on the first, and nothing for a no-op", async () => {
    const original = (
      await plan(empty(), "set rows: scan(files='a.csv')\nset top: limit(rows, n=1)\nset two: limit(rows, n=2)")
    ).workflow;
    const planned = await plan(original, "delete two\nset top: limit(rows, n=3)");
    const versions = editVersions(original, planned, "user");
    expect(versions.map(v => [v.edit.kind, v.edit.operatorId, v.edit.author, ops(v.workflow).sort()])).toEqual([
      ["delete", "two", "user", ["rows", "top"]],
      ["update", "top", "user", ["rows", "top"]],
    ]);
    expect(versions[0].workflow.links.map(link => link.target.operatorID)).toEqual(["top"]);

    const defined = await plan(original, "", "def double(table):\n    return table");
    expect(editVersions(original, defined).map(v => v.edit)).toEqual([
      { kind: "define", functions: ["double"], author: "agent" },
    ]);
    const used = await plan(original, "set wide: double(rows)", "def double(table):\n    return table");
    expect(editVersions(original, used).map(v => v.edit)).toEqual([
      { kind: "add", operatorId: "wide", op: "double", functions: ["double"], author: "agent" },
    ]);
    expect(editVersions(original, await plan(original, "set top: limit(rows, n=1)"))).toEqual([]);
  });
});
