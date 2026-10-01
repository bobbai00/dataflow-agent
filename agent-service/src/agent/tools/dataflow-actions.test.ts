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

import { describe, expect, test, spyOn } from "bun:test";
import * as executionTools from "./workflow-execution-tools";
import { asSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { VercelToolUseDriver } from "../llm-drivers/vercel-tool-use-driver";
import {
  createDataflowTool,
  prepareDataflowActions,
  renderDataflowActionsResult,
  runDataflowActions,
} from "./dataflow-actions";
import { TexeraAgent } from "../texera-agent";
import { AgentMode, ContextMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { assembleContext } from "../util/context-utils";
import type { DataflowAction, DataflowActionsResult } from "./dataflow-actions";

const edit = { type: "edit", changes: 'create operator source: scan("data/orders.csv")' };

describe("compact action observations", () => {
  async function receipt(action: DataflowAction, output: unknown, status: "ok" | "error" = "ok") {
    const result = prepareDataflowActions({ reasoning: "Check the result.", actions: [action] }, true);
    await runDataflowActions(result, async () => ({ status, output }));
    return result;
  }

  test("successful execution observations stay small as the graph grows without losing stored receipts", async () => {
    const result = await receipt(
      { type: "execute" },
      { operators: Array.from({ length: 250 }, (_, i) => ({ id: `old_branch_${i}`, status: "ok", rows: i })) }
    );
    const saved = JSON.stringify(result);
    const text = renderDataflowActionsResult(result);
    expect(text).toContain("1. execute: ok");
    expect(text).toContain("250 operators completed");
    expect(text.length).toBeLessThan(150);
    expect(text).not.toContain("old_branch_");
    expect(JSON.stringify(result)).toBe(saved);
    expect(renderDataflowActionsResult(structuredClone(result))).toBe(text);
  });

  test("failed executions retain operator errors, blocked results, diagnostics and engine errors", async () => {
    const result = await receipt(
      { type: "execute" },
      {
        operators: [
          { id: "ordinary", status: "ok", rows: 100 },
          { id: "header", status: "ok", rows: 10, checks: ["check: header row repeats"] },
          { id: "source", status: "error", message: "File missing: orders.csv" },
          { id: "unfinished", status: "running", message: "No completed result" },
        ],
        blocked: [{ id: "total", message: "source failed" }],
        error: "Engine stopped",
      },
      "error"
    );
    const text = renderDataflowActionsResult(result);
    expect(text).toContain("1. execute: error");
    expect(text).toContain("2 operators completed");
    expect(text).toContain("header: ok");
    expect(text).toContain("check: header row repeats");
    expect(text).toContain("source: error — File missing: orders.csv");
    expect(text).toContain("unfinished: running — No completed result");
    expect(text).toContain("total: blocked — source failed");
    expect(text).toContain("Execution error: Engine stopped");
    expect(text).not.toContain("ordinary:");
  });

  test("edit observations acknowledge atomic changes and retain implicit deletions and stale-input warnings", async () => {
    const result = await receipt(edit as DataflowAction, {
      changes: [
        { operation: "create_operator", operator_id: "source" },
        { operation: "create_edge", edge: "source.out -> total.in" },
        { operation: "delete_operator", operator_id: "probe", deleted_edges: ["source.out -> probe.in"] },
      ],
      unconnected_inputs: ["total.in"],
      invalidated_results: ["total"],
    });
    const text = renderDataflowActionsResult(result);
    expect(text).toContain("Applied 3 graph changes");
    expect(text).not.toContain("create operator: source");
    expect(text).not.toContain("create edge: source.out -> total.in");
    expect(text).toContain("automatically deleted edges: source.out -> probe.in");
    expect(text).toContain("Unconnected required inputs: total.in");
    expect(text).toContain("Invalidated results: total");
  });

  test("rejected edits and skipped actions stay explicit, with no success acknowledgment", async () => {
    const result = prepareDataflowActions({ reasoning: "Load.", actions: [edit, { type: "execute" }] });
    await runDataflowActions(result, async () => ({
      status: "error",
      output: "Atomic edit rejected: missing operator.",
    }));
    const text = renderDataflowActionsResult(result);
    expect(text).toContain("1. edit: error\nAtomic edit rejected: missing operator.");
    expect(text).toContain("2. execute: skipped\nNot run because an earlier action failed.");
    expect(text).not.toContain("Applied");
  });

  test("requested historical results preserve their exact contents and provenance", async () => {
    const result = await receipt(
      { type: "retrieve", operator_id: "total", task_id: 2 },
      {
        operator_id: "total",
        revision: "rev-2",
        historical_state: { task_id: 2, operator_id: "total" },
        superseded_in_call: true,
        text: '1 row\n{"amount":42}',
      }
    );
    expect(renderDataflowActionsResult(result)).toBe(
      '1. retrieve: ok\nHistorical result; changed later in this call.\nSaved result: task 2, operator total.\nOperator total (revision rev-2)\n1 row\n{"amount":42}'
    );
  });
});

describe("ordered dataflow actions", () => {
  test("only available views validate and unavailable requests run no actions", async () => {
    const tool = createDataflowTool(["sample_stats"]);
    const schema = asSchema(tool.inputSchema).jsonSchema as any;
    const retrieve = schema.properties.actions.items.anyOf.find((a: any) => a.properties.type.const === "retrieve");
    expect(retrieve.properties.view.enum).toEqual(["sample_stats"]);
    expect(retrieve.required).toContain("view");
    const invalid = prepareDataflowActions(
      { reasoning: "Read.", actions: [edit, { type: "retrieve", operator_id: "source", view: "full" }] },
      ["sample_stats"]
    );
    expect(invalid.error).toContain("unavailable");
    expect(invalid.actions).toEqual([]);
    expect(
      prepareDataflowActions({ reasoning: "Read.", actions: [{ type: "retrieve", operator_id: "source" }] }).error
    ).toContain("view");
  });
  test("historical actions are exposed and validated only when enabled", () => {
    const actions = [
      { type: "inspect", target: "state", task_id: null, operator_id: "total", include_implementation: true },
      { type: "fork", task_id: 1, operator_id: "total", new_operator_id: "old_total" },
      { type: "retrieve", task_id: 1, operator_id: "total", view: "full" },
    ];
    expect(prepareDataflowActions({ reasoning: "Read earlier state.", actions }).status).toBe("error");
    expect(prepareDataflowActions({ reasoning: "Read earlier state.", actions }, undefined, true).status).toBe("pending");
    expect(
      prepareDataflowActions(
        { reasoning: "Read.", actions: [{ type: "retrieve", task_id: 0, operator_id: "total", view: "full" }] },
        undefined,
        true
      ).status
    ).toBe("error");
    const s = session([]);
    s.agent.updateSettings({ stateHistory: true });
    const info = s.agent.getSystemInfo();
    expect(info.tools.find(tool => tool.name === "dataflow")?.inputSchema).toEqual(
      asSchema(createDataflowTool(undefined, true).inputSchema).jsonSchema
    );
    expect(s.agent.getSettings().systemPrompt).toContain("older formula to a current population");
  });
  test("the public tool requires a rationale and a typed action list", () => {
    const schema = asSchema(createDataflowTool().inputSchema).jsonSchema as any;
    expect(schema.required).toEqual(["reasoning", "actions"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.actions.items.anyOf).toHaveLength(6);
    expect(schema.properties.edits).toBeUndefined();
    const editSchema = schema.properties.actions.items.anyOf.find((a: any) => a.properties.type.const === "edit");
    expect(Object.keys(editSchema.properties)).toEqual(["type", "changes"]);
  });

  test("system-info exports the same action schema sent to the model", () => {
    const s = session([]);
    const exported = s.agent.getSystemInfo().tools.find(tool => tool.name === "dataflow");
    expect(exported?.inputSchema).toEqual(asSchema(createDataflowTool().inputSchema).jsonSchema);
    expect(exported).toMatchObject({ strict: true });
  });

  test("validates the entire envelope before any action runs", () => {
    for (const input of [
      { edits: "source = scan('x')" },
      { reasoning: "", actions: [edit] },
      { reasoning: "load", actions: [] },
      { reasoning: "load", actions: [edit, { type: "execute", force: true }] },
      { reasoning: "load", actions: [{ type: "retrieve", view: "sample", operator_id: 5 }] },
      { reasoning: "load", actions: [edit, { type: "answer", content: "42" }] },
    ])
      expect(prepareDataflowActions(input).error).toBeDefined();
  });

  test("runs actions in order and never implicitly executes an edit or retrieval", async () => {
    const called: string[] = [];
    const result = prepareDataflowActions({
      reasoning: "Load and read the table.",
      actions: [edit, { type: "execute" }, { type: "retrieve", view: "sample", operator_id: "source" }],
    });
    await runDataflowActions(result, async action => {
      called.push(action.type);
      return { status: "ok", output: action.type };
    });
    expect(called).toEqual(["edit", "execute", "retrieve"]);
    expect(result.actions.map(a => a.status)).toEqual(["ok", "ok", "ok"]);
    expect(result.status).toBe("completed");
    const read = prepareDataflowActions({
      reasoning: "Read again.",
      actions: [{ type: "retrieve", view: "sample", operator_id: "source" }],
    });
    await runDataflowActions(read, async action => {
      called.push(action.type);
      return { status: "ok", output: "cached" };
    });
    expect(called).toEqual(["edit", "execute", "retrieve", "retrieve"]);
  });

  test("an execution failure permits reads and retains completed outcomes", async () => {
    const result = prepareDataflowActions({
      reasoning: "Run.",
      actions: [edit, { type: "execute" }, { type: "retrieve", view: "sample", operator_id: "source" }],
    });
    await runDataflowActions(result, async action => {
      if (action.type === "execute") throw new Error("worker unavailable");
      return { status: "ok", output: "created" };
    });
    expect(result.actions.map(a => a.status)).toEqual(["ok", "error", "ok"]);
    expect(result.actions[0].output).toBe("created");
    expect(result.error).toContain("worker unavailable");
    expect(result.status).toBe("error");
  });

  test("partial execution preserves independent retrievals while skipping later mutations", async () => {
    const s = session([
      [
        { type: "edit", changes: 'create operator good: scan("ok.csv")\ncreate operator bad: scan("missing.csv")' },
        { type: "execute" },
        { type: "retrieve", view: "sample", operator_id: "bad" },
        { type: "retrieve", view: "sample", operator_id: "good" },
        { type: "edit", changes: 'create operator never: scan("never.csv")' },
      ],
    ]);
    (s.agent as any).executePostStepChanges = async () => {
      for (const id of ["good", "bad"])
        s.agent.getSnapshotStorage().setOperatorResult(s.agent.getHead()!, id, {
          state: id === "good" ? "Completed" : "Failed",
          inputTuples: 0,
          outputTuples: 1,
          resultMode: "table",
          result: [{ value: 42 }],
          resultSchema: [{ name: "value", type: "int", encoding: "" }],
          ...(id === "bad" ? { error: "missing file" } : {}),
        });
    };
    await s.agent.sendMessage("Read the independent result.");
    expect(s.outcomes[0].actions.map(a => a.status)).toEqual(["ok", "error", "error", "ok", "skipped"]);
    expect(JSON.stringify(s.outcomes[0].actions[3].output)).toContain("42");
    expect(s.agent.getWorkflowState().getOperator("never")).toBeUndefined();
  });

  test("validation identifies the offending action without unrelated schema alternatives", () => {
    const badType = prepareDataflowActions({ reasoning: "Read.", actions: [{ type: "process" }] });
    expect(badType.error).toContain("Action 1");
    expect(badType.error).toContain("inside an edit");
    expect(badType.error!.length).toBeLessThan(300);
    const missingDelete = prepareDataflowActions({ reasoning: "Read.", actions: [{ type: "edit" }] });
    expect(missingDelete.error).toContain("changes");
    expect(missingDelete.error).not.toContain("operator_id");
    expect(missingDelete.actions).toEqual([]);
  });

  test("graph verbs in the outer action receive a concrete edit envelope", () => {
    for (const type of ["create", "update", "modify", "delete"]) {
      const result = prepareDataflowActions({ reasoning: "Change the graph.", actions: [{ type }] });
      expect(result.error).toContain('"type":"edit"');
      expect(result.error).toContain(`"changes":"${type === "modify" ? "update" : type} operator`);
      expect(result.actions).toEqual([]);
    }
  });

  test("an answer is accepted only on its own and ends the batch", async () => {
    const result = prepareDataflowActions({
      reasoning: "The retrieved total is 42.",
      actions: [{ type: "answer", content: "42" }],
    });
    await runDataflowActions(result, async action => ({
      status: "ok",
      output: action.type === "answer" ? action.content : "",
    }));
    expect(result.answer).toBe("42");
    expect(result.status).toBe("completed");
  });
});

function session(batches: DataflowAction[][]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const outcomes: DataflowActionsResult[] = [];
  const contexts: ReturnType<typeof assembleContext>[] = [];
  let executions = 0;
  const agent = new TexeraAgent({
    agentId: "action-test",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      async runTurn(input) {
        for (const [i, actions] of batches.entries()) {
          const args = { reasoning: "Check the next result.", actions };
          const output = await input.tools.dataflow.execute(args);
          await input.onStepFinish({
            text: "",
            toolCalls: [{ toolName: "dataflow", toolCallId: `t${i}`, input: args }],
            toolResults: [{ toolCallId: `t${i}`, output }],
          });
          outcomes.push(output);
          contexts.push(
            assembleContext(
              agent.getVisibleReActSteps(),
              agent.getWorkflowState(),
              agent.getSnapshotStorage(),
              ContextMode.DELTA,
              { agentMode: AgentMode.NATIVE, messageLayout: "native" }
            )
          );
          if (input.getFinalAnswer?.() !== undefined) break;
        }
        return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
      },
    },
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE });
  (agent as any).executePostStepChanges = async (_calls: unknown, _results: unknown, explicit: boolean) => {
    expect(explicit).toBe(true);
    executions++;
    for (const op of (agent as any).workflowState.getAllOperators()) {
      (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        totalRowCount: 1,
        resultMode: "table",
        result: [{ value: `result-${executions}` }],
        resultSchema: [{ name: "value", type: "str" }],
      });
    }
  };
  return { agent, outcomes, contexts, executions: () => executions };
}

describe("dataflow action integration", () => {
  test("changing retrieval views reads the same result and freezes each observation", async () => {
    const s = session([
      [
        { type: "edit", changes: 'create operator source: scan("x.csv")' },
        { type: "execute" },
        { type: "retrieve", operator_id: "source", view: "sample" },
      ],
      [{ type: "retrieve", operator_id: "source", view: "full" }],
      [{ type: "retrieve", operator_id: "source", view: "sample_stats" }],
    ]);
    s.agent.updateSettings({ retrievalViews: ["full", "sample", "sample_stats"], maxResultRows: 1 });
    await s.agent.sendMessage("Read three views.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes.map(o => (o.actions.at(-1)!.output as any).view)).toEqual(["sample", "full", "sample_stats"]);
    for (let i = 1; i < s.contexts.length; i++)
      expect(s.contexts[i].slice(0, s.contexts[i - 1].length)).toEqual(s.contexts[i - 1]);
    const steps = s.agent.getVisibleReActSteps().filter(step => step.toolCalls?.length);
    for (const [i, step] of steps.entries()) {
      const saved = s.agent.getSnapshotStorage().getAssociatedSnapshot(step.id);
      expect(saved?.nativeObservations?.source.options.view).toBe((["sample", "full", "sample_stats"] as const)[i]);
    }
  });
  test("later tasks inspect, fork and retrieve the earlier result without executing or changing the baseline", async () => {
    const batches: DataflowAction[][] = [
      [{ type: "edit", changes: 'create operator source: scan("old.csv")' }, { type: "execute" }],
      [{ type: "answer", content: "First result saved." }],
    ];
    const s = session(batches);
    s.agent.updateSettings({ stateHistory: true });
    await s.agent.sendMessage("Read the baseline.");
    batches.splice(
      0,
      batches.length,
      [{ type: "edit", changes: 'update operator source: scan("new.csv")' }, { type: "execute" }],
      [{ type: "answer", content: "Second result saved." }]
    );
    await s.agent.sendMessage("Use a new input.");
    batches.splice(
      0,
      batches.length,
      [{ type: "inspect", target: "state", task_id: null, operator_id: "source", include_implementation: true }],
      [
        { type: "fork", task_id: 1, operator_id: "source", new_operator_id: "earlier" },
        { type: "retrieve", operator_id: "earlier", view: "full" },
        { type: "retrieve", task_id: 1, operator_id: "source", view: "full" },
        { type: "retrieve", operator_id: "source", view: "full" },
      ],
      [{ type: "answer", content: "Compared the two saved views." }]
    );
    await s.agent.sendMessage("Compare with the first task.");
    expect(s.executions()).toBe(2);
    const inspection = s.outcomes.at(-3)!.actions[0].output as any;
    expect(inspection.versions.map((v: any) => v.task_id)).toEqual([1, 2]);
    const reads = s.outcomes.at(-2)!;
    expect(reads.status).toBe("completed");
    expect(reads.actions[1].output).toMatchObject({ historical_state: { task_id: 1, operator_id: "source" } });
    const restored = session([]);
    await restored.agent.importReActSteps(structuredClone(s.agent.getReActSteps()));
    expect(restored.executions()).toBe(0);
    expect(restored.agent.getWorkflowState().getOperator("earlier")?.nativeOp?.source).toContain("old.csv");
    expect(restored.agent.getWorkflowState().getOperator("earlier")?.stateOrigin?.taskId).toBe(1);
    expect(JSON.stringify(reads.actions[1].output)).toContain("result-1");
    expect(JSON.stringify(reads.actions[2].output)).toContain("result-1");
    expect(JSON.stringify(reads.actions[3].output)).toContain("result-2");
    expect((reads.actions[1].output as any).superseded_in_call).toBeUndefined();
    expect(s.agent.getWorkflowState().getOperator("source")!.nativeOp!.source).toContain("new.csv");
    expect(s.agent.getWorkflowState().getOperator("earlier")!.nativeOp!.source).toContain("old.csv");
  });
  const source: DataflowAction = {
    type: "edit",
    changes:
      'create operator source: scan("data/orders.csv")\ncreate operator last: limit(1)\ncreate edge source.out -> last.in',
  };
  const read: DataflowAction = { type: "retrieve", view: "sample", operator_id: "last" };

  test("edits are deferred from execution, unavailable reads fail, and later cached reads do not execute", async () => {
    const s = session([
      [source],
      [read],
      [{ type: "execute" }, read],
      [read],
      [{ type: "answer", content: "result-1" }],
    ]);
    const response = await s.agent.sendMessage("Read the last table.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[0].status).toBe("completed");
    expect(s.outcomes[1].error).toContain("execute");
    expect(JSON.stringify(s.outcomes[2])).toContain("result-1");
    expect(JSON.stringify(s.outcomes[3])).toContain("result-1");
    expect(response.response).toBe("result-1");
  });

  test("editing an ancestor invalidates downstream retrieval and preserves old observations", async () => {
    const s = session([
      [source, { type: "execute" }, read],
      [{ type: "edit", changes: 'update operator source: scan("data/new.csv")' }, read, { type: "execute" }],
    ]);
    await s.agent.sendMessage("Revise the source.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[1].actions.map(a => a.status)).toEqual(["ok", "error", "skipped"]);
    expect(JSON.stringify(s.outcomes[0])).toContain("result-1");
    const steps = s.agent.getVisibleReActSteps();
    const messages = assembleContext(
      steps,
      (s.agent as any).workflowState,
      (s.agent as any).snapshotStorage,
      ContextMode.DELTA,
      { agentMode: AgentMode.NATIVE, messageLayout: "native" }
    );
    expect(JSON.stringify(messages)).toContain("result-1");
    expect(JSON.stringify(messages)).toContain("skipped");
  });

  test("inspection returns graph edges and registered custom code without execution", async () => {
    const s = session([
      [source, { type: "inspect", target: "graph" }],
      [
        {
          type: "edit",
          changes:
            'create operator kept: filter(fn=keep, doc="Keeps every row")\n    def keep(row):\n        return True\ncreate edge source.out -> kept.in',
        },
        { type: "inspect", target: "operator", operator_id: "kept", include_implementation: true },
      ],
    ]);
    await s.agent.sendMessage("Inspect the workflow.");
    expect(s.executions()).toBe(0);
    expect(JSON.stringify(s.outcomes[0].actions[1].output)).toContain("last");
    expect(JSON.stringify(s.outcomes[0].actions[1].output)).toContain("edges");
    expect(JSON.stringify(s.outcomes[1].actions[1].output)).toContain("def keep(row)");
  });

  test("a missing edge endpoint rejects the entire edit and reports skipped actions in DELTA", async () => {
    const s = session([
      [source, { type: "execute" }, read],
      [
        { type: "inspect", target: "graph" },
        {
          type: "edit",
          changes:
            "create operator good: limit(1)\ncreate operator bad: limit(1)\ncreate operator blocked: limit(1)\ncreate edge source.out -> good.in\ncreate edge missing.out -> bad.in\ncreate edge bad.out -> blocked.in",
        },
        { type: "execute" },
        { type: "retrieve", view: "sample", operator_id: "good" },
      ],
    ]);
    await s.agent.sendMessage("Check a missing dependency.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[1].actions.map(a => a.status)).toEqual(["ok", "error", "skipped", "skipped"]);
    expect(s.agent.getWorkflowState().getOperator("good")).toBeUndefined();
    expect(s.agent.getWorkflowState().getOperator("bad")).toBeUndefined();
    expect(s.agent.getWorkflowState().getOperator("blocked")).toBeUndefined();
    const output = (s.contexts[1].at(-1)!.content as any[])[0].output.value;
    expect(output).toContain("missing");
    expect(output).not.toMatch(/\bprogram\b/i);
    expect(output.match(/^\d+\. \w+: \w+$/gm)).toEqual([
      "1. inspect: ok",
      "2. edit: error",
      "3. execute: skipped",
      "4. retrieve: skipped",
    ]);
  });

  test("DELTA appends observations without changing prior tool frames after edits and cache reads", async () => {
    const s = session([
      [source, { type: "execute" }, read],
      [read, { type: "inspect", target: "graph" }],
      [{ type: "edit", changes: 'update operator source: scan("data/new.csv")' }, { type: "execute" }, read],
      [read],
    ]);
    await s.agent.sendMessage("Read, revise, and read again.");
    for (let i = 1; i < s.contexts.length; i++) {
      expect(s.contexts[i].slice(0, s.contexts[i - 1].length)).toEqual(s.contexts[i - 1]);
      expect(s.contexts[i].length).toBe(s.contexts[i - 1].length + 2);
    }
    expect(s.executions()).toBe(2);
    expect(JSON.stringify(s.contexts[0])).toContain("result-1");
    expect(JSON.stringify(s.contexts[0])).not.toContain("result-2");
    expect(JSON.stringify(s.contexts.at(-1))).toContain("result-2");
    expect(JSON.stringify(s.contexts.at(-1))).not.toContain("# Current Dataflow");
  });

  test("a rejected atomic edit stops the batch and preserves the unchanged graph result", async () => {
    const s = session([
      [source, { type: "execute" }, read],
      [{ type: "edit", changes: "update operator source: scan()" }, { type: "execute" }, read],
      [read],
    ]);
    await s.agent.sendMessage("Try a bad revision.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[1].actions.map(a => a.status)).toEqual(["error", "skipped", "skipped"]);
    expect(s.outcomes[2].status).toBe("completed");
  });
});

describe("action history and model loop", () => {
  const source: DataflowAction = { type: "edit", changes: 'create operator source: scan("data/old.csv")' };
  const read: DataflowAction = { type: "retrieve", view: "sample", operator_id: "source" };

  test("two executions in one call keep each retrieved version and preserve prior snapshots", async () => {
    const s = session([
      [source, { type: "execute" }, read],
      [read, { type: "edit", changes: 'update operator source: scan("data/new.csv")' }, { type: "execute" }, read],
    ]);
    await s.agent.sendMessage("Compare the old and new file.");
    expect(s.executions()).toBe(2);
    expect(JSON.stringify(s.outcomes[1].actions[0].output)).toContain("result-1");
    expect(JSON.stringify(s.outcomes[1].actions[3].output)).toContain("result-2");
    expect(JSON.stringify(s.outcomes[0])).not.toContain("result-2");
    const latest = JSON.stringify(
      assembleContext(
        s.agent.getVisibleReActSteps(),
        s.agent.getWorkflowState(),
        s.agent.getSnapshotStorage(),
        ContextMode.LATEST,
        { agentMode: AgentMode.NATIVE, messageLayout: "opSplit" }
      )
    );
    expect(latest).toContain("result-1");
    expect(latest).toContain("result-2");
    const step = s.agent.getVisibleReActSteps().find(step => step.toolCalls?.length)!;
    expect(() =>
      s.agent.getSnapshotStorage().updatePendingWorkflow(step.id, s.agent.getWorkflowState().getWorkflowContent())
    ).toThrow("completed snapshot");
  });

  test("LATEST retains inspection output and the reason a retrieval failed", async () => {
    const s = session([
      [source, { type: "inspect", target: "operator", operator_id: "source", include_implementation: false }],
      [read],
    ]);
    await s.agent.sendMessage("Inspect a source before running it.");
    const messages = assembleContext(
      s.agent.getVisibleReActSteps(),
      s.agent.getWorkflowState(),
      s.agent.getSnapshotStorage(),
      ContextMode.LATEST,
      { agentMode: AgentMode.NATIVE, messageLayout: "opSplit" }
    );
    const text = JSON.stringify(messages);
    expect(text).toContain("No current result for source");
    expect(text).toContain("Inspection @ Event");
    expect(text).toContain("data/old.csv");
  });

  test("import replays completed edits, skips unrun edits, and never executes", async () => {
    const s = session([[source, read, { type: "edit", changes: 'create operator skipped: scan("data/skipped.csv")' }]]);
    await s.agent.sendMessage("Prepare the source.");
    const imported = session([]);
    await imported.agent.importReActSteps(structuredClone(s.agent.getReActSteps()));
    expect(imported.executions()).toBe(0);
    expect(
      imported.agent
        .getWorkflowState()
        .getAllOperators()
        .map(op => op.operatorID)
    ).toEqual(["source"]);
    expect(imported.agent.getWorkflowState().getOperator("source")?.nativeOp?.source).toContain("data/old.csv");

    // Saved traces from the previous action schema remain replayable.
    const legacy = structuredClone(s.agent.getReActSteps());
    const oldField = (action: any) => {
      if (action.type === "edit") {
        action.program = action.changes.replace(/^create operator (\w+): /gm, "$1 = ");
        action.delete = [];
        delete action.changes;
      }
    };
    for (const step of legacy) {
      for (const call of step.toolCalls ?? []) (call.input?.actions ?? []).forEach(oldField);
      for (const result of step.toolResults ?? [])
        (result.output?.actions ?? []).forEach((item: any) => oldField(item.action));
    }
    const importedLegacy = session([]);
    await importedLegacy.agent.importReActSteps(legacy);
    expect(
      importedLegacy.agent
        .getWorkflowState()
        .getAllOperators()
        .map(op => op.operatorID)
    ).toEqual(["source"]);
    expect(importedLegacy.executions()).toBe(0);
  });

  test("the real SDK sees completed results on the next request and stops immediately on Answer", async () => {
    const s = session([]);
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async options => {
        calls++;
        expect(options.toolChoice).toEqual({ type: "required" });
        expect(options.tools?.find(t => t.type === "function" && t.name === "dataflow")).toMatchObject({
          strict: true,
        });
        if (calls === 2) {
          expect(JSON.stringify(options.prompt)).toContain("result-1");
          expect(JSON.stringify(options.prompt)).not.toContain('"status":"pending"');
        }
        if (calls > 2) throw new Error("Answer must end the loop without another model request");
        const actions = calls === 1 ? [source, { type: "execute" }, read] : [{ type: "answer", content: "result-1" }];
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${calls}`,
              toolName: "dataflow",
              input: JSON.stringify({ reasoning: "Check the stored result.", actions }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    (s.agent as any).driver = new VercelToolUseDriver({ model });
    (s.agent as any).contextAssembler = ({ visibleSteps, workflowState, snapshotStorage, settings }: any) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
      });
    const response = await s.agent.sendMessage("Read the file and answer.");
    expect(response.error).toBeUndefined();
    expect(response.response).toBe("result-1");
    expect(calls).toBe(2);
    expect(JSON.stringify(response.messages)).not.toContain('"status":"pending"');
    expect(s.executions()).toBe(1);
    expect(s.agent.getVisibleReActSteps().at(-1)?.isEnd).toBe(true);
  });
});

test("an aborted execution cannot attach late results or run the next action", async () => {
  const s = session([
    [
      { type: "edit", changes: 'create operator source: scan("data/orders.csv")' },
      { type: "execute" },
      { type: "edit", changes: "create operator never: limit(1)\ncreate edge source.out -> never.in" },
    ],
  ]);
  (s.agent as any).delegateConfig = { workflowId: 1, computingUnitId: 1, userToken: "test" };
  (s.agent as any).executePostStepChanges = (TexeraAgent.prototype as any).executePostStepChanges.bind(s.agent);
  const execute = spyOn(executionTools, "executeWorkflowAndPersist").mockImplementation(
    async (_state, _config, options = {}) => {
      s.agent.stop();
      options.onResult?.("source", {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        result: [{ value: "late" }],
        resultMode: "table",
      });
      return { success: true, state: "Completed", opCount: 1, errorCount: 0 };
    }
  );
  try {
    const response = await s.agent.sendMessage("Prepare the workflow.");
    expect(response.stopped).toBe(true);
    expect(s.agent.getWorkflowState().getOperator("never")).toBeUndefined();
    expect(s.agent.getSnapshotStorage().getOperatorResult(s.agent.getHead(), "source")).toBeUndefined();
  } finally {
    execute.mockRestore();
  }
});

test("an execution failure permits retrieval but rejects the failed result", async () => {
  const s = session([
    [
      { type: "edit", changes: 'create operator source: scan("data/missing.csv")' },
      { type: "execute" },
      { type: "retrieve", view: "sample", operator_id: "source" },
    ],
  ]);
  (s.agent as any).executePostStepChanges = async () => {
    s.agent.getSnapshotStorage().setOperatorResult(s.agent.getHead()!, "source", {
      state: "Failed",
      inputTuples: 0,
      outputTuples: 0,
      resultMode: "error",
      error: "Missing source file data/missing.csv",
    });
    throw new Error("Engine stopped");
  };
  await s.agent.sendMessage("Read the file.");
  expect(s.outcomes[0].actions.map(a => a.status)).toEqual(["ok", "error", "error"]);
  expect(JSON.stringify(s.outcomes[0].actions[1].output)).toContain("Missing source file");
  expect(JSON.stringify(s.outcomes[0].actions[1].output)).toContain("Engine stopped");
});

test("LATEST preserves a retrieved table that a later action supersedes", async () => {
  const s = session([
    [
      { type: "edit", changes: 'create operator source: scan("data/old.csv")' },
      { type: "execute" },
      { type: "retrieve", view: "sample", operator_id: "source" },
      { type: "edit", changes: 'update operator source: scan("data/new.csv")' },
    ],
  ]);
  await s.agent.sendMessage("Read the old source, then revise it.");
  expect(s.outcomes[0].observe).toEqual([]);
  const text = JSON.stringify(
    assembleContext(
      s.agent.getVisibleReActSteps(),
      s.agent.getWorkflowState(),
      s.agent.getSnapshotStorage(),
      ContextMode.LATEST,
      {
        agentMode: AgentMode.NATIVE,
        messageLayout: "opSplit",
        thoughtReplay: true,
      }
    )
  );
  expect(text).toContain("result-1");
  expect(text).toContain("historical result; changed later in this call");
  expect(text).toContain("Check the next result.");
});

test("the step limit reports a missing Answer instead of returning an intermediate rationale", async () => {
  const s = session([]);
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [
        { type: "text", text: "I will inspect the graph." },
        {
          type: "tool-call",
          toolCallId: "limit",
          toolName: "dataflow",
          input: JSON.stringify({ reasoning: "Inspect the graph.", actions: [{ type: "inspect", target: "graph" }] }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  s.agent.updateSettings({ maxSteps: 1 });
  (s.agent as any).driver = new VercelToolUseDriver({ model });
  (s.agent as any).contextAssembler = () => [{ role: "user", content: "Inspect the graph." }];
  const response = await s.agent.sendMessage("Inspect the graph.");
  expect(response.error).toContain("without an answer action");
  expect(response.response).not.toBe("I will inspect the graph.");
  expect(model.doGenerateCalls).toHaveLength(1);
});

test("a plain-text plan gets one recorded protocol correction within the original step budget", async () => {
  const s = session([]);
  const seen: any[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      seen.push(options.prompt);
      const call = seen.length;
      return {
        content:
          call === 1
            ? [{ type: "text" as const, text: "I will inspect the file." }]
            : [
                {
                  type: "tool-call" as const,
                  toolCallId: `repair-${call}`,
                  toolName: "dataflow",
                  input: JSON.stringify({
                    reasoning: "Read and answer.",
                    actions:
                      call === 2
                        ? [edit, { type: "execute" }, { type: "retrieve", operator_id: "source", view: "sample" }]
                        : [{ type: "answer", content: "result-1" }],
                  }),
                },
              ],
        finishReason: {
          unified: call === 1 ? ("stop" as const) : ("tool-calls" as const),
          raw: call === 1 ? "stop" : "tool_calls",
        },
        usage: {
          inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  s.agent.updateSettings({ maxSteps: 3 });
  (s.agent as any).driver = new VercelToolUseDriver({ model });
  (s.agent as any).contextAssembler = ({ visibleSteps, workflowState, snapshotStorage, settings }: any) =>
    assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
      agentMode: AgentMode.NATIVE,
      messageLayout: "native",
    });
  const response = await s.agent.sendMessage("Read the file and answer.");
  expect(response.error).toBeUndefined();
  expect(response.response).toBe("result-1");
  expect(seen).toHaveLength(3);
  expect(JSON.stringify(seen[1])).toContain("No Dataflow action was called");
  expect(seen[1].slice(0, seen[0].length)).toEqual(seen[0]);
  expect(seen[2].slice(0, seen[1].length)).toEqual(seen[1]);
  expect(s.executions()).toBe(1);
  expect(response.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, cachedInputTokens: 6 });
  expect(s.agent.getVisibleReActSteps().filter(step => step.messageSource === "feedback")).toHaveLength(1);
});

test("plain-text protocol correction is bounded and never extends maxSteps", async () => {
  for (const [maxSteps, expectedCalls] of [
    [1, 1],
    [10, 2],
  ]) {
    const s = session([]);
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "I will inspect the file." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      },
    });
    s.agent.updateSettings({ maxSteps });
    (s.agent as any).driver = new VercelToolUseDriver({ model });
    const response = await s.agent.sendMessage("Read the file and answer.");
    expect(response.error).toContain("without an answer action");
    expect(model.doGenerateCalls).toHaveLength(expectedCalls);
    expect(s.executions()).toBe(0);
  }
});

test("import does not apply an edit that failed before committing any statements", async () => {
  const s = session([[{ type: "edit", changes: 'create operator source: scan("data/orders.csv")' }]]);
  await s.agent.sendMessage("Prepare the graph.");
  const trace = structuredClone(s.agent.getReActSteps());
  const result = trace.find(step => step.toolResults?.length)!.toolResults![0]!.output as DataflowActionsResult;
  result.status = "error";
  result.error = "Validation was cancelled";
  result.operators = [];
  result.actions[0].status = "error";
  result.actions[0].output = result.error;
  const imported = session([]);
  await imported.agent.importReActSteps(trace);
  expect(imported.agent.getWorkflowState().getAllOperators()).toEqual([]);
  expect(imported.executions()).toBe(0);
});

test("native multi-task requests preserve every earlier request as a prefix", async () => {
  const s = session([]);
  const requests: any[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      requests.push(structuredClone(options.prompt));
      const n = requests.length;
      const actions =
        n % 2 === 1
          ? [
              {
                type: "edit",
                changes: `${n === 1 ? "create" : "update"} operator source: scan("data/task-${n}.csv")`,
              },
              { type: "execute" },
              { type: "retrieve", operator_id: "source" },
            ]
          : [{ type: "answer", content: `Answer ${n / 2}` }];
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `prefix-${n}`,
            toolName: "dataflow",
            input: JSON.stringify({ reasoning: "Read the next result.", actions }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  (s.agent as any).driver = new VercelToolUseDriver({ model });
  (s.agent as any).contextAssembler = ({ visibleSteps, workflowState, snapshotStorage }: any) =>
    assembleContext(visibleSteps, workflowState, snapshotStorage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      messageLayout: "native",
      userTaskPlacement: "bottom",
    });
  await s.agent.sendMessage("First question: read the first file.");
  await s.agent.sendMessage("Second question: read a different file.");
  expect(requests).toHaveLength(4);
  for (let i = 1; i < requests.length; i++) {
    expect(requests[i].slice(0, requests[i - 1].length)).toEqual(requests[i - 1]);
  }
  expect(JSON.stringify(requests[3]).split("First question:")).toHaveLength(2);
  expect(JSON.stringify(requests[3]).split("Second question:")).toHaveLength(2);
  expect(JSON.stringify(requests[3])).toContain("operators completed");
  expect(JSON.stringify(requests[3])).toContain("result-1");
  expect(JSON.stringify(requests[3])).toContain("result-2");
});

test("a failed model turn is not advertised as a completed historical answer", async () => {
  const s = session([]);
  (s.agent as any).driver = {
    runTurn: async () => {
      throw new Error("Malformed model response");
    },
  };
  await s.agent.sendMessage("First task");
  await s.agent.handleDebugInput("Second task");
  expect((s.agent as any).completedStateTasks()).toEqual([]);
});
