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
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { VercelToolUseDriver } from "../llm-drivers/vercel-tool-use-driver";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

/** A model reply: the statements of one dataflow call, or a text reply. */
type Reply = { statements: string } | { text: string };
const execute: Reply = { statements: "execute\nexecute\nexecute" };
const executeMissing: Reply = { statements: "execute missing" };
const lookup: Reply = { statements: "show builtin scan" };
const scan: Reply = { statements: "set raw: scan(files='data/x/input/a.csv')\nshow result raw" };
const answer: Reply = { text: "The value is 42." };

/** The loop corrections only; budget reminders are feedback steps too. */
const corrections = (agent: TexeraAgent) =>
  agent
    .getVisibleReActSteps()
    .filter(s => s.messageSource === "correction" && s.content.includes("failed the same way"));

function fixture(replyAt: (call: number) => Reply) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      const reply = replyAt(++calls);
      return {
        content:
          "text" in reply
            ? [{ type: "text" as const, text: reply.text }]
            : [
                {
                  type: "tool-call" as const,
                  toolCallId: `loop-${calls}`,
                  toolName: "dataflow",
                  input: JSON.stringify({ python: "", statements: reply.statements }),
                },
              ],
        finishReason:
          "text" in reply
            ? { unified: "stop" as const, raw: "stop" }
            : { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
          outputTokens: { total: 5, text: 4, reasoning: 1 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "repeated-failure-loop",
    modelType: "test",
    driver: new VercelToolUseDriver({ model }),
    contextAssembler: ({ visibleSteps, workflowState, snapshotStorage, settings }) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        thoughtReplay: false,
      }),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false });
  // No engine in a unit test: every operator "executes" to one row.
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators())
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        totalRowCount: 1,
        resultMode: "table",
        result: [{ value: 42 }],
        resultSchema: [{ name: "value", type: "int64", encoding: "" }],
      });
  };
  return { agent, prompts, calls: () => calls };
}

test("four identical failures end the turn after one correction, retaining usage and receipts", async () => {
  const f = fixture(() => execute);
  const result = await f.agent.sendMessage("Analyze the supplied file.");
  expect(f.calls()).toBe(4);
  expect(result.error).toContain("REPEATED_FAILURE_LOOP");
  expect(result.error).toContain("The dataflow is empty");
  expect(result.response).toBe("");
  expect(result.stopped).toBe(false);
  expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 20, cachedInputTokens: 8, reasoningTokens: 4 });
  const feedback = corrections(f.agent);
  expect(feedback).toHaveLength(1);
  expect(feedback[0].content).toContain("The graph is empty");
  expect(feedback[0].content).toContain("Two more identical failures end this turn.");
  // The correction is seen by the third call; every prompt extends the previous one.
  expect(JSON.stringify(f.prompts[2])).toContain(feedback[0].content);
  expect(JSON.stringify(f.prompts[1])).not.toContain(feedback[0].content);
  for (let i = 1; i < f.prompts.length; i++)
    expect(f.prompts[i].slice(0, f.prompts[i - 1].length)).toEqual(f.prompts[i - 1]);
  const receipts = f.agent.getVisibleReActSteps().flatMap(s => s.toolResults ?? []);
  expect(receipts).toHaveLength(4);
  expect(receipts.flatMap(r => (r.output as any).actions)).toHaveLength(12);
  expect(f.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
  expect(f.agent.getVisibleReActSteps().at(-1)?.isEnd).toBe(true);
});

test("the model can still finish after the correction instead of being stopped", async () => {
  const f = fixture(call => (call <= 2 ? execute : call === 3 ? scan : answer));
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The value is 42.");
  expect(f.calls()).toBe(4);
  expect(corrections(f.agent)).toHaveLength(1);
});

test("a successful call resets the streak; an unknown target repeated is its own loop", async () => {
  const f = fixture(call => (call === 3 ? lookup : call === 6 ? scan : call === 7 ? answer : execute));
  expect((await f.agent.sendMessage("Read data/x/input/a.csv and report the value.")).error).toBeUndefined();
  expect(f.calls()).toBe(7);
  expect(corrections(f.agent)).toHaveLength(2);
  const unknown = fixture(() => executeMissing);
  const result = await unknown.agent.sendMessage("Check the requested target.");
  expect(result.error).toContain("REPEATED_FAILURE_LOOP");
  expect(result.error).toContain("Unknown or disabled execution targets: missing");
  expect(unknown.calls()).toBe(4);
});

test("a different failure does not continue the streak", async () => {
  const f = fixture(call => (call % 2 ? execute : executeMissing));
  f.agent.updateSettings({ maxSteps: 6 });
  const result = await f.agent.sendMessage("Alternate failures.");
  expect(result.error ?? "").not.toContain("REPEATED_FAILURE_LOOP");
  expect(corrections(f.agent)).toHaveLength(0);
});

test("the protection resets at the next user turn", async () => {
  const f = fixture(() => execute);
  for (let turn = 0; turn < 2; turn++) {
    expect((await f.agent.sendMessage("Try a new task.")).error).toContain("REPEATED_FAILURE_LOOP");
    expect(f.calls()).toBe((turn + 1) * 4);
  }
});
