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
import type { OperatorInfo, SyncExecutionResult } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { persistOperatorResults } from "../tools/workflow-execution-tools";
import { prepareStructuredExecutionResult } from "./execution-transport";
import { workflowExecutionPlan, workflowFingerprints } from "./result-versions";

const revision = "0123456789abcdef";

test("history fingerprints reuse frozen snapshots and refresh mutable drafts", () => {
  const draft = workflow();
  const first = workflowFingerprints(draft).get("answer")!.subgraphHash;
  draft.operators[0].operatorProperties.code = "CHANGED SOURCE CODE";
  expect(workflowFingerprints(draft).get("answer")!.subgraphHash).not.toBe(first);
  const saved = storage(draft).getWorkflow("A");
  const savedProof = workflowFingerprints(saved);
  expect(workflowFingerprints(saved)).toBe(savedProof);
  draft.operators[0].operatorProperties.code = "LATER CHANGE";
  expect(workflowFingerprints(saved)).toBe(savedProof);
  expect(workflowFingerprints(draft).get("answer")!.subgraphHash).not.toBe(savedProof.get("answer")!.subgraphHash);
});
function op(id: string, inputs: string[] = [], type = inputs.length ? "project" : "scan"): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: inputs.length ? "DataProcessing" : "DataLoading",
    operatorVersion: "1",
    operatorProperties: { code: `compiled ${id}`, workers: 1 },
    inputPorts: [...new Set(inputs)].map((_, i) => ({ portID: `${id}-in-${i}` })),
    outputPorts: [{ portID: `${id}-out` }],
    showAdvanced: false,
    nativeOp: { revision, type, inputs, properties: {}, profileCollection: true },
  };
}
function workflow(operators = [op("source"), op("answer", ["source"])]): WorkflowContent {
  return {
    operators,
    operatorPositions: {},
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
    links: operators.flatMap(o =>
      [...new Set(o.nativeOp!.inputs)].map((id, i) => ({
        linkID: `${id}-${o.operatorID}-${i}`,
        source: { operatorID: id, portID: `${id}-out` },
        target: { operatorID: o.operatorID, portID: `${o.operatorID}-in-${i}` },
      }))
    ),
  };
}
function info(o: OperatorPredicate, executionId = "100", value = 1): OperatorInfo {
  const scalar = { type: "int64", value: String(value) };
  const values = [{ value: scalar, count: 1 }];
  return {
    state: "Completed",
    inputTuples: o.nativeOp!.inputs.length,
    outputTuples: 1,
    resultMode: "table",
    result: [{ x: value }],
    totalRowCount: 1,
    numWorkers: 1,
    resultSchema: [{ name: "x", type: "int64", encoding: "number-or-decimal-string" }],
    materialization: { outputPort: 0, executionId, cached: false },
    resultMetadata: {
      worker: JSON.stringify({
        protocol: "texera.table-profile",
        version: 1,
        workerId: "worker",
        producerId: "a".repeat(32),
        operatorId: o.operatorID,
        operatorRevision: o.nativeOp!.revision,
        status: "available",
        coverage: { scope: "worker", complete: true, rowsProcessed: 1, yields: 1 },
        rowCount: 1,
        columnCount: 1,
        schema: [{ name: "x", type: "int64", dtype: "Int64" }],
        schemaComplete: true,
        columns: {
          x: {
            type: "int64",
            rowsProcessed: 1,
            nullCount: 0,
            nonnullCount: 1,
            nullRatio: 0,
            distinctCount: 1,
            uniquenessRatio: 1,
            min: scalar,
            max: scalar,
            frequencies: { values, otherCount: 0, truncated: false },
            mergeValues: values,
            omissions: [],
          },
        },
        native: {
          operatorType: o.nativeOp!.type,
          inputOperators: o.nativeOp!.inputs,
          operations:
            o.nativeOp!.type === "scan"
              ? {
                  scan: {
                    sources: [{ path: "/authorized/data/a.csv", sizeBytes: 12, mtimeNs: "123456789", format: "csv" }],
                  },
                }
              : {},
        },
        structure: { duplicateRows: 0, allNullRows: 0, allNullColumns: [] },
        algorithm: {
          name: "bounded-exact-v1",
          rowSelection: "prefix",
          distinctLimit: 256,
          rowDistinctLimit: 4096,
          topK: 8,
        },
        omissions: [],
        cost: { collectionMs: 0.1, cellsProcessed: 1, payloadBytes: 0 },
      }),
    },
  };
}
function response(wf: WorkflowContent, executionId = "100", values = wf.operators.map(o => info(o, executionId))) {
  const raw: SyncExecutionResult = {
    success: true,
    state: "Completed",
    executionId,
    capabilities: ["typed-scalar-v1", "table-profile-v1", "schema-fields-only-v1"],
    operators: Object.fromEntries(wf.operators.map((o, i) => [o.operatorID, values[i]]).reverse()),
  };
  return prepareStructuredExecutionResult(raw, 17, workflowExecutionPlan(wf));
}
function storage(wf: WorkflowContent) {
  const s = new WorkflowSnapshotStorage(
    id => (id === "A" ? ["A"] : ["A", id]),
    () => 17
  );
  s.createSnapshot("A", wf);
  return s;
}
function persist(s: WorkflowSnapshotStorage, r: SyncExecutionResult, step = "A") {
  persistOperatorResults(r.operators, (id, value) => s.setOperatorResult(step, id, value));
}

