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
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { createAddOperatorTool, createModifyOperatorTool } from "./general-op-tools";

function setup() {
  const metadataStore = new WorkflowSystemMetadata();
  metadataStore.seedCodeModeDefaults(); // DataLoading (0 inputs), DataProcessing (1 input)
  const schemas = new Map<string, any>();
  for (const type of Object.keys(metadataStore.getAllOperatorTypes())) {
    schemas.set(type, {
      jsonSchema: metadataStore.getSchema(type),
      additionalMetadata: metadataStore.getAdditionalMetadata(type),
    });
  }
  const ws = new WorkflowState();
  const context = {
    metadataStore,
    settings: { maxOperatorResultCharLimit: 1000, toolTimeoutMs: 1000, executionTimeoutMs: 1000 },
  } as any;
  const add = createAddOperatorTool(ws, schemas, context) as any;
  const modify = createModifyOperatorTool(ws, context) as any;
  return { ws, add, modify };
}

const LOAD = 'def load() -> pd.DataFrame:\n    return pd.DataFrame({"k": [1]})\n';

describe("GENERAL mode: DataProcessing input ports follow the process() signature", () => {
  test("addOperator with a two-parameter process() gets two input ports and both links", async () => {
    const { ws, add } = setup();
    await add.execute({ operatorId: "op1", operatorType: "DataLoading", properties: { code: LOAD }, summary: "a" });
    await add.execute({ operatorId: "op2", operatorType: "DataLoading", properties: { code: LOAD }, summary: "b" });
    const out = await add.execute({
      operatorId: "op3",
      operatorType: "DataProcessing",
      properties: { code: "def process(a, b) -> pd.DataFrame:\n    return a.merge(b, on='k')\n" },
      inputOperatorIds: { "0": ["op1"], "1": ["op2"] },
      summary: "merge a and b",
    });
    expect(String(out)).not.toContain("[ERROR]");
    expect(ws.getOperator("op3")!.inputPorts.length).toBe(2);
    const links = ws.getLinksConnectedToOperator("op3").filter(l => l.target.operatorID === "op3");
    expect(links.map(l => `${l.source.operatorID}->${l.target.portID}`).sort()).toEqual([
      "op1->input-0",
      "op2->input-1",
    ]);
  });

  test("modifyOperator that widens process() to two parameters grows the ports before relinking", async () => {
    const { ws, add, modify } = setup();
    await add.execute({ operatorId: "op1", operatorType: "DataLoading", properties: { code: LOAD }, summary: "a" });
    await add.execute({ operatorId: "op2", operatorType: "DataLoading", properties: { code: LOAD }, summary: "b" });
    await add.execute({
      operatorId: "op3",
      operatorType: "DataProcessing",
      properties: { code: "def process(a) -> pd.DataFrame:\n    return a\n" },
      inputOperatorIds: { "0": ["op1"] },
      summary: "one input",
    });
    expect(ws.getOperator("op3")!.inputPorts.length).toBe(1);
    const out = await modify.execute({
      operatorId: "op3",
      properties: { code: "def process(a, b) -> pd.DataFrame:\n    return a.merge(b, on='k')\n" },
      inputOperatorIds: { "0": ["op1"], "1": ["op2"] },
      summary: "two inputs",
    });
    expect(String(out)).not.toContain("[ERROR]");
    expect(ws.getOperator("op3")!.inputPorts.length).toBe(2);
  });

  test("a process() without parameters is rejected with the CODE-mode message", async () => {
    const { add } = setup();
    const out = await add.execute({
      operatorId: "op9",
      operatorType: "DataProcessing",
      properties: { code: "def process() -> pd.DataFrame:\n    return pd.DataFrame()\n" },
      summary: "bad",
    });
    expect(String(out)).toContain("[ERROR]");
    expect(String(out)).toContain("at least one parameter");
  });
});
