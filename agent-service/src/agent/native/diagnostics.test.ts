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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatOperatorResult } from "../tools/result-formatting";
import { WorkflowState } from "../workflow-state";
import type { OperatorPredicate } from "../../types/workflow";
import type { OperatorInfo } from "../../types/execution";
import { REPAIR_HINTS, formatNativeDiagnostic, sanitizeDiagnosticText, type NativeDiagnostic } from "./diagnostics";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { assembleContext } from "../util/context-utils";
import { AgentMode, ContextMode, type ReActStep } from "../../types/agent";

const revision = "0123456789abcdef";
test("a multi-file scan gets a repair hint that can be applied to its definition", () => {
  for (const type of ["Scan", "Union"]) {
    const { diagnostic, info, state } = fixture(type);
    info.error =
      "NATIVE_ERROR_V2:" +
      JSON.stringify({ ...diagnostic, code: "UNION_TYPE", message: "Column value has incompatible types." });
    const output = formatOperatorResult("answer", info, state);
    if (type === "Scan") {
      expect(output).toContain("all_text=True");
      expect(output).toContain("cast");
    } else {
      expect(output).toContain("Cast the named column");
      expect(output).not.toContain("all_text=True");
    }
  }
});

test("redaction preserves submitted-source line coordinates across multiline values", () => {
  const source =
    "def apply(row):\n    private = environ({\n        'SECRET': 'hidden'\n    })\n    PASSWORD='first\nsecond'\n    return row['x'] / 0";
  const clean = sanitizeDiagnosticText(source);
  expect(clean).not.toContain("hidden");
  expect(clean).not.toContain("first");
  expect(clean.split("\n").length).toBe(source.split("\n").length);
  expect(clean.split("\n")[6]).toBe("    return row['x'] / 0");
});

test("blocked consumers point to a root failure without repeating its source and detail", () => {
  const { op, diagnostic, info, state } = fixture();
  const consumer = { ...op, operatorID: "blocked", nativeOp: { ...op.nativeOp!, inputs: ["answer"] } };
  state.addOperator(consumer);
  const root = formatOperatorResult("answer", info, state);
  const blocked = formatOperatorResult("blocked", info, state, {
    nativeEvidence: {
      workflow: state.getWorkflowContent(),
      resolveInput: id => (id === "answer" ? info : undefined),
      data: false,
      flow: false,
      maxChars: 1,
    },
  });
  expect(root).toContain(diagnostic.message);
  expect(blocked).toContain("upstream `answer`");
  expect(blocked).toContain("CALLBACK_RUNTIME");
  expect(blocked).not.toContain(diagnostic.message);
  expect(blocked).not.toContain("return source / denominator");
  expect(blocked.length).toBeLessThan(root.length);
  // If the root's own error was not returned, retain this only copy of it.
  expect(formatOperatorResult("blocked", info, state)).toContain(diagnostic.message);
});
function fixture(type = "Process") {
  const op: OperatorPredicate = {
    operatorID: "answer",
    operatorType: "DataProcessing",
    operatorVersion: "1",
    operatorProperties: {
      code: "def process(source):\n    return generated_runtime(source)\n" + "GENERATED_BOILERPLATE\n".repeat(2000),
    },
    nativeOp: {
      revision,
      type,
      inputs: ["source"],
      properties:
        type === "Process"
          ? { code: "def process(source):\n    denominator = 0\n    return source / denominator" }
          : { columns: ["x"], func: "def apply(row):\n    denominator = 0\n    return row['x'] / denominator" },
    },
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
  };
  const diagnostic: NativeDiagnostic = {
    version: 1,
    operatorId: "answer",
    operatorRevision: revision,
    code: "CALLBACK_RUNTIME",
    stage: "execute",
    message: "ZeroDivisionError: division by zero",
    field: type === "Process" ? "code" : "func",
    source: { entry: type === "Process" ? "process" : "apply", line: 3, excerpt: "    return source / denominator" },
  };
  const info: OperatorInfo = {
    state: "Failed",
    inputTuples: 0,
    outputTuples: 0,
    resultMode: "table",
    error: "(line 999) `raise NativeError(...)` - NATIVE_ERROR_V2:" + JSON.stringify(diagnostic),
  };
  const state = new WorkflowState();
  state.addOperator(op);
  return { op, diagnostic, info, state };
}

