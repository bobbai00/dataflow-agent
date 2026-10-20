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

import { describe, expect, test } from "bun:test";
import { TexeraAgent } from "../texera-agent";
import { AgentMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { prepareDataflowActions } from "./dataflow-actions";
import { topologicalOperators } from "../native/observation-format";
import { executionFingerprints, workflowExecutionPlan } from "../native/result-versions";
import { createHash } from "node:crypto";

function rig(turns: any[][][], transform?: (outcomes: any[]) => any[]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const results: any[] = [];
  const executions: string[][] = [];
  const agent = new TexeraAgent({
    agentId: "json-contract-test",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      async runTurn(input) {
        for (const [turn, requests] of turns.entries()) {
          const calls = requests.map((actions, i) => ({
            toolName: "dataflow",
            toolCallId: `${turn}-${i}`,
            input: { reasoning: "Compute and check.", actions },
          }));
          const prepared = await Promise.all(
            calls.map(async c => ({ toolCallId: c.toolCallId, output: await input.tools.dataflow.execute(c.input) }))
          );
          const outcomes = transform ? transform(prepared) : prepared;
          await input.onStepFinish({ text: "", toolCalls: calls, toolResults: outcomes });
          results.push(...outcomes.map(r => r.output));
          if (input.getFinalAnswer?.() !== undefined) break;
        }
        return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
      },
    },
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    nativeFormat: "json",
    retrievalViews: ["full", "sample", "sample_stats"],
  } as any);
  (agent as any).executePostStepChanges = async (
    _calls: unknown,
    _results: unknown,
    explicit: boolean,
    ids?: string[]
  ) => {
    expect(explicit).toBe(true);
    executions.push(ids ?? []);
    const state = agent.getWorkflowState();
    const selected = ids ? state.getSubDAGForTargets(ids).operators : state.getAllOperators();
    const hashes = executionFingerprints(workflowExecutionPlan(state.getWorkflowContent()));
    const executionId = String(executions.length);
    for (const op of topologicalOperators(selected)) {
      agent.getSnapshotStorage().setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        totalRowCount: 1,
        resultMode: "table",
        executionContext: {
          workflowId: 1,
          executionId,
          ...hashes.get(op.operatorID)!,
          inputs: (op.nativeOp?.inputs ?? []).map((id, i) => ({
            operatorId: id,
            inputPort: i,
            outputPort: 0,
            executionId,
          })),
        },
        materialization: { executionId, outputPort: 0, cached: false },
        result: [{ value: 13.1628 }],
        resultSchema: [{ name: "value", type: "float64", encoding: "PLAIN" }],
      });
    }
  };
  return { agent, results, executions };
}
const process = (id: string, inputs: string[] = []) => ({
  type: "set",
  id,
  operator: "process",
  inputs,
  params: {
    code: `def compute(${inputs.length ? "frame" : ""}):\n    import pandas as pd\n    return pd.DataFrame({'value': [13.1628]})`,
    entry: "",
    doc: "",
  },
});
const scalar = (id: string) => ({ type: "answer", source: { id, column: "value", shape: "scalar", decimals: 4 } });

