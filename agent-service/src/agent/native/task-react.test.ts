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
import { TexeraAgent } from "../texera-agent";
import { AgentMode, ContextMode } from "../../types/agent";
import type { ContextAssemblerInput, DriverRunTurnInput } from "../llm-drivers/types";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

function fixture(catalog = false, asynchronous = false) {
  const inputs: ContextAssemblerInput[] = [];
  const turns: DriverRunTurnInput[] = [];
  const prompts: unknown[] = [];
  const agent = new TexeraAgent({
    agentId: "catalog-react",
    modelType: "test",
    contextAssembler: input => {
      inputs.push(input);
      const messages = [
        { role: "user" as const, content: `shared:${input.visibleSteps.map(s => s.content).join("|")}` },
      ];
      return asynchronous ? Promise.resolve(messages) : messages;
    },
    driver: {
      runTurn: async input => {
        turns.push(input);
        prompts.push(await input.prepareStep({ stepNumber: 0, messages: input.initialMessages }));
        await input.onStepFinish({ text: "answer", usage: { inputTokens: 12, outputTokens: 2 } });
        return { text: "answer", messages: [], usage: { inputTokens: 12, outputTokens: 2 } };
      },
    },
  });
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  (agent as any).metadataStore = metadata;
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    nativeToolMode: "batch",
    nativeCatalogVersion: "v2",
    contextMode: ContextMode.DELTA,
    nativeTaskContext: catalog,
  });
  return { agent, inputs, turns, prompts };
}

test("switching to the catalog keeps the shared assembler, prompt, driver and final-answer lifecycle", async () => {
  const { agent, inputs, turns, prompts } = fixture();
  const prompt = agent.getSettings().systemPrompt;
  const first = await agent.sendMessage("First request: keep units in dollars.");
  expect(first.response).toBe("answer");
  agent.updateSettings({ nativeTaskContext: true });
  expect(agent.getSettings().systemPrompt).toBe(prompt);
  const second = await agent.sendMessage("Second request");
  expect(second.response).toBe("answer");
  expect(inputs).toHaveLength(2);
  expect(inputs[1]!.visibleSteps.map(s => s.content)).toEqual(["Second request"]);
  const rendered = JSON.stringify(prompts[1]);
  expect(rendered).toContain("First request: keep units in dollars.");
  expect(rendered).toContain("Current operator catalog");
  expect(rendered).toContain("shared:Second request");
  expect(Object.keys(turns[1]!.tools)).toEqual(Object.keys(turns[0]!.tools));
  expect(turns[1]!.tools.dataflow.inputSchema.jsonSchema).toEqual(turns[0]!.tools.dataflow.inputSchema.jsonSchema);
  for (const turn of turns) {
    for (const key of ["taskContext", "taskCache", "promptCacheKey", "getFinalAnswer"])
      expect(Object.hasOwn(turn, key)).toBe(false);
  }
  expect(
    agent
      .getAllSteps()
      .filter(s => s.role === "agent")
      .map(s => s.isEnd)
  ).toEqual([true, true]);
});

test("the catalog can be switched off again without clearing the session", async () => {
  const { agent, inputs, prompts } = fixture(true);
  await agent.sendMessage("First request");
  const head = agent.getHead();
  agent.updateSettings({ nativeTaskContext: false });
  expect(agent.getHead()).toBe(head);
  await agent.sendMessage("Second request");
  expect(inputs[1]!.visibleSteps.some(s => s.content === "First request")).toBe(true);
  expect(JSON.stringify(prompts[1])).not.toContain("Current operator catalog");
});

test("a context switch during an active turn fails without mutating settings", async () => {
  const { agent } = fixture();
  (agent as any).driver = {
    runTurn: async () => {
      expect(() => agent.updateSettings({ nativeTaskContext: true, maxSteps: 3 })).toThrow("active turn");
      expect(agent.getSettings().nativeTaskContext).toBe(false);
      expect(agent.getSettings().maxSteps).not.toBe(3);
      return { text: "done", messages: [], usage: {} };
    },
  };
  expect((await agent.sendMessage("Run")).response).toBe("done");
});

test("catalog composition supports async assemblers and the normal context preview", async () => {
  const { agent, inputs } = fixture(true, true);
  await agent.sendMessage("Current request");
  expect(inputs).toHaveLength(1);
  expect(agent.getNextStepContext()).toContain("shared:Current request");
});

test("a catalog switch preserves computed results and retained bindings across the shared post-step path", async () => {
  const { agent } = fixture();
  agent.updateSettings({ nativeTaskHistory: true });
  const retained: string[] = [];
  const history = (agent as any).taskHistory;
  history.retain = async (id: string) => {
    retained.push(id);
    return { path: "/test/retained.arrow", sha256: "a".repeat(64), rowCount: 0 };
  };
  let turn = 0;
  let nextContext = "";
  (agent as any).driver = {
    runTurn: async (input: DriverRunTurnInput) => {
      turn++;
      nextContext = JSON.stringify(await input.prepareStep({ stepNumber: 0, messages: input.initialMessages }));
      const args = {
        operators: turn === 1 ? [{ op: "scan", id: "source", files: "data/fixture.csv" }] : [],
        observe: ["source"],
      };
      const output = await input.tools.dataflow.execute(args);
      await input.onStepFinish({
        text: "Read the source",
        toolCalls: [{ toolName: "dataflow", toolCallId: `call-${turn}`, input: args }],
        toolResults: [{ toolCallId: `call-${turn}`, output }],
      });
      if (turn === 1)
        agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, "source", {
          state: "Completed",
          resultMode: "table",
          result: [],
          totalRowCount: 0,
          inputTuples: 0,
          outputTuples: 0,
          resultVersion: { id: "result-1" },
          materialization: { executionId: "execution-1", outputPort: 0, cached: false },
        } as any);
      await input.onStepFinish({ text: "There are no matching rows." });
      return { text: "There are no matching rows.", messages: [], usage: {} };
    },
  };
  await agent.sendMessage("Read the table");
  expect(history.available("source")).toEqual([1]);
  const workflow = structuredClone(agent.getWorkflowState().getWorkflowContent());
  agent.updateSettings({ nativeTaskContext: true });
  expect((await agent.sendMessage("Report that same result again")).response).toBe("There are no matching rows.");
  expect(agent.getWorkflowState().getWorkflowContent()).toEqual(workflow);
  expect(history.available("source")).toEqual([1, 2]);
  expect(retained).toEqual(["source"]);
  expect(nextContext).toContain("source: 1");
  expect(agent.getSnapshotStorage().getOperatorResult(agent.getHead(), "source")?.result).toEqual([]);
  expect(agent.getAllSteps().some(step => /STALE_ANSWER|EMPTY_ANCESTOR/.test(step.content))).toBe(false);
});

test("retired experimental settings fail explicitly and atomically", () => {
  const { agent } = fixture();
  for (const name of [
    "nativeTaskCache",
    "nativeTaskReuse",
    "nativeTaskReceipts",
    "nativeCompactIndex",
    "nativeDemandExecution",
    "nativeKeptFrames",
    "nativeDirectReturn",
    "nativeCompactPrompt",
  ]) {
    for (const value of [true, false]) {
      expect(() => agent.updateSettings({ nativeTaskContext: true, [name]: value } as any)).toThrow("retired");
      expect(agent.getSettings().nativeTaskContext).toBe(false);
    }
  }
});
