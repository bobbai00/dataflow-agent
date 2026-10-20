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

import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { NATIVE_OPERATOR_NAMES } from "../native/catalog";
import {
  createStructuredDataflowTool,
  type JsonDataflowAction,
  type JsonDataflowActionsInput,
  prepareStructuredDataflowActions,
  structuredDataflowActionsSchema,
} from "./structured-dataflow-actions";

const read: JsonDataflowAction = { type: "read", ids: ["totals"], view: "full", columns: null };
const answer: JsonDataflowAction = { type: "answer", content: "The total is 12.", operator_ids: ["totals"] };
const input = (actions: unknown[]) => ({ reasoning: "Read the computed total.", actions });
const prepare = (actions: unknown[], options = {}) => prepareStructuredDataflowActions(input(actions), options);

describe("typed dataflow action contract", () => {
  test("read and content answer can share one ordered batch", () => {
    const receipt = prepare([read, answer]);
    expect(receipt.protocol).toBe("json");
    expect(receipt.status).toBe("pending");
    expect(receipt.actions.map(a => [a.index, a.action.type, a.status])).toEqual([
      [1, "read", "pending"],
      [2, "answer", "pending"],
    ]);
    expect(receipt.operators).toEqual([]);
  });

  test("preparation retains Python bytes and clones input instead of mutating it", () => {
    const code = "import re\n\ndef calculate(df):\n    return df\n";
    const request = input([
      {
        type: "set",
        id: "totals",
        operator: "process",
        inputs: ["sales"],
        params: { code, entry: "calculate", doc: "Return sales." },
      },
    ]);
    const receipt = prepareStructuredDataflowActions(request);
    expect(receipt.status).toBe("pending");
    expect((receipt.actions[0].action as any).params.code).toBe(code);
    (receipt.actions[0].action as any).params.code = "changed";
    expect((request.actions[0] as any).params.code).toBe(code);
  });

  test("every catalog operator has its own typed set branch", () => {
    const schema = structuredDataflowActionsSchema();
    const branches = schema.properties.actions.items.anyOf;
    expect(
      branches
        .filter((a: any) => a.properties.type.const === "set")
        .map((a: any) => a.properties.operator.const)
        .sort()
    ).toEqual([...NATIVE_OPERATOR_NAMES].sort());
  });

  test("all nested objects are closed with all properties required", () => {
    const visit = (schema: any) => {
      expect(schema.oneOf).toBeUndefined();
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      }
      for (const value of Object.values(schema.properties ?? {})) visit(value);
      for (const value of schema.anyOf ?? []) visit(value);
      if (schema.items) visit(schema.items);
    };
    visit(structuredDataflowActionsSchema({ stateHistory: true, references: true }));
  });

  test.each([
    { type: "edit", changes: "totals = scan('a.csv')" },
    { type: "execute" },
    { type: "retrieve", operator_id: "totals", view: "full" },
    { type: "answer", from: "totals[value:3]" },
    { type: "scan", path: "a.csv" },
  ])("expression action is rejected without mutation: %j", action => {
    const request = input([action]);
    const before = JSON.stringify(request);
    const result = prepareStructuredDataflowActions(request);
    expect(result.status).toBe("error");
    expect(result.actions).toEqual([]);
    expect(JSON.stringify(request)).toBe(before);
    expect(result.error).toContain("No actions ran");
  });

  test("JSON strings, absent required nullable fields and extra fields are rejected", () => {
    for (const request of [
      { reasoning: "Read.", actions: JSON.stringify([read]) },
      input([{ type: "read", ids: ["totals"], view: "full" }]),
      input([{ ...read, expression: "totals[value]" }]),
      input([{ type: "answer", content: "12" }]),
    ])
      expect(prepareStructuredDataflowActions(request).status).toBe("error");
  });

  test("unknown or unavailable views never prepare pending actions", () => {
    expect(prepare([{ ...read, view: "stats" }]).status).toBe("error");
    expect(prepare([read], { views: ["sample_stats"] }).status).toBe("error");
    expect(prepare([{ ...read, view: "sample_stats" }], { views: ["sample_stats"] }).status).toBe("pending");
    const schema = structuredDataflowActionsSchema({ views: ["sample"] });
    expect(
      schema.properties.actions.items.anyOf
        .filter((a: any) => a.properties.type.const === "read")
        .map((a: any) => a.properties.view.enum)
    ).toEqual([["sample"]]);
  });

  test("source answers contain typed shape and explicit nullable options", () => {
    for (const shape of ["scalar", "list", "records"] as const) {
      const source = { id: "totals", column: shape === "list" ? "value" : null, shape, decimals: null };
      expect(prepare([{ type: "answer", source }]).status).toBe("pending");
    }
    expect(
      prepare([{ type: "answer", source: { id: "totals", column: null, shape: "list", decimals: null } }]).status
    ).toBe("error");
    expect(
      prepare([{ type: "answer", source: { id: "totals", column: null, shape: "unknown", decimals: null } }]).status
    ).toBe("error");
    expect(
      prepare([{ type: "answer", source: { id: "totals", column: null, shape: "records", decimals: 2.5 } }]).status
    ).toBe("error");
    expect(
      prepare([{ type: "answer", source: { id: "totals", column: null, shape: "scalar", decimals: 3 } }]).status
    ).toBe("pending");
  });

  test("source shapes share one closed schema with the list column rule described", () => {
    const branch = structuredDataflowActionsSchema().properties.actions.items.anyOf.find(
      (a: any) => a.properties.type.const === "answer" && "source" in a.properties
    );
    const source = branch.properties.source;
    expect(source.anyOf).toBeUndefined();
    expect(source.type).toBe("object");
    expect(source.additionalProperties).toBe(false);
    expect(source.required).toEqual(["id", "column", "shape", "decimals"]);
    expect(source.properties.shape.enum).toEqual(["scalar", "list", "records"]);
    expect(source.properties.column.anyOf.map((a: any) => a.type)).toEqual(["string", "null"]);
    expect(source.properties.column.description).toContain("list requires a non-null column");
    const rejected = prepare([
      { type: "answer", source: { id: "totals", column: null, shape: "list", decimals: null } },
    ]);
    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("a list source answer requires column");
    expect(rejected.actions).toEqual([]);
  });

  test("the single-task schema fits the observed union budget with both counting definitions", () => {
    const count = (schema: any): { total: number; propertyFields: number } => {
      if (!schema || typeof schema !== "object") return { total: 0, propertyFields: 0 };
      const nested = Object.values(schema).map(count);
      return {
        total:
          Number(Boolean(schema.anyOf || Array.isArray(schema.type))) +
          nested.reduce((sum, value) => sum + value.total, 0),
        propertyFields:
          Object.values(schema.properties ?? {}).filter((value: any) => value.anyOf || Array.isArray(value.type))
            .length + nested.reduce((sum, value) => sum + value.propertyFields, 0),
      };
    };
    const singleTask = count(structuredDataflowActionsSchema({ references: true }));
    expect(singleTask).toEqual({ total: 14, propertyFields: 10 });
    expect(singleTask.total).toBeLessThanOrEqual(16);
    expect(singleTask.propertyFields).toBeLessThanOrEqual(16);
    // The provider's exact counting algorithm is unknown. Optional history
    // does not inherit a compilation guarantee from this single-task budget.
    expect(count(structuredDataflowActionsSchema({ stateHistory: true, references: true }))).toEqual({
      total: 20,
      propertyFields: 15,
    });
  });

  test("flattened source schema preserves every valid shape payload and nullable selections", () => {
    for (const shape of ["scalar", "list", "records"] as const) {
      for (const column of shape === "list" ? ["value"] : [null, "value"]) {
        const action: JsonDataflowAction = { type: "answer", source: { id: "totals", column, shape, decimals: 0 } };
        const receipt = prepare([action]);
        expect(receipt.status).toBe("pending");
        expect(receipt.actions[0].action).toEqual(action);
      }
    }
    expect(prepare([{ ...read, columns: null }]).actions[0].action).toEqual(read);
    expect(prepare([{ ...answer, operator_ids: null }]).actions[0].action).toEqual({
      ...answer,
      operator_ids: null,
    });
  });

  test("one answer must be final, while 32 non-answer actions are allowed per call", () => {
    expect(prepare([answer, read]).status).toBe("error");
    expect(prepare([answer, answer]).status).toBe("error");
    expect(prepare(Array.from({ length: 32 }, () => read)).status).toBe("pending");
    expect(prepare(Array.from({ length: 33 }, () => read)).status).toBe("error");
  });

  test("selection duplicates are rejected and repeated separate actions remain ordered", () => {
    expect(prepare([{ ...read, ids: ["totals", "totals"] }]).status).toBe("error");
    expect(prepare([{ type: "delete", ids: ["x", "x"] }]).status).toBe("error");
    expect(prepare([{ ...answer, operator_ids: ["totals", "totals"] }]).status).toBe("error");
    expect(prepare([{ ...read, columns: ["value", "value"] }]).status).toBe("error");
    expect(prepare([read, read]).actions.map(a => a.index)).toEqual([1, 2]);
  });

  test("history and documentation actions are available only when configured", () => {
    const fork = { type: "fork", task_id: 1, operator_id: "old", new_operator_id: "copy" };
    const reference = { type: "inspect", target: "reference", topic: "operators", operator_names: ["scan"] };
    expect(prepare([fork]).status).toBe("error");
    expect(prepare([fork], { stateHistory: true }).status).toBe("pending");
    expect(prepare([reference]).status).toBe("error");
    expect(prepare([reference], { references: true }).status).toBe("pending");
    expect(prepare([{ type: "inspect", target: "graph" }], { multiTask: true }).status).toBe("error");
    expect(prepare([{ type: "inspect", target: "graph", operator_ids: ["x"] }], { multiTask: true }).status).toBe(
      "pending"
    );
  });

  test("history result views use session enums and version listing requires null view", () => {
    const state = {
      type: "inspect",
      target: "state",
      task_id: null,
      operator_id: ["x"],
      include_implementation: false,
      view: null,
    };
    expect(prepare([state], { stateHistory: true }).status).toBe("pending");
    expect(prepare([{ ...state, view: "full" }], { stateHistory: true }).status).toBe("error");
    expect(prepare([{ ...state, task_id: 1, view: "full" }], { stateHistory: true, views: ["sample"] }).status).toBe(
      "error"
    );
  });

  test("tool declaration and execution use the same session schema", async () => {
    const tool = createStructuredDataflowTool({ views: ["sample"], references: true });
    expect(tool.strict).toBe(false);
    expect(tool.description).toContain("Local validation enforces the complete typed contract");
    expect(asSchema(tool.inputSchema).jsonSchema).toEqual(
      structuredDataflowActionsSchema({ views: ["sample"], references: true })
    );
    const accepted = await tool.execute!(
      input([
        { ...read, view: "sample" },
        { ...answer, operator_ids: null },
      ]) as JsonDataflowActionsInput,
      { toolCallId: "one", messages: [] }
    );
    expect(accepted).toMatchObject({ status: "pending" });
    const rejected = await tool.execute!(input([read]) as JsonDataflowActionsInput, {
      toolCallId: "two",
      messages: [],
    });
    expect(rejected).toMatchObject({ status: "error" });
  });
});