test("V2 failures never echo the embedded runtime, including process and shape-only views", () => {
  for (const type of ["Process", "Filter"])
    for (const detail of ["shape", "sample"] as const) {
      const { op, info, state } = fixture(type);
      const rendered = formatOperatorResult("answer", info, state, { detail, operatorAtEvent: op });
      expect(rendered.length).toBeLessThanOrEqual(1600);
      expect(rendered).toContain("CALLBACK_RUNTIME");
      expect(rendered).not.toContain(revision);
      expect(rendered).toContain("line 3");
      expect(rendered).toContain("division by zero");
      expect(rendered).not.toContain("GENERATED_BOILERPLATE");
      expect(rendered).not.toContain("line 999");
      expect(rendered).not.toContain("NATIVE_ERROR_V2");
    }
});

test("a long V2 diagnostic has a separate bounded detail budget and explicit omissions", () => {
  const { diagnostic } = fixture();
  diagnostic.message += " detail".repeat(2000);
  diagnostic.field = "field".repeat(1000);
  diagnostic.source!.excerpt = "very_long_user_line".repeat(2000);
  const rendered = formatNativeDiagnostic(diagnostic);
  expect(rendered.length).toBeLessThanOrEqual(1400);
  expect(rendered).toContain("CALLBACK_RUNTIME");
  expect(rendered).toContain("execute");
  expect(rendered).toContain(revision);
  expect(rendered).toContain("division by zero");
  expect(rendered).toContain("omitted");
});

test("V2 opaque infrastructure errors do not masquerade as callback/syntax failures", () => {
  const { op, info, state } = fixture();
  info.error = "execution failed: timed out waiting for the worker";
  const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(rendered).toContain("EXECUTION_TIMEOUT");
  expect(rendered).toContain("infrastructure");
  expect(rendered).not.toContain("GENERATED_BOILERPLATE");
});

test("a timeout parameter in a library traceback does not classify an unrelated error as a timeout", () => {
  const { op, info, state } = fixture();
  info.error =
    'Traceback (most recent call last):\n  File "concurrent/futures/_base.py", line 456, in result\n    return fut.result(timeout)\nRuntimeError: failed to decode input';
  const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(rendered).toContain("EXECUTION_ERROR");
  expect(rendered).not.toContain("EXECUTION_TIMEOUT");
});

test("a missing cached input is a storage failure even when its traceback contains timeout arguments", () => {
  const { op, info, state } = fixture();
  info.error =
    'Traceback (most recent call last):\n  File "core/storage/runnables/input_port_materialization_reader_runnable.py", line 220, in run\n    self.emit_columnar()\n  File "concurrent/futures/_base.py", line 456, in result\n    return fut.result(timeout)\nFileNotFoundError: cached parquet does not exist';
  const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(rendered).toContain("CACHE_INPUT_READ");
  expect(rendered).toContain("infrastructure");
  expect(rendered).toContain("FileNotFoundError: cached parquet does not exist");
  expect(rendered).toContain("retryable: false");
  expect(rendered).not.toContain("EXECUTION_TIMEOUT");
});

test("actual engine deadlines and timeout exceptions still classify as execution timeouts", () => {
  const { op, info, state } = fixture();
  for (const error of [
    "Timeout after 15 seconds",
    "TimeoutError: request deadline",
    "Workflow execution was killed (timeout).",
  ]) {
    info.error = error;
    expect(formatOperatorResult("answer", info, state, { operatorAtEvent: op })).toContain("EXECUTION_TIMEOUT");
  }
});

