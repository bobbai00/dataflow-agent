/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { createNativeBatchTools, type NativeBatchResult } from "./native-batch-tools";
import { createNativeTypedTools } from "./native-typed-tools";
import { ToolCallScheduler } from "./tool-call-scheduler";

type Spec = { op: string; id: string; [key: string]: unknown };
const source: Spec = { op: "scan", id: "source", files: "data/test.csv" };
const selected: Spec = { op: "filter", id: "selected", input: "source", predicate: "x > 0" };
const total: Spec = { op: "aggregate", id: "total", input: "selected", aggregations: [{ fn: "count" }] };

function setup() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const context = { metadataStore: metadata };
  const typed = createNativeTypedTools(state, context);
  const batch = createNativeBatchTools(state, context).dataflow;
  return {
    state,
    typed,
    execute: (operators: Spec[]): Promise<NativeBatchResult> => batch.execute({ operators, observe: [] }),
  };
}

function links(state: WorkflowState): string[] {
  return state
    .getAllLinks()
    .map(l => `${l.source.operatorID}->${l.target.operatorID}:${l.target.portID}`)
    .sort();
}

describe("native batching shares the parallel-call scheduler", () => {
  test("mixed independent work and a reversed chain have the exact parallel-call execution order and DAG", async () => {
    const batched = setup();
    const parallel = setup();
    const specs = [total, { ...source, id: "independent" }, selected, source];
    const scheduler = new ToolCallScheduler();
    await Promise.all(specs.map(({ op, ...input }) => scheduler.wrap(op, parallel.typed[op]).execute(input, {})));

    const result = await batched.execute(specs);
    expect(result.operators.every(o => o.status === "added")).toBe(true);
    const expected = parallel.state.getAllOperators().map(o => o.operatorID);
    expect(expected).toEqual(["independent", "source", "selected", "total"]);
    expect(batched.state.getAllOperators().map(o => o.operatorID)).toEqual(expected);
    expect(links(batched.state)).toEqual(links(parallel.state));
    // Receipts stay in submitted order, independent of the execution order.
    expect(result.operators.map(o => o.id)).toEqual(specs.map(s => s.id));
  });

  test("the dataflow tool routes each operator through ToolCallScheduler.wrap", async () => {
    const { execute } = setup();
    const wrapped = spyOn(ToolCallScheduler.prototype, "wrap");
    try {
      const result = await execute([total, selected, source]);
      expect(result.operators.every(o => o.status === "added")).toBe(true);
      expect(wrapped.mock.calls.map(call => call[0])).toEqual(["aggregate", "filter", "scan"]);
    } finally {
      wrapped.mockRestore();
    }
  });

  test("extends an existing DAG with forward-referenced branches and a join without losing old consumers", async () => {
    const { state, execute } = setup();
    await execute([source, selected, total]);
    const before = links(state);
    const result = await execute([
      { op: "join", id: "paired", left: "projected", right: "other", on: "x", type: "left" },
      { op: "project", id: "projected", input: "large", keep: ["x"] },
      { op: "filter", id: "large", input: "selected", predicate: "x > 10" },
      { ...source, id: "other" },
    ]);
    expect(result.operators.every(o => o.status === "added")).toBe(true);
    expect(links(state)).toEqual(
      [
        ...before,
        "selected->large:input-0",
        "large->projected:input-0",
        "projected->paired:input-0",
        "other->paired:input-1",
      ].sort()
    );
    expect(state.getOperator("paired")?.nativeOp?.inputs).toEqual(["projected", "other"]);
  });

  test("an upstream revision is scheduled before a new consumer through unchanged existing nodes", async () => {
    const { state, execute } = setup();
    await execute([source, selected, total]);
    const writes = spyOn(state, "addOperator");
    try {
      const result = await execute([
        { op: "compute", id: "answer", input: "total", columns: { doubled: "count * 2" } },
        { ...source, files: "data/revised.csv" },
      ]);
      expect(result.operators.map(o => o.status)).toEqual(["added", "modified"]);
      expect(writes.mock.calls.map(call => call[0].operatorID)).toEqual(["source", "answer"]);
      expect(links(state)).toEqual(["selected->total:input-0", "source->selected:input-0", "total->answer:input-0"]);
    } finally {
      writes.mockRestore();
    }
  });

  test("rewires an existing node to a new producer while adding its new downstream chain", async () => {
    const { state, execute } = setup();
    await execute([source, selected, total]);
    const result = await execute([
      { op: "limit", id: "answer", input: "projected", n: 1 },
      { op: "project", id: "projected", input: "selected", keep: ["x"] },
      { ...selected, input: "replacement" },
      { ...source, id: "replacement" },
    ]);
    expect(result.operators.map(o => o.status)).toEqual(["added", "added", "modified", "added"]);
    expect(links(state)).toEqual([
      "projected->answer:input-0",
      "replacement->selected:input-0",
      "selected->projected:input-0",
      "selected->total:input-0",
    ]);
    expect(state.getOperator("source")).toBeDefined();
  });

  for (const revision of [
    { ...source, files: 42 }, // Schema failure before scheduling.
    { ...source, columns: ["x"] }, // Typed compilation rejects the deprecated field.
  ]) {
    test(`failed upstream revision blocks through an unchanged node (${JSON.stringify(revision)})`, async () => {
      const { state, execute } = setup();
      await execute([source, selected]);
      const before = state.getOperator("source");
      const result = await execute([total, revision, { ...source, id: "independent" }]);
      expect(result.operators.map(o => o.status)).toEqual(["blocked", "error", "added"]);
      expect(result.operators[0].message).toContain("source");
      expect(state.getOperator("source")).toEqual(before);
      expect(state.getOperator("total")).toBeUndefined();
      expect(links(state)).toEqual(["source->selected:input-0"]);
    });
  }

  test("missing inputs and cycles through the existing DAG leave it intact while unrelated edits land", async () => {
    const { state, execute } = setup();
    await execute([source, selected, total]);
    const before = links(state);
    const result = await execute([
      { op: "compute", id: "answer", input: "total", columns: { value: "1" } },
      { ...selected, input: "answer" },
      { op: "limit", id: "dangling", input: "missing", n: 1 },
      { ...source, id: "independent" },
    ]);
    expect(result.operators.map(o => o.status)).toEqual(["error", "error", "error", "added"]);
    expect(result.operators[0].message).toContain("cycle");
    expect(result.operators[2].message).toContain("missing");
    expect(links(state)).toEqual(before);
  });
});
