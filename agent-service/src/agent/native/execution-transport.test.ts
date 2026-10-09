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
import type { SyncExecutionResult } from "../../types/execution";
import { prepareStructuredExecutionResult } from "./execution-transport";

const result = (): SyncExecutionResult => ({
  success: true,
  state: "Completed",
  executionId: "123",
  capabilities: ["table-profile-v1", "typed-scalar-v1", "schema-fields-only-v1"],
  operators: {
    source: {
      state: "Completed",
      inputTuples: 0,
      outputTuples: 1,
      resultMode: "table",
      result: [{ x: null, y: "NULL", z: "9007199254740993" }],
    },
  },
});

test("structured execution attaches request provenance without reinterpreting cells", () => {
  const response = result();
  const parsed = prepareStructuredExecutionResult(response, 17);
  expect(parsed.operators.source.result).toEqual(response.operators.source.result);
  expect(parsed.operators.source.executionContext).toEqual({ workflowId: 17, executionId: "123" });
  expect(response.operators.source.executionContext).toBeUndefined();
});

test("an old backend cannot silently claim V2 scalar semantics", () => {
  const response = result();
  delete response.capabilities;
  const parsed = prepareStructuredExecutionResult(response, 17);
  expect(parsed.success).toBe(false);
  expect(parsed.state).toBe("CapabilityMissing");
  expect(parsed.operators.source.result).toBeUndefined();
  expect(parsed.operators.source.error).toContain("typed-scalar-v1");
});

test("V2 refuses older typed backends that can overwrite user schema fields", () => {
  const response = result();
  response.capabilities = ["typed-scalar-v1", "table-profile-v1", "input-materialization-v1"];
  const parsed = prepareStructuredExecutionResult(response, 17);
  expect(parsed.state).toBe("CapabilityMissing");
  expect(parsed.operators.source.result).toBeUndefined();
  expect(parsed.operators.source.error).toContain("schema-fields-only-v1");
});

test("pre-execution syntax errors retain their diagnostics without requiring a capability response", () => {
  const response: SyncExecutionResult = {
    success: false,
    state: "CompilationFailed",
    operators: {},
    compilationErrors: { source: "syntax" },
  };
  expect(prepareStructuredExecutionResult(response, 17)).toEqual(response);
});

test("successful results without an execution identity are rejected", () => {
  const response = result();
  delete response.executionId;
  expect(prepareStructuredExecutionResult(response, 17).success).toBe(false);
});
