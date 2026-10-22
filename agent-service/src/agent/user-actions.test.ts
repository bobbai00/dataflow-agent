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

import { expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode, AgentState, ContextMode, type ReActStep } from "../types/agent";
import { VercelToolUseDriver } from "./llm-drivers/vercel-tool-use-driver";
import { TexeraAgent } from "./texera-agent";
import { assembleContext } from "./util/context-utils";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { UserActionError } from "./user-actions";

type Reply = { text?: string; call?: { python: string; statements: string } };

const BUILD = {
  python: "import pandas as pd\ndef make_table():\n    return pd.DataFrame({'id': [1, 2, 3], 'value': [10, 20, 30]})",
  statements: "set records: make_table()\nset kept: filter(records, lambda row: row['value'] > 15)\nshow result kept",
};

/** A native agent whose model replies in order and whose engine keeps the
 * rows above a filter's threshold, so a changed condition changes the result. */
function session(replies: Reply[]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt) as unknown[]);
      const reply = replies[Math.min(calls++, replies.length - 1)];
      const content: any[] = reply.text !== undefined ? [{ type: "text" as const, text: reply.text }] : [];
      if (reply.call)
        content.push({
          type: "tool-call" as const,
          toolCallId: `call-${calls}`,
          toolName: "dataflow",
          input: JSON.stringify(reply.call),
        });
      return {
        content,
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
  const agent: TexeraAgent = new TexeraAgent({
    agentId: "user-actions",
    modelType: "test",
    driver: new VercelToolUseDriver({ model, maxRetries: 0 }),
    contextAssembler: input =>
      assembleContext(input.visibleSteps, input.workflowState, input.snapshotStorage, ContextMode.DELTA, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        turnNumberByMessageId: agent.turnNumberMap(),
      }),
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, maxSteps: 10, thoughtReplay: false });
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators()) {
      const threshold = /> (\d+)/.exec(op.nativeOp?.source ?? "")?.[1];
      const values = [10, 20, 30].filter(value => threshold === undefined || value > Number(threshold));
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 3,
        outputTuples: values.length,
        totalRowCount: values.length,
        resultMode: "table",
        result: values.map((value, i) => ({ id: i + 1, value })),
        resultSchema: [
          { name: "id", type: "int64", encoding: "" },
          { name: "value", type: "int64", encoding: "" },
        ],
      });
    }
  };
  return { agent, prompts };
}

async function built() {
  const s = session([{ call: BUILD }, { text: "2 rows remain." }]);
  await s.agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  return s;
}

const source = (agent: TexeraAgent, id: string) => agent.getWorkflowState().getOperator(id)?.nativeOp?.source;
const latest = (agent: TexeraAgent): ReActStep => agent.getVisibleReActSteps().at(-1)!;
/** Every text part the model was sent in one request. */
const promptText = (prompt: unknown[]) => JSON.stringify(prompt);

test("an edit applies through the dataflow and is recorded as a user step the model reads", async () => {
  const { agent } = await built();
  const steps = agent.getAllSteps().length;
  const statement = "set kept: filter(records, lambda row: row['value'] > 25)";

  const outcome = await agent.applyUserAction({ kind: "edit", operatorId: "kept", statement });

  expect(outcome.status).toBe("ok");
  expect(agent.getAllSteps().length).toBe(steps + 1);
  const step = latest(agent);
  expect(step).toBe(outcome.step!);
  expect(step.role).toBe("user");
  expect(step.messageSource).toBe("action");
  expect(step.userAction).toEqual({
    kind: "edit",
    operatorId: "kept",
    statement,
    previous: "set kept: filter(records, lambda row: row['value'] > 15)",
    status: "ok",
  });
  expect(source(agent, "kept")).toBe(statement);
  // The step owns the snapshot of the edited workflow, as an agent call would.
  expect(agent.getSnapshotStorage().hasSnapshotFor(step.id)).toBe(true);
  expect(step.content).toStartWith(`I edited \`kept\` on the canvas. Its definition is now:\n${statement}\n`);
  expect(step.content).toContain("It was: set kept: filter(records, lambda row: row['value'] > 15)");
  expect(step.content).toContain("Keep my change when you restate `kept`.");
  expect(agent.getState()).toBe(AgentState.AVAILABLE);
  // The model reads it, as a user event, on its next request.
  expect(agent.getNextStepContext()).toContain(`I edited \`kept\` on the canvas`);
});

