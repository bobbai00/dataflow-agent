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
import { expect, test } from "bun:test";
import { TexeraAgent } from "./texera-agent";
import { AgentMode, ContextMode } from "../types/agent";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { assembleContext } from "./util/context-utils";
import type { DataflowAction, DataflowActionsResult } from "./tools/dataflow-actions";

/** A native agent whose model issues the given batches and whose engine
 * materializes one row per operator. */
function agentWith(batches: DataflowAction[][]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const outcomes: DataflowActionsResult[] = [];
  let executions = 0;
  const agent = new TexeraAgent({
    agentId: "seed-state-test",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      async runTurn(input) {
        for (const [i, actions] of batches.entries()) {
          const args = { reasoning: "Use the loaded state.", actions };
          const output = await input.tools.dataflow.execute(args);
          await input.onStepFinish({
            text: "",
            toolCalls: [{ toolName: "dataflow", toolCallId: `t${i}`, input: args }],
            toolResults: [{ toolCallId: `t${i}`, output }],
          });
          outcomes.push(output);
          if (input.getFinalAnswer?.() !== undefined) break;
        }
        return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
      },
    },
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, retrievalViews: ["full", "sample", "sample_stats"] });
  (agent as any).executePostStepChanges = async () => {
    executions++;
    for (const op of (agent as any).workflowState.getAllOperators())
      (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: 1,
        totalRowCount: 1,
        resultMode: "table",
        result: [{ value: `loaded-${op.operatorID}` }],
        resultSchema: [{ name: "value", type: "str" }],
      });
  };
  const context = () =>
    assembleContext(
      agent.getVisibleReActSteps(),
      agent.getWorkflowState(),
      agent.getSnapshotStorage(),
      ContextMode.DELTA,
      { agentMode: AgentMode.NATIVE, messageLayout: "native", userTaskPlacement: "bottom" }
    );
  return { agent, outcomes, context, executions: () => executions };
}

test("loaded state is materialized, inherited by the first request, and never rendered or counted as a task", async () => {
  const s = agentWith([
    [{ type: "retrieve", operator_id: "eligible", view: "full" }],
    [{ type: "answer", content: "1" }],
  ]);
  const receipt = await s.agent.seedState(
    'create operator eligible: scan("state/eligible.parquet", format="parquet")\ncreate operator scores: scan("state/scores.parquet", format="parquet")'
  );
  expect(receipt.status).toBe("completed");
  expect(receipt.actions.map(a => a.status)).toEqual(["ok", "ok"]);
  expect(s.executions()).toBe(1);
  expect(String(s.agent.getState())).toBe("AVAILABLE");
  // The seed owns a step with a snapshot, marked synthetic and outside the task order.
  const seed = s.agent.getReActSteps().find(step => step.synthetic === "state");
  expect(seed).toBeDefined();
  expect(s.agent.turnOrder()).toEqual([]);
  expect(s.agent.getSnapshotStorage().hasSnapshotFor(seed!.id)).toBe(true);

  await s.agent.sendMessage("[Task 3] Which units are eligible?");
  // The request is task 1 of the conversation; the seed is not a task.
  expect(s.agent.turnOrder()).toHaveLength(1);
  expect(s.agent.getVisibleReActSteps().some(step => step.synthetic === "state")).toBe(true);
  // The seeded result was read without re-execution.
  const read = s.outcomes[0].actions[0];
  expect(read.status).toBe("ok");
  expect(JSON.stringify(read.output)).toContain("loaded-eligible");
  expect(s.executions()).toBe(1);
  // Nothing about the seed reaches the model: no edit program, no scan paths, no event for it.
  const rendered = JSON.stringify(s.context());
  expect(rendered).toContain("Which units are eligible?");
  expect(rendered).not.toContain("state/eligible.parquet");
  expect(rendered).not.toContain("Load the tables in force");
  expect(rendered).toContain("loaded-eligible");
});

test("seedState refuses a busy or non-native agent", async () => {
  const s = agentWith([]);
  (s.agent as any).state = "GENERATING";
  await expect(s.agent.seedState('create operator a: scan("a.csv")')).rejects.toThrow(/idle/);
  (s.agent as any).state = "AVAILABLE";
  s.agent.updateSettings({ agentMode: AgentMode.CODE });
  await expect(s.agent.seedState('create operator a: scan("a.csv")')).rejects.toThrow(/native/);
});
