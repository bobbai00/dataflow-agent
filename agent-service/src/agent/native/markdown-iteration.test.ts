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
import type { ReActStep } from "../../types/agent";
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import { renderMarkdownIteration } from "./markdown-iteration";

const receipt = (actions: any[], outputs: unknown[], statuses: string[] = []) =>
  ({
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: "completed",
    actions: actions.map((action, i) => ({ index: i + 1, action, status: statuses[i] ?? "ok", output: outputs[i] })),
    operators: [],
    observe: [],
    observationErrors: [],
  }) as DataflowActionsResult;
const step = (actions: any[], output?: unknown): ReActStep => ({
  id: "step",
  messageId: "message",
  stepId: 3,
  timestamp: 0,
  role: "agent",
  content: "",
  isBegin: false,
  isEnd: false,
  toolCalls: [
    {
      toolName: "dataflow",
      toolCallId: "call",
      input: { reasoning: "Inspect the evidence before deciding.", actions },
    },
  ],
  ...(output === undefined ? {} : { toolResults: [{ toolCallId: "call", output }] }),
});
const count = (text: string, part: string) => text.split(part).length - 1;

test("one ordered Markdown iteration retains exact Python and graph edits once with committed outcomes", () => {
  const python =
    'def adjust(table, *, scale=2):\n    """Apply scale.\n# Fake heading\n```markdown\n"""\n    return table * scale\n';
  const changes = 'set a: scan(files="data.csv", doc="Exact source")\nset b: adjust(a, scale=3)\ndelete old';
  const actions = [
    { type: "edit", python, changes },
    { type: "execute", operator_ids: ["b"] },
  ];
  const output = receipt(actions, [
    {
      registrations: [{ name: "adjust", kind: "registered" }],
      changes: [
        { change: "operator", operator_id: "a", operator: "scan", action: "created" },
        { change: "operator", operator_id: "b", operator: "adjust", action: "updated" },
        { change: "operator", operator_id: "old", action: "deleted" },
      ],
    },
    { operators: [{ id: "b", status: "ok", state: "executed" }] },
  ]);
  const saved = step(actions, output);
  const before = structuredClone(saved);
  const text = renderMarkdownIteration(saved, 7);
  expect(text).toStartWith("## Iteration 7\n");
  expect(text).toContain("function adjust registered");
  expect(text).toContain("operator a created");
  expect(text).toContain("operator b updated");
  expect(text).toContain("operator old deleted");
  expect(text).toContain("````python\n" + python);
  expect(count(text, python)).toBe(1);
  expect(count(text, changes)).toBe(1);
  expect(text.indexOf(changes)).toBeLessThan(text.indexOf("2. execute"));
  expect(saved).toEqual(before);
});

test("function updates and failed/skipped attempts retain repairable payload without claiming application", () => {
  const actions = [
    { type: "edit", python: "def f(t):\n    return t + 1", changes: "" },
    { type: "edit", python: "def f(t)\n    return t", changes: "set bad: f(input)" },
    { type: "edit", python: "", changes: "delete input" },
  ];
  const text = renderMarkdownIteration(
    step(
      actions,
      receipt(
        actions,
        [{ registrations: [{ name: "f", kind: "updated" }], changes: [] }, "PYTHON_SYNTAX: missing colon", undefined],
        ["ok", "error", "skipped"]
      )
    ),
    1
  );
  expect(text).toContain("function f updated");
  expect(text).toContain("No changes were applied.");
  expect(text).toContain("PYTHON_SYNTAX");
  expect(text).toContain("def f(t)\n    return t");
  expect(text).toContain("delete input");
  expect(text).toContain("not applied");
  expect(text).not.toContain("operator input deleted");
});

