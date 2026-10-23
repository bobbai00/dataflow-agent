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
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotData } from "../agent/workflow-snapshot-storage";
import type { ReActStep } from "../types/agent";
import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";
import { TraceStore, defaultTracePath, openTraceStore, storedTreeComplete } from "./trace-store";

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
    // Every version comes back with its place in the tree and the dataflow it held.
    const stored = store.snapshotsOf("a1");
    expect(stored.map(s => [s.id, s.parentId, s.stepId, s.version, s.action?.operatorId])).toEqual([
      ["v1", "root", "s1", 1, "scan"],
      ["v2", "root", "s2", 2, "filter"],
      ["v3", "root", "s2", 3, "filter"],
    ]);
    expect(stored[2].workflow.operators.map(o => o.operatorID)).toEqual(["scan", "filter"]);
    expect((stored[1].workflow.operators[1] as any).operatorProperties.code).toBe("y");
    expect((stored[2].workflow.operators[1] as any).operatorProperties.code).toBe("z");
    expect(stored[0].workflow.operatorPositions).toEqual({ scan: { x: 1, y: 2 } });
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

    // The same operator again, on the step's next version: a restore puts each back where it was written.
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
    expect(store.snapshotResultsOf("a1")).toEqual([
      { snapshotId: "v1", stepId: "s1", operatorId: "scan", info: expect.objectContaining({ totalRowCount: 3 }) },
      { snapshotId: "v2", stepId: "s1", operatorId: "scan", info: expect.objectContaining({ totalRowCount: 4 }) },
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

  test("keeps each agent's rows apart: agents number snapshots alike, and seeded agents share step ids", () => {
    const store = new TraceStore(":memory:");
    const workflow = (code: string): WorkflowContent => ({
      operators: [{ operatorID: "x", operatorType: "PythonUDFV2", operatorProperties: { code } } as any],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    });
    const snapshot = (code: string): SnapshotData => ({
      id: "S1",
      parentId: "S0",
      reactStepId: "imported-step",
      workflow: workflow(code),
      results: new Map(),
      createdAt: 1,
      version: 0,
      action: { kind: "add", author: "agent", operatorId: "x" },
    });
    for (const [id, code] of [
      ["a1", "first"],
      ["a2", "second"],
    ]) {
      agent(store, id);
      store.turnStarted({ agentId: id, messageId: "imported-msg", channel: "message", text: code, startedAt: 1 });
      store.turnEnded({ agentId: id, messageId: "imported-msg", endedAt: 2, status: "ok", reply: code });
      store.step(id, step({ id: "imported-step", messageId: "imported-msg", content: code }));
      store.snapshot(id, snapshot(code));
    }
    for (const [id, code] of [
      ["a1", "first"],
      ["a2", "second"],
    ]) {
      expect(store.stepsOf(id).map(s => s.content)).toEqual([code]);
      expect(store.snapshotsOf(id).map(s => (s.workflow.operators[0] as any).operatorProperties.code)).toEqual([code]);
      expect((store.exportAgent(id)!.turns as any[]).map(t => t.reply)).toEqual([code]);
    }
    store.close();
  });

  test("a cleared history stays in the trace, and a restore leaves it out", () => {
    const store = new TraceStore(":memory:");
    agent(store);
    const snapshot = (id: string, stepId: string): SnapshotData => ({
      id,
      parentId: "S0",
      reactStepId: stepId,
      workflow: { operators: [], operatorPositions: {}, links: [], commentBoxes: [], settings: {} } as any,
      results: new Map(),
      createdAt: 1,
    });
    store.step("a1", step({ id: "init", messageId: "m0" }));
    store.snapshot("a1", snapshot("S1", "init"));
    // An import replaces the history: what came before is no longer the agent's.
    store.historyCleared("a1");
    store.step("a1", step({ id: "imported", messageId: "m1" }));
    store.snapshot("a1", snapshot("S3", "imported"));
    expect(store.stepsOf("a1").map(s => s.id)).toEqual(["imported"]);
    expect(store.snapshotsOf("a1").map(s => s.id)).toEqual(["S3"]);
    const trace = store.exportAgent("a1")!;
    expect((trace.steps as any[]).map(s => [s.id, s.cleared])).toEqual([
      ["init", 1],
      ["imported", 0],
    ]);
    // Imported again under the same ids, a step is the agent's once more.
    store.historyCleared("a1");
    store.step("a1", step({ id: "imported", messageId: "m1" }));
    expect(store.stepsOf("a1").map(s => s.id)).toEqual(["imported"]);
    store.close();
  });

  test("keys a database made before by agent, keeping the rows it holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-store-"));
    const path = join(dir, "traces.db");
    // The earlier schema: these tables keyed by their own ids alone.
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE turns (message_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT NOT NULL, source TEXT,
        text TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT, reply TEXT, error TEXT);
      CREATE TABLE steps (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, message_id TEXT NOT NULL, parent_id TEXT,
        step_number INTEGER NOT NULL, role TEXT NOT NULL, source TEXT, correction TEXT, at INTEGER NOT NULL,
        is_begin INTEGER NOT NULL, is_end INTEGER NOT NULL, end_reason TEXT, content TEXT, reasoning TEXT,
        tool_calls INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cached_input_tokens INTEGER, reasoning_tokens INTEGER, input_messages INTEGER, input_chars INTEGER,
        compile_ms INTEGER, context_ms INTEGER, model_ms INTEGER, post_step_ms INTEGER, step TEXT NOT NULL);
      CREATE TABLE snapshots (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, parent_id TEXT, step_id TEXT,
        version INTEGER, kind TEXT, author TEXT, operator_id TEXT, action TEXT, created_at INTEGER NOT NULL,
        operators INTEGER NOT NULL, links TEXT NOT NULL, positions TEXT NOT NULL, settings TEXT, namespace TEXT);
      CREATE TABLE snapshot_operators (snapshot_id TEXT NOT NULL, position INTEGER NOT NULL,
        operator_id TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (snapshot_id, position));
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX snapshots_by_agent ON snapshots (agent_id, created_at);
      INSERT INTO turns (message_id, agent_id, channel, started_at, reply) VALUES ('m1', 'a1', 'message', 1, 'kept');
      INSERT INTO steps (id, agent_id, message_id, step_number, role, at, is_begin, is_end, tool_calls, step)
        VALUES ('s1', 'a1', 'm1', 0, 'user', 1, 1, 1, 0, '{"id":"s1","messageId":"m1","content":"kept"}');
      INSERT INTO snapshots (id, agent_id, parent_id, step_id, version, kind, author, action, created_at, operators,
        links, positions) VALUES ('S1', 'a1', 'S0', 's1', 0, 'add', 'agent',
        '{"kind":"add","author":"agent","operatorId":"x"}', 1, 1, '[]', '{}');
      INSERT INTO snapshot_operators VALUES ('S1', 0, 'x', 'h1');
      INSERT INTO blobs VALUES ('h1', '{"operatorID":"x","operatorType":"PythonUDFV2"}');
    `);
    legacy.close();

    const keyOf = (store: TraceStore, table: string) =>
      ((store as any).db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
        .filter(column => column.pk)
        .sort((a, b) => a.pk - b.pk)
        .map(column => column.name);
    for (let open = 0; open < 2; open++) {
      // Opened twice: the second time finds the tables keyed already.
      const store = new TraceStore(path);
      expect(keyOf(store, "turns")).toEqual(["agent_id", "message_id"]);
      expect(keyOf(store, "steps")).toEqual(["agent_id", "id"]);
      expect(keyOf(store, "snapshots")).toEqual(["agent_id", "id"]);
      expect(keyOf(store, "snapshot_operators")).toEqual(["agent_id", "snapshot_id", "position"]);
      expect(store.stepsOf("a1").map(s => s.content)).toEqual(["kept"]);
      const [stored] = store.snapshotsOf("a1");
      expect([stored.id, stored.parentId, stored.stepId, stored.version]).toEqual(["S1", "S0", "s1", 0]);
      expect(stored.workflow.operators.map(op => op.operatorID)).toEqual(["x"]);
      expect(rowsOf(store, "turns")).toBe(1);
      store.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stored tree is whole when every step's snapshots and their parents are there, roots aside", () => {
    // A step whose dataflow call recorded these versions.
    const made = (id: string, parentId: string | undefined, ...versions: number[]) =>
      step({
        id,
        messageId: "m",
        parentId,
        role: "agent",
        toolCalls: [{ toolName: "dataflow", toolCallId: "c" }] as any,
        toolResults: [
          {
            toolCallId: "c",
            output: {
              kind: "dataflow-actions",
              actions: [{ output: { versions: versions.map(version => ({ version })) } }],
            },
          },
        ] as any,
      });
    const kept = (id: string, stepId: string, parentId: string, version?: number, createdAt = 1) => ({
      id,
      parentId,
      stepId,
      version,
      createdAt,
      workflow: {} as WorkflowContent,
    });
    // A seeded agent: its own initialize under S0, then the import under a root of its own (S2).
    const steps = [
      { ...made("init", undefined), toolCalls: [{ toolName: "initialize" }] as any, toolResults: [] },
      step({ id: "ask", messageId: "m", parentId: "archive-init" }),
      made("build", "ask", 0, 1),
      made("more", "build", 2),
    ];
    const tree = [
      kept("S1", "init", "S0"),
      kept("S3", "build", "S2", 0),
      kept("S4", "build", "S3", 1, 2),
      kept("S5", "more", "S4", 2, 3),
    ];
    expect(storedTreeComplete(steps, tree)).toBe(true);
    // Another agent overwrote a step's first version: its next one lost its parent.
    expect(
      storedTreeComplete(
        steps,
        tree.filter(s => s.id !== "S3")
      )
    ).toBe(false);
    // ... or the first version of a later step.
    expect(
      storedTreeComplete(
        steps,
        tree.filter(s => s.id !== "S4")
      )
    ).toBe(false);
    // ... or every snapshot of a step that made some.
    expect(
      storedTreeComplete(
        steps,
        tree.filter(s => s.id !== "S5")
      )
    ).toBe(false);
    expect(storedTreeComplete(steps, [])).toBe(false);
  });

  test("openTraceStore: 'off' is no store; unset under a test run is a database in memory", () => {
    expect(openTraceStore("off")).toBeUndefined();
    const store = openTraceStore(undefined)!;
    expect(store.path).toBe(":memory:");
    store.close();
    expect(defaultTracePath()).toEndWith("/logs/agent-service/traces.db");
  });
});
