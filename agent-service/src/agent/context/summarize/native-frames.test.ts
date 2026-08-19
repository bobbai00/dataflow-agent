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
import { buildNativeFrames, splitTrailingState } from "./native-frames";
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
