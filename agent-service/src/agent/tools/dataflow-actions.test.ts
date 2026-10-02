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
import { createDataflowTool, prepareDataflowActions, runDataflowActions } from "./dataflow-actions";
import { TexeraAgent } from "../texera-agent";
import { AgentMode, ContextMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { assembleContext } from "../util/context-utils";
import type { DataflowAction, DataflowActionsResult } from "./dataflow-actions";

const edit = { type: "edit", changes: 'create operator source: scan("data/orders.csv")' };

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
  test("the public tool requires a rationale and a typed action list", () => {
    const schema = asSchema(createDataflowTool().inputSchema).jsonSchema as any;
    expect(schema.required).toEqual(["reasoning", "actions"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.actions.items.anyOf).toHaveLength(8);
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

  test("quoted action lists receive array-specific feedback without running or repairing them", () => {
    for (const actions of [JSON.stringify([edit]), '[{"type":"edit","changes":"broken']) {
      const result = prepareDataflowActions({ reasoning: "Load.", actions });
      expect(result.status).toBe("error");
      expect(result.actions).toEqual([]);
      expect(result.error).toContain("JSON array");
      expect(result.error).toContain("string");
      expect(result.error).toContain('"actions":[{"type":"execute"}]');
      expect(result.error).toContain("No actions ran");
    }
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
  test("targeted columns reuse a result and report unavailable profiles", async () => {
    const s = session([
      [
        { type: "edit", changes: 'create operator source: scan("x.csv")' },
        { type: "execute" },
        { type: "retrieve", operator_id: "source", view: "sample_stats", columns: ["value"] },
      ],
    ]);
    s.agent.updateSettings({ retrievalViews: ["sample_stats"] });
    await s.agent.sendMessage("Inspect a selected column.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[0].status).toBe("completed");
    const output = s.outcomes[0].actions.at(-1)!.output as any;
    expect(output.columns).toEqual(["value"]);
    expect(output.unavailable_profiles).toEqual(["value"]);
    expect(output.text).toContain("Data statistics unavailable");
  });

  test("unknown, empty and duplicate column selections fail without extra execution", async () => {
    for (const columns of [[], ["value", "value"]]) {
      const result = prepareDataflowActions({
        reasoning: "Inspect.",
        actions: [{ type: "retrieve", operator_id: "source", view: "sample", columns }],
      });
      expect(result.status).toBe("error");
    }
    const s = session([
      [{ type: "edit", changes: 'create operator source: scan("x.csv")' }, { type: "execute" }],
      [{ type: "retrieve", operator_id: "source", view: "sample", columns: ["unknown"] }],
    ]);
    await s.agent.sendMessage("Reject an unknown column.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[1].error).toContain("Unknown result columns: unknown");
  });

  test("selected execution preserves failed siblings and ignores unconnected old branches", async () => {
    const s = session([
      [
        {
          type: "edit",
          changes:
            'create operator source: scan("data/input.csv")\ncreate operator good: limit(1)\ncreate operator bad: process(fn=fail, doc="Old failed exploration")\n    def fail(df):\n        raise ValueError("old branch")\ncreate operator unfinished: limit(1)\ncreate edge source.out -> good.in\ncreate edge source.out -> bad.in[0]',
        },
      ],
      [
        { type: "execute", operator_ids: ["good"] },
        { type: "retrieve", operator_id: "good", view: "full" },
      ],
    ]);
    delete (s.agent as any).executePostStepChanges;
    (s.agent as any).buildExecutionConfig = () => ({ userToken: "test", workflowId: 321 });
    const requests: string[][] = [];
    const execute = spyOn(executionTools, "executeWorkflowAndPersist").mockImplementation(
      async (_state, _config, options) => {
        const ids = options?.opsToViewResult ?? [];
        requests.push(ids);
        for (const op of _state.getAllOperators().filter(op => ids.includes(op.operatorID)))
          options?.onResult?.(op.operatorID, {
            state: "Completed",
            inputTuples: 0,
            outputTuples: 1,
            resultMode: "table",
            result: [{ value: 7 }],
          });
        return { success: true, state: "Completed", opCount: ids.length, errorCount: 0 };
      }
    );
    try {
      await s.agent.sendMessage("Run the useful branch.");
      expect(s.outcomes[0].error).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0].sort()).toEqual(["good", "source"]);
      expect(s.outcomes[1].status).toBe("completed");
      expect((s.outcomes[1].actions[0].output as any).operators.map((op: any) => op.id).sort()).toEqual([
        "good",
        "source",
      ]);
      expect(s.agent.getWorkflowState().getAllOperators()).toHaveLength(4);
      expect(s.agent.getSnapshotStorage().getOperatorResult(s.agent.getHead(), "good")?.result).toEqual([{ value: 7 }]);
      expect(s.agent.getSnapshotStorage().getOperatorResult(s.agent.getHead(), "unfinished")).toBeUndefined();
    } finally {
      execute.mockRestore();
    }
  });

  test("selected execution validates required upstream inputs and rejects unknown targets", async () => {
    for (const operator_ids of [["unfinished"], ["unknown"]]) {
      const s = session([
        [{ type: "edit", changes: 'create operator source: scan("x.csv")\ncreate operator unfinished: limit(1)' }],
        [{ type: "execute", operator_ids }],
      ]);
      await s.agent.sendMessage("Validate the selected branch.");
      expect(s.executions()).toBe(0);
      expect(s.outcomes[1].status).toBe("error");
      expect(JSON.stringify(s.outcomes[1])).toContain(operator_ids[0]);
    }
  });

  test("an empty execution selection is rejected instead of executing everything", () => {
    const result = prepareDataflowActions({ reasoning: "Run.", actions: [{ type: "execute", operator_ids: [] }] });
    expect(result.status).toBe("error");
    expect(result.actions).toHaveLength(0);
  });

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

  test("budget reminders preserve prior context, reserve Answer, and reset for each user turn", async () => {
    const s = session([]);
    s.agent.updateSettings({ maxSteps: 5, thoughtReplay: false });
    const prompts: unknown[][] = [];
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async options => {
        const turnCall = (calls++ % 5) + 1;
        const prompt = structuredClone(options.prompt);
        const lastUser = [...prompt].reverse().find(m => m.role === "user");
        if (turnCall === 1) expect(JSON.stringify(lastUser)).toContain("Check the graph");
        if (turnCall === 3) expect(JSON.stringify(lastUser)).toContain("3 model calls remain");
        if (turnCall === 5) expect(JSON.stringify(lastUser)).toContain("1 model call remains");
        if (turnCall > 1) expect(prompts.at(-1)!).toEqual(prompt.slice(0, prompts.at(-1)!.length));
        prompts.push(prompt);
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `budget-${calls}`,
              toolName: "dataflow",
              input: JSON.stringify({
                reasoning: "Check the graph.",
                actions:
                  turnCall === 5
                    ? [{ type: "answer", content: "The graph is empty." }]
                    : [{ type: "inspect", target: "graph" }],
              }),
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
        thoughtReplay: false,
      });
    for (let turn = 0; turn < 2; turn++) {
      const response = await s.agent.sendMessage("Check the graph and answer.");
      expect(response.error).toBeUndefined();
      expect(response.response).toBe("The graph is empty.");
    }
    expect(calls).toBe(10);
    const feedback = s.agent.getVisibleReActSteps().filter(step => step.messageSource === "feedback");
    expect(feedback).toHaveLength(4);
    expect(new Set(feedback.map(step => step.messageId)).size).toBe(2);
  });

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

  test.each(["mock-model-id", "claude-sonnet-5.5", "claude-sonnet-5-5"])(
    "the SDK (%s) sees completed results and stops immediately on Answer",
    async modelId => {
      const s = session([]);
      let calls = 0;
      const model = new MockLanguageModelV3({
        modelId,
        doGenerate: async options => {
          calls++;
          expect(options.toolChoice).toEqual({ type: modelId === "mock-model-id" ? "required" : "auto" });
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
    }
  );
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
  expect(JSON.stringify(seen[1])).toContain('\\"type\\":\\"answer\\"');
  expect(JSON.stringify(seen[1])).toContain("user's required format");
  expect(seen[1].slice(0, seen[0].length)).toEqual(seen[0]);
  expect(seen[2].slice(0, seen[1].length)).toEqual(seen[1]);
  expect(s.executions()).toBe(1);
  expect(response.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, cachedInputTokens: 6 });
  expect(
    s.agent
      .getVisibleReActSteps()
      .filter(step => step.messageSource === "feedback" && step.content.includes("No Dataflow action was called"))
  ).toHaveLength(1);
});

test("Sonnet's text-only final answer gets an explicit Answer example and a bounded recovery", async () => {
  const s = session([]);
  s.agent.updateSettings({ maxSteps: 3 });
  let calls = 0;
  const model = new MockLanguageModelV3({
    modelId: "claude-sonnet-5.5",
    doGenerate: async options => {
      calls++;
      expect(options.toolChoice).toEqual({ type: "auto" });
      if (calls === 2) {
        expect(JSON.stringify(options.prompt)).toContain('\\"type\\":\\"answer\\"');
        expect(JSON.stringify(options.prompt)).toContain("user's required format");
      }
      return {
        content:
          calls === 1
            ? [{ type: "text", text: "**Final Answer: No**" }]
            : [
                {
                  type: "tool-call",
                  toolCallId: "answer-recovery",
                  toolName: "dataflow",
                  input: JSON.stringify({
                    reasoning: "Submit the answer.",
                    actions: [{ type: "answer", content: "**Final Answer: No**" }],
                  }),
                },
              ],
        finishReason: { unified: calls === 1 ? "stop" : "tool-calls", raw: calls === 1 ? "stop" : "tool_calls" },
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
  const response = await s.agent.sendMessage("Return No in the requested final-answer format.");
  expect(response.error).toBeUndefined();
  expect(response.response).toBe("**Final Answer: No**");
  expect(calls).toBe(2);
  expect(s.executions()).toBe(0);
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
