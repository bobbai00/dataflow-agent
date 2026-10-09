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
import { asSchema } from "ai";
import { type NativeBatchResult } from "./native-batch-tools";
import { TexeraAgent, computeOperatorAccess } from "../texera-agent";
import { AgentMode, ContextMode, type ReActStep } from "../../types/agent";
import { assembleContext } from "../util/context-utils";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { OperatorInfo } from "../../types/execution";
import { nativeTestTools } from "../native/test-support";

function setup() {
  const { state, tools } = nativeTestTools();
  const execute = (program: string, observe?: string[]): Promise<NativeBatchResult | string> =>
    tools.dataflow.execute({ edits: program, ...(observe !== undefined ? { observe } : {}) });
  const batch = async (program: string, observe?: string[]): Promise<NativeBatchResult> => {
    const result = await execute(program, observe);
    if (typeof result === "string") throw new Error(result);
    return result;
  };
  return { state, tools, execute, batch };
}

const scan = 'source = scan("data/test.csv")';
const filter = 'selected = filter(source, lambda row: row["x"] is not None and row["x"] > 0, doc="Keeps positive x")';
const aggregate = "total = aggregate(selected, n=count())";

describe("native dataflow tool", () => {
  test("dataflowReasoning adds a required reasoning argument, written first; off by default", async () => {
    const schemaOf = (tool: any) => asSchema(tool.inputSchema).jsonSchema as any;
    const off = nativeTestTools().tools.dataflow;
    expect(Object.keys(schemaOf(off).properties)).toEqual(["edits", "delete", "observe"]);
    expect(schemaOf(off).required).toEqual(["edits"]);
    expect(String(off.description)).not.toContain("reasoning");
    const { tools } = nativeTestTools(undefined, { settings: { dataflowReasoning: true } });
    expect(Object.keys(schemaOf(tools.dataflow).properties)).toEqual(["reasoning", "edits", "delete", "observe"]);
    expect(schemaOf(tools.dataflow).required).toEqual(["reasoning", "edits"]);
    expect(String(tools.dataflow.description).startsWith("Start with `reasoning`")).toBe(true);
    const landed = await tools.dataflow.execute({
      reasoning: "Load the file; expect three rows with x and label.",
      edits: 'source = scan("data/test.csv")',
    });
    expect((landed as NativeBatchResult).operators.map(o => o.status)).toEqual(["added"]);
    expect(String(await tools.dataflow.execute({ reasoning: 5, edits: "" } as any))).toContain("reasoning: string");
  });

  test("one program orders forward references without implicitly observing any output", async () => {
    const { batch, state } = setup();
    const result = await batch([aggregate, filter, scan].join("\n"));
    expect(result.operators.map(o => [o.id, o.status])).toEqual([
      ["total", "added"],
      ["selected", "added"],
      ["source", "added"],
    ]);
    expect(result.observe).toEqual([]);
    expect(state.getAllOperators().map(o => o.operatorID)).toEqual(["source", "selected", "total"]);
    expect(state.getAllLinks().length).toBe(2);
    // The definition travels with the operator, as written.
    expect(state.getOperator("selected")?.nativeOp?.source).toBe(filter);
    expect(state.getOperator("selected")?.nativeOp?.type).toBe("Filter");
    expect(state.getOperator("selected")?.nativeOp?.properties.entry).toBe("apply");
  });

  test("explicit empty observations suppress display, retaining all edits and their receipts", async () => {
    const { batch, state } = setup();
    const result = await batch([scan, filter, aggregate].join("\n"), []);
    expect(result.observe).toEqual([]);
    expect(result.operators.every(o => o.status === "added")).toBe(true);
    expect(state.getAllOperators()).toHaveLength(3);
  });

  test("reassigning a name revises the operator, keeps its consumers, and observe may name unchanged tables", async () => {
    const { batch, state } = setup();
    await batch([scan, filter, aggregate].join("\n"));
    const revised = filter.replace("> 0", "> 10");
    const result = await batch(revised, ["total", "source"]);
    expect(result.operators[0].status).toBe("modified");
    expect(result.observe).toEqual(["total", "source"]);
    expect(state.getOperator("selected")?.nativeOp?.properties.func).toContain("> 10");
    expect(state.getAllLinks().some(l => l.source.operatorID === "selected" && l.target.operatorID === "total")).toBe(
      true
    );
    const read = await batch("", ["source", "missing"]);
    expect(read.operators).toEqual([]);
    expect(read.observe).toEqual(["source"]);
    expect(read.observationErrors[0]).toContain("missing");
  });

  test("an invalid statement fails alone, blocks its dependents, and leaves the old revision in place", async () => {
    const { batch, state } = setup();
    await batch([scan, filter].join("\n"));
    const result = await batch(
      [aggregate, "selected = filter(source, 5)", 'other = scan("data/other.csv")'].join("\n")
    );
    expect(result.operators.map(o => o.status)).toEqual(["blocked", "error", "added"]);
    expect(result.operators[0].message).toContain("selected");
    expect(result.operators[1].message).toContain("fn must be a lambda or the name of a function");
    expect(result.operators[1].message).toContain("Signature: filter(T, fn");
    expect(result.operators[1].attempted?.type).toBe("Filter");
    expect(state.getOperator("total")).toBeUndefined();
    expect(state.getOperator("selected")?.nativeOp?.properties.func).toContain("> 0");
  });

  test("duplicate names and cycles are refused before mutation, including cycles through old operators", async () => {
    const { batch, state } = setup();
    await batch([scan, filter, aggregate].join("\n"));
    const cyclic = await batch('selected = filter(total, lambda row: row["n"] > 0, doc="Keeps positive counts")');
    expect(cyclic.operators[0].status).toBe("error");
    expect(cyclic.operators[0].message).toContain("cycle");
    expect(state.getOperator("selected")?.nativeOp?.inputs).toEqual(["source"]);
    const duplicate = await batch([scan, scan].join("\n"));
    expect(duplicate.operators.every(o => o.status === "error")).toBe(true);
    expect(duplicate.operators[0].message).toContain("assigned twice");
    const fresh = await batch(
      [
        'a = filter(b, lambda row: True, doc="all")',
        'b = filter(a, lambda row: True, doc="all")',
        'other = scan("data/o.csv")',
      ].join("\n")
    );
    expect(fresh.operators.map(o => o.status)).toEqual(["error", "error", "added"]);
    expect(state.getOperator("a")).toBeUndefined();
  });

  test("an input table that exists nowhere is refused with its name, before anything lands", async () => {
    const { batch, state } = setup();
    const result = await batch(["a = limit(ghost, 1)", "b = limit(a, 1)"].join("\n"));
    expect(result.operators.map(o => o.status)).toEqual(["error", "blocked"]);
    expect(result.operators[0].message).toContain("Input table `ghost` does not exist");
    expect(result.operators[1].message).toContain("Input `a` was not updated successfully");
    expect(state.getAllOperators()).toHaveLength(0);
  });

  test("a statement that does not parse fails alone; the rest lands and its dependents are blocked", async () => {
    const { batch, state } = setup();
    const result = await batch(
      [
        'broken = filter(source, lambda row: row["x"] >',
        scan,
        "kept = limit(source, 1)",
        "after = limit(broken, 1)",
      ].join("\n")
    );
    const byId = Object.fromEntries(result.operators.map(o => [o.id, o]));
    expect(result.operators.map(o => o.id)).toEqual(["broken", "source", "kept", "after"]);
    expect(byId.broken.status).toBe("error");
    expect(byId.broken.message).toContain("[PROGRAM_SYNTAX; validate;");
    expect(byId.broken.message).toContain("line 1");
    expect(byId.broken.message).toContain("other statements landed");
    expect(byId.source.status).toBe("added");
    expect(byId.kept.status).toBe("added");
    expect(byId.after.status).toBe("blocked");
    expect(byId.after.message).toContain("did not parse");
    expect(state.getOperator("broken")).toBeUndefined();
    expect(state.getOperator("after")).toBeUndefined();
    expect(state.getOperator("kept")).toBeDefined();
  });

  test("unknown operators list the catalog and explain the common slip of writing the name as the operator", async () => {
    const { batch } = setup();
    const result = await batch(
      [
        scan,
        "greece = greece(source)",
        "other = compute(source, x=1)",
        "def helper(row):\n    return True",
        "kept = helper(source)",
      ].join("\n")
    );
    expect(result.operators.map(o => o.status)).toEqual(["added", "error", "error", "error"]);
    expect(result.operators[1].message).toContain("Unknown operator `greece`");
    expect(result.operators[1].message).toContain("goes on the right-hand side");
    expect(result.operators[2].message).toContain("Available: scan, project, cast");
    expect(result.operators[3].message).toContain("is a function you defined");
    expect(result.operators[1].attempted?.type).toBe("Unknown");
  });

  test("agent native mode exposes only dataflow and forces provider parallel calls off", () => {
    const agent = new TexeraAgent({
      agentId: "native-tools-test",
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    agent.updateSettings({ agentMode: AgentMode.NATIVE, parallelToolCalls: true });
    expect(agent.getSettings().parallelToolCalls).toBe(false);
    expect(Object.keys((agent as any).tools).sort()).toEqual(["dataflow"]);
    expect(agent.getSettings().systemPrompt).toContain('aggregate(t, by=[], outputs={"output": reducer(...)})');
    expect(agent.getSettings().systemPrompt).not.toContain("filter(T, fn, doc=");
    const schema = asSchema((agent as any).tools.dataflow.inputSchema).jsonSchema as any;
    const actions = schema.properties.actions.items.anyOf;
    expect(
      actions
        .filter((action: any) => action.properties.type.const === "edit")
        .every((action: any) => action.required.includes("python"))
    ).toBe(true);
    expect(actions.some((action: any) => action.properties.target?.const === "namespace")).toBe(true);
    expect(agent.getSettings().systemPrompt).toContain("retrieve");
    agent.updateSettings({ agentMode: AgentMode.CODE, parallelToolCalls: true });
    expect((agent as any).tools.createOrModifyOperator).toBeDefined();
    expect((agent as any).tools.dataflow).toBeUndefined();
    expect(agent.getSettings().parallelToolCalls).toBe(true);
  });
});

describe("dataflow observation history", () => {
  function history() {
    const { batch, state } = setup();
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
    const dataflow = async (id: string, program: string, observe: string[] = []) => {
      const input = { program, observe };
      const output = await batch(program, observe);
      record(id, "dataflow", input, output);
      return output;
    };
    return { batch, state, steps, storage, record, dataflow };
  }

  test("a replayed call shows its reasoning before the edits", async () => {
    const { state, steps, storage, record, batch } = history();
    const input = {
      reasoning: "Parse the header on line 2; expect 24 rows.",
      edits: 'source = scan("data/test.csv")',
      observe: [],
    };
    record("s1", "dataflow", input, await batch(input.edits, []));
    const text = assembleContext(steps, state, storage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      resultSelection: "all",
      messageLayout: "block",
    })
      .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(text).toContain("- dataflow\n  reasoning: Parse the header on line 2; expect 24 rows.\n  edits:");
  });

  test("historical native DELTA inspection evidence keeps its saved event after later actions", async () => {
    const { state, steps, storage, record, dataflow } = history();
    const render = (mode = ContextMode.DELTA, messageLayout: "native" | "block" = "native") =>
      assembleContext(steps, state, storage, mode, {
        agentMode: AgentMode.NATIVE,
        resultSelection: "all",
        messageLayout,
      });
    await dataflow("s1", scan, []);
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
    const inspectArgs = { operatorId: "source", columns: ["value"], stats: true };
    // Imported old traces remain readable, but no executable result-inspection
    // factory or registration exists in new sessions.
    record("s2", "inspectResult", inspectArgs, "Saved inspection: first_pull_sample_marker; distinct=90");
    const before = render();
    const frame = before
      .filter(m => m.role === "tool")
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(p => p.type === "tool-result" && p.toolCallId === "s2");
    expect(JSON.stringify(frame)).toContain("first_pull_sample_marker");
    expect(JSON.stringify(frame)).toContain("distinct=90");
    expect(JSON.stringify(before)).not.toContain("# Inspections");
    await dataflow("s3", 'source = scan("data/revised.csv")', []);
    cached = { ...cached, result: [{ value: "second_pull_sample_marker" }] };
    storage.setOperatorResult("s3", "source", cached);
    expect(render().slice(0, before.length)).toEqual(before);
    record("s4", "inspectResult", inspectArgs, "Saved inspection: second_pull_sample_marker; distinct=90");
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
      name: "typed arguments",
      original: 'broken = distinct(source, columns=["Source"])',
      revision: 'broken = distinct(source, columns=["source"])',
    },
    {
      name: "process source code",
      original:
        'def broken_fn(source):\n    raise RuntimeError("old failure")\nbroken = process(source, fn=broken_fn, doc="fixture")',
      revision:
        'def broken_fn(source):\n    return source.copy()\nbroken = process(source, fn=broken_fn, doc="fixture")',
    },
  ]) {
    test(`DELTA binds a failed ${scenario.name} definition to its event after revision and deletion`, async () => {
      const { state, steps, storage, record, dataflow } = history();
      const frames = () => {
        const messages = assembleContext(steps, state, storage, ContextMode.DELTA, {
          agentMode: AgentMode.NATIVE,
          resultSelection: "all",
          messageLayout: "native",
        });
        const call = messages
          .filter(m => m.role === "assistant")
          .flatMap(m => (Array.isArray(m.content) ? m.content : []))
          .find(p => p.type === "tool-call" && p.toolCallId === "s1");
        const result = messages
          .filter(m => m.role === "tool")
          .flatMap(m => (Array.isArray(m.content) ? m.content : []))
          .find(p => p.type === "tool-result" && p.toolCallId === "s1");
        expect(call).toBeDefined();
        expect(result).toBeDefined();
        return { call: JSON.stringify(call), result: JSON.stringify(result) };
      };
      const first = await dataflow("s1", `${scan}\n${scenario.original}`, []);
      expect(first.operators.every(o => o.status === "added")).toBe(true);
      storage.setOperatorResult("s1", "broken", {
        state: "Failed",
        inputTuples: 0,
        outputTuples: 0,
        resultMode: "table",
        error: "original_failure_marker",
      });
      const before = frames();
      // The event's tool call carries the definition the model wrote; the
      // failure sits in that event's result. Neither moves when the definition
      // is later revised or the operator deleted.
      expect(before.call).toContain(JSON.stringify(scenario.original).slice(1, -1));
      expect(before.call).not.toContain(JSON.stringify(scenario.revision).slice(1, -1));
      expect(before.result).toContain("original_failure_marker");
      const revised = await dataflow("s2", scenario.revision, []);
      expect(revised.operators.at(-1)!.status).toBe("modified");
      expect(frames()).toEqual(before);
      expect(state.deleteOperator("broken")).toBe(true);
      record("s3", "deleteOperator", { id: "broken" }, "deleted");
      expect(frames()).toEqual(before);
    });
  }

  test("DELTA keeps each request at its event, shows hidden execution receipts and errors, and supports cached observations", async () => {
    const { state, steps, storage, dataflow } = history();
    const info = (id: string, value: string, error?: string) =>
      ({
        operatorID: id,
        state: error ? "Failed" : "Completed",
        totalRowCount: 1,
        outputTuples: 1,
        result: [{ value }],
        error,
      }) as unknown as OperatorInfo;
    const add = async (id: string, program: string, observe: string[], results: Record<string, OperatorInfo>) => {
      const output = await dataflow(id, program, observe);
      for (const [opId, result] of Object.entries(results)) storage.setOperatorResult(id, opId, result);
      return output;
    };
    const first = await add("s1", [scan, filter, aggregate].join("\n"), ["total"], {
      source: info("source", "hidden_source"),
      selected: info("selected", "hidden_selected"),
      total: info("total", "shown_total"),
    });
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
    // The action is the program as written.
    expect(before).toContain(filter);
    expect(computeOperatorAccess(steps[0].toolCalls, steps[0].toolResults)?.[0].addedOperatorIds.sort()).toEqual([
      "selected",
      "source",
      "total",
    ]);
    expect(first.observe).toEqual(["total"]);
    await add("s2", 'bad = scan("bad.csv")', ["source"], { bad: info("bad", "", "file missing") });
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
