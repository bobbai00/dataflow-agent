/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { WorkflowState } from "../workflow-state";
import {
  EMPTY_DATAFLOW_ERROR,
  prepareActions,
  rejectedActions,
  renderDataflowActionsResult,
  runDataflowActions,
  type DataflowAction,
} from "./dataflow-actions";
import { prepareDataflowCall } from "./turn-tool";

const VIEWS = ["sample_stats", "full"] as const;
const request = (actions: DataflowAction[]) => prepareActions(actions, VIEWS);

describe("registered Python action contract", () => {
  test("a namespace survives a workflow round trip even without graph nodes", () => {
    const state = new WorkflowState();
    const namespace = { cells: ["LIMIT = 5"], functions: {}, bindings: {}, revision: "ns-1" };
    state.setWorkflowContent({ ...state.getWorkflowContent(), nativeNamespace: namespace } as any);
    const snapshot = structuredClone(state.getWorkflowContent());
    expect(snapshot.nativeNamespace).toEqual(namespace);
    const restored = new WorkflowState();
    restored.setWorkflowContent(snapshot);
    expect(restored.getWorkflowContent().nativeNamespace).toEqual(namespace);
    expect(restored.getWorkflowContent().operators).toEqual([]);
  });

  test("definition-only edits, batched reads and namespace inspection are accepted as one pending list", () => {
    const result = request([
      { type: "edit", python: "def source():\n    return pd.DataFrame({'value': [1]})", changes: "" },
      { type: "inspect", target: "namespace", names: ["source"], include_implementation: true },
      { type: "retrieve", operator_ids: ["a", "b"], view: "full" },
    ]);
    expect(result.status).toBe("pending");
    expect(result.protocol).toBe("registered-python-v1");
    expect(result.actions.map(item => [item.index, item.status])).toEqual([
      [1, "pending"],
      [2, "pending"],
      [3, "pending"],
    ]);
  });

  test("empty edits, duplicate selections and disabled views are refused before any action", () => {
    for (const [actions, message] of [
      [[{ type: "edit", python: " ", changes: "\n" }], "An edit needs definitions or statements."],
      [[{ type: "retrieve", operator_ids: ["x", "x"], view: "full" }], "Selected names must be unique."],
      [[{ type: "execute", operator_ids: ["x", "x"] }], "Selected names must be unique."],
      [
        [{ type: "inspect", target: "namespace", names: ["f", "f"], include_implementation: true }],
        "Selected names must be unique.",
      ],
      [
        [{ type: "inspect", target: "reference", topic: "operators", operator_names: ["scan", "scan"] }],
        "Selected names must be unique.",
      ],
      [[{ type: "retrieve", operator_ids: ["x"], view: "sample" }], 'The view "sample" is unavailable'],
    ] as Array<[DataflowAction[], string]>) {
      const result = request(actions);
      expect(result.status).toBe("error");
      expect(result.actions).toEqual([]);
      expect(result.error).toContain(message);
      expect(result.error).toEndWith("No actions ran.");
    }
  });

  test("a rejected call renders why nothing ran, after any ignored-prose note", () => {
    const text = renderDataflowActionsResult(
      rejectedActions(EMPTY_DATAFLOW_ERROR, { statements: [], ignoredProse: [2, 4] })
    );
    expect(text).toBe(
      `note: lines 2, 4 of statements are not statements and were ignored.\n## call rejected\n${EMPTY_DATAFLOW_ERROR}`
    );
  });

  test("a partial result request keeps every successful member, in order, around a failed one", async () => {
    const result = prepareDataflowCall(
      { python: "def f(table):\n    return table", statements: "show result a, missing, b full" },
      VIEWS
    );
    expect(result.actions.map(item => item.action.type)).toEqual(["edit", "execute", "retrieve"]);
    await runDataflowActions(result, async action =>
      action.type === "edit"
        ? { status: "ok", output: { registrations: [{ name: "f", kind: "registered" }], changes: [] } }
        : action.type === "execute"
          ? { status: "ok", output: { operators: [] } }
          : {
              status: "error",
              output: {
                results: [
                  {
                    operator_id: "a",
                    status: "ok",
                    text: "first table",
                    operator_blocks: [{ id: "a", kind: "f", state: "executed", result: "1 row" }],
                  },
                  { operator_id: "missing", status: "error", error: "UNKNOWN_OPERATOR: missing" },
                  {
                    operator_id: "b",
                    status: "ok",
                    text: "second table",
                    operator_blocks: [{ id: "b", kind: "f", state: "executed", result: "1 row" }],
                  },
                ],
              },
            }
    );
    expect(result.status).toBe("error");
    const text = renderDataflowActionsResult(result);
    expect(text).toContain("## edits applied\nfunctions: f registered");
    expect(text).toContain("## show result a, missing, b full");
    expect(text).toContain("result a (f): 1 row\nfirst table");
    expect(text).toContain("result missing: unavailable\n- error UNKNOWN_OPERATOR: missing");
    expect(text).toContain("result b (f): 1 row\nsecond table");
    expect(text.indexOf("first table")).toBeLessThan(text.indexOf("second table"));
  });

  test("after a failed execution later reads still run, but nothing runs after a failed edit", async () => {
    const afterExecution = request([
      { type: "execute", operator_ids: ["a"] },
      { type: "retrieve", operator_ids: ["a"], view: "full" },
    ]);
    await runDataflowActions(afterExecution, async action =>
      action.type === "execute" ? { status: "error", output: "engine failed" } : { status: "ok", output: {} }
    );
    expect(afterExecution.actions.map(item => item.status)).toEqual(["error", "ok"]);
    expect(afterExecution.error).toBe("Action 1 (execute) failed: engine failed");
    const afterEdit = request([
      { type: "edit", python: "", changes: "set a: scan(files='a.csv')" },
      { type: "execute", operator_ids: ["a"] },
    ]);
    await runDataflowActions(afterEdit, async () => {
      throw new Error("rejected");
    });
    expect(afterEdit.actions.map(item => item.status)).toEqual(["error", "skipped"]);
    expect(afterEdit.actions[1].output).toBe("Not run because an earlier action failed.");
  });
});
