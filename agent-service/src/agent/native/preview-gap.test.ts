/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import { previewGap } from "./evidence";

test("a raw preview whose sample lost its middle lines names them: they are the budget, not the file", () => {
  // WiDS task 3, 2026-09-26: an 8-line preview of 650-10,000 character lines arrived as lines 0, 6, 7.
  const rows = [0, 6, 7].map(line_no => ({ file: "rankmd.csv", line_no, line: "..." }));
  expect(previewGap(rows, 8)).toBe(
    "Preview lines not shown here: 1–5 (5 lines; the result's size budget, not the file). They are ordinary lines of the file; read them with a smaller preview or skip_lines."
  );
  // A single missing line, and lines missing after the last one shown.
  expect(previewGap([0, 2, 3].map(line_no => ({ line_no })), 6)).toBe(
    "Preview lines not shown here: 1, 4… (3 lines; the result's size budget, not the file). They are ordinary lines of the file; read them with a smaller preview or skip_lines."
  );
  // A contiguous preview needs no notice; a preview starting at skip_lines is contiguous too.
  expect(previewGap([0, 1, 2].map(line_no => ({ line_no })), 3)).toBeUndefined();
  expect(previewGap([5, 6, 7].map(line_no => ({ line_no })), 3)).toBeUndefined();
});
