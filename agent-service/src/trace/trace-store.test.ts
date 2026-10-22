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
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import type { SnapshotData } from "../agent/workflow-snapshot-storage";
import type { ReActStep } from "../types/agent";
import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";
import { TraceStore, defaultTracePath, openTraceStore } from "./trace-store";

const step = (overrides: Partial<ReActStep> & Pick<ReActStep, "id" | "messageId">): ReActStep => ({
  stepId: 0,
  timestamp: 1000,
  role: "user",
  content: "hi",
  isBegin: true,
  isEnd: true,
  ...overrides,
});

const agent = (store: TraceStore, id = "a1") =>
  store.agentCreated({
    id,
    name: "Bob",
    model: "m",
    driver: "vercel-tool-use",
    workflowId: 7,
    user: { uid: 1, name: "texera" },
    settings: { maxSteps: 3 },
    createdAt: 1,
  });

const rowsOf = (store: TraceStore, table: string): number =>
  ((store as any).db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("TraceStore", () => {
  test("records a turn's message, steps and model request as they happen, and exports them in order", () => {
    const store = new TraceStore(":memory:");
    agent(store);
    store.turnStarted({
      agentId: "a1",
      messageId: "msg-1",
      channel: "message",
      source: "chat",
      text: "How many rows?",
      startedAt: 1000,
    });
    store.step("a1", step({ id: "s1", messageId: "msg-1" }));
    const agentStep = step({
      id: "s2",
      messageId: "msg-1",
      parentId: "s1",
      stepId: 1,
      role: "agent",
      content: "",
      isEnd: false,
      timestamp: 1500,
      toolCalls: [{ toolName: "dataflow", toolCallId: "c1", input: { statements: "execute" } }],
      usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240 },
      inputMessages: [{ role: "user", content: "x".repeat(100) }],
      timing: { preparedAt: 1000, requestedAt: 1100, compileMs: 60, contextMs: 40, modelMs: 400 },
    });
    store.step("a1", agentStep);
    store.llmCall({
      agentId: "a1",
      messageId: "msg-1",
      stepId: "s2",
      model: "m",
      startedAt: 1100,
      endedAt: 1500,
      inputMessages: 1,
      inputChars: 100,
      outputChars: 30,
      usage: agentStep.usage,
    });
    // The step changes twice more: its actions ran, then it ends the turn.
    store.step("a1", { ...agentStep, timing: { ...agentStep.timing, postStepMs: 250 } });
    store.step("a1", { ...agentStep, isEnd: true, timing: { ...agentStep.timing, postStepMs: 250 } });
    store.turnEnded({ agentId: "a1", messageId: "msg-1", endedAt: 1800, status: "ok", reply: "3 rows" });

    const trace = store.exportAgent("a1")!;
    expect(trace.agent).toMatchObject({
      id: "a1",
      model: "m",
      workflow_id: 7,
      user_name: "texera",
      settings: { maxSteps: 3 },
    });
    expect(trace.turns).toEqual([
      expect.objectContaining({
        message_id: "msg-1",
        channel: "message",
        started_at: 1000,
        ended_at: 1800,
        status: "ok",
        reply: "3 rows",
      }),
    ]);
    const steps = trace.steps as any[];
    expect(steps.map(s => [s.id, s.role, s.is_end])).toEqual([
      ["s1", "user", 1],
      ["s2", "agent", 1],
    ]);
    // A step is one row however often it is recorded, and the model's input is kept by size only.
    expect(steps[1]).toMatchObject({
      input_tokens: 1200,
      input_messages: 1,
      input_chars: 100,
      compile_ms: 60,
      model_ms: 400,
      post_step_ms: 250,
      tool_calls: 1,
    });
    expect(steps[1].step.inputMessages).toBeUndefined();
    expect(steps[1].step.toolCalls[0].input).toEqual({ statements: "execute" });
    expect(trace.llm_calls).toEqual([
      expect.objectContaining({
        step_id: "s2",
        started_at: 1100,
        ended_at: 1500,
        input_chars: 100,
        input_tokens: 1200,
      }),
    ]);
    expect(store.listAgents()).toEqual([expect.objectContaining({ id: "a1", turns: 1, steps: 2, last_step_at: 1500 })]);
    expect(store.stepsOf("a1").map(s => s.id)).toEqual(["s1", "s2"]);
    expect(store.exportAgent("nobody")).toBeUndefined();
    store.close();
  });

  test("a turn answering a recorded action keeps the action's start", () => {
    const store = new TraceStore(":memory:");
    agent(store);
    store.turnStarted({
      agentId: "a1",
      messageId: "act-1",
      channel: "action",
      source: "action",
      text: "You ran x",
      startedAt: 10,
    });
    store.turnEnded({ agentId: "a1", messageId: "act-1", endedAt: 20, status: "ok" });
    store.turnStarted({
      agentId: "a1",
      messageId: "act-1",
      channel: "action",
      source: "action",
      text: "You ran x",
      startedAt: 30,
    });
    store.turnEnded({ agentId: "a1", messageId: "act-1", endedAt: 90, status: "ok", reply: "x has 3 rows." });
    expect(store.exportAgent("a1")!.turns).toEqual([
      expect.objectContaining({ message_id: "act-1", started_at: 10, ended_at: 90, reply: "x has 3 rows." }),
    ]);
    store.close();
  });

  test("stores each operator once across snapshots, and gives every step's dataflow back as its newest version", () => {
    const store = new TraceStore(":memory:");
    agent(store);
    const op = (id: string, code: string) =>
      ({ operatorID: id, operatorType: "PythonUDFV2", operatorProperties: { code } }) as any;
    const scan = op("scan", "x".repeat(10_000)); // one object, shared as frozen snapshot operators are
    const workflow = (operators: any[]): WorkflowContent => ({
      operators,
      operatorPositions: { scan: { x: 1, y: 2 } },
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    });
    const snapshot = (id: string, stepId: string, operators: any[], version: number): SnapshotData => ({
      id,
      parentId: "root",
      reactStepId: stepId,
      workflow: workflow(operators),
      results: new Map(),
      createdAt: version,
      version,
      action: { kind: "add", author: "agent", operatorId: operators.at(-1).operatorID },
    });
    store.snapshot("a1", snapshot("v1", "s1", [scan], 1));
    store.snapshot("a1", snapshot("v2", "s2", [scan, op("filter", "y")], 2));
    store.snapshot("a1", snapshot("v3", "s2", [scan, op("filter", "z")], 3));
    store.snapshot("a1", snapshot("v3", "s2", [scan, op("filter", "z")], 3)); // recorded again: still one row

    expect(rowsOf(store, "snapshots")).toBe(3);
    expect(rowsOf(store, "blobs")).toBe(3); // scan once, two filters
    const exported = store.exportAgent("a1")!.snapshots as any[];
    expect(exported.map(s => [s.id, s.step_id, s.version, s.kind, s.operator_id, s.operators])).toEqual([
      ["v1", "s1", 1, "add", "scan", 1],
      ["v2", "s2", 2, "add", "filter", 2],
      ["v3", "s2", 3, "add", "filter", 2],
    ]);
    const workflows = store.snapshotWorkflows("a1");
    expect(Object.keys(workflows).sort()).toEqual(["s1", "s2"]);
    expect(workflows.s2.operators.map(o => o.operatorID)).toEqual(["scan", "filter"]);
    expect((workflows.s2.operators[1] as any).operatorProperties.code).toBe("z");
    expect(workflows.s1.operatorPositions).toEqual({ scan: { x: 1, y: 2 } });
    store.close();
  });

  test("records results with a bounded sample, executions with their timings, events and the agent's end", () => {
    const store = new TraceStore(":memory:");
    agent(store);
    const info = {
      operatorId: "scan",
      state: "CompletedFromCache",
      inputTuples: 0,
      outputTuples: 3,
      totalRowCount: 3,
      result: Array.from({ length: 7 }, (_, i) => ({ a: i === 0 ? "x".repeat(300) : i })),
      resultSchema: [{ name: "a", type: "string", encoding: "utf8" }],
      executionContext: { workflowId: 1, executionId: "e1" },
    } as unknown as OperatorInfo;
    store.operatorResult({ agentId: "a1", snapshotId: "v1", stepId: "s1", operatorId: "scan", info, at: 5 });
    store.execution({
      agentId: "a1",
      messageId: "msg-1",
      stepId: "s1",
      run: {
        targets: ["scan"],
        executionId: "e1",
        success: true,
        state: "Completed",
        startedAt: 10,
        endedAt: 60,
        phaseMetrics: { version: 1, compilation: "passed", compilationDurationMs: 12, runtimeStartAttempted: true },
        clientTiming: { requestToHeadersMs: 40, responseBodyDecodeMs: 5, resultPreparationMs: 1, snapshotStoreMs: 2 },
      },
    });
    store.event({ agentId: "a1", kind: "stop", at: 70, detail: { by: "user" } });
    store.agentSettings("a1", { maxSteps: 5 }, { maxSteps: 5 });
    store.agentEnded("a1", "deleted", 99);

    // The same operator again, for the same step: the newest result is the one a restore takes.
    store.operatorResult({
      agentId: "a1",
      snapshotId: "v2",
      stepId: "s1",
      operatorId: "scan",
      info: { ...info, totalRowCount: 4 },
      at: 6,
    });

    const trace = store.exportAgent("a1")!;
    const [result, newer] = trace.operator_results as any[];
    expect(result).toMatchObject({
      operator_id: "scan",
      rows: 3,
      cached: 1,
      execution_id: "e1",
      schema: info.resultSchema,
    });
    expect(result.sample).toHaveLength(5);
    expect(result.sample[0].a).toEndWith("…");
    expect(result.sample[0].a).toHaveLength(201);
    expect(result.info.result).toHaveLength(7); // the whole result travels with the row
    expect(newer.rows).toBe(4);
    expect(store.operatorResultsOf("a1")).toEqual([
      { stepId: "s1", operatorId: "scan", info: expect.objectContaining({ totalRowCount: 4 }) },
    ]);
    expect(trace.executions).toEqual([
      expect.objectContaining({
        execution_id: "e1",
        targets: ["scan"],
        started_at: 10,
        ended_at: 60,
        success: 1,
        compilation: "passed",
        compilation_ms: 12,
        request_ms: 40,
        store_ms: 2,
      }),
    ]);
    expect((trace.events as any[]).map(e => [e.kind, e.detail])).toEqual([
      ["stop", { by: "user" }],
      ["settings", { maxSteps: 5 }],
    ]);
    expect(trace.agent).toMatchObject({ settings: { maxSteps: 5 }, ended_at: 99, end_reason: "deleted" });

    // A write that fails is logged, never thrown.
    store.close();
    expect(() => store.event({ agentId: "a1", kind: "after close" })).not.toThrow();
  });

  test("openTraceStore: 'off' is no store; unset under a test run is a database in memory", () => {
    expect(openTraceStore("off")).toBeUndefined();
    const store = openTraceStore(undefined)!;
    expect(store.path).toBe(":memory:");
    store.close();
    expect(defaultTracePath()).toEndWith("/logs/agent-service/traces.db");
  });
});
