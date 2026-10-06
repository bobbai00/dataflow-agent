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
import * as compileApi from "../../api/compile-api";
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

const edit = { type: "edit", changes: 'source = scan("data/orders.csv")' };

describe("compact action observations", () => {
  async function receipt(action: DataflowAction, output: unknown, status: "ok" | "error" = "ok") {
    const result = prepareDataflowActions({ reasoning: "Check the result.", actions: [action] }, undefined, true);
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
    expect(text).toContain("250 operators: 250 executed, 0 cached");
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
    expect(text).toContain("4 operators: 2 executed, 0 cached");
    expect(text).toContain("**header** (operator, executed)");
    expect(text).toContain("check: header row repeats");
    expect(text).toContain("error EXECUTION_FAILED: File missing: orders.csv");
    expect(text).toContain("note: No completed result");
    expect(text).toContain("not run: total (source failed)");
    expect(text).toContain("error EXECUTION_FAILED: Engine stopped");
    expect(text).not.toContain("ordinary:");
  });

  test("edit observations report one line per change, then invalidations and unconnected inputs", async () => {
    const result = await receipt(edit as DataflowAction, {
      changes: [
        { change: "operator", operator_id: "source", operator: "scan", action: "updated" },
        { change: "operator", operator_id: "joined", operator: "join", action: "created" },
        { change: "operator", operator_id: "kept", operator: "filter", action: "unchanged" },
        { change: "operator", operator_id: "probe", operator: "limit", action: "deleted" },
        { change: "edge", edge: "source -> probe", action: "removed" },
        { change: "edge", edge: "source -> joined.left", action: "created" },
      ],
      unconnected_inputs: ["total.in", "pair.left", "pair.right"],
      invalidated_results: ["source", "total"],
    });
    expect(renderDataflowActionsResult(result).split("\n").slice(1)).toEqual([
      "operator source updated (scan)",
      "operator joined created (join)",
      "operator kept unchanged",
      "operator probe deleted",
      "edge source -> probe removed",
      "edge source -> joined.left created",
      "results invalidated: source, total",
      "total.in is unconnected; restate total with its inputs or delete it before executing.",
      "pair.left, pair.right are unconnected; restate pair with its inputs or delete it before executing.",
    ]);
  });

  test("rejected edits and skipped actions stay explicit, with no success acknowledgment", async () => {
    const result = prepareDataflowActions({ reasoning: "Load.", actions: [edit, { type: "execute" }] });
    await runDataflowActions(result, async () => ({
      status: "error",
      output: "Atomic edit rejected: missing operator.",
    }));
    const text = renderDataflowActionsResult(result);
    expect(text).toContain(
      "1. edit: error\nNo changes were applied.\n- error EDIT_REJECTED: Atomic edit rejected: missing operator."
    );
    expect(text).toContain("2. execute: skipped (action 1 failed)");
    expect(text).not.toContain("Applied");
  });

  test("requested historical results preserve their exact contents and provenance", async () => {
    const result = await receipt(
      { type: "retrieve", operator_id: "total", view: "full" },
      {
        operator_blocks: [
          { id: "total", kind: "aggregate", state: "saved", result: "1 row × 1 column (saved by task 2)" },
        ],
        operator_id: "total",
        revision: "rev-2",
        historical_state: { task_id: 2, operator_id: "total" },
        superseded_in_call: true,
        text: '1 row\n{"amount":42}',
      }
    );
    expect(renderDataflowActionsResult(result)).toBe(
      '### 1. retrieve total: ok\n- **total** (aggregate, saved)\n  - result: 1 row × 1 column (saved by task 2)\n1 row\n{"amount":42}\n- note: this result was superseded later in the call.'
    );
  });
});

