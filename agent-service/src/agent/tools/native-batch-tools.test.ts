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
import Ajv from "ajv";
import { createNativeBatchTools, nativeBatchSchema, type NativeBatchResult } from "./native-batch-tools";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { TexeraAgent, computeOperatorAccess } from "../texera-agent";
import { AgentMode, ContextMode, type ReActStep } from "../../types/agent";
import { assembleContext } from "../util/context-utils";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { OperatorInfo } from "../../types/execution";
import { createInspectResultTool } from "./inspect-result-tool";
import { NativeRecipeStore } from "../native/recipes";

function setup() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const tools = createNativeBatchTools(state, { metadataStore: metadata });
  const execute = (args: Record<string, unknown>): Promise<NativeBatchResult> => tools.dataflow.execute(args);
  return { state, execute };
}

const scan = { op: "scan", id: "source", files: "data/test.csv" };
const filter = { op: "filter", id: "selected", input: "source", predicate: "x > 0" };
const aggregate = { op: "aggregate", id: "total", input: "selected", aggregations: [{ fn: "count" }] };

describe("native batch tools", () => {
  test("saved recipe expands through the real scheduler and preserves original inputs", async () => {
    const state = new WorkflowState(), metadata = new WorkflowSystemMetadata();
    metadata.seedCodeModeDefaults();
    const tools = createNativeBatchTools(state, { metadataStore: metadata }, "v1", new NativeRecipeStore());
    await tools.dataflow.execute({ operators: [scan, filter, aggregate], save_as: "initial" });
    const result = await tools.dataflow.execute({
      operators: [{ ...scan, id: "fresh", files: "v2.csv" }],
      reuse: { recipe: "initial", targets: ["total"], bind: { source: "fresh" }, prefix: "local" },
    });
    expect(result.operators.map((op: any) => op.status)).toEqual(["added", "added", "added"]);
    expect(result.observe).toEqual(["local_total"]);
    expect(state.getOperator("local_selected")?.nativeOp?.inputs).toEqual(["fresh"]);
    expect(state.getOperator("selected")?.nativeOp?.inputs).toEqual(["source"]);
  });
  test("schema retains typed catalog parameters without colliding with join.type", () => {
    const validate = new Ajv({ strict: false }).compile(nativeBatchSchema());
    expect(
      validate({ operators: [scan, { op: "join", id: "pairs", left: "a", right: "b", type: "left", on: "id" }] })
    ).toBe(true);
    expect(validate({ operators: [{ ...filter, unsupported: true }] })).toBe(false);
    expect(validate({ operators: [{ op: "filter", id: "x", input: "source" }] })).toBe(false);
  });

  test("one heterogeneous batch orders forward references without implicitly observing any output", async () => {
    const { execute, state } = setup();
    const result = await execute({ operators: [aggregate, filter, scan] });
    expect(result.operators.map(o => [o.id, o.status])).toEqual([
      ["total", "added"],
      ["selected", "added"],
      ["source", "added"],
    ]);
    expect(result.observe).toEqual([]);
    expect(state.getAllOperators().map(o => o.operatorID)).toEqual(["source", "selected", "total"]);
    expect(state.getAllLinks().length).toBe(2);
  });

  test("explicit empty observations suppress display, retaining all edits and their receipts", async () => {
    const { execute, state } = setup();
    const result = await execute({ operators: [scan, filter, aggregate], observe: [] });
    expect(result.observe).toEqual([]);
    expect(result.operators.every(o => o.status === "added")).toBe(true);
    expect(state.getAllOperators()).toHaveLength(3);
  });

  test("upserts keep downstream consumers, and observe can request an unchanged existing output", async () => {
    const { execute, state } = setup();
    await execute({ operators: [scan, filter, aggregate] });
    const result = await execute({ operators: [{ ...filter, predicate: "x > 10" }], observe: ["total", "source"] });
    expect(result.operators[0].status).toBe("modified");
    expect(result.observe).toEqual(["total", "source"]);
    expect(state.getOperator("selected")?.nativeOp?.properties.predicate).toBe("x > 10");
    expect(state.getAllLinks().some(l => l.source.operatorID === "selected" && l.target.operatorID === "total")).toBe(
      true
    );
    const read = await execute({ operators: [], observe: ["source", "missing"] });
    expect(read.observe).toEqual(["source"]);
    expect(read.observationErrors[0]).toContain("missing");
  });

  test("invalid upstream revision blocks dependents instead of using the previous version, while independent work lands", async () => {
    const { execute, state } = setup();
    await execute({ operators: [scan, filter] });
    const result = await execute({
      operators: [aggregate, { ...filter, predicate: 5 }, { op: "scan", id: "other", files: "data/other.csv" }],
    });
    expect(result.operators.map(o => o.status)).toEqual(["blocked", "error", "added"]);
    expect(result.operators[0].message).toContain("selected");
    expect(state.getOperator("total")).toBeUndefined();
    expect(state.getOperator("selected")?.nativeOp?.properties.predicate).toBe("x > 0");
  });

  test("duplicate IDs and cycles are refused before mutation, including cycles through old operators", async () => {
    const { execute, state } = setup();
    await execute({ operators: [scan, filter, aggregate] });
    const cyclic = await execute({ operators: [{ ...filter, input: "total" }] });
    expect(cyclic.operators[0].status).toBe("error");
    expect(cyclic.operators[0].message).toContain("cycle");
    expect(state.getOperator("selected")?.nativeOp?.inputs).toEqual(["source"]);
    const duplicate = await execute({ operators: [scan, scan] });
    expect(duplicate.operators.every(o => o.status === "error")).toBe(true);
    const fresh = await execute({
      operators: [
        { ...filter, id: "a", input: "b" },
        { ...filter, id: "b", input: "a" },
        { ...scan, id: "other" },
      ],
    });
    expect(fresh.operators.map(o => o.status)).toEqual(["error", "error", "added"]);
    expect(state.getOperator("a")).toBeUndefined();
  });

  test("agent batch mode exposes one mutation tool and inspection, and forces provider parallel calls off", () => {
    const agent = new TexeraAgent({
      agentId: "batch-test",
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    agent.updateSettings({ agentMode: AgentMode.NATIVE, nativeToolMode: "batch", parallelToolCalls: true });
    expect(agent.getSettings().parallelToolCalls).toBe(false);
    expect(Object.keys((agent as any).tools).sort()).toEqual(["dataflow", "deleteOperator", "inspectResult"]);
    expect(agent.getSettings().systemPrompt).toContain("operators");
    expect(agent.getSettings().systemPrompt).toContain("observe");
    expect(agent.getSettings().systemPrompt).not.toContain("parallel tool calls");
    agent.updateSettings({ nativeToolMode: "typed", parallelToolCalls: true });
    expect((agent as any).tools.scan).toBeDefined();
    expect((agent as any).tools.dataflow).toBeUndefined();
    expect(agent.getSettings().parallelToolCalls).toBe(true);
  });
});

describe("batch observation history", () => {
  test("chronological requests keep the complete prior message prefix across turns", () => {
    const state = new WorkflowState();
    const steps: ReActStep[] = [{ id: "u1", messageId: "m1", stepId: 0, timestamp: 1, role: "user", content: "Initial question", isBegin: true, isEnd: true }];
    const storage = new WorkflowSnapshotStorage(id => steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id));
    const render = () => assembleContext(steps, state, storage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE, messageLayout: "native", userTaskPlacement: "chronological" as any,
      flowLevel: 0, dataLevel: 0, columnStats: false,
    });
    const first = render();
    steps.push({ id: "a1", parentId: "u1", messageId: "m1", stepId: 1, timestamp: 2, role: "agent", content: "First answer", isBegin: true, isEnd: true });
    const completed = render();
    expect(completed.slice(0, first.length)).toEqual(first);
    steps.push({ id: "u2", parentId: "a1", messageId: "m2", stepId: 0, timestamp: 3, role: "user", content: "Different second question", isBegin: true, isEnd: true });
    const next = render();
    // A preview after the final answer may append a synthetic Continue; no
    // model call was made with it, and the next real user request replaces it.
    const history = completed.at(-1)?.content === "Continue." ? completed.slice(0, -1) : completed;
    expect(next.slice(0, history.length)).toEqual(history);
    expect(next.at(-1)?.content).toBe("Different second question");
    expect(JSON.stringify(next).match(/Initial question/g)).toHaveLength(1);
    expect(JSON.stringify(next).match(/Different second question/g)).toHaveLength(1);
  });
  test("native DELTA inspection evidence stays in its event and keeps the old message prefix after later actions", async () => {
    const { execute, state } = setup();
    const steps: ReActStep[] = [];
    const storage = new WorkflowSnapshotStorage(id =>
      steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
    );
    const record = (id: string, toolName: string, input: unknown, output: unknown) => {
      steps.push({
        id,
        parentId: steps.at(-1)?.id,
        messageId: "m",
        stepId: steps.length + 1,
        timestamp: 1,
        role: "agent",
        content: "",
        isBegin: false,
        isEnd: false,
        toolCalls: [{ toolName, toolCallId: id, input }],
        toolResults: [{ toolCallId: id, output }],
      });
      storage.createSnapshot(id, state.getWorkflowContent());
    };
    const render = (mode = ContextMode.DELTA, messageLayout: "native" | "block" = "native") =>
      assembleContext(steps, state, storage, mode, {
        agentMode: AgentMode.NATIVE,
        resultSelection: "all",
        messageLayout,
      });
    const args = { operators: [scan], observe: [] };
    record("s1", "dataflow", args, await execute(args));
    let cached: OperatorInfo = {
      state: "Completed",
      inputTuples: 0,
      outputTuples: 100,
      totalRowCount: 100,
      resultMode: "table",
      truncated: true,
      result: [{ value: "first_pull_sample_marker" }],
      columnStats: { value: "(str): null=0, distinct=90" },
    };
    storage.setOperatorResult("s1", "source", cached);
    const inspect = createInspectResultTool({ getResult: () => cached, workflowState: state });
    const inspectArgs = { operatorId: "source", columns: ["value"], stats: true };
    record("s2", "inspectResult", inspectArgs, await (inspect as any).execute(inspectArgs));
    const before = render();
    const frame = before
      .filter(m => m.role === "tool")
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(p => p.type === "tool-result" && p.toolCallId === "s2");
    expect(JSON.stringify(frame)).toContain("first_pull_sample_marker");
    expect(JSON.stringify(frame)).toContain("distinct=90");
    expect(JSON.stringify(before)).not.toContain("# Inspections");
    // A later upsert changes both the live result and operator definition, but
    // the original inspection is an immutable output of the earlier tool call.
    const revision = { operators: [{ ...scan, files: "data/revised.csv" }], observe: [] };
    record("s3", "dataflow", revision, await execute(revision));
    cached = { ...cached, result: [{ value: "second_pull_sample_marker" }] };
    storage.setOperatorResult("s3", "source", cached);
    expect(render().slice(0, before.length)).toEqual(before);
    record("s4", "inspectResult", inspectArgs, await (inspect as any).execute(inspectArgs));
    expect(render().slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(render())).toContain("second_pull_sample_marker");
    expect(state.deleteOperator("source")).toBe(true);
    record("s5", "deleteOperator", { id: "source" }, "deleted");
    expect(render().slice(0, before.length)).toEqual(before);
    // LATEST and non-native message layouts keep their established tail deck.
    expect(JSON.stringify(render(ContextMode.LATEST))).toContain("# Inspections");
    expect(JSON.stringify(render(ContextMode.DELTA, "block"))).toContain("# Inspections");
  });

  for (const scenario of [
    {
      name: "typed properties",
      original: { op: "distinct", id: "broken", input: "source", columns: ["Source"] },
      revision: { op: "distinct", id: "broken", input: "source", columns: ["source"] },
      failedDefinition: 'Operator properties: {"columns":["Source"]}',
      currentDefinition: 'Operator properties: {"columns":["source"]}',
    },
    {
      name: "UDF source code",
      original: {
        op: "udf",
        id: "broken",
        inputs: ["source"],
        code: 'def process(source):\n    raise RuntimeError("old failure")',
      },
      revision: {
        op: "udf",
        id: "broken",
        inputs: ["source"],
        code: "def process(source):\n    return source.copy()",
      },
      failedDefinition: 'raise RuntimeError("old failure")',
      currentDefinition: "return source.copy()",
    },
  ]) {
    test(`DELTA binds failed ${scenario.name} to the event after revision and deletion`, async () => {
      const { execute, state } = setup();
      const steps: ReActStep[] = [];
      const storage = new WorkflowSnapshotStorage(id =>
        steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
      );
      const record = (id: string, toolName: string, input: unknown, output: unknown) => {
        steps.push({
          id,
          parentId: steps.at(-1)?.id,
          messageId: "m",
          stepId: steps.length + 1,
          timestamp: 1,
          role: "agent",
          content: "",
          isBegin: false,
          isEnd: false,
          toolCalls: [{ toolName, toolCallId: id, input }],
          toolResults: [{ toolCallId: id, output }],
        });
        storage.createSnapshot(id, state.getWorkflowContent());
      };
      const firstToolFrame = () => {
        const messages = assembleContext(steps, state, storage, ContextMode.DELTA, {
          agentMode: AgentMode.NATIVE,
          resultSelection: "all",
          messageLayout: "native",
        });
        const result = messages
          .filter(m => m.role === "tool")
          .flatMap(m => (Array.isArray(m.content) ? m.content : []))
          .find(p => p.type === "tool-result" && p.toolCallId === "s1");
        expect(result).toBeDefined();
        return JSON.stringify(result);
      };
      const firstArgs = { operators: [scan, scenario.original], observe: [] };
      const first = await execute(firstArgs);
      expect(first.operators.every(o => o.status === "added")).toBe(true);
      record("s1", "dataflow", firstArgs, first);
      storage.setOperatorResult("s1", "broken", {
        state: "Failed",
        inputTuples: 0,
        outputTuples: 0,
        resultMode: "table",
        error: "original_failure_marker",
      });
      const before = firstToolFrame();
      // JSON escapes the native tool result, so normalize both expected strings
      // the same way without depending on the observation's indentation.
      expect(before).toContain("original_failure_marker");
      expect(before).toContain(scenario.failedDefinition.replaceAll('"', '\\"'));
      expect(before).not.toContain(scenario.currentDefinition.replaceAll('"', '\\"'));
      const revisedArgs = { operators: [scenario.revision], observe: [] };
      const revised = await execute(revisedArgs);
      expect(revised.operators[0].status).toBe("modified");
      record("s2", "dataflow", revisedArgs, revised);
      expect(firstToolFrame()).toBe(before);
      expect(state.deleteOperator("broken")).toBe(true);
      record("s3", "deleteOperator", { id: "broken" }, "deleted");
      expect(firstToolFrame()).toBe(before);
    });
  }

  test("DELTA keeps each request at its event, shows hidden execution receipts and errors, and supports cached observations", async () => {
    const { execute, state } = setup();
    const steps: ReActStep[] = [];
    const storage = new WorkflowSnapshotStorage(id =>
      steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id)
    );
    const info = (id: string, value: string, error?: string) =>
      ({
        operatorID: id,
        state: error ? "Failed" : "Completed",
        totalRowCount: 1,
        outputTuples: 1,
        result: [{ value }],
        error,
      }) as unknown as OperatorInfo;
    const add = async (id: string, args: Record<string, unknown>, results: Record<string, OperatorInfo>) => {
      const output = await execute(args);
      steps.push({
        id,
        parentId: steps.at(-1)?.id,
        messageId: "m",
        stepId: steps.length + 1,
        timestamp: 1,
        role: "agent",
        content: "",
        isBegin: false,
        isEnd: false,
        toolCalls: [{ toolName: "dataflow", toolCallId: id, input: args }],
        toolResults: [{ toolCallId: id, output }],
      });
      storage.createSnapshot(id, state.getWorkflowContent());
      for (const [opId, result] of Object.entries(results)) storage.setOperatorResult(id, opId, result);
      return output;
    };
    const first = await add(
      "s1",
      { operators: [scan, filter, aggregate], observe: ["total"] },
      {
        source: info("source", "hidden_source"),
        selected: info("selected", "hidden_selected"),
        total: info("total", "shown_total"),
      }
    );
    const render = (mode = ContextMode.DELTA) =>
      assembleContext(steps, state, storage, mode, { agentMode: AgentMode.NATIVE, resultSelection: "all" })
        .map(m => m.content)
        .join("\n");
    const before = render();
    expect(before).toContain("shown_total");
    expect(before).not.toContain("hidden_source");
    expect(before).not.toContain("hidden_selected");
    expect(before).toContain("result not requested");
    expect(before).not.toContain("(not executed)");
    expect(before).toContain('properties: {"predicate":"x > 0"}');
    expect(computeOperatorAccess(steps[0].toolCalls, steps[0].toolResults)?.[0].addedOperatorIds.sort()).toEqual([
      "selected",
      "source",
      "total",
    ]);
    expect(first.observe).toEqual(["total"]);
    await add(
      "s2",
      { operators: [{ op: "scan", id: "bad", files: "bad.csv" }], observe: ["source"] },
      { bad: info("bad", "", "file missing") }
    );
    const after = render();
    expect(after).toContain("hidden_source");
    expect(after).toContain("file missing");
    expect(after).not.toContain("hidden_selected");
    // The source requested later must not retroactively reveal it at s1.
    expect(after.slice(after.indexOf("## Agent Event 1"), after.indexOf("## Agent Event 2"))).not.toContain(
      "hidden_source"
    );
    expect(render(ContextMode.LATEST)).not.toContain("hidden_selected");
    const withCompileError = assembleContext(steps, state, storage, ContextMode.LATEST, {
      agentMode: AgentMode.NATIVE,
      resultSelection: "all",
      compilationResult: {
        operatorOutputSchemas: {},
        operatorErrors: { selected: { type: "validation", message: "compile_guard_marker" } },
      },
    })
      .map(m => m.content)
      .join("\n");
    expect(withCompileError).toContain("compile_guard_marker");
  });
});
