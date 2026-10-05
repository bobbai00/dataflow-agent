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
import { comparisonAnswer } from "./comparison-answer";

test("a provider rejection with an end marker never completes a benchmark task", () => {
  const error = "Error: invalid_function_parameters";
  expect(comparisonAnswer([{ isEnd: true, content: error }], error)).toEqual({ answer: error, completed: false });
});

test("a completed nonanswer remains a scored solver outcome", () => {
  const answer = '{"error":"Unable to solve"}';
  expect(comparisonAnswer([{ isEnd: true, toolResults: [{ output: { kind: "dataflow-actions", answer } }] }])).toEqual({
    answer,
    completed: true,
  });
});

test("a cached Answer receipt takes precedence over fallback text", () => {
  const answer = '{"count":12}';
  expect(
    comparisonAnswer(
      [{ toolResults: [{ output: { kind: "dataflow-actions", answer } }] }, { isEnd: true, content: "fallback" }],
      "transport fallback"
    )
  ).toEqual({ answer, completed: true });
});

test("text-only answers and unfinished Answer receipts remain incomplete", () => {
  expect(comparisonAnswer([{ isEnd: true, content: '{"count":12}' }]).completed).toBe(false);
  expect(
    comparisonAnswer([{ toolResults: [{ output: { kind: "dataflow-actions", answer: '{"count":12}' } }] }]).completed
  ).toBe(false);
});
