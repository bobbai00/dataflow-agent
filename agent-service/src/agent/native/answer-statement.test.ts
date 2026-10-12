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
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode, ContextMode } from "../../types/agent";
import { VercelToolUseDriver } from "../llm-drivers/vercel-tool-use-driver";
import { TexeraAgent } from "../texera-agent";
import { assembleContext } from "../util/context-utils";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { buildRegisteredNativeSystemPrompt } from "../prompts";
import { type AnswerTable, composeAnswer, parseAnswer } from "./answer-statement";
import { parseTurn } from "./turn-syntax";

const tables: Record<string, AnswerTable> = {
  top: {
    rows: [
      { market: "UK", score: 0.703333, n: 576 },
      { market: "India", score: 0.681666, n: 956 },
    ],
    columns: ["market", "score", "n"],
    total: 2,
  },
  check: { rows: [{ matches: true, note: null }], columns: ["matches", "note"], total: 1 },
  empty: { rows: [], columns: ["x"], total: 0 },
  cut: { rows: [{ x: 1 }], columns: ["x"], total: 3 },
  big: { rows: Array.from({ length: 51 }, (_, x) => ({ x })), columns: ["x"], total: 51 },
};
const table = (id: string) => {
  if (!tables[id]) throw new Error(`UNKNOWN_OPERATOR: no operator \`${id}\`.`);
  return tables[id];
};
const answer = (text: string) => composeAnswer(parseAnswer(text), table);

describe("answer statements", () => {
  test("tables become their rows, columns pick, one-row columns are values, and digits rounds", () => {
    expect(answer('{"leaders": top[market, score], "match": check.matches, "source": "first pass"} digits=4')).toEqual({
      ok: true,
      text: '{"leaders":[{"market":"UK","score":0.7033},{"market":"India","score":0.6817}],"match":true,"source":"first pass"}',
      value: {
        leaders: [
          { market: "UK", score: 0.7033 },
          { market: "India", score: 0.6817 },
        ],
        match: true,
        source: "first pass",
      },
    });
    expect(answer('{"markets": top.market, "counts": top[["n"]]}')).toMatchObject({
      text: '{"markets":["UK","India"],"counts":[{"n":576},{"n":956}]}',
    });
    expect(answer("check.matches")).toMatchObject({ text: "true" });
    expect(answer("[top.n, None, 1.5]")).toMatchObject({ text: "[[576,956],null,1.5]" });
  });

  test("an answer reads at least one table and is written as a value", () => {
    expect(() => parseAnswer('{"n": 3}')).toThrow("an answer names at least one table");
    expect(() => parseAnswer("{leaders: top}")).toThrow("object keys are quoted strings");
    expect(() => parseAnswer('{"a": top')).toThrow('expected "}"');
    expect(() => parseAnswer('{"a": top} extra')).toThrow('unexpected "extra"');
  });

  test("an empty, cut, oversized or unknown table, an unknown column, or an all-null pick is refused", () => {
    expect(answer('{"a": empty}')).toEqual({ ok: false, error: "ANSWER_EMPTY: `empty` has no rows." });
    expect(answer('{"a": cut}')).toEqual({ ok: false, error: "ANSWER_INCOMPLETE: only 1 of `cut`'s 3 rows are held." });
    expect(answer('{"a": big}')).toMatchObject({
      ok: false,
      error: expect.stringContaining("ANSWER_TOO_LARGE: `big` has 51 rows"),
    });
    expect(answer('{"a": nope}')).toMatchObject({ ok: false, error: expect.stringContaining("UNKNOWN_OPERATOR") });
    expect(answer('{"a": top.rank}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('UNKNOWN_COLUMN: `top` has no column "rank"'),
    });
    expect(answer('{"a": check.note}')).toEqual({
      ok: false,
      error: "ANSWER_ALL_NULL: `check.note` is null in every row.",
    });
  });

  test("with the setting, a call ends with an answer statement that computes its tables first", () => {
    const parsed = parseTurn(
      { python: "", statements: 'set top: limit(ranked, n=5)\nanswer {"leaders": top,\n  "match": check.matches}' },
      { views: ["sample", "full"], answerStatement: true }
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.turn.actions.map(action => action.type)).toEqual(["edit", "execute", "answer"]);
    expect(parsed.turn.actions[1]).toEqual({ type: "execute", operator_ids: ["top", "check"] });
    expect(parsed.turn.statements.map(s => s.kind)).toEqual(["edit", "answer"]);
    const after = parseTurn(
      { python: "", statements: 'answer {"a": top}\nshow result top' },
      { views: ["sample"], answerStatement: true }
    );
    expect(after).toMatchObject({ ok: false, error: expect.stringContaining("answer is the call's last statement") });
    // Without it, a line starting with answer is not a statement.
    const off = parseTurn({ python: "", statements: 'show result top\nanswer {"a": top}' }, { views: ["sample"] });
    if (!off.ok) throw new Error(off.error);
    expect(off.turn.actions.map(action => action.type)).toEqual(["execute", "retrieve"]);
    expect(off.turn.ignoredProse).toEqual([2]);
  });

  test("the prompt says how to answer only when the setting is on", () => {
    expect(buildRegisteredNativeSystemPrompt(ContextMode.DELTA)).toContain("There is no answer statement.");
    const on = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { answerStatement: true });
    expect(on).toContain(
      'end the call with an answer statement when the tables it computes hold the answer: `answer {"key": table'
    );
    expect(on).not.toContain("There is no answer statement.");
  });
});