test("a Python worker that died mid-run is WORKER_EXITED, named, and not a timeout", () => {
  const sentence =
    "The Python worker for operator weather exited with code 143 (killed by signal 15, SIGTERM) while the operator was running; the operator produced no complete result.";
  const { op, info, state } = fixture();
  info.error = `execution failed — Execution failed due to the following error:\nError:\n  EXECUTION_FAILURE: java.lang.RuntimeException: ${sentence}`;
  const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(rendered).toContain("WORKER_EXITED");
  expect(rendered).toContain("infrastructure");
  expect(rendered).toContain(sentence);
  expect(rendered).toContain("ran out of memory");
  expect(rendered).not.toContain("EXECUTION_TIMEOUT");
  expect(rendered).not.toContain("java.lang.RuntimeException");
  info.error =
    "execution failed — The Python worker for operator weather exited with code 1 while the operator was running.";
  const crashed = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(crashed).toContain("WORKER_EXITED");
  expect(crashed).toContain("crashed");
  expect(crashed).not.toContain("memory");
});

test("an overloaded result store is BACKEND_UNAVAILABLE, not the operator's code", () => {
  const { op, info, state } = fixture();
  info.error =
    "execution failed — Execution failed due to the following error:\nError:\n  EXECUTION_FAILURE: java.lang.Throwable: (pg8000.dbapi.ProgrammingError) {'S': 'FATAL', 'C': '53300', 'M': 'sorry, too many clients already'}";
  const refused = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(refused).toContain("BACKEND_UNAVAILABLE");
  expect(refused).toContain("infrastructure");
  expect(refused).toContain("too many clients already");
  expect(refused).not.toContain("EXECUTION_ERROR");
  info.error =
    "execution failed — EXECUTION_FAILURE: java.lang.Throwable: Could not open the stored input vfs:///wid/1/eid/2/globalportid/x/result after 5 attempts: No storage is found for the given URI";
  const unread = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(unread).toContain("BACKEND_UNAVAILABLE");
  expect(unread).toContain("Could not open the stored input vfs:///wid/1/eid/2/globalportid/x/result after 5 attempts");
});

test("backend capability, authorization and availability failures are infrastructure diagnostics", () => {
  for (const [error, code, retryable] of [
    [
      "V2 requires a backend with typed-scalar-v1, schema-fields-only-v1 and execution identity support",
      "BACKEND_CAPABILITY",
      false,
    ],
    ["Execution request failed: 403 Forbidden", "WORKFLOW_AUTHORIZATION", false],
    ["Execution request failed: 503 Service Unavailable", "BACKEND_UNAVAILABLE", true],
  ] as const) {
    const { op, state, info } = fixture();
    info.error = error;
    const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
    expect(rendered).toContain(code);
    expect(rendered).toContain("infrastructure");
    expect(rendered).toContain(`retryable: ${retryable}`);
  }
});

test("V2 error rendering redacts credential-shaped strings rather than echoing them", () => {
  const { op, info, state, diagnostic } = fixture();
  diagnostic.message =
    'request failed Authorization: Bearer token-to-hide password="secret-to-hide" OPENAI_API_KEY=sk-sensitive-key';
  info.error = "NATIVE_ERROR_V2:" + JSON.stringify(diagnostic);
  const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  for (const value of ["token-to-hide", "secret-to-hide", "sk-sensitive-key"]) expect(rendered).not.toContain(value);
  expect(rendered).toContain("[redacted]");
});

test("a wrong-revision payload cannot borrow the current submitted source", () => {
  const { op, info, state, diagnostic } = fixture();
  diagnostic.operatorRevision = "older_revision";
  diagnostic.source!.excerpt = "STALE_SOURCE_EXCERPT";
  info.error = "NATIVE_ERROR_V2:" + JSON.stringify(diagnostic);
  const rendered = formatOperatorResult("answer", info, state, { operatorAtEvent: op });
  expect(rendered).toContain("DIAGNOSTIC_BINDING_MISMATCH");
  expect(rendered).not.toContain("STALE_SOURCE_EXCERPT");
  expect(rendered).not.toContain("GENERATED_BOILERPLATE");
});

