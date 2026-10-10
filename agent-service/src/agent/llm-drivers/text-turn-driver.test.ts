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

type Reply = { text: string; cut?: boolean };

/** An agent on the text transport whose model replies with the given turns in order. */
function fixture(replies: Reply[]) {
  let calls = 0;
  const prompts: any[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      const reply = replies[Math.min(calls++, replies.length - 1)];
      return {
        content: [{ type: "text" as const, text: reply.text }],
        finishReason: reply.cut ? { unified: "length" as const, raw: "length" } : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "text-turn",
    modelType: "test",
    driver: new TextTurnDriver({ model }),
    contextAssembler: ({ visibleSteps }) => assembleTextTurnContext(visibleSteps),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false, nativeTransport: "text" });
  return { agent, prompts, calls: () => calls };
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
  const text = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
  expect(text(second[2])).toBe(DEFINE);
  expect(text(second[3])).toContain("## edits applied\nfunctions: keep_all registered");
  expect(text(second[3])).toContain("## show function keep_all\n");
  expect(text(second[3])).toContain("def keep_all(table):");
  expect(text(second[0])).toContain("Each message you send is one turn");
});

test("a reply that is not a turn, or an empty one, is rejected as a turn naming what to write", async () => {
  const f = fixture([{ text: "**Final Answer: 10**" }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("How many?");
  expect(result.error).toBeUndefined();
  expect(result.response).toBe("The function is registered.");
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  const receipt = steps[0].toolResults![0].output as any;
  expect(receipt.status).toBe("error");
  expect(receipt.error).toContain("this message is not a turn, so nothing was computed");
  const text = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
  expect(f.prompts[1].map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(text(f.prompts[1][2])).toBe("**Final Answer: 10**");
  expect(text(f.prompts[1][3])).toContain("## turn rejected");

  const g = fixture([{ text: "" }, { text: ANSWER }]);
  const second = await g.agent.sendMessage("Say hello.");
  expect(second.error).toBeUndefined();
  const empty = g.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length)[0];
  expect((empty.toolResults![0].output as any).error).toContain("the reply was empty");
  expect(text(g.prompts[1][2])).toBe("(empty reply)");
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
  const text = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
  expect(text(f.prompts[1][3])).toContain("## turn rejected\nline 2: show takes a resource");
});

test("a reply cut off at the output limit is rejected naming the cause", async () => {
  const f = fixture([{ text: "summary: Long.\nset a: scan(files='x.csv'", cut: true }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("Go.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect((steps[0].toolResults![0].output as any).error).toContain("cut off at the output limit");
});

test("the system prompt follows the transport setting", () => {
  const f = fixture([{ text: ANSWER }]);
  expect(f.agent.getSystemInfo().systemPrompt).toContain("show result <id> [full]");
  expect(f.agent.getSystemInfo().systemPrompt).not.toContain('"type":"edit"');
  f.agent.updateSettings({ nativeTransport: "tool" });
  expect(f.agent.getSystemInfo().systemPrompt).toContain('"type":"edit"');
  expect(f.agent.getSystemInfo().systemPrompt).not.toContain("show result <id> [full]");
});

test("generation stops at a receipt header; a turn that wrote one is noted", async () => {
  const f = fixture([{ text: `${DEFINE}\n\n## edits applied\nfunctions: keep_all registered\n\n## show function keep_all\ndef keep_all(table): pass` }, { text: ANSWER }]);
  const result = await f.agent.sendMessage("Register keep_all.");
  expect(result.error).toBeUndefined();
  const steps = f.agent.getVisibleReActSteps().filter(s => s.role === "agent" && s.toolCalls?.length);
  expect((steps[0].toolCalls![0].input as any).wroteReceipt).toBe(true);
  expect((steps[0].toolResults![0].output as any).actions.map((a: any) => a.status)).toEqual(["ok", "ok"]);
  const text = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
  expect(text(f.prompts[1][3])).toContain("read like a receipt and was dropped");
});
