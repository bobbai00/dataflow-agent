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
import { TexeraAgent } from "./texera-agent";
import { AgentState } from "../types/agent";

const agent = () =>
  new TexeraAgent({
    agentId: "concurrent-turn-test",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "done", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });

test("a turn reserves the session before asynchronous history retention", async () => {
  const a = agent();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  (a as any).sealTaskHistory = () => gate;
  const first = a.sendMessage("first");
  const second = a.sendMessage("second");
  release();
  const results = await Promise.allSettled([first, second]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  expect(
    a
      .getReActSteps()
      .filter(s => s.role === "user")
      .map(s => s.content)
  ).toEqual(["first"]);
  expect(a.getState()).toBe(AgentState.AVAILABLE);
});

test("debug input cannot enter a session while a normal turn is preparing", async () => {
  const a = agent();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  (a as any).sealTaskHistory = () => gate;
  const first = a.sendMessage("first");
  const debug = a.handleDebugInput("overlapping task");
  release();
  const results = await Promise.allSettled([first, debug]);
  expect(results[1].status).toBe("rejected");
  expect(
    a
      .getReActSteps()
      .filter(s => s.role === "user")
      .map(s => s.content)
  ).toEqual(["first"]);
});

test("a failed history seal releases the session for a later recovery", async () => {
  const a = agent();
  let seals = 0;
  (a as any).sealTaskHistory = async () => {
    if (++seals === 2) throw new Error("archive unavailable");
  };
  await expect(a.sendMessage("first")).rejects.toThrow("archive unavailable");
  expect(a.getState()).toBe(AgentState.AVAILABLE);
  expect((await a.sendMessage("recovery")).response).toBe("done");
});