test("V2 process code/reflection and flow-error decorations use submitted code and bounded diagnostics", () => {
  for (const failed of [false, true]) {
    const { op, info, state } = fixture();
    const steps: ReActStep[] = [];
    const storage = new WorkflowSnapshotStorage(id =>
      steps.slice(0, steps.findIndex(step => step.id === id) + 1).map(step => step.id)
    );
    for (const id of ["A", "B", "C"]) {
      steps.push({
        id,
        parentId: steps.at(-1)?.id,
        messageId: "m",
        stepId: steps.length,
        timestamp: 1,
        role: "agent",
        content: "",
        isBegin: steps.length === 0,
        isEnd: false,
        toolCalls: [
          {
            toolName: "udf",
            toolCallId: id,
            input: { id: "answer", inputs: ["source"], code: op.nativeOp!.properties.code },
          },
        ],
        toolResults: [{ toolCallId: id, output: "Modified operator 'answer'." }],
      });
      storage.createSnapshot(id, state.getWorkflowContent());
      storage.setOperatorResult(
        id,
        "answer",
        failed ? info : { state: "Completed", inputTuples: 1, outputTuples: 1, resultMode: "table", result: [{ x: 1 }] }
      );
    }
    const rendered = JSON.stringify(
      assembleContext(steps, state, storage, ContextMode.LATEST, {
        agentMode: AgentMode.NATIVE,
        attemptReflection: true,
        opExtras: () =>
          ({ detail: "shape", includeCode: true, column: {}, tuple: {}, codeHistory: [], resultHistory: [] }) as any,
      })
    );
    expect(rendered.includes("GENERATED_BOILERPLATE")).toBe(false);
    expect(rendered).not.toContain("NATIVE_ERROR_V2:");
    if (failed) expect(rendered).toContain("CALLBACK_RUNTIME");
    else expect(rendered).toContain("return source / denominator");
  }
});

describe("error taxonomy rendering", () => {
  test("every code the runtime or the tool layer can raise has a repair hint", () => {
    const runtime = readFileSync(new URL("./python/runtime.py", import.meta.url), "utf8");
    const codes = new Set<string>();
    for (const match of runtime.matchAll(/_error\(\s*spec,\s*"([A-Z_]+)"/g)) codes.add(match[1]);
    for (const match of runtime.matchAll(/"(INPUT_[A-Z_]+)"/g)) codes.add(match[1]);
    codes.add("SCAN_OPTIONS"); // raised through the local `reject` helper
    for (const code of ["INVALID_ARGUMENTS", "UPSTREAM_FAILED", "PROGRAM_SYNTAX"]) codes.add(code);
    const missing = [...codes].filter(code => !REPAIR_HINTS[code]);
    expect(missing).toEqual([]);
    expect(codes.size).toBeGreaterThan(40);
  });

  test("a runtime diagnostic renders code, stage, revision, cause, hint and the offending argument", () => {
    const text = formatNativeDiagnostic({
      version: 1,
      operatorId: "joined",
      operatorRevision: "abc123",
      code: "JOIN_ARGUMENT",
      stage: "validate",
      message: "how must be one of 'inner', 'left', 'right', 'full', 'cross', got 'semi'.",
      field: "how",
    });
    expect(text).toStartWith("[JOIN_ARGUMENT; validate; revision abc123]");
    expect(text).toContain("got 'semi'");
    expect(text).toContain("Hint: how is inner/left/right/full/cross");
    expect(text).toContain("Field: how");
  });

  test("a callback failure renders the failing line of the submitted function", () => {
    const text = formatNativeDiagnostic({
      version: 1,
      operatorId: "cleaned",
      operatorRevision: "abc123",
      code: "MISSING_COLUMN",
      stage: "execute",
      message: "The function read column 'Acres', which the input table does not have.",
      field: "columns[0].func",
      source: { entry: "apply", line: 2, excerpt: "    return row['Acres'] * 2" },
    });
    expect(text).toContain("Field: columns[0].func");
    expect(text).toContain("apply line 2: return row['Acres'] * 2");
    expect(text).toContain("Hint: Check the input's columns and correct the column name.");
  });
});
