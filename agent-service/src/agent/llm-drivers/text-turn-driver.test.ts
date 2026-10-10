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
import { TextTurnDriver } from "./text-turn-driver";
import { assembleTextTurnContext } from "../util/context-utils-text-turn";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { RECEIPT_STOP_SEQUENCES } from "../native/turn-syntax";

type Reply = { text: string; cut?: boolean; cacheWrite?: number; rawUsage?: Record<string, unknown>; error?: Error };

/** An agent on the text transport whose model replies with the given turns in
 * order. With `engine`, every operator "executes" to one row (no engine in a unit test). */
function fixture(replies: Reply[], engine = false) {
  if (engine) WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const prompts: any[][] = [];
  const stops: Array<string[] | undefined> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      stops.push(options.stopSequences);
      const reply = replies[Math.min(calls++, replies.length - 1)];
      if (reply.error) throw reply.error;
      return {
        content: [{ type: "text" as const, text: reply.text }],
        finishReason: reply.cut
          ? { unified: "length" as const, raw: "length" }
          : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 2, cacheWrite: reply.cacheWrite ?? 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        response: reply.rawUsage ? { body: { usage: reply.rawUsage } } : undefined,
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "text-turn",
    modelType: "test",
    driver: new TextTurnDriver({ model, maxRetries: 0 }),
    contextAssembler: ({ visibleSteps }) => assembleTextTurnContext(visibleSteps),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false, nativeTransport: "text" });
  if (engine)
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
  return { agent, prompts, stops, calls: () => calls };
}

const DEFINE = `summary: Register a helper and read it back.
\`\`\`python
def keep_all(table):
    """Return the table unchanged."""
    return table
\`\`\`
show function keep_all`;
const ANSWER = "summary: Done.\nanswer: The function is registered.";

