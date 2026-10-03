/*
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

/**
 * `messageLayout: "opBlock"` — one user message per operator, creation order.
 *
 * A block holds what is true of THAT operator right now: its inputs, its
 * parameters, and the result its current definition produced. What it must not
 * hold is anything about which step we are on, because that rewrites an early
 * message for a reason unrelated to the operator and drops the provider's
 * prefix cache from there down.
 *
 * Observing an operator SUBSCRIBES it: the block keeps a result section from
 * then on. The body is re-rendered from the live result every time, never
 * replayed from the text captured when it was observed — LATEST's whole point
 * is that what you read is what is true now.
 *
 * The properties these tests pin:
 *   1. a result the agent never asked for is still not shown;
 *   2. a result it did ask for is not withdrawn when it looks elsewhere;
 *   3. a redefined operator shows what its NEW definition produced;
 *   4. an upstream change refreshes every downstream result the agent watches.
 */

import { expect, test } from "bun:test";
import { AgentMode, ContextMode, type ReActStep } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import { createNativeTools } from "../tools/native-batch-tools";
import { dataflowInput, type LegacySpec } from "./test-support";
import { prepareStructuredExecutionResult } from "./execution-transport";
import { workflowExecutionPlan } from "./result-versions";

function fixture() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const tools = createNativeTools(state, {
    metadataStore: metadata,
    settings: { nativeProfileCollection: true },
  } as any);
  const steps: ReActStep[] = [];
  const storage = new WorkflowSnapshotStorage(
    id => steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id),
    () => 17
  );

  const record = async (id: string, operators: Record<string, unknown>[], observe: string[]) => {
    const input = dataflowInput({ operators: operators as LegacySpec[], observe });
    const output = await tools.dataflow.execute(input);
    steps.push({
      id,
      parentId: steps.at(-1)?.id,
      messageId: "m",
      stepId: steps.length + 1,
      timestamp: 1,
      role: "agent",
      content: "",
      isBegin: false,
      isEnd: false,
      toolCalls: [{ toolName: "dataflow", toolCallId: id, input }],
      toolResults: [{ toolCallId: id, output }],
    });
    storage.createSnapshot(id, state.getWorkflowContent());
  };

  const persist = (step: string, values: Record<string, number[]>, execution: string) => {
    const workflow = state.getWorkflowContent();
    const raw: Record<string, OperatorInfo> = {};
    for (const [id, nums] of Object.entries(values)) {
      const v = workflow.operators.find(o => o.operatorID === id)!.nativeOp!;
      const distinct = [...new Set(nums)].sort((a, b) => a - b);
      const scalar = (n: number) => ({ type: "int64", value: String(n) });
      const counts = distinct.map(n => ({ value: scalar(n), count: nums.filter(x => x === n).length }));
      const inputs = v.inputs.map(up => values[up]?.length ?? storage.getOperatorResult(step, up)?.totalRowCount!);
      raw[id] = {
        state: "Completed",
        inputTuples: inputs.reduce((a, b) => a + b, 0),
        outputTuples: nums.length,
        resultMode: "table",
        result: nums.slice(0, 1).map(x => ({ x })),
        totalRowCount: nums.length,
        truncated: nums.length > 1,
        numWorkers: 1,
        resultSchema: [{ name: "x", type: "int64", encoding: "number-or-decimal-string" }],
        materialization: { outputPort: 0, executionId: execution, cached: false },
        resultMetadata: {
          w: JSON.stringify({
            protocol: "texera.table-profile",
            version: 1,
            workerId: "w",
            producerId: "a".repeat(32),
            operatorId: id,
            operatorRevision: v.revision,
            status: "available",
            coverage: { scope: "worker", complete: true, rowsProcessed: nums.length, yields: 1 },
            rowCount: nums.length,
            columnCount: 1,
            schema: [{ name: "x", type: "int64", dtype: "Int64" }],
            schemaComplete: true,
            columns: {
              x: {
                type: "int64",
                rowsProcessed: nums.length,
                nullCount: 0,
                nonnullCount: nums.length,
                nullRatio: nums.length ? 0 : null,
                distinctCount: distinct.length,
                uniquenessRatio: nums.length ? distinct.length / nums.length : null,
                min: nums.length ? scalar(Math.min(...nums)) : null,
                max: nums.length ? scalar(Math.max(...nums)) : null,
                frequencies: { values: counts, otherCount: 0, truncated: false },
                mergeValues: counts,
                omissions: [],
              },
            },
            structure: { duplicateRows: nums.length - distinct.length, allNullRows: 0, allNullColumns: [] },
            native: {
              operatorType: v.type,
              inputOperators: v.inputs,
              inputRows: inputs,
              outputRows: nums.length,
              operations:
                v.type === "Filter"
                  ? { keptRows: nums.length, rejectedRows: inputs[0] - nums.length, nullPredicates: 0 }
                  : {},
            },
            algorithm: {
              name: "bounded-exact-v1",
              rowSelection: "prefix",
              distinctLimit: 256,
              rowDistinctLimit: 4096,
              topK: 8,
            },
            omissions: [],
            cost: { collectionMs: 0, cellsProcessed: nums.length, payloadBytes: 0 },
          }),
        },
      };
    }
    const response = prepareStructuredExecutionResult(
      {
        success: true,
        state: "Completed",
        operators: raw,
        executionId: execution,
        capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
        inputMaterializations: Object.fromEntries(
          workflow.operators.map(op => [
            op.operatorID,
            raw[op.operatorID]?.materialization ?? storage.getOperatorResult(step, op.operatorID)?.materialization!,
          ])
        ),
      },
      17,
      workflowExecutionPlan(workflow)
    );
    for (const [id, info] of Object.entries(response.operators)) storage.setOperatorResult(step, id, info);
  };

  const render = (layout: "opBlock" | "opSplit") =>
    assembleContext(steps, state, storage, ContextMode.LATEST, {
      agentMode: AgentMode.NATIVE,
      messageLayout: layout,
      dataEvidence: true,
      flowEvidence: true,
      maxOperatorResultCharLimit: 2000,
    }).map(m => String(m.content));

  return { state, steps, storage, record, persist, render };
}