test("retrieval preserves view/column requests, partial failures, and actual values", () => {
  const actions = [
    { type: "retrieve", operator_ids: ["a", "missing"], view: "sample_stats", columns: ["value", "Year "] },
  ];
  const text = renderMarkdownIteration(
    step(
      actions,
      receipt(
        actions,
        [
          {
            results: [
              { operator_id: "a", status: "ok", text: "records: sample_stats\n| value | Year |\n| 12 | 2024 |" },
              { operator_id: "missing", status: "error", error: "UNKNOWN_OPERATOR: missing" },
            ],
          },
        ],
        ["error"]
      )
    ),
    2
  );
  expect(text).toContain('view="sample_stats"');
  expect(text).toContain('columns=["value","Year "]');
  expect(text).toContain("| 12 | 2024 |");
  expect(text).toContain("UNKNOWN_OPERATOR");
  expect(text).toContain("retrieve a, missing: error");
});

test("inspection retains every request option and unusual argument strings", () => {
  const actions = [
    { type: "inspect", target: "schema", operator_id: "wide", offset: 200, limit: 10, note: "\n## Embedded\n```" },
  ];
  const text = renderMarkdownIteration(step(actions, receipt(actions, [{ text: "Schema page." }])), 3);
  expect(text).toContain("offset=200");
  expect(text).toContain("limit=10");
  expect(text).toContain('note="\\n## Embedded\\n```"');
});

test("receipts match toolCallId even when received out of order", () => {
  const a = [{ type: "execute", operator_ids: ["a"] }];
  const b = [{ type: "execute", operator_ids: ["b"] }];
  const saved = step(a);
  saved.toolCalls = [
    { toolName: "dataflow", toolCallId: "first", input: { reasoning: "First.", actions: a } },
    { toolName: "dataflow", toolCallId: "second", input: { reasoning: "Second.", actions: b } },
  ];
  saved.toolResults = [
    { toolCallId: "second", output: receipt(b, [{ operators: [{ id: "b", status: "ok", state: "cached" }] }]) },
    { toolCallId: "first", output: receipt(a, ["EXECUTION_TIMEOUT: a"], ["error"]) },
  ];
  const text = renderMarkdownIteration(saved, 4);
  expect(text.indexOf("execute a: error")).toBeLessThan(text.indexOf("execute b: ok"));
  expect(text).toContain("1 cached");
});

test("missing, malformed, unknown, and mismatched receipts remain explicit unconfirmed data", () => {
  const action = { type: "edit", python: "def f():\n    pass", changes: "set x: f()" };
  const missing = renderMarkdownIteration(step([action]), 1);
  expect(missing).toContain("No receipt");
  expect(missing).toContain(action.python);
  expect(missing).not.toContain("registered");
  const malformed = step([]);
  malformed.toolCalls![0].input = '{"actions": [ BROKEN\n## not a frame\n```';
  expect(renderMarkdownIteration(malformed, 2)).toContain(malformed.toolCalls![0].input);
  const unknown = step([]);
  unknown.toolCalls![0].toolName = "external_tool";
  unknown.toolCalls![0].input = { path: "/tmp/example" };
  unknown.toolResults = [{ toolCallId: "call", output: { error: "denied" }, isError: true }];
  expect(renderMarkdownIteration(unknown, 3)).toContain('"denied"');
  const other = [{ type: "edit", python: "", changes: "delete other" }];
  const mismatched = renderMarkdownIteration(step([action], receipt(other, [{ changes: [] }])), 4);
  expect(mismatched).toContain("does not match");
  expect(mismatched).toContain(action.python);
  expect(mismatched).toContain("delete other");
});

test("rejected envelopes retain original attempts and don't invent application", () => {
  const saved = step([{ type: "edit", changes: "delete source" }], {
    ...receipt([], []),
    status: "error",
    error: "Invalid arguments. No actions ran.",
  });
  const text = renderMarkdownIteration(saved, 1);
  expect(text).toContain("call rejected");
  expect(text).toContain("delete source");
  expect(text).not.toContain("operator source deleted");
});

