/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { buildNativeFrames } from "./native-frames";
import type { ReActStep } from "../../../types/agent";

const CTX = [
  "# User Task",
  "",
  "Find the answer.",
  "",
  "## Agent Event 2",
  "",
  "Thought: load the file",
  "",
  "Action:",
  "- createOrModifyOperator",
  "    operatorId: load_a",
  "    code:",
  "      def load():",
  "        pass",
  "",
  "Observation:",
  "- operator load_a added",
  "  Output Table: 3 rows, 2 cols",
  "  Schema (2 cols): a (str), b (str)",
  "",
  "## Agent Event 3",
  "",
  "Thought: now join",
  "",
  "Action:",
  "- createOrModifyOperator",
  "    operatorId: join_b",
  "",
  "Observation:",
  "- operator join_b added",
  "  Lineage: 12 rows in → 3 rows out (25.0%)",
].join("\n");

function step(id: string, calls: Array<[string, string]>, outputs: Record<string, string> = {}): ReActStep {
  return {
    id, messageId: "m", stepId: 1, timestamp: 1, role: "agent", content: "", isBegin: true, isEnd: false,
    toolCalls: calls.map(([tcid, op]) => ({ toolCallId: tcid, toolName: "createOrModifyOperator", input: { operatorId: op } })),
    toolResults: calls.map(([tcid]) => ({ toolCallId: tcid, output: outputs[tcid] ?? "ok" })),
  } as ReActStep;
}

const MAP = new Map<number, ReActStep>([
  [2, step("s2", [["call_a", "load_a"]])],
  [3, step("s3", [["call_b", "join_b"]])],
]);