/** The message that carries one operator's block, or "" if it has none. */
const blockFor = (messages: string[], id: string) => messages.find(m => m.includes(`**${id}**`)) ?? "";
const hasBody = (block: string) => block.includes("records:");

const source = { op: "scan", id: "source", files: "data/test.csv" };
const selected = {
  op: "filter",
  id: "selected",
  input: "source",
  columns: ["x"],
  func: "def apply(row):\n    return row['x'] > 0",
};
const final = { op: "project", id: "final", input: "selected", keep: ["x"] };

async function threeOperatorGraph() {
  const f = fixture();
  await f.record("A", [source, selected, final], ["selected"]);
  f.persist("A", { source: [-1, 0, 10, 20, 30], selected: [10, 20, 30], final: [10, 20, 30] }, "100");
  f.storage.captureNativeObservations("A", ["selected"], { data: true, flow: true, maxChars: 2000 });
  return f;
}

test("opBlock: a result the agent never observed is still withheld", async () => {
  const f = await threeOperatorGraph();
  const messages = f.render("opBlock");

  // The observed operator shows its body, with its operator semantics intact.
  expect(hasBody(blockFor(messages, "selected"))).toBe(true);
  expect(blockFor(messages, "selected")).toContain("- flow: Filter kept=3/5");
  // Author descriptions stay in definitions; guarantees describe the contract.
  expect(blockFor(messages, "selected")).toContain("- flow: contract; Filter: stable subset");
  expect(blockFor(messages, "selected")).not.toContain("- flow: contract; Filter: legacy fixture");

  // The two the agent did not ask for carry a row count and nothing else. An
  // unobserved table is not leaked just because the layout retains bodies.
  for (const id of ["source", "final"]) {
    expect(hasBody(blockFor(messages, id))).toBe(false);
    expect(blockFor(messages, id)).toContain("result:");
  }
  expect(messages.join("\n")).not.toContain("Sample record: -1");
});

test("opBlock: an observed result survives the agent looking elsewhere", async () => {
  const f = await threeOperatorGraph();

  // A cached read of a different operator. No operator is edited or re-run.
  await f.record("B", [], ["final"]);
  f.storage.captureNativeObservations("B", ["final"], { data: true, flow: true, maxChars: 2000 });
  const messages = f.render("opBlock");

  expect(hasBody(blockFor(messages, "final"))).toBe(true);
  // `selected` keeps the body it earned at step A: nothing about it changed.
  expect(hasBody(blockFor(messages, "selected"))).toBe(true);
  expect(blockFor(messages, "selected")).toContain("- flow: Filter kept=3/5");
  // Still never observed, so still withheld.
  expect(hasBody(blockFor(messages, "source"))).toBe(false);

  // Today's layout withdraws it, which is the churn opBlock exists to remove.
  const today = f.render("opSplit");
  expect(hasBody(blockFor(today, "selected"))).toBe(false);
  expect(blockFor(today, "selected")).toContain("result not requested");
});

