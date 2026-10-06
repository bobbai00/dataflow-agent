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
import { asSchema } from "ai";
import { createDataflowTool, type DataflowActionsResult } from "./dataflow-actions";

test("saved-version tools expose read with definitions-only access and no history-copy actions", async () => {
  const tool = createDataflowTool(["full", "sample"], true, true);
  const schema = asSchema(tool.inputSchema).jsonSchema as any;
  const variants = schema.properties.actions.items.anyOf;
  expect(variants.some((a: any) => a.properties.type.const === "read")).toBe(true);
  expect(variants.some((a: any) => a.properties.type.const === "retrieve")).toBe(false);
  expect(variants.some((a: any) => a.properties.target?.const === "state")).toBe(false);
  const result = await tool.execute!({ reasoning: "Inspect the saved rule.", actions: [
    { type: "read", operator_ids: ["scores@2"], view: null, include_implementation: true, columns: null },
  ] } as any, {} as any) as DataflowActionsResult;
  expect(result.status).toBe("pending");
});

test("multi-task answers declare roots, including an explicitly empty declaration", async () => {
  const tool = createDataflowTool(["full"], true, true);
  for (const operator_ids of [[], ["scores@2"]]) {
    const result = await tool.execute!({ reasoning: "Answer from checked evidence.", actions: [
      { type: "answer", content: "Answer", operator_ids },
    ] } as any, {} as any) as DataflowActionsResult;
    expect(result.status).toBe("pending");
  }
  const missing = await tool.execute!({ reasoning: "Answer.", actions: [{ type: "answer", content: "Answer" }] } as any, {} as any) as DataflowActionsResult;
  expect(missing.status).toBe("error");
  expect(missing.error).toContain("operator_ids");
});
