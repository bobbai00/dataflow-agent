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
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode } from "../../types/agent";
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import { TexeraAgent } from "../texera-agent";
import { VercelToolUseDriver } from "../llm-drivers/vercel-tool-use-driver";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { hasCurrentResult, namedOperatorIds, namedResultsFeedback } from "./named-results";

test("a reply names operators through the string values of its JSON objects", () => {
  const known = new Set(["o1", "o2", "rep0"]);
  const reply =
    'Built `rep0` and the two tables.\n\n{"output_01.csv": "o1", "output_02.csv": "o2"}\n\n**Final Answer: {"output_01.csv": "o1", "output_02.csv": "o2"}**';
  expect(namedOperatorIds(reply, known)).toEqual(["o1", "o2"]);
  // Unknown IDs, prose mentions, non-string values and malformed objects do not count.
  expect(namedOperatorIds('{"output_01.csv": "gone", "rows": 3} `rep0` {not json}', known)).toEqual([]);
  expect(namedOperatorIds("Final Answer: 42", known)).toEqual([]);
});

test("a current result is a completed result of the operator's current definition", () => {
  const op = { operatorID: "o1", nativeOp: { revision: "r2" } } as unknown as OperatorPredicate;
  const info = (extra: Partial<OperatorInfo>) => ({ state: "Completed", ...extra }) as OperatorInfo;
  expect(hasCurrentResult(op, info({ resultVersion: { operatorRevision: "r2" } as any }))).toBe(true);
  expect(hasCurrentResult(op, info({ state: "CompletedFromCache" }))).toBe(true);
  expect(hasCurrentResult(op, info({ resultVersion: { operatorRevision: "r1" } as any }))).toBe(false);
  expect(hasCurrentResult(op, info({ error: "boom" }))).toBe(false);
  expect(hasCurrentResult(op, info({ state: "Running" }))).toBe(false);
  expect(hasCurrentResult(op, undefined)).toBe(false);
  expect(hasCurrentResult(undefined, info({}))).toBe(false);
});

test("the correction names the tables and why they have no result", () => {
  expect(namedResultsFeedback([{ id: "o2", error: "KeyError: 'x'" }])).toBe(
    "Your reply names `o2`, which has no result: computing it failed (`o2`: KeyError: 'x'). Fix the graph with the dataflow tool, show the table, then reply again."
  );
  expect(namedResultsFeedback([{ id: "o1" }, { id: "o2" }])).toContain(
    "names `o1`, `o2`, which have no result: nothing computed it."
  );
});

/** A model that sends `calls` dataflow statements in turn, then the reply. */
function fixture(statements: string[], reply: string, fail: ReadonlySet<string> = new Set()) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const call = calls++;
      const text = call >= statements.length;
      return {
        content: text
          ? [{ type: "text" as const, text: reply }]
          : [
              {
                type: "tool-call" as const,
                toolCallId: `named-${call}`,
                toolName: "dataflow",
                input: JSON.stringify({ python: "", statements: statements[call] }),
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
    agentId: `named-results-${Math.random()}`,
    modelType: "test",
    driver: new VercelToolUseDriver({ model }),
    contextAssembler: ({ visibleSteps, workflowState, snapshotStorage, settings }) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        thoughtReplay: false,
      }),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 25, thoughtReplay: false });
  // No engine in a unit test: an execution computes exactly the operators it is asked for.
  const executed: string[][] = [];
  (agent as any).executePostStepChanges = async (
    _calls: unknown,
    _results: unknown,
    _all: boolean,
    operatorIds: string[] = [],
    _onExecution: unknown,
    owner?: string
  ) => {
    executed.push([...operatorIds]);
    const workflow = agent.getWorkflowState();
    for (const id of operatorIds) {
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
  return { agent, executed, calls: () => calls };
}

const build = "set raw: scan(files='data/x/input/a.csv')\nset out: limit(raw, n=5)\nshow result raw";

test("a reply that names a declared but uncomputed table gets it computed, with no model call", async () => {
  const f = fixture([build], 'Done.\n\n{"output_01.csv": "out"}');
  const result = await f.agent.sendMessage("Write output_01.csv.");
  expect(result.response).toBe('Done.\n\n{"output_01.csv": "out"}');
  expect(f.calls()).toBe(2);
  // `show result raw` computed raw; the reply's table was computed when the reply arrived.
  expect(f.executed.at(-1)).toEqual(["out"]);
  const out = f.agent.getSnapshotStorage().getOperatorResult(f.agent.getHead(), "out");
  expect(out?.state).toBe("Completed");
  expect(f.agent.getVisibleReActSteps().some(s => s.messageSource === "feedback")).toBe(false);
});

test("a reply that names a table already shown, or no table, computes nothing more", async () => {
  const shown = fixture([`${build}\nshow result out`], '{"output_01.csv": "out"}');
  await shown.agent.sendMessage("Write output_01.csv.");
  expect(shown.calls()).toBe(2);
  // `show result out` computed it once; the reply did not compute it again.
  expect(shown.executed.filter(ids => ids.includes("out"))).toHaveLength(1);
  const plain = fixture([build], "Final Answer: 42");
  await plain.agent.sendMessage("Answer.");
  expect(plain.executed.flat()).not.toContain("out");
});

test("a named table that fails to compute sends the reply back once", async () => {
  const f = fixture([build], '{"output_01.csv": "out"}', new Set(["out"]));
  const result = await f.agent.sendMessage("Write output_01.csv.");
  // The reply, the correction, the second reply; the second is accepted as it stands.
  expect(f.calls()).toBe(3);
  expect(result.response).toBe('{"output_01.csv": "out"}');
  const feedback = f.agent.getVisibleReActSteps().filter(s => s.messageSource === "feedback");
  expect(feedback).toHaveLength(1);
  expect(feedback[0].content).toContain("Your reply names `out`, which has no result: computing it failed");
});