test("opBlock: a redefined operator shows the result its NEW definition produced", async () => {
  const f = await threeOperatorGraph();

  // Same id, new predicate, re-executed: a new revision and a new result.
  await f.record("B", [{ ...selected, func: "def apply(row):\n    return row['x'] > 15" }], []);
  f.persist("B", { selected: [20, 30], final: [20, 30] }, "101");
  const messages = f.render("opBlock");

  // The block still carries a result — and it is the CURRENT one.
  expect(hasBody(blockFor(messages, "selected"))).toBe(true);
  expect(blockFor(messages, "selected")).toContain("result: 2 rows");
  expect(blockFor(messages, "selected")).toContain("row['x'] > 15");
  // The measurement from the superseded revision is gone, not merely moved.
  expect(messages.join("\n")).not.toContain("- flow: Filter kept=3/5");
  expect(blockFor(messages, "selected")).not.toContain("result: 3 rows");
});

test("opBlock: an upstream change refreshes every downstream result the agent watches", async () => {
  const f = await threeOperatorGraph();
  // `final` is observed too, so both downstream blocks are subscribed.
  await f.record("B", [], ["final"]);
  f.storage.captureNativeObservations("B", ["final"], { data: true, flow: true, maxChars: 2000 });
  expect(blockFor(f.render("opBlock"), "final")).toContain("result: 3 rows");

  // Now only the SOURCE changes. `selected` and `final` are untouched
  // definitions, but their data moves underneath them — which is precisely the
  // case LATEST exists for. Neither may keep showing the 3-row tables.
  await f.record("C", [{ ...source, files: "data/other.csv" }], []);
  f.persist("C", { source: [-1, 0, 50], selected: [50], final: [50] }, "102");
  const messages = f.render("opBlock");

  for (const id of ["selected", "final"]) {
    expect(hasBody(blockFor(messages, id))).toBe(true);
    expect(blockFor(messages, id)).toContain("result: 1 row × 1 column");
    expect(blockFor(messages, id)).not.toContain("result: 3 rows");
  }
  expect(messages.join("\n")).not.toContain("- flow: Filter kept=3/5");
  // The source itself was never observed, so it still shows only its shape.
  expect(hasBody(blockFor(messages, "source"))).toBe(false);
});

test("opBlock: observing a new operator subscribes it from then on", async () => {
  const f = await threeOperatorGraph();
  // `final` has never been observed, so it shows its shape only.
  expect(hasBody(blockFor(f.render("opBlock"), "final"))).toBe(false);

  await f.record("B", [], ["final"]);
  f.storage.captureNativeObservations("B", ["final"], { data: true, flow: true, maxChars: 2000 });
  expect(hasBody(blockFor(f.render("opBlock"), "final"))).toBe(true);

  // And it stays, once the agent moves on again.
  await f.record("C", [], ["selected"]);
  f.storage.captureNativeObservations("C", ["selected"], { data: true, flow: true, maxChars: 2000 });
  expect(hasBody(blockFor(f.render("opBlock"), "final"))).toBe(true);
});

test("opBlock: definitions and process code do not depend on the observe list", async () => {
  const f = fixture();
  const udf = {
    op: "udf",
    id: "scored",
    inputs: ["source"],
    code: "def process(source):\n    return source.assign(y=source['x'] * 2)",
  };
  await f.record("A", [source, udf], ["scored"]);
  f.persist("A", { source: [1, 2, 3], scored: [1, 2, 3] }, "100");
  f.storage.captureNativeObservations("A", ["scored"], { data: true, flow: true, maxChars: 2000 });

  const observedBlock = blockFor(f.render("opBlock"), "scored");
  // opBlock shows the process function body in every block, observed or not;
  // opSplit keeps only the statement so the body is never in the snapshot.
  expect(observedBlock).toContain("def scored_fn(source)");
  expect(observedBlock).toContain('scored = process(source, fn=scored_fn, doc="legacy fixture")');
  expect(blockFor(f.render("opSplit"), "scored")).not.toContain("def scored_fn(source)");
  expect(blockFor(f.render("opSplit"), "scored")).toContain(
    'scored = process(source, fn=scored_fn, doc="legacy fixture")'
  );

  // Every block carries its definition as written, whatever the observe list.
  for (const id of ["source", "scored"]) expect(blockFor(f.render("opBlock"), id)).toContain("definition:");
});

test("opBlock: the volatile tail sections get their own messages", async () => {
  const f = await threeOperatorGraph();
  const messages = f.render("opBlock");
  // The action receipt changes every step. Glued to the last operator it would
  // invalidate a block that did not change; it must stand alone.
  const receipt = messages.filter(m => m.includes("Last completed action in this task"));
  expect(receipt).toHaveLength(1);
  expect(receipt[0]).toContain("# Last Action");
  expect(receipt[0]).not.toContain("operator `final`");
});
