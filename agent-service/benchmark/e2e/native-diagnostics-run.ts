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
    await session.debug("Exercise native diagnostics and repeated validation repair in one task.");
    const repeatRejected = async (
      first: Awaited<ReturnType<typeof session.debug>>,
      invalid: Record<string, unknown>,
      probeId: string,
      firstValue: number
    ) => {
      const firstError = (first.snapshot.results.answer as any).nativeError;
      assert.doesNotMatch(firstError.diagnostic.hint ?? "", /Needs inspection/);
      const repeated = await session.debug({ operators: [invalid], observe: [] });
      const repeatedError = (repeated.snapshot.results.answer as any).nativeError;
      assert.equal(repeatedError.diagnostic.code, firstError.diagnostic.code);
      assert.match(repeatedError.diagnostic.message, /Repeated validation failure \(2\)/);
      assert.match(repeatedError.diagnostic.message, /Schema example: /);
      assert.match(repeatedError.diagnostic.hint, /Needs inspection.*inspectError/);
      assert.equal(repeatedError.executionId, null);
      assert.deepEqual(repeated.snapshot.workflow, first.snapshot.workflow, "invalid retry changed the DAG");
      assert.match(repeated.serviceContext, /Repeated validation failure \(2\)/);
      assert.match(repeated.serviceContext, /Schema example: /);
      assert.match(repeated.serviceContext, /Needs inspection/);

      const paused = await session.debug({
        operators: [invalid, { op: "limit", id: probeId, input: "source", n: 1 }],
        observe: [probeId],
      });
      const pausedError = (paused.snapshot.results.answer as any).nativeError;
      assert.match(pausedError.diagnostic.message, /Identical invalid submission paused/);
      assert.equal(pausedError.executionId, null);
      assert.deepEqual(
        paused.step.toolResults?.[0]?.output?.operators.map((outcome: any) => outcome.status),
        ["error", "added"]
      );
      assert.ok(paused.snapshot.workflow);
      assert.ok(first.snapshot.workflow);
      assert.deepEqual(
        paused.snapshot.workflow.operators.find(op => op.operatorID === "answer"),
        first.snapshot.workflow.operators.find(op => op.operatorID === "answer"),
        "paused submission replaced the accepted operator"
      );
      assert.deepEqual((paused.snapshot.results[probeId] as any).sampleRecords, [{ x: firstValue }]);
      assert.match(paused.serviceContext, /Identical invalid submission paused/);

      const acknowledged = await session.debug(
        { operatorId: "answer", diagnosticId: pausedError.diagnosticId },
        "inspectError"
      );
      assert.match(acknowledged.step.toolResults?.[0]?.output, /Current error inspection/);
      assert.deepEqual(acknowledged.snapshot.results, paused.snapshot.results, "acknowledgement changed results");
      assert.deepEqual(acknowledged.snapshot.workflow, paused.snapshot.workflow);
      // A corrected submission is always eligible. This unchanged retry also
      // verifies that inspecting the exact current diagnostic acknowledged it.
      const retried = await session.debug({ operators: [invalid], observe: [] });
      const retriedError = (retried.snapshot.results.answer as any).nativeError;
      assert.equal(retriedError.diagnostic.code, firstError.diagnostic.code);
      assert.doesNotMatch(retriedError.diagnostic.message, /Identical invalid submission paused/);
      assert.doesNotMatch(retriedError.diagnostic.hint ?? "", /Needs inspection/);
      assert.equal(retriedError.executionId, null);
      assert.deepEqual(retried.snapshot.workflow, paused.snapshot.workflow);
      assert.equal(retried.step.messageId, first.step.messageId, "retries must share one user task");
      return retried;
    };

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
    assert.doesNotMatch(pulled.serviceContext, /inspectResult/);
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

    const invalidPython = filter("def apply(row):\n    return REJECTED_SOURCE +");
    const rejected = await session.debug({
      operators: [invalidPython],
      observe: [],
    });
    let rejectedError = (rejected.snapshot.results.answer as any).nativeError;
    assert.equal(rejectedError.diagnostic.code, "PYTHON_SYNTAX");
    assert.equal(rejectedError.executionId, null);
    assert.equal(rejectedError.phase, "attempt");
    assert.deepEqual(rejected.snapshot.workflow, repaired.snapshot.workflow);
    assert.equal((rejected.snapshot.results.final as any)?.sampleRecords, undefined);
    const pythonRetried = await repeatRejected(rejected, invalidPython, "python_repair_probe", 1);
    rejectedError = (pythonRetried.snapshot.results.answer as any).nativeError;
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

    const invalidSchema = { ...filter(good), columns: "x" };
    const schemaRejected = await session.debug({ operators: [invalidSchema], observe: [] });
    const schemaError = (schemaRejected.snapshot.results.answer as any).nativeError;
    assert.equal(schemaError.diagnostic.code, "INVALID_ARGUMENTS");
    assert.match(schemaError.diagnostic.message, /\/columns must be array/);
    await repeatRejected(schemaRejected, invalidSchema, "schema_repair_probe", 2);
    const schemaRepaired = await session.debug({ operators: [filter(good)], observe: ["new_answer"] });
    assert.deepEqual((schemaRepaired.snapshot.results.new_answer as any).sampleRecords, [{ x: 2 }, { x: 3 }]);
    assert.equal((await inspect({ operatorId: "answer" })).status, 404);
    const trace = await session.trace();
    reports.push({
      contextMode,
      workflowId: session.workflowId,
      passed: true,
      debugSteps: trace.steps.filter(step =>
        step.toolCalls?.some(call => ["dataflow", "inspectError"].includes(call.toolName))
      ).length,
      runtimeDiagnosticId: runtimeError.diagnosticId,
      rejectedDiagnosticId: rejectedError.diagnosticId,
      schemaDiagnosticId: schemaError.diagnosticId,
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
        "repeated schema/preflight errors with compact repair examples",
        "identical invalid submission pause with independent real-worker success",
        "current diagnostic acknowledgement and successful correction",
      ],
    });
  } finally {
    await session.close();
  }
}
console.log(JSON.stringify({ suite: "native-v2-diagnostics", realLLM: false, reports, cleanup: "complete" }, null, 2));
