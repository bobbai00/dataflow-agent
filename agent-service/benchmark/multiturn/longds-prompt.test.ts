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
import { buildLongDSPrompt } from "./longds-prompt";

test("native session wrapper uses the actual action contract", () => {
  const turn = {
    turn_id: 1,
    context: "Keep the first three reviewed stores.",
    question: "Report the count, rounded to 2 places.",
  };
  const prompt = buildLongDSPrompt({ files: ["data/orders.csv"] }, turn, true);
  expect(prompt).toContain("answer.content");
  expect(prompt).toContain("sole action");
  expect(prompt).not.toContain("Final Answer:");
  expect(prompt).toContain("explicitly execute");
  expect(prompt).toContain("Retrieval never executes");
  expect(prompt).toContain("data/orders.csv");
  expect(prompt).toContain(turn.context);
  expect(prompt).toContain(turn.question);
});

test("later tasks retain their complete original content", () => {
  const turn = {
    turn_id: 2,
    context: "Keep the same stores.\nDo not change the subset.",
    question: "Which lack evidence?",
  };
  const prompt = buildLongDSPrompt({ files: ["data/orders.csv"] }, turn, false);
  expect(prompt).toBe(`[Task 2]\n${turn.context}\nQuestion: ${turn.question}`);
});