describe("buildNativeFrames", () => {
  test("retains the entire multiline reply for Answer repair", () => {
    const reply =
      'The computation is complete.\n\n- The result is 10.87 percentage points.\n- Check units.\n\n```json\n{"value":10.87}\n```\nFinal Answer: 10.87';
    const text = `# User Task\nFind the answer.\n\n## Agent Event 1\nThought: ${reply}`;
    const { messages } = buildNativeFrames(text, new Map([[1, step("s1", [])]]));
    expect(messages.find(m => m.role === "assistant")?.content).toBe(reply);
    expect(messages.at(-1)?.content).toBe("Continue.");
  });

  test("multiline rationale stops at the real Action block", () => {
    const text = CTX.replace("Thought: load the file", "Thought: load the file\n\nThen validate the schema.");
    const { messages } = buildNativeFrames(text, MAP);
    expect((messages[1].content as any[])[0].text).toBe("load the file\n\nThen validate the schema.");
  });

  test("emits a real tool-calling transcript", () => {
    const { messages, events } = buildNativeFrames(CTX, MAP);
    expect(events).toBe(2);
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  });

  test("assistant turns carry actual tool-call parts, NOT prose actions", () => {
    const { messages } = buildNativeFrames(CTX, MAP);
    const a = messages[1];
    expect(Array.isArray(a.content)).toBe(true);
    const parts = a.content as any[];
    const call = parts.find(p => p.type === "tool-call");
    expect(call.toolCallId).toBe("call_a");
    expect(call.toolName).toBe("createOrModifyOperator");
    expect(call.input).toEqual({ operatorId: "load_a" });
    // REGRESSION GUARD: the rendered `Action:` block must never appear as text
    // in an assistant turn — that is what taught the model to narrate calls.
    const text = parts.filter(p => p.type === "text").map(p => p.text).join("\n");
    expect(text).not.toContain("Action:");
    expect(text).not.toContain("- createOrModifyOperator");
    expect(text).not.toContain("## Agent Event");
    expect(text).toContain("load the file");
  });

  test("our rendered evidence lands in the tool result", () => {
    const { messages } = buildNativeFrames(CTX, MAP);
    const parts = messages[2].content as any[];
    expect(parts[0].type).toBe("tool-result");
    expect(parts[0].toolCallId).toBe("call_a");
    expect(parts[0].output.type).toBe("text");
    expect(parts[0].output.value).toContain("Schema (2 cols): a (str), b (str)");
    expect(messages[4].content as any).toBeDefined();
    expect(((messages[4].content as any[])[0]).output.value).toContain("Lineage: 12 rows in");
  });

  test("registered dataflow keeps native roles and exact code with only rendered outcomes", () => {
    const input = {
      reasoning: "Normalize the labels and read the result.",
      actions: [
        {
          type: "edit",
          python: 'def normalize(t, column):\n    """Trim labels in the selected column."""\n    return t.assign(**{column: t[column].str.strip()})\n',
          changes: 'set clean: normalize(raw, column="label")',
        },
        { type: "execute", operator_ids: ["clean"] },
        { type: "retrieve", operator_ids: ["clean"], view: "full" },
      ],
    };
    const recorded = step("registered", []);
    recorded.toolCalls = [{ toolCallId: "registered-call", toolName: "dataflow", input }];
    recorded.toolResults = [{
      toolCallId: "registered-call",
      output: { kind: "dataflow-actions", status: "completed", cachedOperatorCount: 2 },
    }];
    const observation = [
      "### 1. Edit — completed",
      "- Function `normalize` registered.",
      '- Operator `clean` added: `normalize(raw, column="label")`.',
      "### 2. Execute — completed",
      "- Operator `clean` executed.",
      "### 3. Retrieve — completed",
      "Operator `clean`: 1 row, 1 column.",
      "| label |",
      "| --- |",
      "| example |",
    ].join("\n");
    const text = `# User Task\nTrim the labels.\n\n## Agent Event 1\nAction:\ndataflow\nObservation:\n${observation}`;
    const { messages } = buildNativeFrames(text, new Map([[1, recorded]]));

    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[1].content).toEqual([
      { type: "tool-call", toolCallId: "registered-call", toolName: "dataflow", input },
    ]);
    expect(messages[2].content).toEqual([
      {
        type: "tool-result",
        toolCallId: "registered-call",
        toolName: "dataflow",
        output: { type: "text", value: observation },
      },
    ]);
    expect(JSON.stringify(messages[2])).not.toContain("cachedOperatorCount");
  });

  test.each(["completed", "failed"])("dataflow retains its %s receipt without a rendered observation", status => {
    const recorded = step("registered", []);
    recorded.toolCalls = [{ toolCallId: "registered-call", toolName: "dataflow", input: { actions: [] } }];
    recorded.toolResults = [{ toolCallId: "registered-call", output: { kind: "dataflow-actions", status } }];
    const text = "# User Task\nInspect the graph.\n\n## Agent Event 1\nAction:\ndataflow";
    const { messages } = buildNativeFrames(text, new Map([[1, recorded]]));
    expect((messages[2].content as any[])[0].output.value).toBe(`dataflow-actions: ${status}`);
  });

  test("only the dataflow call carrying the observation omits its receipt", () => {
    const recorded = step("multi", []);
    recorded.toolCalls = ["first", "last"].map(toolCallId => ({ toolCallId, toolName: "dataflow", input: { actions: [] } }));
    recorded.toolResults = ["first", "last"].map(toolCallId => ({
      toolCallId,
      output: { kind: "dataflow-actions", status: "completed" },
    }));
    const text = "# User Task\nInspect the graph.\n\n## Agent Event 1\nAction:\ndataflow\nObservation:\nOperator `a` exists.";
    const { messages } = buildNativeFrames(text, new Map([[1, recorded]]));
    const results = messages[2].content as any[];
    expect(results.map(result => [result.toolCallId, result.output.value])).toEqual([
      ["first", "dataflow-actions: completed"],
      ["last", "Operator `a` exists."],
    ]);
  });

  test("every tool call has exactly one matching result (provider validity)", () => {
    const { messages } = buildNativeFrames(CTX, MAP);
    const callIds: string[] = [];
    const resultIds: string[] = [];
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as any[]) {
        if (p.type === "tool-call") callIds.push(p.toolCallId);
        if (p.type === "tool-result") resultIds.push(p.toolCallId);
      }
    }
    expect(callIds.sort()).toEqual(resultIds.sort());
  });

  test("multiple calls in one step each get a result; evidence rides the last", () => {
    const multi = new Map<number, ReActStep>([
      [2, step("s2", [["c1", "op1"], ["c2", "op2"]], { c1: "ok", c2: "ok" })],
      [3, step("s3", [["c3", "op3"]])],
    ]);
    const { messages } = buildNativeFrames(CTX, multi);
    const results = (messages[2].content as any[]).filter(p => p.type === "tool-result");
    expect(results).toHaveLength(2);
    expect(results[0].output.value).not.toContain("Schema (2 cols)");
    expect(results[1].output.value).toContain("Schema (2 cols)");
  });

  // The model's own reply is rendered verbatim as `Thought: <reply>`, so the
  // structure lines it may contain (a `# ` comment or heading, `Action:`,
  // `Observation:`, `## Agent Event N`) are its words, never section bounds.
  // From DeepSeek astronomy-hard-7 (2026-10-10): the reply's `# load` comment
  // was read as a trailing section, the reply was cut at 391 of 3,235
  // characters, and the next request rebuilt it whole (prefix changed).
  const registered = (reply: string, observation: string) => {
    const recorded = step("registered", []);
    recorded.content = reply;
    recorded.toolCalls = [{ toolCallId: "call", toolName: "dataflow", input: { statements: "show result raw" } }];
    recorded.toolResults = [{ toolCallId: "call", output: { kind: "dataflow-actions", status: "completed" } }];
    const text = `# User Task\nForecast density.\n\n## Agent Event 1\nThought: ${reply}\nAction:\ndataflow\nObservation:\n${observation}`;
    return buildNativeFrames(text, new Map([[1, recorded]]));
  };
  const observation = "## show result raw\nresult raw (scan): 3 rows × 2 columns\n| file | bytes |\n|---|---|\n| a.csv | 10 |";

  test.each([
    ["a fenced comment", 'The solution likely:\n\n```python\nimport pandas as pd\n\n# load\n...\n# context = last 16 hours\n```\n\nHmm.'],
    ["a Markdown heading", "Read the files first.\n\n# Plan\n\n1. List them."],
    ["structure labels", "Steps so far.\nAction:\nObservation:\n## Agent Event 7\nNext, list the files."],
  ])("the latest reply keeps %s as its own text", (_, reply) => {
    const { messages } = registered(reply, observation);
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "tool"]);
    expect((messages[1].content as any[])[0]).toEqual({ type: "text", text: reply });
    expect((messages[2].content as any[])[0].output.value).toBe(observation);
  });

  test("the latest reply renders the same whether or not an event follows it", () => {
    const reply = "```python\n# load\ndf = read()\n```\n# Plan\nCompare the counts.";
    const recorded = step("registered", []);
    recorded.content = reply;
    recorded.toolCalls = [{ toolCallId: "call", toolName: "dataflow", input: {} }];
    recorded.toolResults = [{ toolCallId: "call", output: { kind: "dataflow-actions", status: "completed" } }];
    const first = `# User Task\nForecast density.\n\n## Agent Event 1\nThought: ${reply}\nAction:\ndataflow\nObservation:\n${observation}`;
    const map = new Map([[1, recorded], [2, step("s2", [["call2", "op"]])]]);
    const a = buildNativeFrames(first, map);
    const b = buildNativeFrames(`${first}\n\n## Agent Event 2\nThought: next\nAction:\ndataflow\nObservation:\nok`, map);
    for (let i = 0; i < a.messages.length; i++) expect(JSON.stringify(b.messages[i])).toBe(JSON.stringify(a.messages[i]));
  });

  test("a final reply with a heading stays one assistant turn", () => {
    const reply = "The density is 2.4e-12.\n\n# Check\n\nUnits are kg/m³.\n\n**Final Answer: 2.4e-12**";
    const text = `# User Task\nFind the answer.\n\n## Agent Event 1\nThought: ${reply}`;
    const recorded = step("s1", []);
    recorded.content = reply;
    const { messages } = buildNativeFrames(text, new Map([[1, recorded]]));
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].content).toBe(reply);
  });

  test("APPEND-ONLY: adding an event leaves earlier messages byte-identical", () => {
    const short = CTX.slice(0, CTX.indexOf("## Agent Event 3")).trimEnd();
    const a = buildNativeFrames(short, MAP);
    const b = buildNativeFrames(CTX, MAP);
    for (let i = 0; i < a.messages.length - 1; i++) {
      expect(JSON.stringify(b.messages[i])).toBe(JSON.stringify(a.messages[i]));
    }
  });

  test("an event whose step has no tool calls degrades to a text turn", () => {
    const noCalls = new Map<number, ReActStep>([[2, step("s2", [])], [3, step("s3", [["c", "op"]])]]);
    const { messages } = buildNativeFrames(CTX, noCalls);
    // still valid: no orphan tool result, and pairing holds for the rest
    const ids = { calls: [] as string[], results: [] as string[] };
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as any[]) {
        if (p.type === "tool-call") ids.calls.push(p.toolCallId);
        if (p.type === "tool-result") ids.results.push(p.toolCallId);
      }
    }
    expect(ids.calls.sort()).toEqual(ids.results.sort());
  });

  test("no events ⇒ single user block", () => {
    const flat = "# User Task\n\ndo it\n\n# Current Dataflow\n";
    const { messages, events } = buildNativeFrames(flat, new Map());
    expect(events).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(flat);
  });

  test("missing step for an event still yields a valid transcript", () => {
    const { messages } = buildNativeFrames(CTX, new Map());
    expect(messages[messages.length - 1].role).toBe("user");
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const p of m.content as any[]) expect(p.type).not.toBe("tool-result");
      }
    }
  });
});

