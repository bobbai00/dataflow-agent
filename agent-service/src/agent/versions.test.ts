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

/** Dataflow versions: one snapshot per action (see VersionAction). */
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

describe("the snapshot storage keeps one version per action", () => {
  test("a step's actions chain as versions that keep their snapshots; the step resolves to its newest", () => {
    const store = new WorkflowSnapshotStorage(path);
    const start = store.createSnapshot("A", workflow(["a"]), { action: { kind: "start", author: "agent" } });
    store.setOperatorResult("A", "a", info(3));
    const pending = store.createSnapshot("B", workflow(["a"]));
    // A step that leaves the dataflow as it was is no version until it records one.
    expect(pending.version).toBeUndefined();

    const edits = store.recordVersions("B", [
      { action: edit("add", "b"), workflow: workflow(["a", "b"], [["a", "b"]]), createdAt: 1000 },
      {
        action: edit("add", "c"),
        workflow: workflow(
          ["a", "b", "c"],
          [
            ["a", "b"],
            ["b", "c"],
          ]
        ),
        createdAt: 1001,
      },
    ]);
    expect(edits.map(s => [s.version, s.action?.operatorId, ops(s.workflow), s.createdAt])).toEqual([
      [1, "b", ["a", "b"], 1000],
      [2, "c", ["a", "b", "c"], 1001],
    ]);
    // The step's pending snapshot became its first version.
    expect(edits[0]).toBe(pending);
    expect(pending.parentId).toBe(start.id);
    expect(edits[1].parentId).toBe(pending.id);
    // Each version carries the results still current for it.
    expect(pending.results.has("a")).toBe(true);

    // A run and a show are versions too, of the dataflow as it stands; the run's results land on it.
    const [run] = store.recordVersions("B", [{ action: { kind: "run", author: "agent" } }]);
    store.setOperatorResult("B", "c", info(2));
    const [show] = store.recordVersions("B", [{ action: { kind: "show", operatorIds: ["c"], author: "agent" } }]);
    expect([run.version, show.version]).toEqual([3, 4]);
    expect(ops(run.workflow)).toEqual(["a", "b", "c"]);
    expect(run.results.get("c")?.info.outputTuples).toBe(2);
    expect(edits[1].results.has("c")).toBe(false);
    expect(show.results.get("c")?.info).toBe(run.results.get("c")?.info);
    expect(show.createdAt).toBeGreaterThanOrEqual(run.createdAt);

    // Every version keeps its id; the step resolves to the newest.
    expect(store.getOwnedSnapshot("B")).toBe(show);
    expect(store.getStepVersions("B").map(v => v.id)).toEqual([pending.id, edits[1].id, run.id, show.id]);
    expect(store.getWorkflow("B")).toBe(show.workflow);
    expect(store.getOperatorResult("B", "a")).toEqual(info(3));
    expect(
      store.getSnapshotTreeNodes().map(node => [node.version, node.action?.kind, node.owned, node.reactStepId])
    ).toEqual([
      [undefined, undefined, false, undefined],
      [0, "start", true, "A"],
      [1, "add", false, "B"],
      [2, "add", false, "B"],
      [3, "run", false, "B"],
      [4, "show", true, "B"],
    ]);
    expect(store.getSnapshotTreeNodes().find(node => node.id === pending.id)?.timestamp).toBe(1000);
  });

  test("a run version in which an operator failed says so", () => {
    const store = new WorkflowSnapshotStorage(path);
    store.createSnapshot("A", workflow(["a"]), { action: { kind: "start", author: "agent" } });
    const [run] = store.recordVersions("A", [{ action: { kind: "run", operatorIds: ["a"], author: "user" } }]);
    expect(store.getSnapshotTreeNodes().find(node => node.id === run.id)?.failed).toBeUndefined();
    store.setOperatorResult("A", "a", { ...info(0), state: "Failed", error: "boom" } as OperatorInfo);
    expect(store.getSnapshotTreeNodes().find(node => node.id === run.id)).toMatchObject({
      action: { kind: "run", operatorIds: ["a"], author: "user" },
      failed: true,
    });
  });

  test("a completed step takes no more versions; pruning and clearing drop them", () => {
    const store = new WorkflowSnapshotStorage(path);
    store.createSnapshot("A", workflow(["a"]), { action: { kind: "start", author: "agent" } });
    store.createSnapshot("B", workflow(["a"]));
    store.recordVersions("B", [
      { action: edit("add", "b"), workflow: workflow(["a", "b"]) },
      { action: edit("add", "c"), workflow: workflow(["a", "b", "c"]) },
    ]);
    store.createSnapshot("C", workflow(["a", "b", "c"]));
    expect(() => store.recordVersions("B", [{ action: edit("delete", "c"), workflow: workflow(["a", "b"]) }])).toThrow(
      "Cannot change a completed snapshot"
    );
    store.pruneOrphans(new Set(["A"]));
    expect(store.getSnapshotTreeNodes().map(node => node.reactStepId)).toEqual([undefined, "A"]);
    store.clear();
    expect(store.createSnapshot("A", workflow(["a"]), { action: { kind: "start", author: "agent" } }).version).toBe(0);
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
    const restored = store.createSnapshot("A", workflow(["a"]), { action: { kind: "start", author: "agent" } });
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
    expect(versions.map(v => [v.action.kind, v.action.operatorId, ops(v.workflow).sort()])).toEqual([
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
    expect(versions.map(v => [v.action.kind, v.action.operatorId, v.action.author, ops(v.workflow).sort()])).toEqual([
      ["delete", "two", "user", ["rows", "top"]],
      ["update", "top", "user", ["rows", "top"]],
    ]);
    expect(versions[0].workflow.links.map(link => link.target.operatorID)).toEqual(["top"]);

    const defined = await plan(original, "", "def double(table):\n    return table");
    expect(editVersions(original, defined).map(v => v.action)).toEqual([
      { kind: "define", functions: ["double"], author: "agent" },
    ]);
    const used = await plan(original, "set wide: double(rows)", "def double(table):\n    return table");
    expect(editVersions(original, used).map(v => v.action)).toEqual([
      { kind: "add", operatorId: "wide", op: "double", functions: ["double"], author: "agent" },
    ]);
    expect(editVersions(original, await plan(original, "set top: limit(rows, n=1)"))).toEqual([]);
  });
});