describe("receipt details found in live runs", () => {
  async function receipt(action: DataflowAction, output: unknown, status: "ok" | "error" = "ok") {
    const result = prepareDataflowActions({ reasoning: "Check.", actions: [action] }, undefined, true);
    await runDataflowActions(result, async () => ({ status, output }));
    return renderDataflowActionsResult(result);
  }

  test("the graph index shortens singular and saved shapes", async () => {
    const text = await receipt(
      { type: "inspect", target: "graph", operator_ids: ["one", "copy"] },
      {
        operators: [],
        unconnected_inputs: [],
        operator_blocks: [
          { id: "one", kind: "aggregate", state: "executed", result: "1 row × 1 column", columns: ["n int64"] },
          {
            id: "copy",
            kind: "aggregate",
            state: "saved",
            inputs: [{ id: "one" }],
            origin: "task 3",
            result: "8 rows × 2 columns (saved by task 3)",
            columns: ["unit str", "score int64"],
          },
        ],
      }
    );
    expect(text).toContain("| one | aggregate |  | 1 × 1 |  | n |");
    expect(text).toContain("| copy | aggregate | one | 8 × 2 (saved by task 3) | 3 | unit, score |");
  });

  test("the versions list names task ranges, restores, input changes and recomputations", async () => {
    const version = (task_id: number, revision: string, hash: string, extra = {}) => ({
      task_id,
      revision,
      subgraph_hash: hash,
      expression: `map(${revision})`,
      ...extra,
    });
    const text = await receipt(
      {
        type: "inspect",
        target: "state",
        operator_id: "score",
        task_id: null,
        include_implementation: false,
        view: null,
      },
      {
        operator_id: "score",
        versions: [
          version(1, "a", "x", { through_task_id: 2 }),
          version(3, "b", "y"),
          version(4, "b", "z"),
          version(5, "a", "x"),
          version(6, "a", "x"),
        ],
      }
    );
    expect(text).toContain("| tasks | change | definition |");
    expect(text).toContain("| 1-2 | created | `map(a)` |");
    expect(text).toContain("| 3 | updated | `map(b)` |");
    expect(text).toContain("| 4 | inputs changed | `map(b)` |");
    expect(text).toContain("| 5 | restored from task 2 | `map(a)` |");
    expect(text).toContain("| 6 | recomputed | `map(a)` |");
  });

  test("a restore is reported by its note", async () => {
    const text = await receipt(
      { type: "edit", changes: "eligible = at(eligible, task=2)" },
      {
        changes: [],
        version_notes: ["Restored eligible's task-2 definition in place."],
        invalidated_results: ["eligible"],
        unconnected_inputs: [],
        operator_blocks: [],
      }
    );
    expect(text).toContain("results invalidated: eligible\nnote: Restored eligible's task-2 definition in place.");
  });

  test("a rejected edit says once that nothing was applied", async () => {
    const text = await receipt(
      { type: "edit", changes: "b = limit(b, 1)" },
      "Line 1: b cannot be its own input. Give the new table its own name, for example `b_2 = limit(b, ...)`. No changes were applied.",
      "error"
    );
    expect(text.split("No changes were applied.").length - 1).toBe(1);
    expect(text).toContain("- error EDIT_REJECTED: Line 1: b cannot be its own input.");
  });
});

describe("ordered dataflow actions", () => {
  test("historical retrieval honors the same available views as current retrieval", () => {
    const schema = asSchema(createDataflowTool(["sample"], true).inputSchema).jsonSchema as any;
    const retrieves = schema.properties.actions.items.anyOf.filter((a: any) => a.properties.type.const === "retrieve");
    expect(retrieves).toHaveLength(2);
    for (const retrieve of retrieves) expect(retrieve.properties.view.enum).toEqual(["sample"]);
    const inspect = schema.properties.actions.items.anyOf.find((a: any) => a.properties.target?.const === "state");
    expect(inspect.properties.view.anyOf[0].enum).toEqual(["sample"]);
    const input = {
      reasoning: "Read.",
      actions: [
        {
          type: "inspect",
          target: "state",
          operator_id: "total",
          task_id: 1,
          include_implementation: false,
          view: "full",
        },
      ],
    };
    expect(prepareDataflowActions(input, ["sample"], true).error).toContain("unavailable");
    input.actions[0].view = "sample";
    expect(prepareDataflowActions(input, ["sample"], true).status).toBe("pending");
  });

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
      {
        type: "inspect",
        target: "state",
        task_id: null,
        operator_id: "total",
        include_implementation: true,
        view: null,
      },
      {
        type: "inspect",
        target: "state",
        task_id: 1,
        operator_id: "total",
        include_implementation: false,
        view: "full",
      },
    ];
    expect(prepareDataflowActions({ reasoning: "Read earlier state.", actions }).status).toBe("error");
    expect(prepareDataflowActions({ reasoning: "Read earlier state.", actions }, undefined, true).status).toBe(
      "pending"
    );
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
      asSchema(createDataflowTool(["full", "sample", "sample_stats"], true).inputSchema).jsonSchema
    );
    expect(s.agent.getSettings().systemPrompt).toContain("`new_name = at(name, task=N)`");
  });
  test("the public tool requires a rationale and a typed action list", () => {
    const schema = asSchema(createDataflowTool().inputSchema).jsonSchema as any;
    expect(schema.required).toEqual(["reasoning", "actions"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.actions.items.anyOf).toHaveLength(12);
    expect(schema.properties.edits).toBeUndefined();
    const editSchema = schema.properties.actions.items.anyOf.find((a: any) => a.properties.type.const === "edit");
    expect(Object.keys(editSchema.properties)).toEqual(["type", "changes"]);
  });

  test("system-info exports the same action schema sent to the model", () => {
    const s = session([]);
    const exported = s.agent.getSystemInfo().tools.find(tool => tool.name === "dataflow");
    expect(exported?.inputSchema).toEqual(
      asSchema(createDataflowTool(["full", "sample", "sample_stats"]).inputSchema).jsonSchema
    );
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
        { type: "edit", changes: 'good = scan("ok.csv")\nbad = scan("missing.csv")' },
        { type: "execute" },
        { type: "retrieve", view: "sample", operator_id: "bad" },
        { type: "retrieve", view: "sample", operator_id: "good" },
        { type: "edit", changes: 'never = scan("never.csv")' },
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
      expect(result.error).toContain(
        type === "delete" ? '"changes":"del <name>"' : '"changes":"<name> = <operator>(<inputs>, ...)"'
      );
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
      output: action.type === "answer" && "content" in action ? action.content : "",
    }));
    expect(result.answer).toBe("42");
    expect(result.status).toBe("completed");
  });
});

