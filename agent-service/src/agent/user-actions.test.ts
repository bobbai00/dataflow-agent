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
import type { VersionInfo } from "./workflow-snapshot-storage";

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
  // The agent's call made v0 (records), v1 (kept), v2 (its run) and v3 (its show); the user's edit is v4.
  expect(step.userAction).toEqual({
    kind: "edit",
    operatorId: "kept",
    statement,
    previous: "set kept: filter(records, lambda row: row['value'] > 15)",
    status: "ok",
    version: 4,
  });
  const version = agent
    .getSnapshotStorage()
    .getSnapshotTreeNodes()
    .find(node => node.version === 4);
  expect(version?.action).toEqual({ kind: "update", operatorId: "kept", op: "filter", author: "user" });
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
  // A run is a version, and so is showing its result: v5 and v6 after the edit's v4.
  expect(outcome.step!.userAction).toEqual({ kind: "run", operatorId: "kept", status: "ok", rows: 1, version: 6 });
  expect(
    agent
      .getSnapshotStorage()
      .getStepVersions(outcome.step!.id)
      .map(snapshot => snapshot.action)
  ).toEqual([
    { kind: "run", operatorIds: ["kept"], author: "user" },
    { kind: "show", operatorIds: ["kept"], author: "user" },
  ]);
  // The agent responds to a run, so the user's step asks it to.
  expect(outcome.respond).toBe(true);
  expect(outcome.step!.content).toStartWith(
    "I ran `kept` on the canvas.\nWhat does this result mean for my request?\n\n"
  );
  expect(outcome.step!.content).toContain("show result kept");

  agent.updateSettings({ respondToCanvasRuns: false });
  const quiet = await agent.applyUserAction({ kind: "run", operatorId: "kept" });
  expect(quiet.respond).toBe(false);
  expect(quiet.step!.content).toStartWith("I ran `kept` on the canvas.\n\n");
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
  expect(outcome.step!.userAction).toMatchObject({ kind: "edit", run: true, status: "ok", rows: 3, version: 6 });
  expect(outcome.respond).toBe(true);
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

test("each action of a call is a version of its own: its edits, its run and its show", async () => {
  const { agent } = await built();
  const storage = agent.getSnapshotStorage();
  const build = agent.getVisibleReActSteps().find(step => step.toolCalls?.length)!;
  const actions = (build.toolResults![0].output as any).actions;
  const versions = actions.find((item: any) => item.action.type === "edit").output.versions as VersionInfo[];
  expect(versions.map(({ snapshotId: _id, timestamp: _at, ...version }) => version)).toEqual([
    { version: 0, kind: "add", operatorId: "records", op: "make_table", functions: ["make_table"], author: "agent" },
    { version: 1, kind: "add", operatorId: "kept", op: "filter", author: "agent" },
  ]);
  const [first, last] = versions.map(version => storage.getSnapshotById(version.snapshotId)!);
  expect(first.workflow.operators.map(op => op.operatorID)).toEqual(["records"]);
  expect(first.workflow.links).toEqual([]);
  expect(last.parentId).toBe(first.id);
  expect(last.workflow.operators.map(op => op.operatorID).sort()).toEqual(["kept", "records"]);
  // `show result kept` runs kept, then shows it: two more versions, of the same dataflow.
  const run = actions.find((item: any) => item.action.type === "execute").output.version as VersionInfo;
  const show = actions.find((item: any) => item.action.type === "retrieve").output.version as VersionInfo;
  expect([run, show].map(({ version, kind, operatorIds }) => ({ version, kind, operatorIds }))).toEqual([
    { version: 2, kind: "run", operatorIds: ["kept"] },
    { version: 3, kind: "show", operatorIds: ["kept"] },
  ]);
  expect(storage.getSnapshotById(run.snapshotId)!.parentId).toBe(last.id);
  expect(storage.getSnapshotById(run.snapshotId)!.results.get("kept")?.info.totalRowCount).toBe(2);
  expect(last.results.has("kept")).toBe(false);
  // Each version is timed by its action; the step resolves to the last.
  expect(versions[0].timestamp).toBeLessThanOrEqual(run.timestamp);
  expect(run.timestamp).toBeLessThanOrEqual(show.timestamp);
  expect(storage.getOwnedSnapshot(build.id)?.id).toBe(show.snapshotId);
  // The answer after them changed nothing: four versions in all.
  expect(storage.getSnapshotTreeNodes().filter(node => node.version !== undefined).length).toBe(4);
});

