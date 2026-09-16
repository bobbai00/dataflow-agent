/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { describe, expect, test } from "bun:test";
import { TaskHistory, type RetainedResult } from "./task-history";
import { createNativeBatchTools, nativeBatchSchema } from "../tools/native-batch-tools";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import Ajv from "ajv";

const info = (id: string) =>
  ({
    state: "Completed",
    inputTuples: 0,
    outputTuples: 1000,
    resultMode: "table",
    result: [{ x: 1 }],
    totalRowCount: 1000,
    displayedRows: 1,
    truncated: true,
    materialization: { outputPort: 0, executionId: id, cached: false },
    resultVersion: { id: `r${id}` },
  }) as any;
const artifact = (execution: string): RetainedResult => ({
  path: `/tmp/archive/${execution}.arrow`,
  sha256: "a".repeat(64),
  rowCount: 1000,
});
const source = {
  operatorID: "source",
  nativeOp: { type: "Scan", properties: { files: "data/a.csv" }, inputs: [], version: "v2" },
} as any;

describe("task history", () => {
  test("freezes complete materializations, reuses unchanged data, and never falls forward", async () => {
    const calls: string[] = [];
    const history = new TaskHistory(async (_id, result) => {
      calls.push(result.materialization!.executionId!);
      return artifact(result.materialization!.executionId!);
    });
    await history.seal(1, [source], new Map([["source", info("11")]]));
    await history.seal(2, [source], new Map([["source", info("11")]]));
    await history.seal(3, [source], new Map([["source", info("12")]]));
    expect(calls).toEqual(["11", "12"]);
    expect(history.resolve({ operator: "source", atTask: 1 }).artifact.path).toBe("/tmp/archive/11.arrow");
    expect(history.resolve({ operator: "source", atTask: 3 }).artifact.path).toBe("/tmp/archive/12.arrow");
    expect(() => history.resolve({ operator: "source", atTask: 4 })).toThrow("unavailable");
    expect(() => history.resolve({ operator: "missing", atTask: 1 })).toThrow("unavailable");
    await expect(history.seal(1, [source], new Map([["source", info("12")]]))).rejects.toThrow("sealed");
  });

  test("failed outputs and failed retention never masquerade as historical success", async () => {
    const history = new TaskHistory(async () => {
      throw new Error("disk full");
    });
    const errors = await history.seal(1, [source], new Map([["source", info("1")]]));
    expect(errors.join()).toContain("disk full");
    expect(() => history.resolve({ operator: "source", atTask: 1 })).toThrow("unavailable");
    const failed = new TaskHistory(async () => artifact("bad"));
    await failed.seal(1, [source], new Map([["source", { ...info("1"), error: "failed" }]]));
    expect(() => failed.resolve({ operator: "source", atTask: 1 })).toThrow("unavailable");
  });

  test("task input schema is opt-in and accepts only positive integral task numbers", () => {
    const plain = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
    const enabled = new Ajv({ strict: false }).compile(nativeBatchSchema("v2", { taskHistory: true }));
    const batch = (atTask: unknown) => ({
      operators: [{ op: "project", id: "old", input: { operator: "source", atTask }, keep: ["x"] }],
    });
    expect(plain(batch(1))).toBe(false);
    expect(enabled(batch(1))).toBe(true);
    for (const x of [0, -1, 1.5, "1"]) expect(enabled(batch(x))).toBe(false);
  });

  test("historical edges terminate at stored data; editing today's producer cannot touch them", async () => {
    const state = new WorkflowState();
    const metadata = new WorkflowSystemMetadata();
    metadata.seedCodeModeDefaults();
    const history = new TaskHistory(async () => artifact("11"));
    await history.seal(1, [source], new Map([["source", info("11")]]));
    const tools = createNativeBatchTools(state, { metadataStore: metadata, taskHistory: history }, "v2");
    const result = await tools.dataflow.execute({
      operators: [
        { op: "scan", id: "source", files: "data/new.csv" },
        { op: "project", id: "original", input: { operator: "source", atTask: 1 }, keep: ["x"] },
        { op: "project", id: "current", input: "source", keep: ["x"] },
      ],
    });
    expect(result.operators.map((x: any) => x.status)).toEqual(["added", "added", "added"]);
    expect(state.getDownstreamOperators("source")).toContain("current");
    expect(state.getDownstreamOperators("source")).not.toContain("original");
    expect(state.getOperator("original")!.nativeOp!.taskInputs).toEqual([{ operator: "source", atTask: 1 }]);
    const missing = await tools.dataflow.execute({
      operators: [{ op: "project", id: "bad", input: { operator: "source", atTask: 2 }, keep: ["x"] }],
    });
    expect(missing.operators[0].status).toBe("error");
    expect(state.getOperator("bad")).toBeUndefined();
  });
});