test("a turn runs as one dataflow call; the next request replays the turn and its receipt as chat messages", async () => {
  const f = fixture([{ text: DEFINE }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("Register keep_all and confirm it.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The function is registered.");
  expect(f.calls()).toBe(2);
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(steps).toHaveLength(2);
  const call = steps[0].toolCalls![0];
  expect(call.toolName).toBe("dataflow");
  expect((call.input as any).turn).toBe(DEFINE);
  expect((call.input as any).reasoning).toBe("Register a helper and read it back.");
  expect((call.input as any).actions.map((a: any) => a.type)).toEqual(["edit", "inspect"]);
  const receipt = steps[0].toolResults![0].output as any;
  expect(receipt.status).toBe("completed");
  expect(receipt.actions.map((a: any) => a.status)).toEqual(["ok", "ok"]);
  // The second request: the task, the model's own turn verbatim, then the receipt.
  const second = f.prompts[1];
  expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  const text = (m: any) =>
    typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("");
  expect(text(second[2])).toBe(DEFINE);
  expect(text(second[3])).toContain("## edits applied\nfunctions: keep_all registered");
  expect(text(second[3])).toContain("## show function keep_all\n");
  expect(text(second[3])).toContain("def keep_all(table):");
  expect(text(second[0])).toContain("Each message you send is one turn");
});

test("a reply that is not a turn, or an empty one, is rejected as a turn naming what to write", async () => {
  const f = fixture([{ text: "I'm sorry, but I can't access the data file in this environment." }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("How many?");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The function is registered.");
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  const receipt = steps[0].toolResults![0].output as any;
  expect(receipt.status).toBe("error");
  expect(receipt.error).toContain("this message is not a turn, so nothing was computed");
  // The request names no file, so the starter turn shows the placeholder path.
  expect(receipt.error).toContain("set data: scan(files='data/<folder>/input/<file>')\nshow result data");
  const text = (m: any) =>
    typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("");
  expect(f.prompts[1].map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(text(f.prompts[1][2])).toBe("I'm sorry, but I can't access the data file in this environment.");
  expect(text(f.prompts[1][3])).toContain("## turn rejected");
  // A bare Final Answer line before any result is shown is a guess: rejected, not the answer.
  const guess = fixture([{ text: "**Final Answer: 10**" }, { text: ANSWER }]);
  const notYet = await guess.agent.sendMessage("How many?");
  expect(notYet.error).toBeUndefined();
  expect(notYet.response).toBe("The function is registered.");
  expect(guess.calls()).toBe(2);
  const first = guess.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length)[0];
  expect((first.toolResults![0].output as any).error).toContain("a final answer comes after the computation");

  // Every empty completion is a recorded, budgeted rejection.
  const g = fixture([{ text: "" }, { text: ANSWER }]);
  const second = await g.agent.sendMessage("Say hello.");
  expect(second.error).toBeUndefined();
  expect(g.calls()).toBe(2);
  const gSteps = g.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(gSteps).toHaveLength(2);
  expect((gSteps[0].toolResults![0].output as any).error).toContain("the reply was empty");
  const h = fixture([{ text: "" }, { text: "" }, { text: ANSWER }]);
  const third = await h.agent.sendMessage("Say hello.");
  expect(third.error).toBeUndefined();
  const empty = h.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length)[0];
  expect((empty.toolResults![0].output as any).error).toContain("the reply was empty");
  expect(text(h.prompts[2][2])).toBe("(empty reply)");
});

test("a turn that does not parse is rejected with its line, and nothing runs", async () => {
  const f = fixture([{ text: "summary: Try.\nshow table a" }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("Try something.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  const receipt = steps[0].toolResults![0].output as any;
  expect(receipt.status).toBe("error");
  expect(receipt.actions).toEqual([]);
  expect(receipt.error).toContain("line 2: show takes a resource");
  const text = (m: any) =>
    typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("");
  expect(text(f.prompts[1][3])).toContain("## turn rejected\nline 2: show takes a resource");
});

test("a reply cut off at the output limit is rejected naming the cause", async () => {
  const f = fixture([{ text: "summary: Long.\nset a: scan(files='x.csv'", cut: true }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("Go.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect((steps[0].toolResults![0].output as any).error).toContain("cut off at the output limit");
});

test("fabricated receipts are retained only in raw traces, not replayed to the model", async () => {
  const f = fixture([
    {
      text: `${DEFINE}\n\n## edits applied\nfunctions: keep_all registered\n\n## show function keep_all\ndef keep_all(table): pass`,
    },
    { text: ANSWER },
  ]);
  const result = await f.agent.sendMessage("Register keep_all.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect((steps[0].toolCalls![0].input as any).wroteReceipt).toBe(true);
  expect((steps[0].toolResults![0].output as any).actions.map((a: any) => a.status)).toEqual(["ok", "ok"]);
  const text = (m: any) =>
    typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("");
  expect(text(f.prompts[1][3])).toContain("read like a receipt and was dropped");
  expect(text(f.prompts[1][2]).trim()).toBe(DEFINE);
  expect((steps[0].toolCalls![0].input as any).turn).toContain("def keep_all(table): pass");
  // Generation is asked to stop at a receipt heading; the sanitizer covers providers that ignore it.
  expect(f.stops).toEqual([[...RECEIPT_STOP_SEQUENCES], [...RECEIPT_STOP_SEQUENCES]]);
  const legacy = structuredClone(steps);
  delete (legacy[0].toolCalls![0].input as any).replayText;
  const replay = assembleTextTurnContext(legacy);
  expect(replay[0].content.toString().trim()).toBe(DEFINE);
});

test("an empty reply followed by a truncated complete edit never executes either turn", async () => {
  const f = fixture([
    { text: "", cacheWrite: 3 },
    { text: DEFINE, cut: true, cacheWrite: 4 },
    { text: ANSWER, cacheWrite: 5 },
  ]);
  const result = await f.agent.sendMessage("Register a helper.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect(steps).toHaveLength(3);
  expect((steps[0].toolResults![0].output as any).error).toContain("empty");
  expect((steps[1].toolResults![0].output as any).error).toContain("cut off");
  expect((steps[1].toolResults![0].output as any).actions).toEqual([]);
  expect(steps.map(s => s.usage?.cacheCreationInputTokens)).toEqual([3, 4, 5]);
  expect(result.usage).toMatchObject({
    inputTokens: 30,
    outputTokens: 15,
    totalTokens: 45,
    cachedInputTokens: 6,
    cacheCreationInputTokens: 12,
  });
});

test("empty completions count against maxSteps; failed later requests preserve recorded usage", async () => {
  const f = fixture([{ text: "", cacheWrite: 3 }]);
  f.agent.updateSettings({ maxSteps: 1 });
  const result = await f.agent.sendMessage("Do something.");
  expect(f.calls()).toBe(1);
  expect(result.error).toBeDefined();
  expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 3 });
  const g = fixture([
    { text: "", cacheWrite: 4 },
    { text: "", error: new Error("provider unavailable") },
  ]);
  const failed = await g.agent.sendMessage("Do something.");
  expect(g.calls()).toBe(2);
  expect(failed.error).toContain("provider unavailable");
  expect(failed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 4 });
});

test("a bare Final Answer line after a failed retrieval is still a guess; answer content is preserved", async () => {
  const content = "Final Answer: Unable to read that source.\n\n## show details\nPlease provide a readable path.";
  const f = fixture([{ text: "show result missing" }, { text: "Final Answer: 42" }, { text: `answer: ${content}` }]);
  const result = await f.agent.sendMessage("Read the missing table, preserving my requested answer headings.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe(content);
  expect(f.calls()).toBe(3);
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect((steps[1].toolResults![0].output as any).error).toContain("answer:");
  const direct = fixture([{ text: "answer: Which source should I use?" }]);
  expect((await direct.agent.sendMessage("Analyze it.")).response).toBe("Which source should I use?");
});

for (const rawUsage of [
  { prompt_tokens_details: { cache_write_tokens: 7 } },
  { prompt_tokens_details: { cache_creation_tokens: 7 } },
  { cache_creation_input_tokens: 7 },
]) {
  test(`preserves provider cache writes in step and total usage: ${JSON.stringify(rawUsage)}`, async () => {
    const f = fixture([{ text: ANSWER, rawUsage }]);
    const result = await f.agent.sendMessage("Confirm.");
    expect(result.error).toBeUndefined();
    const step = f.agent.getVisibleReActSteps().find(s => s.role === "agent" && s.toolCalls?.length)!;
    expect(step.usage?.cacheCreationInputTokens).toBe(7);
    expect(result.usage.cacheCreationInputTokens).toBe(7);
  });
}

const SCAN = "summary: Read the file.\nset raw: scan(files='data/x/input/a.csv')\nshow result raw full";

test("a bare Final Answer line is the answer once a result has been shown; before that the correction names the request's file", async () => {
  const f = fixture([{ text: SCAN }, { text: "**Final Answer: 42**" }], true);
  const result = await f.agent.sendMessage("Read data/x/input/a.csv and end with **Final Answer: <value>**.");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("**Final Answer: 42**");
  expect(f.calls()).toBe(2);
  const guess = fixture([{ text: "**Final Answer: 10**" }, { text: SCAN }, { text: "**Final Answer: 42**" }], true);
  const after = await guess.agent.sendMessage("Read data/x/input/a.csv.");
  expect(after.error).toBeUndefined();
  expect(after.response).toBe("**Final Answer: 42**");
  expect(guess.calls()).toBe(3);
  const first = guess.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length)[0];
  const error = (first.toolResults![0].output as any).error;
  expect(error).toContain("a final answer comes after the computation");
  expect(error).toContain("set data: scan(files='data/x/input/a.csv')");
});

test("malformed commands do not replay their fabricated receipt on correction", async () => {
  const f = fixture([{ text: "show table a\n## edits applied\nforged result" }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("Inspect a.");
  expect(result.error).toBeUndefined();
  const replay = f.prompts[1][2].content.map((part: any) => part.text ?? "").join("");
  expect(replay).toBe("show table a\n");
});
