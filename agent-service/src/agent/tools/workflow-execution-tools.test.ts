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
import { persistOperatorResults } from "./workflow-execution-tools";
import type { OperatorInfo } from "../../types/execution";

function withResult(rows: number): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows,
    resultMode: "table",
    result: Array.from({ length: rows }, (_, i) => ({ x: i })),
  };
}

function withError(message: string): OperatorInfo {
  return {
    state: "Failed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
    error: message,
  };
}

function stub(state: string = "Skipped"): OperatorInfo {
  // No result array. No (or empty) error string. This is the shape the
  // backend returns for ops it touched but could not materialize — e.g.
  // a downstream operator whose upstream errored.
  return {
    state,
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
  };
}

describe("persistOperatorResults — stub-write guard (tight-accuracy invariant)", () => {
  test("forwards opInfo that carries a result array", () => {
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults({ a: withResult(3) }, (id, info) => calls.push([id, info]));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("a");
    expect(calls[0][1].result).toHaveLength(3);
  });

  test("forwards opInfo that carries an error string", () => {
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults({ a: withError("boom") }, (id, info) => calls.push([id, info]));
    expect(calls).toHaveLength(1);
    expect(calls[0][1].error).toBe("boom");
  });

  test("forwards opInfo with an empty (but defined) result array — a legitimate '0 rows' result", () => {
    // `result: []` ≠ stub: the backend executed the op and produced zero
    // rows. The agent should still see this as a real execution.
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults({ a: withResult(0) }, (id, info) => calls.push([id, info]));
    expect(calls).toHaveLength(1);
    expect(calls[0][1].result).toEqual([]);
  });

  test("drops stub entries (no result + no error)", () => {
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults({ a: stub() }, (id, info) => calls.push([id, info]));
    expect(calls).toHaveLength(0);
  });

  test("drops stub with empty-string error (treated as no error)", () => {
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults({ a: { ...stub(), error: "" } }, (id, info) => calls.push([id, info]));
    expect(calls).toHaveLength(0);
  });

  test("legal-hard-2 shape: persists upstream error and parallel branch's data, drops downstream stubs", () => {
    // metroStats errored, processIdentityTheft is on a parallel branch that
    // ran successfully, findMaxRate / inspectMerged came back as stubs
    // because their upstream (metroStats) failed.
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults(
      {
        metroStats: withError("AttributeError: 'DataFrame' object has no attribute 'dtype'"),
        identityTheftCSVs: withResult(764),
        processIdentityTheft: withResult(452),
        findMaxRate: stub(),
        inspectMerged: stub(),
      },
      (id, info) => calls.push([id, info])
    );
    const persistedIds = calls.map(([id]) => id).sort();
    expect(persistedIds).toEqual(["identityTheftCSVs", "metroStats", "processIdentityTheft"]);
    // findMaxRate and inspectMerged are skipped → the snapshot's previously
    // inherited entries (if any) are preserved by the new tight-accuracy
    // inheritance rule in `WorkflowSnapshotStorage.createSnapshot`, OR remain
    // absent when invalidated. Either way, `(no result data)` never gets
    // written.
  });

  test("no-op when callback is undefined", () => {
    // Shouldn't throw, shouldn't filter.
    expect(() => persistOperatorResults({ a: withResult(1) }, undefined)).not.toThrow();
  });

  test("no-op when operators is undefined", () => {
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults(undefined, (id, info) => calls.push([id, info]));
    expect(calls).toHaveLength(0);
  });

  test("skips null info entries (defensive)", () => {
    const calls: Array<[string, OperatorInfo]> = [];
    persistOperatorResults(
      { a: withResult(1), b: null as unknown as OperatorInfo },
      (id, info) => calls.push([id, info])
    );
    expect(calls.map(([id]) => id)).toEqual(["a"]);
  });
});
