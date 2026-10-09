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
import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { AgentMode, ContextMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

/** Each request runs its scripted batches through the real dataflow tool. */
function session(requests: unknown[][][], sessionState = true) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const contexts: ModelMessage[][] = [];
  let request = 0;
  const agent = new TexeraAgent({
    agentId: "session-state",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      async runTurn(input: any) {
        const batches = requests[request++];
        for (const [i, actions] of batches.entries()) {
          const args = { reasoning: "Next step.", actions };
          const output = await input.tools.dataflow.execute(args);
          const id = `r${request}-${i}`;
          await input.onStepFinish({
            text: "",
            toolCalls: [{ toolName: "dataflow", toolCallId: id, input: args }],
            toolResults: [{ toolCallId: id, output }],
          });
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
    } as any,
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, multiTask: true, sessionState });
  // Every operator completes with the same three-row table.
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators())
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 3,
        outputTuples: 3,
        totalRowCount: 3,
        resultMode: "table",
        result: [{ value: 1 }, { value: 2 }, { value: 3 }],
        resultSchema: [{ name: "value", type: "int64", encoding: "" }],
      });
  };
  return { agent, contexts };
}

const firstRequest = [
  [
    {
      type: "edit",
      python: 'def keep(row):\n    """Keep every row."""\n    return True',
      changes: "set raw: scan(files='data.csv')\nset kept: filter(raw, predicate='keep')",
    },
    { type: "execute" },
  ],
  [{ type: "answer", content: "Three rows." }],
];

test("a later request carries the state it inherited, frozen and replayed with the request", async () => {
  const s = session([firstRequest, [[{ type: "inspect", target: "graph" }], [{ type: "answer", content: "Same." }]]]);
  await s.agent.sendMessage("First request.");
  await s.agent.sendMessage("Second request.");
  const requests = s.agent.getVisibleReActSteps().filter(step => step.role === "user" && step.isBegin);
  expect(requests[0].sessionState).toBeUndefined();
  const state = requests[1].sessionState!;
  expect(state).toContain("## Session state at the start of this request");
  expect(state).toContain("- `keep(row)`: Keep every row.");
  expect(state).toContain("| raw | `scan(files='data.csv')` | 3 rows, 1 column | 1 | value |");
  expect(state).toContain("| kept | `filter(raw, predicate='keep')` | 3 of 3 rows, 1 column | 1 | as raw |");
  // Both calls of the second request see the same block right after its text.
  const requestText = (messages: ModelMessage[]) =>
    messages.find(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Second request."))
      ?.content as string | undefined;
  const later = s.contexts.slice(-2).map(requestText);
  expect(later[0]).toBe(`Second request.\n\n${state}`);
  expect(later[1]).toBe(later[0]);
});

test("without the setting a later request carries nothing extra", async () => {
  const s = session([firstRequest, [[{ type: "answer", content: "Same." }]]], false);
  await s.agent.sendMessage("First request.");
  await s.agent.sendMessage("Second request.");
  const requests = s.agent.getVisibleReActSteps().filter(step => step.role === "user" && step.isBegin);
  expect(requests.map(step => step.sessionState)).toEqual([undefined, undefined]);
});