test("reversed response order binds profiles to exact input versions and source identities", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  const source = s.getOperatorResult("A", "source")!;
  const answer = s.getOperatorResult("A", "answer")!;
  expect(source.resultVersion).toMatchObject({
    workflowId: 17,
    operatorId: "source",
    operatorRevision: revision,
    outputPort: 0,
    executionId: "100",
    complete: true,
    sourceFingerprints: [{ path: "/authorized/data/a.csv", sizeBytes: 12, mtimeNs: "123456789" }],
  });
  expect(answer.resultVersion?.inputs).toEqual([
    { inputIndex: 0, operatorId: "source", outputPort: 0, resultVersion: source.resultVersion!.id },
  ]);
  expect(answer.tableProfile).toMatchObject({ status: "available", resultVersion: answer.resultVersion!.id });
});

test("cached observe preserves version and a verified cache hit reuses the producing profile", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  const before = s.getOperatorResult("A", "answer")!;
  s.createSnapshot("B", wf);
  expect(s.getOperatorResult("B", "answer")!.resultVersion).toEqual(before.resultVersion);
  const cached = wf.operators.map(o => ({
    ...info(o),
    resultMetadata: undefined,
    materialization: { outputPort: 0, executionId: "100", cached: true, subdagHash: "engine-cache-key" },
  }));
  persist(s, response(wf, "101", cached), "B");
  const after = s.getOperatorResult("B", "answer")!;
  expect(after.executionContext?.executionId).toBe("101");
  expect(after.resultVersion).toEqual(before.resultVersion);
  expect(after.tableProfile).toEqual(before.tableProfile);
  expect(s.getOperatorResult("A", "answer")).toEqual(before);
});

test("same-shaped upstream edits invalidate profiles, while historical observations stay pinned", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  const before = structuredClone(s.getOperatorResult("A", "answer"));
  const changed = structuredClone(wf);
  changed.operators[0].operatorProperties.code = "different source values";
  changed.operators[0].nativeOp!.revision = "fedcba9876543210";
  s.createSnapshot("B", changed);
  expect(s.getOperatorResult("B", "answer")).toBeUndefined();
  persist(
    s,
    response(
      changed,
      "102",
      changed.operators.map(o => info(o, "102", 2))
    ),
    "B"
  );
  expect(s.getOperatorResult("B", "answer")!.resultVersion?.id).not.toBe(before!.resultVersion!.id);
  expect(s.getOperatorResult("A", "answer")).toEqual(before);
  // A delayed old request must not restore its data/profile into the new snapshot.
  persist(s, response(wf), "B");
  expect(s.getOperatorResult("B", "answer")!.result).toEqual([{ x: 2 }]);
});

test("new materialization without a code change invalidates same-step descendants and rejects late inputs", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  const fresh = response(
    wf,
    "102",
    wf.operators.map(o => info(o, "102", 2))
  );
  s.setOperatorResult("A", "source", fresh.operators.source);
  expect(s.getOperatorResult("A", "answer")).toBeUndefined();
  s.setOperatorResult("A", "answer", response(wf).operators.answer);
  expect(s.getOperatorResult("A", "answer")).toBeUndefined();
  s.setOperatorResult("A", "answer", fresh.operators.answer);
  s.setOperatorResult("A", "source", response(wf).operators.source);
  expect(s.getOperatorResult("A", "answer")!.result).toEqual([{ x: 2 }]);
});

