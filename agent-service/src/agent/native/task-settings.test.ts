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
  // The prompt teaches the four state gestures, restore among them.
  expect(a.getSettings().systemPrompt).toContain('restore=[{"operator": name, "task": N, "as": new_id}]');
  expect(a.getSettings().systemPrompt).not.toContain("atTask");
  await a.sendMessage("hello");
  expect(() => a.updateSettings({ nativeTaskHistory: false })).toThrow("fresh");
  expect(() => a.updateSettings({ agentMode: AgentMode.CODE })).toThrow();
  expect(a.getSettings().agentMode).toBe(AgentMode.NATIVE);
});

test("the state gestures are taught whenever outputs are retained, the entry layout only with the catalog", () => {
  const prompt = (nativeTaskHistory: boolean, nativeTaskContext: boolean, nativeTaskRestore = true) => {
    const a = agent();
    a.updateSettings({ agentMode: AgentMode.NATIVE, nativeTaskHistory, nativeTaskContext, nativeTaskRestore });
    return a.getSettings().systemPrompt ?? "";
  };
  const fullHistory = prompt(true, false);
  expect(fullHistory).toContain("restore=[");
  expect(fullHistory).toContain("numbered from 1");
  expect(fullHistory).not.toContain("as an entry");
  const catalog = prompt(true, true);
  expect(catalog).toContain("restore=[");
  expect(catalog).toContain("Each completed task appears once, as an entry");
  expect(catalog).toContain("# Tables now");
  expect(catalog).toContain("Tables read");
  // The working method is taught in every task mode, after the layout and the gestures.
  for (const text of [fullHistory, catalog, prompt(true, true, false)]) {
    expect(text).toContain("Work each task as a careful analyst");
    expect(text).toContain("add several operators in one call whenever you are comfortable");
    expect(text.indexOf("Work each task")).toBeGreaterThan(text.indexOf("numbered"));
  }
  // Entries without the restore step: the ablation arm reads history but is not taught to rebuild it.
  expect(prompt(true, true, false)).not.toContain("restore=[");
  const catalogOnly = prompt(false, true);
  expect(catalogOnly).toContain("as an entry");
  expect(catalogOnly).not.toContain("at(name, task=N)");
});
