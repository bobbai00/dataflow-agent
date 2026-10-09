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
import { asSchema } from "ai";
import { WorkflowState } from "../workflow-state";
import {
  createRegisteredDataflowTool,
  prepareRegisteredDataflowActions,
  renderDataflowActionsResult,
  runDataflowActions,
} from "./dataflow-actions";

const request = (actions: unknown[]) => prepareRegisteredDataflowActions({ reasoning: "Check the contract.", actions });

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
  test("supports definition-only edits, batched reads and namespace inspection", () => {
    const result = request([
      { type: "edit", python: "def source():\n    return pd.DataFrame({'value': [1]})", changes: "" },
      { type: "inspect", target: "namespace" },
      { type: "inspect", target: "namespace", names: ["source"], include_implementation: true },
      { type: "retrieve", operator_ids: ["a", "b"], view: "full" },
    ]);
    expect(result.status).toBe("pending");
    expect(result.protocol).toBe("registered-python-v1");
  });

  test("rejects old write/read/answer envelopes and empty or duplicate selections before any action", () => {
    for (const action of [
      { type: "edit", changes: "x = scan('x.csv')" },
      { type: "edit", python: " ", changes: "\n" },
      { type: "retrieve", operator_id: "x", view: "full" },
      { type: "retrieve", operator_ids: [], view: "full" },
      { type: "retrieve", operator_ids: ["x", "x"], view: "full" },
      { type: "inspect", target: "namespace", names: ["f", "f"], include_implementation: true },
      { type: "answer", from: "x" },
    ]) {
      const result = request([action]);
      expect(result.status).toBe("error");
      expect(result.actions).toEqual([]);
    }
    expect(
      request([
        { type: "inspect", target: "graph" },
        { type: "answer", content: "done" },
      ]).status
    ).toBe("error");
  });

  test("stringified actions are rejected with an array example, without decoding or running them", () => {
    for (const actions of ['[{"type":"execute"}]', '[{"type":"execute"}]}']) {
      const result = prepareRegisteredDataflowActions({ reasoning: "Inspect.", actions });
      expect(result.status).toBe("error");
      expect(result.actions).toEqual([]);
      expect(result.error).toContain("actions must be a JSON array, not a string");
      expect(result.error).toContain('"actions":[{"type":"inspect","target":"graph"}]');
      expect(result.error).toContain("No actions ran.");
    }
  });

  test("the provider sees only the registered contract and reference remains available", async () => {
    const schema = (await asSchema(createRegisteredDataflowTool(["full"]).inputSchema).jsonSchema) as any;
    const actions = schema.properties.actions.items.anyOf;
    expect(actions.some((a: any) => a.properties.target?.const === "namespace")).toBe(true);
    expect(actions.some((a: any) => a.properties.target?.const === "reference")).toBe(true);
    expect(
      actions.filter((a: any) => a.properties.type.const === "edit").every((a: any) => a.required.includes("python"))
    ).toBe(true);
    expect(
      actions
        .filter((a: any) => a.properties.type.const === "retrieve")
        .every((a: any) => a.required.includes("operator_ids"))
    ).toBe(true);
    expect(actions.some((a: any) => "from" in a.properties)).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('"process"');
  });

  test("Markdown acknowledges committed functions and preserves successful members of partial retrieval", async () => {
    const result = request([
      { type: "edit", python: "def f(table):\n    return table", changes: "" },
      { type: "retrieve", operator_ids: ["a", "missing", "b"], view: "full" },
    ]);
    await runDataflowActions(result, async action =>
      action.type === "edit"
        ? { status: "ok", output: { registrations: [{ name: "f", kind: "registered" }], changes: [] } }
        : {
            status: "error",
            output: {
              results: [
                {
                  operator_id: "a",
                  status: "ok",
                  text: "first table",
                  operator_blocks: [{ id: "a", kind: "f", state: "executed" }],
                },
                { operator_id: "missing", status: "error", error: "UNKNOWN_OPERATOR: missing" },
                {
                  operator_id: "b",
                  status: "ok",
                  text: "second table",
                  operator_blocks: [{ id: "b", kind: "f", state: "executed" }],
                },
              ],
            },
          }
    );
    const text = renderDataflowActionsResult(result);
    expect(text).toContain("function f registered");
    expect(text).toContain("retrieve a, missing, b: error");
    expect(text).toContain("first table");
    expect(text).toContain("UNKNOWN_OPERATOR");
    expect(text).toContain("second table");
    expect(text.indexOf("first table")).toBeLessThan(text.indexOf("second table"));
  });
});