test("self-joins preserve two logical roles even with one physical input", () => {
  const wf = workflow([op("source"), op("answer", ["source", "source"], "join")]);
  const s = storage(wf);
  persist(s, response(wf));
  const inputs = s.getOperatorResult("A", "answer")!.resultVersion!.inputs;
  expect(inputs.map(i => i.inputIndex)).toEqual([0, 1]);
  expect(inputs[0].resultVersion).toBe(inputs[1].resultVersion);
});

test("missing cache origin/profile stays unavailable rather than using the current retrieval as producer", () => {
  const wf = workflow([op("source")]);
  const s = storage(wf);
  const cached = {
    ...info(wf.operators[0]),
    resultMetadata: undefined,
    materialization: { outputPort: 0, executionId: null, cached: true },
  };
  persist(s, response(wf, "103", [cached]));
  const result = s.getOperatorResult("A", "source")!;
  expect(result.result).toEqual([{ x: 1 }]);
  expect(result.resultVersion).toMatchObject({ executionId: null, complete: false });
  expect(result.tableProfile?.status).toBe("unavailable");
});

test("profile failures do not destroy data, and disabled collection does not decode stray envelopes", () => {
  const wf = workflow([op("source")]);
  const s = storage(wf);
  persist(s, response(wf, "100", [{ ...info(wf.operators[0]), resultMetadata: { bad: "not JSON" } }]));
  expect(s.getOperatorResult("A", "source")!.result).toEqual([{ x: 1 }]);
  expect(s.getOperatorResult("A", "source")!.tableProfile?.status).toBe("unavailable");
  wf.operators[0].nativeOp!.profileCollection = false;
  const disabled = storage(wf);
  persist(disabled, response(wf));
  expect(disabled.getOperatorResult("A", "source")!.tableProfile).toBeUndefined();
});

test("workflow identity, physical input wiring and native metadata are checked independently", () => {
  const wf = workflow();
  const s = storage(wf);
  const wrongWorkflow = response(wf);
  wrongWorkflow.operators.source.executionContext!.workflowId = 18;
  s.setOperatorResult("A", "source", wrongWorkflow.operators.source);
  expect(s.getOperatorResult("A", "source")).toBeUndefined();
  const miswired = workflow([op("source"), op("other"), op("answer", ["source"])]);
  (miswired.links[0].source as { operatorID: string; portID: string }).operatorID = "other";
  (miswired.links[0].source as { operatorID: string; portID: string }).portID = "other-out";
  const bad = storage(miswired);
  persist(bad, response(miswired));
  expect(bad.getOperatorResult("A", "answer")!.tableProfile?.status).toBe("unavailable");
  const changed = structuredClone(wf);
  changed.operators[0].nativeOp!.properties = { changed: true };
  persist(s, response(wf));
  s.createSnapshot("B", changed);
  expect(s.getOperatorResult("B", "answer")).toBeUndefined();
});

test("errors replace successful profiles even without observe; result metadata cannot mutate history", () => {
  const wf = workflow();
  const s = storage(wf);
  const r = response(wf);
  persist(s, r);
  const before = s.getOperatorResult("A", "source")!;
  expect(() => {
    before.tableProfile!.columns.x.nullCount = 99;
  }).toThrow();
  r.operators.source.result![0].x = 99;
  expect(before.result).toEqual([{ x: 1 }]);
  s.createSnapshot("B", wf);
  s.setOperatorResult("B", "source", {
    ...response(wf, "104").operators.source,
    result: undefined,
    error: "CAST_INVALID_VALUE",
    state: "Failed",
  });
  expect(s.getOperatorResult("B", "source")!.tableProfile).toBeUndefined();
  expect(s.getOperatorResult("B", "answer")).toBeUndefined();
  expect(before.tableProfile!.columns.x.nullCount).toBe(0);
});