test("a call streams each version as its action records it, and its step after each action", async () => {
  const { agent } = session([{ call: BUILD }, { text: "2 rows remain." }]);
  const events: string[] = [];
  agent.setProgressCallback((_stepId, { version, running }) =>
    events.push(`${version.kind} v${version.version}${running ? ` running [${running.join(", ")}]` : ""}`)
  );
  agent.setStepCallback(step => {
    const actions = (step.toolResults?.[0]?.output as any)?.actions;
    if (actions) events.push(`step ${actions.map((item: any) => item.status).join(", ")}`);
  });
  await agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  expect(events).toEqual([
    "step pending, pending, pending",
    "add v0",
    "add v1",
    "step ok, pending, pending",
    "run v2 running [records, kept]",
    "run v2 running []",
    "step ok, ok, pending",
    "show v3",
    "step ok, ok, ok",
    "step ok, ok, ok",
  ]);
});

test("a run says it computes what it was asked for, and above that only what has no current result", async () => {
  const { agent } = await built();
  const running: string[][] = [];
  agent.setProgressCallback((_stepId, progress) => {
    if (progress.running?.length) running.push(progress.running);
  });
  await agent.applyUserAction({ kind: "run", operatorId: "kept" });
  // records was computed by the agent's call and is unchanged; kept is the one asked for.
  expect(running).toEqual([["kept"]]);
  await agent.applyUserAction({
    kind: "edit",
    operatorId: "records",
    statement: "set records: make_table(doc='The records')",
    run: true,
  });
  expect(running.at(-1)).toEqual(["records"]);
});

test("importing a session rebuilds its versions, runs and shows included, at the times they happened", async () => {
  const { agent } = await built();
  const recorded = agent
    .getSnapshotStorage()
    .getSnapshotTreeNodes()
    .filter(node => node.version !== undefined)
    .map(node => [node.action?.kind, node.action?.operatorId ?? node.action?.operatorIds?.join(","), node.timestamp]);
  const { agent: copy } = session([]);
  await copy.importReActSteps(structuredClone(agent.getAllSteps()));
  const imported = copy
    .getSnapshotStorage()
    .getSnapshotTreeNodes()
    .filter(node => node.version !== undefined)
    .map(node => [node.action?.kind, node.action?.operatorId ?? node.action?.operatorIds?.join(","), node.timestamp]);
  expect(imported).toEqual(recorded);
  expect(imported.map(([kind]) => kind)).toEqual(["add", "add", "run", "show"]);
});

test("an imported session keeps the version numbers its steps recorded", async () => {
  const { agent } = await built();
  const steps = structuredClone(agent.getAllSteps());
  // As an archive without the start version would have them: every recorded number five higher.
  for (const step of steps)
    for (const result of step.toolResults ?? [])
      for (const item of (result.output as any)?.actions ?? []) {
        for (const version of item.output?.versions ?? []) version.version += 5;
        if (item.output?.version) item.output.version.version += 5;
      }
  const { agent: copy } = session([]);
  await copy.importReActSteps(steps);
  const numbers = copy
    .getSnapshotStorage()
    .getSnapshotTreeNodes()
    .filter(node => node.version !== undefined)
    .map(node => [node.version, node.action?.kind]);
  expect(numbers).toEqual([
    [5, "add"],
    [6, "add"],
    [7, "run"],
    [8, "show"],
  ]);
});

test("an imported session's earlier versions show the results its runs had computed by then", async () => {
  const { agent } = await built();
  const { agent: copy } = session([]);
  await copy.importReActSteps(structuredClone(agent.getAllSteps()));
  // An archive keeps each step's results as the step ended.
  const results = Object.entries(agent.exportOperatorResults()).flatMap(([stepId, byOperator]) =>
    Object.entries(byOperator).map(([operatorId, info]) => ({ stepId, operatorId, info }))
  );
  copy.restoreOperatorResults(results);
  const build = copy.getAllSteps().find(step => step.toolCalls?.some(call => call.toolName === "dataflow"))!;
  const versions = copy.getSnapshotStorage().getStepVersions(build.id);
  expect(versions.map(version => [version.action?.kind, [...version.results.keys()].sort()])).toEqual([
    ["add", []],
    ["add", []],
    // The run computed kept and what it reads; the show after it keeps them.
    ["run", ["kept", "records"]],
    ["show", ["kept", "records"]],
  ]);
});

test("checking out a version shows exactly it: a step's newest version checks out its step, an earlier one is restored", async () => {
  const { agent } = session([{ call: BUILD }, { text: "2 rows remain." }]);
  await agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  const storage = agent.getSnapshotStorage();
  const answer = latest(agent);
  const build = agent.getVisibleReActSteps().find(step => step.toolCalls?.length)!;
  const [records, kept, run, show] = storage.getStepVersions(build.id);
  expect([records, kept, run, show].map(version => version.action?.kind)).toEqual(["add", "add", "run", "show"]);
  // The newest version is what the turn ended with: the answer comes along.
  expect(agent.checkoutVersion(show.id)).toBe(answer.id);
  expect(storage.getAssociatedSnapshot(agent.getHead()).id).toBe(show.id);
  for (const version of [records, kept, run]) {
    const head = agent.checkoutVersion(version.id)!;
    expect(agent.getStepsById().get(head)?.userAction).toMatchObject({ kind: "restore", version: version.version });
    // HEAD shows the version itself: its dataflow, and only the results it had.
    expect(storage.getOwnedSnapshot(head)?.parentId).toBe(version.id);
    expect([...storage.getAllVisibleResults(head).keys()]).toEqual([...version.results.keys()]);
    // Going back to it again reuses the restore.
    expect(agent.checkoutVersion(version.id)).toBe(head);
  }
  expect(run.results.size).toBeGreaterThan(0);
  // A run the call went on from undoes no edit; only later results are gone.
  const restored = agent.getStepsById().get(agent.checkoutVersion(run.id)!)!;
  expect(restored.content).toEndWith("its operators are unchanged, and only the results computed by then are kept.");
  expect(restored.content).toContain("as it was right after you ran");
});

