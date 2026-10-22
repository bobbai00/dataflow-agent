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
import { AgentMode, ContextMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { VercelToolUseDriver } from "./vercel-tool-use-driver";

type Reply = { text?: string; call?: Record<string, string>; finish?: "length" };

/** A native agent whose model replies with the given dataflow calls or texts in order. */
function fixture(replies: Reply[]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const prompts: any[][] = [];
  const choices: any[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      choices.push(options.toolChoice);
      const reply = replies[Math.min(calls++, replies.length - 1)];
      const content: any[] = reply.text !== undefined ? [{ type: "text" as const, text: reply.text }] : [];
      if (reply.call)
        content.push({
          type: "tool-call" as const,
          toolCallId: `call-${calls}`,
          toolName: "dataflow",
          input: JSON.stringify(reply.call),
        });
      return {
        content,
        finishReason: reply.call
          ? { unified: "tool-calls" as const, raw: "tool_calls" }
          : reply.finish === "length"
            ? { unified: "length" as const, raw: "length" }
            : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "turn-tool",
    modelType: "test",
    driver: new VercelToolUseDriver({ model, maxRetries: 0 }),
    contextAssembler: input =>
      assembleContext(input.visibleSteps, input.workflowState, input.snapshotStorage, ContextMode.DELTA, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
      }),
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    maxSteps: 25,
    thoughtReplay: false,
    retrievalViews: ["sample", "full"],
  });
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
  return { agent, prompts, choices, calls: () => calls };
}

const text = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
const DEFINE = {
  python: 'def keep_all(table):\n    """Return the table unchanged."""\n    return table',
  statements: "show function keep_all",
};
const SCAN = {
  python: "",
  statements: "set raw: scan(files='data/x/input/a.csv')\nshow result raw full",
};

test("each call is replayed verbatim with its receipt as the tool result; tool choice stays auto", async () => {
  const f = fixture([{ call: DEFINE }, { call: SCAN }, { text: "**Final Answer: 42**" }]);
  const result = await f.agent.sendMessage(
    "Register keep_all, then read data/x/input/a.csv and answer with **Final Answer: <value>**."
  );
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("**Final Answer: 42**");
  expect(f.calls()).toBe(3);
  expect(f.choices.every(choice => choice?.type !== "required")).toBe(true);
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent");
  const first = steps[0];
  expect(first.toolCalls![0].input).toEqual(DEFINE);
  const receipt = first.toolResults![0].output as any;
  expect(receipt.status).toBe("completed");
  expect(receipt.turn.statements.map((s: any) => s.text)).toEqual(["show function keep_all"]);
  expect(receipt.actions.map((a: any) => [a.action.type, a.status])).toEqual([
    ["edit", "ok"],
    ["inspect", "ok"],
  ]);
  // The second request: the task, the call as the model wrote it, then the receipt as a tool message.
  const second = f.prompts[1];
  expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  const call = second[2].content.find((part: any) => part.type === "tool-call");
  expect(call.input).toEqual(DEFINE);
  const toolResult = second[3].content[0];
  const rendered =
    typeof toolResult.output?.value === "string" ? toolResult.output.value : JSON.stringify(toolResult.output);
  expect(rendered).toContain("## edits applied\nfunctions: keep_all registered");
  expect(rendered).toContain("## show function keep_all");
  expect(rendered).toContain("def keep_all(table):");
  // The third request carries the shown result; the plain reply ends the task as the answer.
  const third = f.prompts[2];
  const shown =
    typeof third[5].content[0].output?.value === "string"
      ? third[5].content[0].output.value
      : JSON.stringify(third[5].content[0].output);
  expect(shown).toContain("## show result raw full");
  expect(shown).toContain("| 42 |");
  const last = steps[steps.length - 1];
  expect(last.isEnd).toBe(true);
  expect(last.content).toBe("**Final Answer: 42**");
  const prompt = f.agent.getSystemInfo().systemPrompt;
  expect(prompt).toContain("`statements`");
  expect(prompt).not.toContain("`summary`");
  expect(prompt).not.toContain("answer: <text to the end of the turn>");
  expect(f.agent.getSystemInfo().tools.map(tool => tool.name)).toEqual(["dataflow"]);
});