test("profile-to-table count, schema and native contracts are checked, including cached reuse", () => {
  const wf = workflow([op("source")]);
  for (const changed of [
    { totalRowCount: 2 },
    { resultSchema: [{ name: "other", type: "int64", encoding: "number-or-decimal-string" }] },
  ]) {
    const fresh = storage(wf);
    persist(fresh, response(wf, "100", [{ ...info(wf.operators[0]), ...changed }]));
    expect(fresh.getOperatorResult("A", "source")!.tableProfile!.status).toBe("unavailable");
    const cached = storage(wf);
    persist(cached, response(wf));
    persist(
      cached,
      response(wf, "101", [
        {
          ...info(wf.operators[0]),
          resultMetadata: undefined,
          ...changed,
          materialization: { outputPort: 0, executionId: "100", cached: true },
        },
      ])
    );
    expect(cached.getOperatorResult("A", "source")!.tableProfile!.status).toBe("unavailable");
  }
  const bad = info(wf.operators[0]);
  const metadata = JSON.parse(bad.resultMetadata!.worker);
  metadata.native.operatorType = "udf";
  bad.resultMetadata!.worker = JSON.stringify(metadata);
  const s = storage(wf);
  persist(s, response(wf, "100", [bad]));
  expect(s.getOperatorResult("A", "source")!.tableProfile!.omissions).toContain("profile_native_contract_mismatch");
});

test("partial worker coverage stays partial after binding, never a fabricated complete output", () => {
  const wf = workflow([op("source")]);
  const s = storage(wf);
  persist(s, response(wf, "100", [{ ...info(wf.operators[0]), numWorkers: 2 }]));
  const result = s.getOperatorResult("A", "source")!;
  expect(result.resultVersion!.complete).toBe(true);
  expect(result.tableProfile).toMatchObject({ status: "partial", coverage: { complete: false }, rowCount: null });
});

test("empty object columns use the materialized schema without guessing a type from samples", () => {
  const wf = workflow([op("source")]);
  const empty = info(wf.operators[0]);
  const metadata = JSON.parse(empty.resultMetadata!.worker);
  Object.assign(metadata, { rowCount: 0, native: null });
  metadata.coverage.rowsProcessed = 0;
  metadata.schema = [{ name: "x", type: "unknown", dtype: "object" }];
  Object.assign(metadata.columns.x, {
    type: "unknown",
    rowsProcessed: 0,
    nullCount: 0,
    nonnullCount: 0,
    nullRatio: null,
    distinctCount: 0,
    uniquenessRatio: null,
    min: null,
    max: null,
    frequencies: { values: [], otherCount: 0, truncated: false },
    mergeValues: [],
  });
  Object.assign(empty, {
    result: [],
    totalRowCount: 0,
    outputTuples: 0,
    resultSchema: [{ name: "x", type: "str", encoding: "native" }],
    resultMetadata: { worker: JSON.stringify(metadata) },
  });
  const s = storage(wf);
  persist(s, response(wf, "100", [empty]));
  const profile = s.getOperatorResult("A", "source")!.tableProfile!;
  expect(profile.status).toBe("available");
  expect(profile.schema[0].type).toBe("str");
  expect(profile.columns.x.type).toBe("str");
  expect(profile.columns.x.nonnullCount).toBe(0);
});

test("unknown cache input history is not bound to newly materialized inputs", () => {
  const wf = workflow();
  const s = storage(wf);
  const values = [
    info(wf.operators[0], "101"),
    {
      ...info(wf.operators[1]),
      resultMetadata: undefined,
      materialization: { outputPort: 0, executionId: "100", cached: true },
    },
  ];
  persist(s, response(wf, "101", values));
  const answer = s.getOperatorResult("A", "answer")!;
  expect(answer.resultVersion!.complete).toBe(false);
  expect(answer.resultVersion!.inputs[0].resultVersion).toBeNull();
  expect(answer.tableProfile!.status).toBe("unavailable");
});

test("snapshot workflow definitions are immutable and request hashing ignores UI/object-key ordering", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  expect(() => {
    s.getWorkflow("A").operators[0].operatorProperties.code = "mutated";
  }).toThrow();
  const reordered = structuredClone(wf);
  Object.assign(reordered.operators[0], {
    operatorProperties: { workers: 1, code: "compiled source" },
    customDisplayName: "new label",
  });
  const other = storage(reordered);
  persist(other, response(reordered));
  expect(other.getOperatorResult("A", "answer")!.resultVersion!.id).toBe(
    s.getOperatorResult("A", "answer")!.resultVersion!.id
  );
});