describe("stable first message (prefix cache)", () => {
  test("buildNativeFrames drops the no-events placeholder so step 1 ends like every later prefix", () => {
    const r = buildNativeFrames("# User Task\nQ\n\n# Agent Events\n\n(no agent actions yet)", new Map());
    expect(r.messages).toEqual([{ role: "user", content: "# User Task\nQ\n\n# Agent Events" }]);
  });
});

describe("multi-turn transcript", () => {
  test("an earlier user turn becomes a user message after the tool result, not part of it", () => {
    const text = [
      "# User Task\nSecond question",
      "",
      "# Agent Events",
      "",
      "## Agent Event 1",
      "Thought: look",
      "Action:",
      "- scan ...",
      "Observation:",
      "- scan operator `a` added",
      "",
      "## User Event 2",
      "",
      "First follow-up question",
      "",
      "## Agent Event 3",
      "Action:",
      "- filter ...",
      "Observation:",
      "- filter operator `b` added",
    ].join("\n");
    const step = (id: string, name: string): ReActStep =>
      ({ id, role: "agent", content: "", toolCalls: [{ toolCallId: id, toolName: name, input: { id: name } }], toolResults: [{ toolCallId: id, output: "ok" }] }) as unknown as ReActStep;
    const r = buildNativeFrames(text, new Map([[1, step("c1", "scan")], [3, step("c3", "filter")]]));
    const roles = r.messages.map(m => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
    expect(r.messages[3].content).toBe("First follow-up question");
    expect(JSON.stringify(r.messages[2].content)).not.toContain("First follow-up question");
  });
});
