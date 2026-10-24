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
import { asSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import { TexeraAgent } from "../texera-agent";
import { VercelToolUseDriver } from "../llm-drivers/vercel-tool-use-driver";
import { createDataflowTool, prepareDataflowCall } from "../tools/turn-tool";
import { asDataflowActionsResult } from "../tools/dataflow-actions";
import { renderTurnReceipt } from "./turn-receipt";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

/** A model that sends the given dataflow calls in turn, then the text reply. */
function fixture(
  calls: Array<Record<string, string>>,
  reply: string,
  fail: ReadonlySet<string> = new Set(),
  callReply = true
) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let made = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const call = made++;
      const text = call >= calls.length;
      return {
        content: text
          ? [{ type: "text" as const, text: reply }]
          : [
              {
                type: "tool-call" as const,
                toolCallId: `reply-${call}`,
                toolName: "dataflow",
                input: JSON.stringify({ python: "", ...calls[call] }),
              },
            ],
        finishReason: text
          ? { unified: "stop" as const, raw: "stop" }
          : { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: `call-reply-${Math.random()}`,
    modelType: "test",
    driver: new VercelToolUseDriver({ model }),
    contextAssembler: ({ visibleSteps, workflowState, snapshotStorage, settings }) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        thoughtReplay: false,
      }),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false, callReply });
  // No engine in a unit test: an execution computes the operators it is asked for and their ancestors.
  (agent as any).executePostStepChanges = async (
    _calls: unknown,
    _results: unknown,
    _all: boolean,
    requested: string[] = [],
    _onExecution: unknown,
    owner?: string
  ) => {
    const workflow = agent.getWorkflowState();
    const operatorIds = [...requested];
    for (let i = 0; i < operatorIds.length; i++)
      for (const link of workflow.getAllLinks())
        if (link.target.operatorID === operatorIds[i] && !operatorIds.includes(link.source.operatorID))
          operatorIds.push(link.source.operatorID);
    // Ancestors first, so no result is older than its inputs' results.
    for (const id of operatorIds.reverse()) {
      const revision = workflow.getAllOperators().find(op => op.operatorID === id)?.nativeOp?.revision;
      agent.getSnapshotStorage().setOperatorResult(owner ?? agent.getHead()!, id, {
        operatorId: id,
        state: fail.has(id) ? "Failed" : "Completed",
        inputTuples: 0,
        outputTuples: 1,
        totalRowCount: 1,
        resultMode: fail.has(id) ? "error" : "table",
        ...(fail.has(id) ? { error: "KeyError: 'x'" } : {}),
        result: [{ value: 42 }],
        resultSchema: [{ name: "value", type: "int64", encoding: "" }],
        resultVersion: { operatorRevision: revision } as any,
      } as OperatorInfo);
    }
    if (operatorIds.some(id => fail.has(id))) throw new Error("execution failed");
  };
  return { agent, calls: () => made };
}

/** The receipts of the dataflow calls, in order. */
function receipts(agent: TexeraAgent): string[] {
  return agent
    .getVisibleReActSteps()
    .flatMap(step => step.toolResults ?? [])
    .map(tr => asDataflowActionsResult(tr.output))
    .filter(result => result !== undefined)
    .map(result => renderTurnReceipt(result!, result!.turn));
}

const build = "set raw: scan(files='data/x/input/a.csv')\nset out: limit(raw, n=5)\nshow result out";
const answer = '**Final Answer: {"output_01.csv": "out"}**';

test("a call whose statements all succeed ends the request with its reply, without another model call", async () => {
  const f = fixture([{ statements: build, reply: answer }], "unused");
  const result = await f.agent.sendMessage("Write output_01.csv.");
  expect(result.response).toBe(answer);
  expect(f.calls()).toBe(1);
  expect(receipts(f.agent).at(-1)).toContain("## reply\nsent, ending the request");
});

test("a call with a failed statement drops its reply and the model continues", async () => {
  const f = fixture(
    [{ statements: build, reply: answer }, { statements: "show result raw" }],
    "Final Answer: fixed",
    new Set(["out"])
  );
  const result = await f.agent.sendMessage("Write output_01.csv.");
  expect(f.calls()).toBe(3);
  expect(result.response).toBe("Final Answer: fixed");
  expect(receipts(f.agent)[0]).toContain("## reply\nnot sent: a statement of this call failed; fix it, then reply.");
});

test("a reply naming a declared but uncomputed table gets it computed, then sent", async () => {
  const declared = "set raw: scan(files='data/x/input/a.csv')\nset out: limit(raw, n=5)\nshow result raw";
  const f = fixture([{ statements: declared, reply: answer }], "unused");
  const result = await f.agent.sendMessage("Write output_01.csv.");
  expect(result.response).toBe(answer);
  expect(f.calls()).toBe(1);
  expect(f.agent.getSnapshotStorage().getOperatorResult(f.agent.getHead(), "out")?.state).toBe("Completed");
});

test("a reply alone answers once a result was shown; before any, it is not sent", async () => {
  const shown = fixture([{ statements: build }, { statements: "", reply: answer }], "unused");
  expect((await shown.agent.sendMessage("Write output_01.csv.")).response).toBe(answer);
  expect(shown.calls()).toBe(2);
  const early = fixture([{ statements: "", reply: answer }, { statements: build }], "Final Answer: later");
  expect((await early.agent.sendMessage("Write output_01.csv.")).response).toBe("Final Answer: later");
  expect(receipts(early.agent)[0]).toContain("## reply\nnot sent: no result has been shown yet");
});

test("without callReply the tool has no reply field and calls run as before", async () => {
  const off = (createDataflowTool(undefined, false, false, false) as any).inputSchema;
  expect(Object.keys(asSchema(off).jsonSchema.properties as object)).toEqual(["python", "statements"]);
  const strict = asSchema((createDataflowTool(undefined, false, false, true) as any).inputSchema).jsonSchema as any;
  expect(strict.required).toEqual(["python", "statements", "reply"]);
  const claude = asSchema((createDataflowTool(undefined, false, true, true) as any).inputSchema).jsonSchema as any;
  expect(claude.required).toEqual(["statements"]);
  expect(prepareDataflowCall({ python: "", statements: build, reply: "  x  " }).reply).toBe("x");
  // A call without the field runs as before, and the reply without the tool is the answer.
  const f = fixture([{ statements: build }], "Final Answer: text", new Set(), false);
  const result = await f.agent.sendMessage("Write output_01.csv.");
  expect(f.calls()).toBe(2);
  expect(result.response).toBe("Final Answer: text");
  expect(receipts(f.agent)[0]).not.toContain("## reply");
});