test("an unchanged cached input can be version-bound without requesting its table again", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  const changed = structuredClone(wf);
  changed.operators[1].operatorProperties.code = "revised consumer";
  s.createSnapshot("B", changed);
  const raw: SyncExecutionResult = {
    success: true,
    state: "Completed",
    executionId: "101",
    capabilities: ["typed-scalar-v1", "table-profile-v1", "schema-fields-only-v1"],
    operators: { answer: info(changed.operators[1], "101") },
    inputMaterializations: { source: { outputPort: 0, executionId: "100", cached: true } },
  };
  persist(s, prepareStructuredExecutionResult(raw, 17, workflowExecutionPlan(changed)), "B");
  expect(s.getOperatorResult("B", "answer")!.resultVersion!.complete).toBe(true);
  expect(s.getOperatorResult("B", "answer")!.tableProfile!.status).toBe("available");
  expect(s.getOperatorResult("B", "source")!.executionContext!.executionId).toBe("100");
});

test("fresh unrequested inputs invalidate older visible data without discarding the new consumer result", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  s.createSnapshot("B", wf);
  const fresh = response(
    wf,
    "102",
    wf.operators.map(o => info(o, "102", 2))
  );
  // Only the consumer table is available; the request proves its input was freshly
  // produced, but supplies no new source table/profile to replace the old one.
  s.setOperatorResult("B", "answer", fresh.operators.answer);
  expect(s.getOperatorResult("B", "answer")!.result).toEqual([{ x: 2 }]);
  expect(s.getOperatorResult("B", "answer")!.tableProfile!.status).toBe("unavailable");
  expect(s.getOperatorResult("B", "source")).toBeUndefined();
  expect(s.getOperatorResult("A", "source")!.result).toEqual([{ x: 1 }]);
});

test("repair can reuse a pinned historical profile only with the same producer and input versions", () => {
  const wf = workflow();
  const s = storage(wf);
  persist(s, response(wf));
  const good = s.getOperatorResult("A", "answer")!;
  s.createSnapshot("B", wf);
  s.setOperatorResult("B", "answer", {
    ...response(wf, "101").operators.answer,
    result: undefined,
    state: "Failed",
    error: "CALLBACK_RETURN_TYPE",
  });
  const repaired = response(
    wf,
    "102",
    wf.operators.map(o => ({
      ...info(o),
      resultMetadata: undefined,
      materialization: { outputPort: 0, executionId: "100", cached: true },
    }))
  );
  persist(s, repaired, "B");
  expect(s.getOperatorResult("B", "answer")!.resultVersion).toEqual(good.resultVersion);
  expect(s.getOperatorResult("B", "answer")!.tableProfile).toEqual(good.tableProfile);
  // The same old producer cannot lend its profile to different current inputs.
  const newInput = response(
    wf,
    "103",
    wf.operators.map(o => info(o, "103", 2))
  );
  s.setOperatorResult("B", "source", newInput.operators.source);
  const mismatched = response(wf, "104", [
    info(wf.operators[0], "103", 2),
    {
      ...info(wf.operators[1]),
      resultMetadata: undefined,
      materialization: { outputPort: 0, executionId: "100", cached: true },
    },
  ]);
  s.setOperatorResult("B", "answer", mismatched.operators.answer);
  expect(s.getOperatorResult("B", "answer")!.tableProfile!.status).toBe("unavailable");
});

test("a bystander of a failed run keeps its cached result; a consumer of the failure does not", () => {
  // legal-hard-28: observing `general_imposter` (cached, unrelated) after another
  // operator failed returned "[ERROR] … not executed" instead of its table.
  const base = workflow();
  const s = storage(base);
  persist(s, response(base));
  const next = workflow([op("source"), op("answer", ["source"]), op("bad"), op("uses_bad", ["bad"])]);
  s.createSnapshot("B", next);
  const failure = (_o: OperatorPredicate): OperatorInfo => ({
    state: "Failed",
    resultMode: "table",
    inputTuples: 0,
    outputTuples: 0,
    error:
      "NATIVE_ERROR_V2:" +
      JSON.stringify({
        version: 1,
        operatorId: "bad",
        operatorRevision: revision,
        code: "CALLBACK_RUNTIME",
        stage: "execute",
        message: "ValueError: boom",
      }),
  });
  for (const o of next.operators) s.setOperatorResult("B", o.operatorID, failure(o));
  const answer = s.getOperatorResult("B", "answer")!;
  expect(answer.error).toBeUndefined();
  expect(answer.result).toEqual([{ x: 1 }]);
  expect(s.getOperatorResult("B", "uses_bad")!.error).toContain("bad");
  expect(s.getOperatorResult("B", "bad")!.error).toContain("boom");
});