test("a reply without a tool call before any shown result is corrected, at most twice, with a starter call from the request", async () => {
  const f = fixture([
    { text: "I'm sorry, but I can't access the data file in this environment." },
    { call: SCAN },
    { text: "Final Answer: 42" },
  ]);
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("Final Answer: 42");
  expect(f.calls()).toBe(3);
  const correction = text(f.prompts[1][f.prompts[1].length - 1]);
  expect(correction).toContain("nothing was computed");
  expect(correction).toContain("scan(files='data/x/input/a.csv')");
  expect(correction).toContain("show result data");

  const stubborn = fixture([
    { text: "I cannot access files." },
    { text: "I cannot access files." },
    { text: "I cannot access files." },
    { call: SCAN },
  ]);
  const failed = await stubborn.agent.sendMessage("Read data/x/input/a.csv.");
  expect(stubborn.calls()).toBe(3);
  expect(failed.response).toBe("");
  expect(failed.error).toBeDefined();
});

test("a follow-up after the task was solved is answered in words, without a correction", async () => {
  const f = fixture([
    { call: SCAN },
    { text: "Final Answer: 42" },
    { text: "42 is the value in the only row of a.csv." },
  ]);
  await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  const followUp = await f.agent.sendMessage("Where does that number come from?");
  expect(followUp.error).toBeUndefined();
  expect(followUp.response).toBe("42 is the value in the only row of a.csv.");
  expect(f.calls()).toBe(3);
  expect(f.agent.getVisibleReActSteps().some(step => step.messageSource === "correction")).toBe(false);
});

test("a correction is the service's note, not the user's words; separate requests each show their own result", async () => {
  const f = fixture([
    { call: SCAN },
    { text: "Final Answer: 42" },
    { text: "As before, 42." },
    { call: SCAN },
    { text: "Final Answer: 42" },
  ]);
  f.agent.updateSettings({ multiRequest: "transcript" });
  await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  const second = await f.agent.sendMessage("Read data/x/input/a.csv again and report the value.");
  expect(second.response).toBe("Final Answer: 42");
  const correction = f.agent.getVisibleReActSteps().find(step => step.content.startsWith("That reply was text"));
  expect(correction).toMatchObject({
    role: "user",
    messageSource: "correction",
    correction: "missing-action",
    isBegin: false,
  });
});

test("a reply cut off at the output limit is not the answer; the model gets a correction", async () => {
  const f = fixture([
    { call: SCAN },
    { text: "Let me reconsider the units: the radius varies by", finish: "length" },
    { text: "Final Answer: 42" },
  ]);
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and report the value.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("Final Answer: 42");
  expect(f.calls()).toBe(3);
  const correction = text(f.prompts[2][f.prompts[2].length - 1]);
  expect(correction).toContain("cut off at the output limit");
});

test("an answer written as a statement is a rejected call that runs nothing", async () => {
  const f = fixture([{ call: { python: "", statements: "answer: 42" } }, { call: SCAN }, { text: "42" }]);
  const result = await f.agent.sendMessage("Read data/x/input/a.csv.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("42");
  const first = f.agent.getVisibleReActSteps().filter(s => s.role === "agent")[0];
  const receipt = first.toolResults![0].output as any;
  expect(receipt.status).toBe("error");
  expect(receipt.actions).toEqual([]);
  const toolResult = f.prompts[1][3].content[0];
  const rendered =
    typeof toolResult.output?.value === "string" ? toolResult.output.value : JSON.stringify(toolResult.output);
  expect(rendered).toContain("## call rejected");
  expect(rendered).toContain("reply with the answer text and no tool call");
});

test("text the model writes beside a call is replayed with the call, before its receipt", async () => {
  const f = fixture([
    { text: "First I read the file to see its columns.", call: SCAN },
    { text: "**Final Answer: 42**" },
  ]);
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and answer with **Final Answer: <value>**.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("**Final Answer: 42**");
  const second = f.prompts[1];
  expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  const parts = second[2].content.map((part: any) => part.type);
  expect(parts).toEqual(["text", "tool-call"]);
  expect(second[2].content[0].text).toBe("First I read the file to see its columns.");
  expect(second[2].content[1].input).toEqual(SCAN);
});
