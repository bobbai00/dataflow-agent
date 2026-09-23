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
import { test, expect } from "bun:test";
import { TexeraAgent } from "../texera-agent";
import { AgentMode } from "../../types/agent";
function agent() {
  return new TexeraAgent({
    agentId: "tasks",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "done", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
}
test("task features validate atomically and history cannot be enabled halfway through a session", async () => {
  const a = agent();
  // Native is the default mode, so history may be chosen before the session starts.
  a.updateSettings({ agentMode: AgentMode.NATIVE, nativeTaskHistory: true, nativeTaskContext: true });
  expect(a.getSettings().nativeTaskHistory).toBe(true);
  // The prompt teaches the one reference form the program language accepts.
  expect(a.getSettings().systemPrompt).toContain("at(name, task=N)");
  expect(a.getSettings().systemPrompt).not.toContain("atTask");
  await a.sendMessage("hello");
  expect(() => a.updateSettings({ nativeTaskHistory: false })).toThrow("fresh");
  expect(() => a.updateSettings({ agentMode: AgentMode.CODE })).toThrow();
  expect(a.getSettings().agentMode).toBe(AgentMode.NATIVE);
});

test("the reference form is taught whenever outputs are retained, the catalog vocabulary only with the catalog", () => {
  const prompt = (nativeTaskHistory: boolean, nativeTaskContext: boolean) => {
    const a = agent();
    a.updateSettings({ agentMode: AgentMode.NATIVE, nativeTaskHistory, nativeTaskContext });
    return a.getSettings().systemPrompt ?? "";
  };
  const fullHistory = prompt(true, false);
  expect(fullHistory).toContain("at(name, task=N)");
  expect(fullHistory).toContain("numbered from 1");
  expect(fullHistory).not.toContain("created@N");
  const catalog = prompt(true, true);
  expect(catalog).toContain("at(name, task=N)");
  expect(catalog).toContain("created@N");
  const catalogOnly = prompt(false, true);
  expect(catalogOnly).toContain("# Operator catalog at the start of this task");
  expect(catalogOnly).not.toContain("at(name, task=N)");
});
