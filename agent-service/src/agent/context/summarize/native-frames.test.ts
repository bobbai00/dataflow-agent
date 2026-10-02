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
import { buildNativeFrames, splitOperators, splitTrailingState, splitTurns } from "./native-frames";
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
  "",
  "# Operators needing attention",
  "- join_b lost 9 rows",
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
    const reply = 'The computation is complete.\n\n- The result is 10.87 percentage points.\n- Check units.\n\n```json\n{"value":10.87}\n```\nFinal Answer: 10.87';
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
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "user"]);
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

  test("trailing current-state section stays last so the prefix stays stable", () => {
    const { messages } = buildNativeFrames(CTX, MAP);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("# Operators needing attention");
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

  test("no events ⇒ single user block (LATEST untouched)", () => {
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

describe("splitTrailingState", () => {
  const render = (events: number, state: string) =>
    [
      "# Task\nCompute the mean.",
      ...Array.from({ length: events }, (_, i) => `## Agent Event ${i + 1}\nThought: step ${i + 1}\nObservation:\nrows=${i}`),
      `# Current Dataflow\n${state}`,
    ].join("\n\n");

  test("cuts the volatile state section off the append-only history", () => {
    const { head, tail } = splitTrailingState(render(2, "op_a: 10 rows"));
    expect(tail).toContain("# Current Dataflow");
    expect(head).not.toContain("# Current Dataflow");
    expect(head).toContain("## Agent Event 2");
  });

  test("keeps the head byte-identical as steps accumulate (the cacheable prefix)", () => {
    // Same guarantee the cache depends on: step N's head must be a prefix of
    // step N+1's head, or Anthropic can never match the stored entry.
    const a = splitTrailingState(render(2, "op_a: 10 rows")).head;
    const b = splitTrailingState(render(3, "op_a: 99 rows")).head;
    expect(b.startsWith(a)).toBe(true);
  });

  test("returns no tail when there is no trailing state section", () => {
    const { head, tail } = splitTrailingState("# Task\nonly a task, no events");
    expect(tail).toBe("");
    expect(head).toContain("only a task");
  });

  test("loses no content — head + tail covers the whole render", () => {
    const text = render(2, "op_a: 10 rows");
    const { head, tail } = splitTrailingState(text);
    expect((head + "\n\n" + tail).replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });
});

describe("stable first message (prefix cache)", () => {
  test("splitOperators splits a single operator too", () => {
    const text = "# User Task\nQ\n\n# Current Dataflow\n## Operators\n\n### scan operator `a`\nProperties: {}\nResult: x";
    const parts = splitOperators(text);
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe("# User Task\nQ\n\n# Current Dataflow\n## Operators");
    expect(parts[1].startsWith("### scan operator `a`")).toBe(true);
  });
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

describe("turnSplit", () => {
  test("one message per finished turn, per live step, and per top-level section", () => {
    const text = [
      "# Catalog",
      "",
      "## Turn 1",
      "### Task",
      "first",
      "### Answer",
      "42",
      "",
      "## Turn 2 (in progress)",
      "### Task",
      "second",
      "",
      "# Your Task",
      "",
      "Work on turn 2.",
      "",
      "### Steps",
      "",
      "#### Step 1",
      "Action: - scan",
      "Observation: ok",
      "",
      "#### Step 2",
      "Action: - filter",
    ].join("\n");
    const parts = splitTurns(text);
    expect(parts.map(p => p.split("\n")[0])).toEqual(["# Catalog", "## Turn 1", "## Turn 2 (in progress)", "# Your Task", "### Steps", "#### Step 1", "#### Step 2"]);
    expect(parts.join("\n\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });
});