describe("structured native agent contract", () => {
  test("settings reject an unknown format atomically", () => {
    const s = rig([]);
    const old = s.agent.getSettings();
    expect(() => s.agent.updateSettings({ nativeFormat: "not-a-format", maxSteps: 1 } as any)).toThrow();
    expect(s.agent.getSettings()).toEqual(old);
  });
  test("protocol hashes describe the actual session prompt and schema", () => {
    const s = rig([]);
    const info = s.agent.getSystemInfo();
    const dataflow = info.tools.find(tool => tool.name === "dataflow")!;
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(s.agent.getNativeProtocol()).toEqual({
      format: "json",
      toolSchemaSha256: hash(JSON.stringify({ inputSchema: dataflow.inputSchema, strict: false })),
      systemPromptSha256: hash(info.systemPrompt),
    });
    expect(dataflow.strict).toBe(false);
    const before = s.agent.getNativeProtocol()!.toolSchemaSha256;
    const mutableTool = (s.agent as unknown as { tools: { dataflow: { strict: boolean } } }).tools.dataflow;
    mutableTool.strict = true;
    expect(s.agent.getNativeProtocol()!.toolSchemaSha256).not.toBe(before);
    mutableTool.strict = false;
    s.agent.updateSettings({ nativeFormat: "expression" });
    expect(s.agent.getNativeProtocol()?.format).toBe("expression");
    expect(s.agent.getNativeProtocol()?.toolSchemaSha256).not.toBe(hash(JSON.stringify(dataflow.inputSchema)));
    const expression = s.agent.getSystemInfo().tools.find(tool => tool.name === "dataflow")!;
    expect(s.agent.getNativeProtocol()?.toolSchemaSha256).toBe(hash(JSON.stringify(expression.inputSchema)));
  });
  test("changing views reuses a complete current result without executing again", async () => {
    const s = rig([
      [[process("t"), { type: "read", ids: ["t"], view: "sample_stats", columns: null }]],
      [[{ type: "read", ids: ["t"], view: "full", columns: null }, scalar("t")]],
    ]);
    const response = await s.agent.sendMessage("Report the ratio.");
    expect(response.response).toBe("13.1628");
    expect(s.executions).toEqual([["t"]]);
    expect(s.results.every(result => result.status === "completed")).toBe(true);
  });
  test("switching formats on an authored workflow requires a fresh agent", async () => {
    const s = rig([[[process("t"), { type: "answer", content: "Created.", operator_ids: null }]]]);
    await s.agent.sendMessage("Create a table.");
    const before = s.agent.getSettings();
    expect(() => s.agent.updateSettings({ nativeFormat: "expression", maxSteps: 1 })).toThrow("fresh");
    expect(s.agent.getSettings()).toEqual(before);
  });
  test("source answer executes only its dependencies and returns a scalar", async () => {
    const s = rig([
      [[process("unused"), process("source"), process("answer_table", ["source"]), scalar("answer_table")]],
    ]);
    const response = await s.agent.sendMessage("Report the ratio to four decimals.");
    expect(s.results[0].error).toBeUndefined();
    expect(response.response).toBe("13.1628");
    expect(s.executions).toEqual([["answer_table"]]);
    expect(s.agent.getSnapshotStorage().getOperatorResult((s.agent as any).head, "unused")).toBeUndefined();
    expect(s.results[0].actions.every((a: any) => a.status === "ok")).toBe(true);
  });
  test("multiple calls share wire order and a forward-referenced atomic edit phase", async () => {
    const s = rig([
      [
        [process("answer_table", ["source"])],
        [process("source")],
        [{ type: "read", ids: ["answer_table"], view: "full", columns: null }, scalar("answer_table")],
      ],
    ]);
    const response = await s.agent.sendMessage("Report the ratio.");
    expect(s.results[0].error).toBeUndefined();
    expect(response.response).toBe("13.1628");
    expect(s.executions).toEqual([["answer_table"]]);
    expect(s.results.map(r => r.status)).toEqual(["completed", "completed", "completed"]);
    expect(s.results.flatMap(r => r.actions.map((a: any) => a.index))).toEqual([1, 1, 1, 2]);
  });
  test("more than32 actions across calls are accepted and inspect never executes", async () => {
    const s = rig([
      [
        ...Array.from({ length: 35 }, () => [{ type: "inspect", target: "graph" }]),
        [{ type: "answer", content: "No execution needed.", operator_ids: null }],
      ],
    ]);
    const response = await s.agent.sendMessage("Inspect graph.");
    expect(response.response).toBe("No execution needed.");
    expect(s.results.filter(r => r.status === "completed")).toHaveLength(36);
    expect(s.executions).toHaveLength(0);
  });
  test("failed contiguous edits roll back and later calls receive skipped receipts", async () => {
    const s = rig([[[process("good")], [process("broken", ["absent"])], [scalar("good")]]]);
    await s.agent.sendMessage("Try this graph.");
    expect(s.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    expect(s.executions).toHaveLength(0);
    expect(s.results[0].actions[0].status).toBe("error");
    expect(s.results[2].actions[0].status).toBe("skipped");
  });
  test("an answer followed by another call rejects the turn before mutation", async () => {
    const s = rig([[[process("t"), scalar("t")], [process("late")]]]);
    await s.agent.sendMessage("Report value.");
    expect(s.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    expect(s.results.every(r => r.status === "error")).toBe(true);
  });
  test("SDK preparation errors retain their call IDs and stop later writes", async () => {
    const s = rig([[[process("bad")], [process("late")]]], outcomes => {
      outcomes[0].output = "[ERROR] SDK rejected the arguments.";
      outcomes[0].isError = true;
      return outcomes;
    });
    await s.agent.sendMessage("Try the ordered calls.");
    expect(s.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    expect(s.executions).toHaveLength(0);
    const receipts = s.agent.getReActSteps().flatMap(step => step.toolResults ?? []);
    expect(receipts.map(r => r.toolCallId)).toEqual(["0-0", "0-1"]);
    expect((receipts[0].output as any).error).toContain("SDK rejected");
    expect((receipts[1].output as any).actions[0].status).toBe("skipped");
    expect(receipts.every(r => r.isError)).toBe(true);
  });
  test("a missing SDK receipt is an explicit ordered failure", async () => {
    const s = rig([[[process("missing")], [process("late")]]], outcomes => outcomes.slice(1));
    await s.agent.sendMessage("Try the ordered calls.");
    expect(s.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    const receipts = s.agent.getReActSteps().flatMap(step => step.toolResults ?? []);
    expect(receipts.map(r => r.toolCallId)).toEqual(["0-0", "0-1"]);
    expect((receipts[0].output as any).error).toContain("No prepared result");
    expect((receipts[1].output as any).actions[0].status).toBe("skipped");
  });
  test("an answer before an invalid final call rejects the entire response", async () => {
    const s = rig([[[process("t"), scalar("t")], []]]);
    const response = await s.agent.sendMessage("Report value.");
    expect(s.agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    expect(s.executions).toHaveLength(0);
    expect(response.response).not.toBe("13.1628");
    expect(s.results.every(r => r.status === "error")).toBe(true);
  });
  test("original expression content-answer rule is unchanged", () => {
    const r = prepareDataflowActions({
      reasoning: "Read then answer.",
      actions: [
        { type: "inspect", target: "graph" },
        { type: "answer", content: "done" },
      ],
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("only action");
  });
});