test("a run shows the result to the model and reports the rows", async () => {
  const { agent } = await built();
  await agent.applyUserAction({
    kind: "edit",
    operatorId: "kept",
    statement: "set kept: filter(records, lambda row: row['value'] > 25)",
  });

  const outcome = await agent.applyUserAction({ kind: "run", operatorId: "kept" });

  expect(outcome.status).toBe("ok");
  expect(outcome.step!.userAction).toEqual({ kind: "run", operatorId: "kept", status: "ok", rows: 1 });
  expect(outcome.step!.content).toStartWith("I ran `kept` on the canvas.\n\n");
  expect(outcome.step!.content).toContain("show result kept");
});

test("an edit can run in the same action", async () => {
  const { agent } = await built();
  const outcome = await agent.applyUserAction({
    kind: "edit",
    operatorId: "kept",
    statement: "set kept: filter(records, lambda row: row['value'] > 5, doc='Every record')",
    run: true,
  });
  expect(outcome.status).toBe("ok");
  expect(outcome.step!.userAction).toMatchObject({ kind: "edit", run: true, status: "ok", rows: 3 });
  expect(outcome.step!.content).toStartWith("I edited and ran `kept` on the canvas.");
  expect(agent.getWorkflowState().getOperator("kept")?.nativeOp?.doc).toBe("Every record");
});

test("the agent's next turn receives the user's edit and run, after its own events", async () => {
  const { agent, prompts } = session([
    { call: BUILD },
    { text: "2 rows remain." },
    { call: { python: "", statements: "show result kept" } },
    { text: "1 row remains." },
  ]);
  await agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  await agent.applyUserAction({
    kind: "edit",
    operatorId: "kept",
    statement: "set kept: filter(records, lambda row: row['value'] > 25)",
    run: true,
  });
  await agent.sendMessage("How many remain now?");

  const next = promptText(prompts[2]);
  expect(next).toContain("I edited and ran `kept` on the canvas.");
  expect(next).toContain("lambda row: row['value'] > 25");
  // In order: the first answer, the user's action, then the new request.
  expect(next.indexOf("2 rows remain.")).toBeLessThan(next.indexOf("I edited and ran"));
  expect(next.indexOf("I edited and ran")).toBeLessThan(next.indexOf("How many remain now?"));
  // The model's current task is still the user's request, not the action.
  expect(agent.getVisibleReActSteps().filter(step => step.messageSource === "action").length).toBe(1);
});

test("an edit is checked first: a rejected or empty edit records nothing", async () => {
  const { agent } = await built();
  const steps = agent.getAllSteps().length;
  const before = source(agent, "kept");
  const reject = async (statement: string, message: string | RegExp) => {
    const attempt = agent.applyUserAction({ kind: "edit", operatorId: "kept", statement });
    await expect(attempt).rejects.toBeInstanceOf(UserActionError);
    await expect(attempt).rejects.toThrow(message);
  };

  await reject(
    "set kept: filter(records, lambda row: row['value'] >)",
    /^Changes line 1, operator kept: invalid syntax/
  );
  await reject("set other: limit(records, n=1)", "Write one statement that defines `kept`");
  await reject(
    "set kept: filter(records, lambda row: row['value'] > 1)\nset extra: limit(records, n=1)",
    "Only `kept` can change here"
  );
  await reject("set kept: filter(missing, lambda row: True)", /missing/);
  expect(await agent.applyUserAction({ kind: "edit", operatorId: "kept", statement: ` ${before!}\n` })).toEqual({
    status: "unchanged",
  });

  expect(agent.getAllSteps().length).toBe(steps);
  expect(source(agent, "kept")).toBe(before);
  expect(agent.getState()).toBe(AgentState.AVAILABLE);
});

test("an action needs an available native agent and a native operator", async () => {
  const { agent } = await built();
  await expect(agent.applyUserAction({ kind: "run", operatorId: "nope" })).rejects.toMatchObject({ status: 404 });
  (agent as any).state = AgentState.GENERATING;
  await expect(agent.applyUserAction({ kind: "run", operatorId: "kept" })).rejects.toMatchObject({ status: 409 });
  (agent as any).state = AgentState.AVAILABLE;
  agent.updateSettings({ agentMode: AgentMode.CODE });
  await expect(agent.applyUserAction({ kind: "run", operatorId: "kept" })).rejects.toMatchObject({ status: 400 });
});
