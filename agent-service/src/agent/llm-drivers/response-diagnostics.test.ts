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

import { expect, test } from "bun:test";
import { responseDiagnostics } from "./response-diagnostics";

test("records complete raw/parsed Answer arguments and provider finish reason", () => {
  const input = { reasoning: "Submit.", actions: [{ type: "answer", content: "first\nsecond" }] };
  const result = responseDiagnostics(
    "tool-calls",
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { tool_calls: [{ id: "call1", function: { name: "dataflow", arguments: JSON.stringify(input) } }] },
        },
      ],
    },
    [{ toolCallId: "call1", toolName: "dataflow", input }]
  );
  expect(result.rawFinishReason).toBe("tool_calls");
  expect(result.calls[0].matchesParsed).toBe(true);
  expect(result.calls[0].rawPreview).toContain("second");
});

test("malformed or clipped arguments remain distinguishable, with secrets redacted", () => {
  const raw = '{"token":"sk-test-secret123456789", "value":"' + "x".repeat(5000);
  const result = responseDiagnostics(
    "length",
    {
      choices: [{ finish_reason: "length", message: { tool_calls: [{ id: "broken", function: { arguments: raw } }] } }],
    },
    []
  );
  expect(result.finishReason).toBe("length");
  expect(result.calls[0].rawChars).toBe(raw.length);
  expect(result.calls[0].validJson).toBe(false);
  expect(result.calls[0].rawPreview).not.toContain("secret123456789");
  expect(result.calls[0].rawPreview!.length).toBeLessThanOrEqual(2048);
  expect(result.calls[0].matchesParsed).toBeNull();
});