test("no-action/final/user steps stay distinct; provider reasoning is never replayed", () => {
  const empty = {
    ...step([]),
    toolCalls: [],
    isEnd: true,
    content: "Exact final answer",
    reasoningText: "Private provider reasoning",
  };
  expect(renderMarkdownIteration(empty, 1)).toBe("");
  expect(renderMarkdownIteration({ ...empty, role: "user", isEnd: false }, 1)).toBe("");
  const actions = [{ type: "answer", content: "Exact final answer" }];
  const final = {
    ...step(actions, receipt(actions, [{}])),
    isEnd: true,
    content: "Exact final answer",
    reasoningText: "Private provider reasoning",
  };
  const text = renderMarkdownIteration(final, 2);
  expect(text).toContain("Answer recorded.");
  expect(text).not.toContain("Exact final answer");
  expect(text).not.toContain("Private provider reasoning");
});

test("orphan receipts are retained without inventing a matching authored request", () => {
  const saved = {
    ...step([]),
    toolCalls: [],
    toolResults: [{ toolCallId: "orphan", output: { message: "retained response" } }],
  };
  expect(renderMarkdownIteration(saved, 1)).toContain("Receipt without recorded call");
  expect(renderMarkdownIteration(saved, 1)).toContain("retained response");
});

test("a pending receipt and an empty reasoning-only iteration do not imply completion", () => {
  const actions = [{ type: "edit", python: "", changes: "delete old" }];
  const pending = receipt(actions, [undefined], ["pending"]);
  pending.status = "pending";
  const text = renderMarkdownIteration(step(actions, pending), 1);
  expect(text).toContain("edit: pending");
  expect(text).toContain("outcome unconfirmed");
  expect(text).not.toContain("operator old deleted");
  const reasoning = { ...step([]), toolCalls: [], content: "Review the current result.\n## This is reasoning" };
  expect(renderMarkdownIteration(reasoning, 2)).toContain("> Review the current result.\n> ## This is reasoning");
});

test("duplicate call ids are ambiguous and neither submitted source nor receipts disappear", () => {
  const actions = [{ type: "edit", python: "def f():\n    pass", changes: "" }];
  const saved = step(actions, receipt(actions, [{ registrations: [{ name: "f", kind: "registered" }] }]));
  saved.toolCalls!.push({
    toolName: "dataflow",
    toolCallId: "call",
    input: { reasoning: "Second.", actions: [{ type: "execute" }] },
  });
  const text = renderMarkdownIteration(saved, 1);
  expect(text).toContain("Ambiguous receipt");
  expect(text).toContain(actions[0].python);
  expect(text).toContain("Receipt without recorded call");
  expect(text).not.toContain("function f registered");
});

test("tool-level error flags and errors after completed actions remain visible", () => {
  const actions = [{ type: "edit", python: "", changes: "delete old" }];
  const output = receipt(actions, [{ changes: [{ change: "operator", operator_id: "old", action: "deleted" }] }]);
  output.status = "error";
  output.error = "Post-action recording failed.";
  const saved = step(actions, output);
  saved.toolResults![0].isError = true;
  const text = renderMarkdownIteration(saved, 1);
  expect(text).toContain("Tool call reported an error");
  expect(text).toContain("Post-action recording failed.");
  expect(text).toContain("operator old deleted");
});

test("malformed receipt errors cannot break context rendering", () => {
  const actions = [{ type: "execute" }];
  const output = { ...receipt(actions, [{ operators: [] }]), error: { unexpected: "non-string error" } };
  const text = renderMarkdownIteration(step(actions, output), 1);
  expect(text).toContain("non-string error");
  expect(text).toContain("Submitted call");
});

test("unknown action receipts preserve opaque results instead of rendering an empty success", () => {
  const actions = [{ type: "future_action", settings: { mode: "new" } }];
  const text = renderMarkdownIteration(
    step(actions, receipt(actions, [{ opaque_result: "must remain available" }])),
    1
  );
  expect(text).toContain("must remain available");
  expect(text).toContain("future_action");
});
