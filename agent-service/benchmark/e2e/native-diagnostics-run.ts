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

import { strict as assert } from "node:assert";
import { nativeTestSession } from "./native-test-session";

// Requires the matching V2 engine/Python and an isolated agent service. Starts
// no services and touches only its own workflows/CUs. This is a real-worker
// debug fixture, not an LLM trace or permission test for the whole legacy API.
const reports: unknown[] = [];
const load = (values: number[]) => ({
  op: "udf",
  id: "source",
  code: `def load():\n    import pandas as pd\n    return pd.DataFrame({'x': ${JSON.stringify(values)}})`,
});
const filter = (func: string) => ({ op: "filter", id: "answer", input: "source", columns: ["x"], func });
const good = "def apply(row):\n    return row['x'] >= 2  # REPAIRED_SOURCE";
for (const contextMode of ["delta", "latest"] as const) {
  const session = await nativeTestSession({ contextMode, messageLayout: "native", nativeProfileCollection: false });
  try {
    const initial = await session.debug({
      operators: [
        { op: "project", id: "final", input: "answer", keep: ["x"] },
        filter("def apply(row):\n    return True"),
        { op: "project", id: "independent", input: "source", keep: ["x"] },
        load([1, 2]),
      ],
      observe: ["final"],
    });
    assert.deepEqual((initial.snapshot.results.final as any).sampleRecords, [{ x: 1 }, { x: 2 }]);

    const failed = await session.debug({
      operators: [filter("def apply(row):\n    raise ValueError('CALLBACK_FAILURE_MARKER')")],
      observe: [],
    });
    const runtimeError = (failed.snapshot.results.answer as any).nativeError;
    assert.equal(runtimeError.diagnostic.code, "CALLBACK_RUNTIME");
    assert.equal(runtimeError.diagnostic.source.line, 2);
    assert.ok(runtimeError.executionId, "runtime failure needs actual execution identity");
    assert.equal((failed.snapshot.results.final as any)?.sampleRecords, undefined);
    assert.match(failed.serviceContext, /CALLBACK_RUNTIME/);
    assert.doesNotMatch(
      failed.serviceContext,
      /class NativeError\(ValueError\)|class _UndeclaredColumn|def _validate_function\(/
    );
    assert.deepEqual(failed.snapshot.nativeObservations, {});

    const inspect = (query: Record<string, string>) =>
      session.request(`/${session.agentId}/inspect-error`, "POST", query);
    const expanded = await inspect({ operatorId: "answer" });
    assert.equal(expanded.status, 200);
    const detail = (await expanded.json()) as any;
    assert.match(detail.text, /CALLBACK_FAILURE_MARKER/);
    assert.ok(detail.text.length < 4500);
    assert.equal(detail.traceback, undefined);
    assert.equal(detail.submittedSource, undefined);
    for (const authorization of [undefined, "Bearer invalid"]) {
      const denied = await fetch(`${session.baseUrl}/api/agents/${session.agentId}/inspect-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ operatorId: "answer" }),
      });
      assert.equal(denied.status, 401);
    }
    const pulled = await session.debug({ operatorId: "answer" }, "inspectError");
    assert.deepEqual(pulled.snapshot.results, failed.snapshot.results, "inspection changed cached results");
    assert.equal(pulled.snapshot.workflowSourceStepId, failed.step.id, "inspection must not own a workflow snapshot");

    const repaired = await session.debug({ operators: [filter(good)], observe: ["final"] });
    assert.deepEqual((repaired.snapshot.results.final as any).sampleRecords, [{ x: 2 }]);
    assert.equal((await inspect({ operatorId: "answer" })).status, 404);
    const historical = await inspect({ operatorId: "answer", diagnosticId: runtimeError.diagnosticId });
    assert.equal(historical.status, 200);
    const past = (await historical.json()) as any;
    assert.match(past.text, /Historical error/);
    assert.match(past.text, /CALLBACK_FAILURE_MARKER/);
    assert.doesNotMatch(past.text, /REPAIRED_SOURCE/);
    const pastPull = await session.debug(
      { operatorId: "answer", diagnosticId: runtimeError.diagnosticId },
      "inspectError"
    );
    assert.deepEqual(pastPull.snapshot.results, repaired.snapshot.results);

    const rejected = await session.debug({
      operators: [filter("def apply(row):\n    return REJECTED_SOURCE +")],
      observe: [],
    });
    const rejectedError = (rejected.snapshot.results.answer as any).nativeError;
    assert.equal(rejectedError.diagnostic.code, "PYTHON_SYNTAX");
    assert.equal(rejectedError.executionId, null);
    assert.equal(rejectedError.phase, "attempt");
    assert.deepEqual(rejected.snapshot.workflow, repaired.snapshot.workflow);
    assert.equal((rejected.snapshot.results.final as any)?.sampleRecords, undefined);
    const deferred = await session.debug({
      operators: [{ op: "project", id: "new_answer", input: "final", keep: ["x"] }],
      observe: ["new_answer"],
    });
    assert.equal((deferred.snapshot.results.new_answer as any)?.state, "Blocked");
    assert.equal((deferred.snapshot.results.new_answer as any)?.nativeError.executionId, null);

    const upstream = await session.debug({ operators: [load([2, 3])], observe: [] });
    assert.deepEqual((upstream.snapshot.results.independent as any)?.sampleRecords, [{ x: 2 }, { x: 3 }]);
    assert.deepEqual((upstream.snapshot.results.answer as any)?.nativeError, rejectedError);
    assert.equal((upstream.snapshot.results.new_answer as any)?.state, "Blocked");
    const restored = await session.debug({ operators: [filter(good)], observe: ["new_answer"] });
    assert.deepEqual((restored.snapshot.results.new_answer as any)?.sampleRecords, [{ x: 2 }, { x: 3 }]);
    assert.equal((await inspect({ operatorId: "answer" })).status, 404);
    // The service's assembled context, not the helper's reconstructed mirror,
    // must retain the already-earned historical inspection after later edits.
    assert.match(restored.serviceContext, /Historical error inspection/);
    assert.match(restored.serviceContext, /CALLBACK_FAILURE_MARKER/);
    reports.push({
      contextMode,
      workflowId: session.workflowId,
      passed: true,
      debugSteps: 9,
      runtimeDiagnosticId: runtimeError.diagnosticId,
      rejectedDiagnosticId: rejectedError.diagnosticId,
      checks: [
        "real worker callback source and execution binding",
        "hidden failure visibility",
        "authenticated bounded inspection",
        "read-only current/historical model pulls",
        "rejected revision invalidation",
        "later consumer blocked",
        "independent upstream execution",
        "same-code repair",
        "persistent service context",
      ],
    });
  } finally {
    await session.close();
  }
}
console.log(JSON.stringify({ suite: "native-v2-diagnostics", realLLM: false, reports, cleanup: "complete" }, null, 2));