test("checking out a step's last version moves HEAD there; an earlier version is restored as a user step", async () => {
  const { agent, prompts } = session([
    { call: BUILD },
    { text: "2 rows remain." },
    { call: { python: "", statements: "show result records" } },
    { text: "3 records." },
  ]);
  await agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  const storage = agent.getSnapshotStorage();
  const answer = latest(agent);
  const build = agent.getVisibleReActSteps().find(step => step.toolCalls?.length)!;
  const [records] = (build.toolResults![0].output as any).actions[0].output.versions as Array<{
    snapshotId: string;
  }>;

  // The last version of the call is what its turn ended with, the answer included.
  expect(agent.checkoutVersion(storage.getOwnedSnapshot(build.id)!.id)).toBe(answer.id);
  expect(agent.getHead()).toBe(answer.id);

  const head = agent.checkoutVersion(records.snapshotId)!;
  const restore = agent.getStepsById().get(head)!;
  expect(restore.parentId).toBe(build.id);
  expect(restore.role).toBe("user");
  expect(restore.messageSource).toBe("action");
  expect(restore.userAction).toEqual({ kind: "restore", operatorId: "records", version: 0, status: "ok" });
  expect(restore.content).toStartWith(
    "I restored v0 of the dataflow, as it was right after your edit of `records`; the later edits of that call are undone."
  );
  expect(restore.content).toContain("No longer defined: `kept`.");
  expect(
    agent
      .getWorkflowState()
      .getAllOperators()
      .map(op => op.operatorID)
  ).toEqual(["records"]);
  // The restore continues from v0 without being a version itself.
  expect(storage.getOwnedSnapshot(head)?.parentId).toBe(records.snapshotId);
  expect(storage.getOwnedSnapshot(head)?.version).toBeUndefined();

  await agent.sendMessage("How many records are there?");
  expect(promptText(prompts[2])).toContain("I restored v0 of the dataflow");
  expect(agent.checkoutVersion("S999")).toBeUndefined();
});

test("the agent answers a canvas run in a turn of its own, with no new message", async () => {
  const { agent, prompts } = session([
    { call: BUILD },
    { text: "2 rows remain." },
    { text: "With your threshold of 25, 1 row remains: id 3." },
  ]);
  await agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  const outcome = await agent.applyUserAction({
    kind: "edit",
    operatorId: "kept",
    statement: "set kept: filter(records, lambda row: row['value'] > 25)",
    run: true,
  });

  await agent.respondToUserAction(outcome.step!);

  const turn = agent.getAllSteps().filter(step => step.messageId === outcome.step!.messageId);
  expect(turn.map(step => step.role)).toEqual(["user", "agent"]);
  expect(turn[1]).toMatchObject({ content: "With your threshold of 25, 1 row remains: id 3.", isEnd: true });
  expect(promptText(prompts[2])).toContain("What does this result mean for my request?");
  expect(agent.getState()).toBe(AgentState.AVAILABLE);
  // Only the newest action can be answered.
  await expect(agent.respondToUserAction(outcome.step!)).rejects.toMatchObject({ status: 409 });
});

test("an edit that keeps the old doc asks the agent for one that fits; a new doc does not", async () => {
  const documented = {
    ...BUILD,
    statements: BUILD.statements.replace(
      "lambda row: row['value'] > 15)",
      "lambda row: row['value'] > 15, doc='Records over 15.')"
    ),
  };
  const { agent } = session([{ call: documented }, { text: "2 rows remain." }]);
  await agent.sendMessage("Keep the records whose value is over 15. How many remain?");
  const kept = await agent.applyUserAction({
    kind: "edit",
    operatorId: "kept",
    statement: "set kept: filter(records, lambda row: row['value'] > 25, doc='Records over 15.')",
  });
  expect(kept.step!.content).toContain(
    "Its doc still describes the earlier definition: restate `kept` with a doc that fits."
  );
  const renewed = await agent.applyUserAction({
    kind: "edit",
    operatorId: "kept",
    statement: "set kept: filter(records, lambda row: row['value'] > 20, doc='Records over 20.')",
  });
  expect(renewed.step!.content).not.toContain("Its doc still describes");
});