describe("answers composed from a table and column-scoped retrieval", () => {
  test("an answer with from closes a batch after execute; with content it stands alone", () => {
    const composed = prepareDataflowActions({
      reasoning: "Build and report.",
      actions: [{ type: "edit", changes: 't = scan("a.csv")' }, { type: "execute" }, { type: "answer", from: "t[:2]" }],
    });
    expect(composed.status).toBe("pending");
    const notLast = prepareDataflowActions({
      reasoning: "x",
      actions: [{ type: "answer", from: "t" }, { type: "execute" }],
    });
    expect(notLast.error).toContain("last action");
    const withContent = prepareDataflowActions({
      reasoning: "x",
      actions: [{ type: "execute" }, { type: "answer", content: "42" }],
    });
    expect(withContent.error).toContain("answer with content must be the only action");
    expect(withContent.error).toContain("answer with from");
    const twice = prepareDataflowActions({
      reasoning: "x",
      actions: [
        { type: "answer", from: "t" },
        { type: "answer", content: "42" },
      ],
    });
    expect(twice.error).toContain("One answer per call");
    const scoped = prepareDataflowActions({
      reasoning: "x",
      actions: [{ type: "retrieve", operator_id: "t", view: "full", columns: ["a", "b"] }],
    });
    expect(scoped.status).toBe("pending");
    const emptyScope = prepareDataflowActions({
      reasoning: "x",
      actions: [{ type: "retrieve", operator_id: "t", view: "full", columns: [] }],
    });
    expect(emptyScope.error).toContain("retrieve");
    const badFrom = prepareDataflowActions({ reasoning: "x", actions: [{ type: "answer", from: "" }] });
    expect(badFrom.error).toContain("answer");
  });

  test("the runtime composes the answer from the executed table and refuses what it cannot answer from", async () => {
    const s = session([
      [{ type: "edit", changes: 't = scan("data/t.csv")' }, { type: "execute" }, { type: "answer", from: "t" }],
    ]);
    const response = await s.agent.sendMessage("Report the value.");
    expect(s.outcomes[0].status).toBe("completed");
    expect(s.outcomes[0].answer).toBe('{"value":"result-1"}');
    expect(response.response).toBe('{"value":"result-1"}');
    expect(renderDataflowActionsResult(s.outcomes[0])).toContain(
      'Answer composed from t.\nanswer: {"value":"result-1"}'
    );
    const two = session([
      [
        { type: "edit", changes: 'a = scan("data/a.csv")\nb = scan("data/b.csv")' },
        { type: "execute" },
        { type: "answer", from: "first=a; second=b[value]" },
      ],
    ]);
    const twoResponse = await two.agent.sendMessage("Report both.");
    expect(two.outcomes[0].answer).toBe('{"first":{"value":"result-1"},"second":{"value":"result-1"}}');
    expect(twoResponse.response).toBe('{"first":{"value":"result-1"},"second":{"value":"result-1"}}');
    expect(renderDataflowActionsResult(two.outcomes[0])).toContain("Answer composed from a, b.");
    const missing = session([[{ type: "answer", from: "nothing" }]]);
    await missing.agent.sendMessage("Report.");
    expect(missing.outcomes[0].status).toBe("error");
    expect(missing.outcomes[0].error).toContain("no table `nothing`");
    expect(missing.outcomes[0].answer).toBeUndefined();
    const unknownColumn = session([
      [
        { type: "edit", changes: 't = scan("data/t.csv")' },
        { type: "execute" },
        { type: "retrieve", operator_id: "t", view: "full", columns: ["nope"] },
      ],
    ]);
    await unknownColumn.agent.sendMessage("Read.");
    expect(unknownColumn.outcomes[0].error).toContain('UNKNOWN_COLUMN: `t` has no column "nope". Its columns: value.');
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
  agent.updateSettings({ agentMode: AgentMode.NATIVE, retrievalViews: ["full", "sample", "sample_stats"] });
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
  test("reference lookups preserve the graph and do not become answer source reads", async () => {
    const s = session([
      [{ type: "inspect", target: "reference", topic: "operators", operator_names: ["join", "process"] }],
      [{ type: "inspect", target: "reference", topic: "example", example: "single" }],
      [{ type: "answer", content: "Read the relevant documentation." }],
    ]);
    s.agent.updateSettings({ stateHistory: true, taskContext: "dependencies", nativePromptDetail: "on_demand" });
    const before = structuredClone(s.agent.getWorkflowState().getWorkflowContent());
    await s.agent.sendMessage("Inspect the reference.");
    expect(s.agent.getWorkflowState().getWorkflowContent()).toEqual(before);
    expect(s.executions()).toBe(0);
    expect(s.outcomes[0].references).toEqual([]);
    expect(s.outcomes[0].observe).toEqual([]);
    expect(renderDataflowActionsResult(s.outcomes[0])).toContain("reference join, process: ok");
    expect(renderDataflowActionsResult(s.outcomes[0])).toContain("join(");
    expect(renderDataflowActionsResult(s.outcomes[0])).not.toContain("pivot(");
  });

  test("unconfirmed answer sources remain candidates until a branch is explicitly selected", async () => {
    const batches: DataflowAction[][] = [
      [{ type: "edit", changes: 'source = scan("data.csv")\nprobe = scan("probe.csv")' }],
      [
        { type: "execute", operator_ids: ["source", "probe"] },
        { type: "retrieve", operator_id: "source", view: "sample" },
        { type: "retrieve", operator_id: "probe", view: "sample" },
      ],
      [{ type: "answer", content: "An answer without declared sources." }],
    ];
    const s = session(batches);
    s.agent.updateSettings({ stateHistory: true, taskContext: "dependencies" });
    await s.agent.sendMessage("First task.");
    batches.splice(
      0,
      batches.length,
      [{ type: "inspect", target: "task", task_id: 1, operator_id: null, include_implementation: true, view: "full" }],
      [{ type: "answer", content: "Sources need selection." }]
    );
    await s.agent.sendMessage("Inspect the first task.");
    const automatic = s.outcomes[3].actions[0].output as any;
    expect(automatic.selection_basis).toBe("observed_reads");
    expect(automatic.output_roots.roots).toHaveLength(2);
    expect(automatic.dataflows).toEqual([]);
    expect(renderDataflowActionsResult(s.outcomes[3])).toContain("Select");
    batches.splice(
      0,
      batches.length,
      [
        {
          type: "inspect",
          target: "task",
          task_id: 1,
          operator_id: "source",
          include_implementation: false,
          view: "full",
        },
      ],
      [{ type: "answer", content: "Selected the source." }]
    );
    await s.agent.sendMessage("Inspect the selected branch.");
    const selected = s.outcomes[5].actions[0].output as any;
    expect(selected.selection_basis).toBe("selected");
    expect(selected.dataflows[0].operators.map((op: any) => op.operator_id)).toEqual(["source"]);
    expect(selected.dataflows[0].observations.map((op: any) => op.operator_id)).toEqual(["source"]);
    expect(s.executions()).toBe(1);
  });

  test("history tools expose scoped graph inspection and reject whole-session discovery", () => {
    const schema = asSchema(createDataflowTool(["sample"], true).inputSchema).jsonSchema as any;
    const graphs = schema.properties.actions.items.anyOf.filter((a: any) => a.properties.target?.const === "graph");
    expect(graphs).toHaveLength(1);
    expect(graphs[0].required).toContain("operator_ids");
    expect(
      prepareDataflowActions(
        { reasoning: "Inspect.", actions: [{ type: "inspect", target: "graph" }] },
        ["sample"],
        true
      ).status
    ).toBe("error");
    expect(
      prepareDataflowActions(
        { reasoning: "Inspect.", actions: [{ type: "inspect", target: "graph", operator_ids: ["source"] }] },
        ["sample"],
        true
      ).status
    ).toBe("pending");
  });

  test("declared answer roots retrieve a complete saved branch after later edits and deletion", async () => {
    const batches: DataflowAction[][] = [
      [
        {
          type: "edit",
          changes:
            'source = process(fn=load, doc="Original working rows")\n    def load():\n        return pd.DataFrame({"value": [1]})\neligible = limit(source, 5)\ntotal = project(eligible, keep=["value"])\nprobe = scan("unrelated.csv")',
        },
        { type: "execute" },
        { type: "retrieve", operator_id: "probe", view: "sample" },
      ],
      [{ type: "answer", content: "First result.", operator_ids: ["total"] }],
    ];
    const s = session(batches);
    s.agent.updateSettings({ stateHistory: true, stateLedger: false, taskContext: "dependencies" });
    await s.agent.sendMessage("Use the original working rows.");
    const original = s.agent.getTaskHistory()[0];
    expect(original.output_roots?.basis).toBe("answer");
    expect(original.output_roots?.roots.map(root => root.operator_id)).toEqual(["total"]);
    batches.splice(
      0,
      batches.length,
      [{ type: "edit", changes: 'source = scan("changed.csv")\ndel total' }],
      [{ type: "answer", content: "Changed the current graph." }]
    );
    await s.agent.sendMessage("Change the source and remove the old report.");
    const current = structuredClone(s.agent.getWorkflowState().getWorkflowContent());
    batches.splice(
      0,
      batches.length,
      [
        { type: "inspect", target: "task", task_id: 1, operator_id: null, include_implementation: true, view: "full" },
        { type: "inspect", target: "task", task_id: 1 },
      ],
      [{ type: "answer", content: "Inspected original task." }]
    );
    await s.agent.sendMessage("Retrieve task 1's computation.");
    const output = s.outcomes[4].actions[0].output as any;
    expect(output.selection_basis).toBe("answer");
    expect(output.dataflows).toHaveLength(1);
    expect(output.dataflows[0].roots).toEqual(["total"]);
    expect(output.dataflows[0].operators.map((op: any) => op.operator_id)).toEqual(["source", "eligible", "total"]);
    expect(output.dataflows[0].edges).toHaveLength(2);
    const text = renderDataflowActionsResult(s.outcomes[4]);
    expect(text).toContain("def load");
    expect(text).toContain('"value": [1]');
    expect(text).toContain("result-1");
    expect(text).not.toContain("changed.csv");
    const simple = s.outcomes[4].actions[1].output as any;
    expect(simple.dataflows[0].operators.every((op: any) => !op.implementation)).toBe(true);
    expect(simple.dataflows[0].observations).toEqual([]);
    expect(s.agent.getWorkflowState().getWorkflowContent()).toEqual(current);
    expect(s.executions()).toBe(1);
    expect(s.agent.getTaskHistory()[2].consulted_tasks).toContain(1);
    expect(s.agent.getTaskHistory()[2].dependencies.map(edge => edge.task_id)).toEqual([1]);
  });

  test("answer provenance rejects unknown or unavailable sources atomically, then allows correction", async () => {
    for (const operator_ids of [["source"], ["source", "missing"]]) {
      const s = session([
        [{ type: "edit", changes: 'source = scan("data.csv")' }],
        [{ type: "answer", content: "Unverified.", operator_ids }],
        [{ type: "execute", operator_ids: ["source"] }],
        [{ type: "answer", content: "Checked.", operator_ids: ["source"] }],
      ]);
      s.agent.updateSettings({ stateHistory: true });
      await s.agent.sendMessage("Answer with valid provenance.");
      expect(s.outcomes[1].status).toBe("error");
      expect(s.outcomes[1].error).toContain("no completed result");
      expect(s.outcomes[1].references).toEqual([]);
      expect(s.outcomes[3].answer).toBe("Checked.");
      expect(s.agent.getTaskHistory()[0].output_roots?.roots.map(root => root.operator_id)).toEqual(["source"]);
    }
  });

  test("task views and answer source declarations respect session availability and uniqueness", async () => {
    const request = (action: DataflowAction, views: ("sample" | "full")[] = ["sample"], history = true) =>
      prepareDataflowActions({ reasoning: "Read saved work.", actions: [action] }, views, history);
    const inspection: DataflowAction = {
      type: "inspect",
      target: "task",
      task_id: 1,
      operator_id: null,
      include_implementation: false,
      view: "full",
    };
    expect(request(inspection).error).toContain("unavailable");
    expect(request({ ...inspection, view: null }).status).toBe("pending");
    expect(request({ ...inspection, operator_id: ["a", "a"], view: null }).error).toContain("unique");
    expect(request({ type: "answer", content: "Done.", operator_ids: ["a", "a"] }).error).toContain("unique");
    expect(request({ type: "answer", content: "Done.", operator_ids: ["a"] }, ["sample"], false).status).toBe("error");
    const schema = (await asSchema(createDataflowTool(["sample"], true).inputSchema).jsonSchema) as any;
    const taskSchema = schema.properties.actions.items.anyOf.find(
      (s: any) => s.properties.target?.const === "task" && s.properties.view
    );
    expect(taskSchema.properties.view.anyOf[0].enum).toEqual(["sample"]);
  });

  test("ordinary ReAct shows selection scope before execution and on reads with the ledger and statistics disabled", async () => {
    const s = session([
      [
        {
          type: "edit",
          changes:
            'source = scan("data/toy.csv")\nlimited = limit(source, 5)\ndisplayed = project(limited, keep=["value"])',
        },
        { type: "inspect", target: "operator", operator_id: "displayed", include_implementation: false },
      ],
      [
        { type: "execute", operator_ids: ["displayed"] },
        { type: "retrieve", operator_id: "displayed", view: "sample" },
      ],
    ]);
    s.agent.updateSettings({ stateLedger: false, flowEvidence: false, dataEvidence: false });
    await s.agent.sendMessage("Inspect and read the selected table.");
    const before = renderDataflowActionsResult(s.outcomes[0]);
    const after = renderDataflowActionsResult(s.outcomes[1]);
    expect(before).toContain('scope: limit "limited": n=5');
    expect(before).toContain("unknown rows");
    expect(after).toContain('scope: limit "limited": n=5');
    // The mock has no engine proof tying the child's input to the parent's
    // version, so it must not invent a retention measurement.
    expect(after).toContain('input "source" (unknown rows)');
    expect(before + after).not.toMatch(/#### Task|inputs from earlier tasks:|flow:|check=/);
    expect(s.executions()).toBe(1);
    expect(JSON.stringify(s.contexts.at(-1))).toContain("scope:");
    for (const mode of [ContextMode.DELTA, ContextMode.LATEST])
      for (const messageLayout of ["native", "opSplit", "opBlock"] as const) {
        const messages = assembleContext(
          s.agent.getVisibleReActSteps(),
          s.agent.getWorkflowState(),
          s.agent.getSnapshotStorage(),
          mode,
          { agentMode: AgentMode.NATIVE, messageLayout, dataEvidence: false, flowEvidence: false }
        );
        expect(JSON.stringify(messages)).toContain('scope: limit \\"limited\\": n=5');
      }
  });

  test("saved and forked selection scopes use historical definitions and leave earlier observations unchanged", async () => {
    const batches: DataflowAction[][] = [
      [
        {
          type: "edit",
          changes: 'source = scan("data/toy.csv")\nselected = limit(source, 5)',
        },
        { type: "execute" },
        { type: "retrieve", operator_id: "selected", view: "full" },
      ],
      [{ type: "answer", content: "First result." }],
    ];
    const s = session(batches);
    s.agent.updateSettings({ stateHistory: true, stateLedger: false });
    await s.agent.sendMessage("Select up to five rows.");
    const first = renderDataflowActionsResult(s.outcomes[0]);
    batches.splice(
      0,
      batches.length,
      [
        { type: "edit", changes: "selected = limit(source, 2)" },
        { type: "execute" },
        { type: "retrieve", operator_id: "selected", view: "full" },
      ],
      [{ type: "answer", content: "Second result." }]
    );
    await s.agent.sendMessage("Now select up to two rows.");
    const second = renderDataflowActionsResult(s.outcomes[2]);
    batches.splice(
      0,
      batches.length,
      [
        {
          type: "inspect",
          target: "state",
          task_id: 1,
          operator_id: "selected",
          include_implementation: false,
          view: "full",
        },
        { type: "edit", changes: "selected_old = at(selected, task=1)" },
        { type: "retrieve", operator_id: "selected_old", view: "full" },
      ],
      [{ type: "answer", content: "Compared saved state." }]
    );
    await s.agent.sendMessage("Inspect the earlier selection.");
    const saved = renderDataflowActionsResult(s.outcomes[4]);
    expect(first).toContain('scope: limit "selected": n=5');
    expect(second).toContain('scope: limit "selected": n=2');
    expect(saved).toContain('scope: limit "selected": n=5');
    expect(saved).toContain('scope: limit "selected_old": n=5');
    expect(renderDataflowActionsResult(s.outcomes[0])).toBe(first);
    expect(s.executions()).toBe(2);
    expect(saved).not.toContain("#### Task");
    const dependency = s.agent.getTaskHistory()[2].dependencies.find(edge => edge.task_id === 1)!;
    expect(dependency.references.every(ref => ["source", "selected"].includes(ref.operator_id!))).toBe(true);
    expect(s.outcomes[4].references?.find(ref => ref.actionIndex === 3 && ref.kind === "read")).toMatchObject({
      operatorId: "selected",
      savedTaskId: 1,
    });
  });

  test("selected execution preserves failed siblings and ignores unconnected old branches", async () => {
    const s = session([
      [
        {
          type: "edit",
          changes:
            'source = scan("data/input.csv")\ngood = limit(source, 1)\nbad = process(source, fn=fail, doc="Old failed exploration")\n    def fail(df):\n        raise ValueError("old branch")\nscratch = scan("data/scratch.csv")\nunfinished = limit(scratch, 1)',
        },
        { type: "edit", changes: "del scratch" },
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
        [
          { type: "edit", changes: 'source = scan("x.csv")\nscratch = scan("y.csv")\nunfinished = limit(scratch, 1)' },
          { type: "edit", changes: "del scratch" },
        ],
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

  test("selected execution exposes a provider-compatible schema and rejects duplicate targets locally", () => {
    for (const history of [false, true]) {
      const schema = asSchema(createDataflowTool(undefined, history).inputSchema).jsonSchema as any;
      const selected = schema.properties.actions.items.anyOf.find(
        (a: any) => a.properties.type.const === "execute" && a.properties.operator_ids
      );
      expect(selected.properties.operator_ids).not.toHaveProperty("uniqueItems");
      const result = prepareDataflowActions(
        { reasoning: "Run.", actions: [{ type: "execute", operator_ids: ["total", "total"] }] },
        undefined,
        history
      );
      expect(result.status).toBe("error");
      expect(result.error).toContain("unique");
      expect(result.actions).toHaveLength(0);
    }
  });

  test("changing retrieval views reads the same result and freezes each observation", async () => {
    const s = session([
      [
        { type: "edit", changes: 'source = scan("x.csv")' },
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
  test("later tasks inspect, copy and retrieve the earlier result without executing or changing the baseline", async () => {
    const batches: DataflowAction[][] = [
      [{ type: "edit", changes: 'source = scan("old.csv")' }, { type: "execute" }],
      [{ type: "answer", content: "First result saved." }],
    ];
    const s = session(batches);
    s.agent.updateSettings({ stateHistory: true });
    await s.agent.sendMessage("Read the baseline.");
    batches.splice(
      0,
      batches.length,
      [{ type: "edit", changes: 'source = scan("new.csv")' }, { type: "execute" }],
      [{ type: "answer", content: "Second result saved." }]
    );
    await s.agent.sendMessage("Use a new input.");
    batches.splice(
      0,
      batches.length,
      [
        {
          type: "inspect",
          target: "state",
          task_id: null,
          operator_id: "source",
          include_implementation: true,
          view: null,
        },
      ],
      [
        { type: "edit", changes: "earlier = at(source, task=1)" },
        { type: "retrieve", operator_id: "earlier", view: "full" },
        {
          type: "inspect",
          target: "state",
          task_id: 1,
          operator_id: "source",
          include_implementation: false,
          view: "sample",
        },
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
    expect((reads.actions[2].output as any).versions[0].observation.view).toBe("sample");
    const restored = session([]);
    restored.agent.updateSettings({ stateHistory: true });
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
    changes: 'source = scan("data/orders.csv")\nlast = limit(source, 1)',
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
      [{ type: "edit", changes: 'source = scan("data/new.csv")' }, read, { type: "execute" }],
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
          changes: 'kept = filter(source, fn=keep, doc="Keeps every row")\n    def keep(row):\n        return True',
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
          changes: "good = limit(source, 1)\nbad = limit(missing, 1)\nblocked = limit(bad, 1)",
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
    expect(output.match(/(?<=### )\d+\. [^\n:]+: (?:ok|error|skipped)/g)).toEqual([
      "1. inspect graph: ok",
      "2. edit: error",
      "3. execute: skipped",
      "4. retrieve good: skipped",
    ]);
  });

  test("DELTA appends observations without changing prior tool frames after edits and cache reads", async () => {
    const s = session([
      [source, { type: "execute" }, read],
      [read, { type: "inspect", target: "graph" }],
      [{ type: "edit", changes: 'source = scan("data/new.csv")' }, { type: "execute" }, read],
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
      [{ type: "edit", changes: "source = scan()" }, { type: "execute" }, read],
      [read],
    ]);
    await s.agent.sendMessage("Try a bad revision.");
    expect(s.executions()).toBe(1);
    expect(s.outcomes[1].actions.map(a => a.status)).toEqual(["error", "skipped", "skipped"]);
    expect(s.outcomes[2].status).toBe("completed");
  });
});

describe("action history and model loop", () => {
  const source: DataflowAction = { type: "edit", changes: 'source = scan("data/old.csv")' };
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
      [read, { type: "edit", changes: 'source = scan("data/new.csv")' }, { type: "execute" }, read],
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
    expect(text).toContain("RESULT_NOT_RUN");
    expect(text).toContain("Inspection @ Event");
    expect(text).toContain("data/old.csv");
  });

  test("import replays completed edits, skips unrun edits, and never executes", async () => {
    const s = session([[source, read, { type: "edit", changes: 'skipped = scan("data/skipped.csv")' }]]);
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
        action.program = action.changes;
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
      { type: "edit", changes: 'source = scan("data/orders.csv")' },
      { type: "execute" },
      { type: "edit", changes: "never = limit(source, 1)" },
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
      { type: "edit", changes: 'source = scan("data/missing.csv")' },
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
      { type: "edit", changes: 'source = scan("data/old.csv")' },
      { type: "execute" },
      { type: "retrieve", view: "sample", operator_id: "source" },
      { type: "edit", changes: 'source = scan("data/new.csv")' },
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
  const s = session([[{ type: "edit", changes: 'source = scan("data/orders.csv")' }]]);
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
  s.agent.updateSettings({ stateHistory: true });
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
                changes: `source = scan("data/task-${n}.csv")`,
              },
              { type: "execute" },
              { type: "retrieve", operator_id: "source", view: "full" },
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
  // This is a mocked model/engine test; do not contact a developer's compiler.
  const compilation = spyOn(compileApi, "compileWorkflowAsync").mockResolvedValue(null);
  try {
    await s.agent.sendMessage("First question: read the first file.");
    await s.agent.sendMessage("Second question: read a different file.");
    expect(requests).toHaveLength(4);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].slice(0, requests[i - 1].length)).toEqual(requests[i - 1]);
    }
    expect(JSON.stringify(requests[3]).split("First question:")).toHaveLength(2);
    expect(JSON.stringify(requests[3]).split("Second question:")).toHaveLength(2);
    expect(JSON.stringify(requests[3])).toMatch(/operators?( in scope)?:/);
    expect(JSON.stringify(requests[3])).toContain("result-1");
    expect(JSON.stringify(requests[3])).toContain("result-2");
    expect(JSON.stringify(requests[3])).not.toContain("changed_operators");
  } finally {
    compilation.mockRestore();
  }
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
