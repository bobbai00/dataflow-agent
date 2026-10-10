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

import { expect, test } from "bun:test";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { formatOperatorResult } from "../tools/result-formatting";
import { WorkflowState } from "../workflow-state";

const secret = "delegated-credential-not-to-echo";
function workflow(revision = "r1", text = "ORIGINAL_SOURCE"): WorkflowContent {
  const op = (id: string, inputs: string[]): OperatorPredicate => ({
    operatorID: id,
    operatorType: inputs.length ? "DataProcessing" : "DataLoading",
    operatorVersion: "1",
    operatorProperties: { code: "GENERATED_RUNTIME_NOT_FOR_THE_MODEL" },
    nativeOp: {
      type: "Process",
      revision: id === "answer" ? revision : "input-r1",
      inputs,
      properties: { code: `def process(source):\n    note = '${text}'\n    raise ValueError('failure')` },
    },
    inputPorts: inputs.map((_, i) => ({ portID: `in-${i}` })),
    outputPorts: [{ portID: "out" }],
    showAdvanced: false,
  });
  return {
    operators: [op("source", []), op("answer", ["source"]), op("final", ["answer"])],
    links: [
      {
        linkID: "s-a",
        source: { operatorID: "source", portID: "out" },
        target: { operatorID: "answer", portID: "in-0" },
      },
      {
        linkID: "a-f",
        source: { operatorID: "answer", portID: "out" },
        target: { operatorID: "final", portID: "in-0" },
      },
    ],
    operatorPositions: {},
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}
function failure(revision = "r1", executionId = "100"): OperatorInfo {
  return {
    state: "Failed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
    executionContext: { workflowId: 17, executionId },
    error:
      "NATIVE_ERROR_V2:" +
      JSON.stringify({
        version: 1,
        operatorId: "answer",
        operatorRevision: revision,
        stage: "execute",
        code: "CALLBACK_RUNTIME",
        field: "code",
        message: `ValueError: ${secret}`,
        source: { entry: "process", line: 3, excerpt: "    raise ValueError('failure')" },
      }),
  };
}
function store() {
  const paths: Record<string, string[]> = { A: ["A"], B: ["A", "B"], C: ["A", "B", "C"], X: ["A", "X"] };
  return new WorkflowSnapshotStorage(
    id => paths[id] ?? [],
    () => 17,
    () => [secret]
  );
}

test("execution diagnostics bind to immutable event source and remain inspectable after repair", () => {
  const storage = store(),
    initial = workflow();
  storage.createSnapshot("A", initial);
  const info = failure();
  storage.setOperatorResult("A", "answer", info);
  const first = storage.inspectNativeError("A", { operatorId: "answer" });
  expect(first.found).toBe(true);
  expect(first.text).toContain("ORIGINAL_SOURCE");
  expect(first.text).not.toContain(secret);
  expect(storage.getOperatorResult("A", "answer")?.error).not.toContain(secret);
  expect(first.text).not.toContain("GENERATED_RUNTIME_NOT_FOR_THE_MODEL");
  expect(first.summary?.executionId).toBe("100");
  expect(first.summary?.diagnosticId).toMatch(/^diag_[a-f0-9]{24}$/);
  initial.operators[1].nativeOp!.properties.code = "MUTATED_CALLER_SOURCE";
  info.error = "MUTATED_ERROR";
  storage.createSnapshot("B", workflow("r2", "REPAIRED_SOURCE"));
  storage.setOperatorResult("B", "answer", {
    state: "Completed",
    inputTuples: 1,
    outputTuples: 1,
    resultMode: "table",
    result: [{ answer: 42 }],
  });
  expect(storage.inspectNativeError("B", { operatorId: "answer" }).found).toBe(false);
  const past = storage.inspectNativeError("B", { operatorId: "answer", revision: "r1" });
  expect(past.found).toBe(true);
  expect(past.text).toContain("Historical error");
  expect(past.text).toContain("ORIGINAL_SOURCE");
  expect(past.text).not.toContain("REPAIRED_SOURCE");
  expect(past.text).not.toContain("MUTATED_");
  expect(past.summary).toEqual(first.summary);
  const frozen = Object.values(storage.getAssociatedSnapshot("A").nativeDiagnostics!)[0];
  expect(Object.isFrozen(frozen)).toBe(true);
  expect(Object.isFrozen(frozen.diagnostic)).toBe(true);
});

test("same revision in different executions has distinct IDs; revision lookup follows the active branch", () => {
  const storage = store();
  storage.createSnapshot("A", workflow());
  storage.setOperatorResult("A", "answer", failure());
  const first = storage.inspectNativeError("A", { operatorId: "answer" });
  storage.createSnapshot("B", workflow());
  storage.setOperatorResult("B", "answer", failure("r1", "101"));
  const second = storage.inspectNativeError("B", { operatorId: "answer", revision: "r1" });
  expect(second.summary?.executionId).toBe("101");
  expect(second.summary?.diagnosticId).not.toBe(first.summary?.diagnosticId);
  storage.createSnapshot("X", workflow());
  expect(storage.inspectNativeError("X", { operatorId: "answer", revision: "r1" }).summary).toEqual(first.summary);
  expect(
    storage.inspectNativeError("B", { operatorId: "answer", diagnosticId: first.summary!.diagnosticId }).summary
  ).toEqual(first.summary);
  expect(
    storage.inspectNativeError("B", { operatorId: "source", diagnosticId: first.summary!.diagnosticId }).found
  ).toBe(false);
});

test("missing/pruned error records never fall back to the current source or another operator", () => {
  const storage = store();
  storage.createSnapshot("A", workflow());
  storage.setOperatorResult("A", "answer", failure());
  const id = storage.inspectNativeError("A", { operatorId: "answer" }).summary!.diagnosticId;
  expect(storage.inspectNativeError("A", { operatorId: "answer", revision: "missing" }).found).toBe(false);
  storage.pruneOrphans(new Set());
  expect(storage.inspectNativeError("A", { operatorId: "answer", diagnosticId: id }).found).toBe(false);
  storage.clear();
  expect(storage.inspectNativeError(undefined, { operatorId: "answer" }).found).toBe(false);
});

test("late/wrong-revision source pointers are withheld instead of using today's code", () => {
  const storage = store();
  storage.createSnapshot("A", workflow("r2", "TODAY_SOURCE"));
  storage.setOperatorResult("A", "answer", failure("r1"));
  const result = storage.inspectNativeError("A", { operatorId: "answer" });
  expect(result.text).toContain("DIAGNOSTIC_BINDING_MISMATCH");
  expect(result.text).not.toContain("TODAY_SOURCE");
});

test("expanded inspection never exposes a truncated generated-runtime prefix as an error excerpt", () => {
  const storage = store();
  storage.createSnapshot("A", workflow());
  const info = failure();
  info.error = "GENERATED_RUNTIME_FRAME\n".repeat(1000) + info.error;
  storage.setOperatorResult("A", "answer", info);
  const inspection = storage.inspectNativeError("A", { operatorId: "answer" });
  expect(inspection.text).toContain("CALLBACK_RUNTIME");
  expect(inspection.text).not.toContain("GENERATED_RUNTIME_FRAME");
  expect(inspection.text).toContain("omitted");
});

test("expanded inspection can retrieve message detail omitted from the normal error receipt", () => {
  const storage = store();
  storage.createSnapshot("A", workflow());
  const info = failure();
  const diagnostic = JSON.parse(info.error!.slice("NATIVE_ERROR_V2:".length));
  diagnostic.message = "Invalid value. " + "detail ".repeat(100) + "END_OF_REPAIR_DETAIL";
  info.error = "NATIVE_ERROR_V2:" + JSON.stringify(diagnostic);
  storage.setOperatorResult("A", "answer", info);
  expect(storage.inspectNativeError("A", { operatorId: "answer" }).text).toContain("END_OF_REPAIR_DETAIL");
});

test("operator IDs named like object prototype fields do not hide current execution diagnostics", () => {
  const storage = store(),
    wf = workflow();
  wf.operators[1] = { ...wf.operators[1], operatorID: "constructor" };
  wf.operators[2].nativeOp!.inputs = ["constructor"];
  wf.links[0] = { ...wf.links[0], target: { ...wf.links[0].target, operatorID: "constructor" } };
  wf.links[1] = { ...wf.links[1], source: { ...wf.links[1].source, operatorID: "constructor" } };
  storage.createSnapshot("A", wf);
  const info = failure();
  info.error = info.error!.replace('"operatorId":"answer"', '"operatorId":"constructor"');
  storage.setOperatorResult("A", "constructor", info);
  expect(storage.inspectNativeError("A", { operatorId: "constructor" }).found).toBe(true);
});
