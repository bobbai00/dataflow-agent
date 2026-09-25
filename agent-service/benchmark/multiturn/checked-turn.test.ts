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
import { checkedTurn } from "./checked-turn";
import type { AgentTurnResult } from "../../src/api/agent-service-api";

const partial = { completed: false, finalAnswer: "stale prior answer", errors: ["Timed out"] } as AgentTurnResult;

test("a timeout discards stale text and waits for stop before permitting another turn", async () => {
  let release!: () => void;
  let stopped = false,
    finished = false;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const turn = checkedTurn(
    async () => partial,
    async () => {
      stopped = true;
      await gate;
    }
  );
  void turn.then(() => {
    finished = true;
  });
  await Bun.sleep(1);
  expect(stopped).toBe(true);
  expect(finished).toBe(false);
  release();
  expect(await turn).toEqual({ answer: "", error: "Error: Timed out", canContinue: true });
});

test("a failure to stop the session prevents later submissions", async () => {
  const result = await checkedTurn(
    async () => partial,
    async () => {
      throw new Error("still running");
    }
  );
  expect(result.canContinue).toBe(false);
  expect(result.answer).toBe("");
  expect(result.error).toContain("still running");
});

test("a completed answer needs no stop", async () => {
  const result = await checkedTurn(
    async () => ({ ...partial, completed: true, finalAnswer: "42", errors: [] }),
    async () => {
      throw new Error("unexpected stop");
    }
  );
  expect(result).toEqual({ answer: "42", canContinue: true });
});