type Reply = { text?: string; call?: { python: string; statements: string } };

/** A native agent with answer statements whose model replies in order; every
 * operator "executes" to the rows below. */
function session(replies: Reply[], rows: Record<string, unknown>[]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const reply = replies[Math.min(calls++, replies.length - 1)];
      return {
        content: reply.call
          ? [
              {
                type: "tool-call" as const,
                toolCallId: `call-${calls}`,
                toolName: "dataflow",
                input: JSON.stringify(reply.call),
              },
            ]
          : [{ type: "text" as const, text: reply.text ?? "" }],
        finishReason: reply.call
          ? { unified: "tool-calls" as const, raw: "tool_calls" }
          : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "answer-statement",
    modelType: "test",
    driver: new VercelToolUseDriver({ model, maxRetries: 0 }),
    contextAssembler: input =>
      assembleContext(input.visibleSteps, input.workflowState, input.snapshotStorage, ContextMode.DELTA, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
      }),
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    maxSteps: 25,
    thoughtReplay: false,
    retrievalViews: ["sample", "full"],
    answerStatement: true,
  });
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators())
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: rows.length,
        totalRowCount: rows.length,
        resultMode: "table",
        result: rows,
        resultSchema: Object.keys(rows[0] ?? { value: 0 }).map(name => ({ name, type: "int64", encoding: "" })),
      });
  };
  return { agent, calls: () => calls };
}

const SCAN = "set totals: scan(files='data/x/input/a.csv')";

describe("a request that ends with an answer statement", () => {
  test("ends after that call, with the composed answer as its reply", async () => {
    const { agent, calls } = session(
      [{ call: { python: "", statements: `${SCAN}\nanswer {"n": totals.value}` } }],
      [{ value: 42 }]
    );
    const result = await agent.sendMessage("How many? Answer as JSON.");
    expect(result.error).toBeUndefined();
    expect(result.response).toBe('{"n":42}');
    expect(calls()).toBe(1);
    const steps = agent.getVisibleReActSteps().filter(step => step.role === "agent");
    const last = steps[steps.length - 1];
    expect([last.content, last.isEnd, last.toolCalls]).toEqual(['{"n":42}', true, undefined]);
    const receipt = (steps[0].toolResults![0].output as any).actions.map((a: any) => [a.action.type, a.status]);
    expect(receipt).toEqual([
      ["edit", "ok"],
      ["execute", "ok"],
      ["answer", "ok"],
    ]);
  });

  test("a refused answer leaves the request open for the model's reply", async () => {
    const { agent, calls } = session(
      [
        { call: { python: "", statements: `${SCAN}\nanswer {"n": totals.value}` } },
        { call: { python: "", statements: "show result totals" } },
        { text: '{"n": "none"}' },
      ],
      []
    );
    const result = await agent.sendMessage("How many? Answer as JSON.");
    expect(result.error).toBeUndefined();
    expect(result.response).toBe('{"n": "none"}');
    expect(calls()).toBe(3);
    const first = agent.getVisibleReActSteps().find(step => step.role === "agent")!;
    const answer = (first.toolResults![0].output as any).actions.find((a: any) => a.action.type === "answer");
    expect([answer.status, answer.output]).toEqual(["error", "ANSWER_EMPTY: `totals` has no rows."]);
  });
});
