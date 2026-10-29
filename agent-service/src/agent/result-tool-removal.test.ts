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

import { expect, spyOn, test } from "bun:test";
import { buildRegisteredNativeSystemPrompt } from "./prompts";
import { TexeraAgent } from "./texera-agent";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";

function agent() {
  return new TexeraAgent({
    agentId: "result-tool-removal",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
}

test("the agent has no result-inspection tool, before or after a settings change", async () => {
  const subject = agent();
  const info = subject.getSystemInfo();
  expect(info.tools.map(tool => tool.name)).not.toContain("inspectResult");
  expect(info.systemPrompt).not.toContain("inspectResult");
  await expect(subject.executeTool("inspectResult", { operatorId: "source", stats: true })).rejects.toThrow(
    "not found"
  );
  expect(info.tools.some(tool => tool.name === "inspectError")).toBe(false);
  subject.updateSettings({ maxSteps: 20 });
  expect(subject.getSystemInfo().tools.map(tool => tool.name)).not.toContain("inspectResult");
});

test("initialization and delegate rebuilds cannot restore result inspection", async () => {
  const subject = agent();
  const metadata = WorkflowSystemMetadata.getInstance();
  const initialized = spyOn(metadata, "isInitialized").mockReturnValue(true);
  try {
    await subject.initialize();
    expect(subject.getSystemInfo().tools.map(tool => tool.name)).toEqual(["dataflow"]);
    subject.setDelegateConfig({ userToken: "", workflowId: 0 });
    expect(subject.getSystemInfo().tools.map(tool => tool.name)).not.toContain("inspectResult");
    await expect(subject.executeTool("inspectResult", { operatorId: "source" })).rejects.toThrow("not found");
  } finally {
    initialized.mockRestore();
  }
});

test("the model driver receives no result-inspection schema", async () => {
  let dispatchedTools: string[] | undefined;
  const subject = new TexeraAgent({
    agentId: "result-tool-driver-removal",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      runTurn: async options => {
        dispatchedTools = Object.keys(options.tools);
        return { text: "done", messages: [], usage: {} };
      },
    },
  });
  await subject.sendMessage("Answer without executing a workflow.");
  expect(dispatchedTools).toBeDefined();
  expect(dispatchedTools).not.toContain("inspectResult");
  expect(dispatchedTools).toEqual(["dataflow"]);
});

test("the prompt builder cannot advertise a removed tool", () => {
  const prompt = buildRegisteredNativeSystemPrompt();
  expect(prompt).not.toContain("inspectResult");
  expect(prompt).toContain("show result");
});
