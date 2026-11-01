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

/** The one diagnostic record an event retained (records are never inherited). */
function recordOf(storage: WorkflowSnapshotStorage, stepId: string) {
  const records = Object.values(storage.getAssociatedSnapshot(stepId).nativeDiagnostics ?? {});
  expect(records.length).toBe(1);
  return records[0];
}

test("execution diagnostics bind to immutable event source and stay pinned after repair", () => {
  const storage = store(),
    initial = workflow();
  storage.createSnapshot("A", initial);
  const info = failure();
  storage.setOperatorResult("A", "answer", info);
  const first = recordOf(storage, "A");
  expect(first.submittedSource?.text).toContain("ORIGINAL_SOURCE");
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(storage.getOperatorResult("A", "answer")?.error).not.toContain(secret);
  expect(JSON.stringify(first)).not.toContain("GENERATED_RUNTIME_NOT_FOR_THE_MODEL");
  expect(first.executionId).toBe("100");
  expect(first.diagnosticId).toMatch(/^diag_[a-f0-9]{24}$/);
  expect(storage.getOperatorResult("A", "answer")?.nativeError?.diagnosticId).toBe(first.diagnosticId);
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
  expect(storage.getOperatorResult("B", "answer")?.nativeError).toBeUndefined();
  const pinned = recordOf(storage, "A");
  expect(pinned).toEqual(first);
  expect(JSON.stringify(pinned)).not.toContain("MUTATED_");
  expect(JSON.stringify(pinned)).not.toContain("REPAIRED_SOURCE");
  expect(Object.isFrozen(pinned)).toBe(true);
  expect(Object.isFrozen(pinned.diagnostic)).toBe(true);
});

test("same revision in different executions has distinct IDs", () => {
  const storage = store();
  storage.createSnapshot("A", workflow());
  storage.setOperatorResult("A", "answer", failure());
  const first = recordOf(storage, "A");
  storage.createSnapshot("B", workflow());
  storage.setOperatorResult("B", "answer", failure("r1", "101"));
  const second = recordOf(storage, "B");
  expect(second.executionId).toBe("101");
  expect(second.operatorRevision).toBe(first.operatorRevision);
  expect(second.diagnosticId).not.toBe(first.diagnosticId);
});

test("late/wrong-revision source pointers are withheld instead of using today's code", () => {
  const storage = store();
  storage.createSnapshot("A", workflow("r2", "TODAY_SOURCE"));
  storage.setOperatorResult("A", "answer", failure("r1"));
  const record = recordOf(storage, "A");
  expect(record.diagnostic.code).toBe("DIAGNOSTIC_BINDING_MISMATCH");
  expect(record.submittedSource).toBeUndefined();
  expect(JSON.stringify(record)).not.toContain("TODAY_SOURCE");
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
  expect(storage.getOperatorResult("A", "constructor")?.nativeError?.operatorId).toBe("constructor");
  expect(recordOf(storage, "A").operatorId).toBe("constructor");
});
