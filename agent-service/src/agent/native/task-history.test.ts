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
import { createNativeTools } from "../tools/native-batch-tools";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

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
  test("records a cache hit using its original producing execution", async () => {
    const retained: string[] = [];
    const history = new TaskHistory(async (_id, result) => {
      retained.push(result.materialization!.executionId!);
      return artifact("11");
    });
    await history.seal(
      3,
      [source],
      new Map([
        [
          "source",
          {
            ...info("11"),
            state: "CompletedFromCache",
            executionContext: { workflowId: 1, executionId: "22" },
            materialization: { executionId: "11", outputPort: 0, cached: true },
          },
        ],
      ])
    );
    expect(retained).toEqual(["11"]);
    expect(history.resolve({ operator: "source", atTask: 3 }).artifact.path).toBe("/tmp/archive/11.arrow");
  });
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

  test("at(name, task=N) is a saved-table reference; malformed forms and a session without history are refused", async () => {
    const state = new WorkflowState();
    const metadata = new WorkflowSystemMetadata();
    metadata.seedCodeModeDefaults();
    // No task history: the reference parses, then its statement is refused with the reason.
    const plain = createNativeTools(state, { metadataStore: metadata });
    const off = await plain.dataflow.execute({ program: 'old = project(at(source, task=1), keep=["x"])' });
    expect(off.operators[0].status).toBe("error");
    expect(off.operators[0].message).toContain("keeps no task history");
    // With history, only a table name and a positive integral task number are accepted.
    const history = new TaskHistory(async () => artifact("11"));
    await history.seal(1, [source], new Map([["source", info("11")]]));
    const tools = createNativeTools(state, { metadataStore: metadata, taskHistory: history });
    for (const bad of [
      "at(source)",
      "at(source, task=0)",
      "at(source, task=1.5)",
      'at("source", task=1)',
      "at(source, task=1, x=2)",
    ]) {
      const result = await tools.dataflow.execute({ program: `old = project(${bad}, keep=["x"])` });
      expect(result.operators[0].status).toBe("error");
      expect(result.operators[0].message).toContain("write at(name, task=N)");
    }
    // Both spellings of the task number are the same reference.
    for (const good of ["at(source, task=1)", "at(source, 1)"]) {
      const result = await tools.dataflow.execute({ program: `old = project(${good}, keep=["x"])` });
      expect(result.operators[0].status).not.toBe("error");
    }
  });

  test("historical edges terminate at stored data; editing today's producer cannot touch them", async () => {
    const state = new WorkflowState();
    const metadata = new WorkflowSystemMetadata();
    metadata.seedCodeModeDefaults();
    const history = new TaskHistory(async () => artifact("11"));
    await history.seal(1, [source], new Map([["source", info("11")]]));
    const tools = createNativeTools(state, { metadataStore: metadata, taskHistory: history });
    const result = await tools.dataflow.execute({
      program: [
        'source = scan("data/new.csv")',
        'original = project(at(source, task=1), keep=["x"])',
        'current = project(source, keep=["x"])',
      ].join("\n"),
    });
    expect(result.operators.map((x: any) => x.status)).toEqual(["added", "added", "added"]);
    expect(state.getDownstreamOperators("source")).toContain("current");
    expect(state.getDownstreamOperators("source")).not.toContain("original");
    expect(state.getOperator("original")!.nativeOp!.taskInputs).toEqual([{ operator: "source", atTask: 1 }]);
    // The retained source renders as the expression that reads it, never as its id.
    const served = state.getOperator(state.getOperator("original")!.nativeOp!.inputs[0])!;
    expect(served.taskSource).toEqual({ operator: "source", atTask: 1 });
    expect(served.nativeOp!.source).toBe("at(source, task=1)");
    // A task with no saved version: refused alone, nothing created.
    const missing = await tools.dataflow.execute({ program: 'bad = project(at(source, task=2), keep=["x"])' });
    expect(missing.operators[0].status).toBe("error");
    expect(missing.operators[0].message).toContain("unavailable");
    expect(state.getOperator("bad")).toBeUndefined();
    // The internal id is not a table name the model may write.
    const internal = await tools.dataflow.execute({
      program: `leak = project(${state.getOperator("original")!.nativeOp!.inputs[0]}, keep=["x"])`,
    });
    expect(internal.operators[0].status).toBe("error");
    expect(internal.operators[0].message).toContain("read a saved table with at(name, task=N)");
  });
});
