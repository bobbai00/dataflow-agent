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
import { createLegacyNativeAgent } from "./test-support/legacy-native-agent";
import { AgentMode, ContextMode } from "../types/agent";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { assembleContext } from "./util/context-utils";
import { renderDataflowActionsResult } from "./tools/dataflow-actions";
import type { DataflowAction, DataflowActionsResult } from "./tools/dataflow-actions";
import { splitVersionCommands } from "./state-ledger";

/** Row counts the mocked engine assigns, by operator ID. */
const ROWS: Record<string, number> = {
  units: 100,
  eligible: 70,
  top8: 8,
  joined: 8,
  score: 70,
  score_t1: 70,
  empty_units: 0,
  kept: 8,
  dropped: 92,
};

/** A native agent whose model issues one batch per request, whose engine
 * materializes `ROWS[id]` rows per operator, with ledger and history on. */
function agentWith(turns: DataflowAction[][][]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const outcomes: DataflowActionsResult[] = [];
  let turn = -1;
  const agent = createLegacyNativeAgent({
    agentId: "ledger-test",
    modelType: "test",
    contextAssembler: () => [],
    driver: {
      async runTurn(input) {
        turn++;
        for (const [i, actions] of turns[turn].entries()) {
          const args = { reasoning: "Next step.", actions };
          const output = await input.tools.dataflow.execute(args);
          await input.onStepFinish({
            text: "",
            toolCalls: [{ toolName: "dataflow", toolCallId: `t${turn}-${i}`, input: args }],
            toolResults: [{ toolCallId: `t${turn}-${i}`, output }],
          });
          outcomes.push(output);
          if (input.getFinalAnswer?.() !== undefined) break;
        }
        return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
      },
    },
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    retrievalViews: ["full", "sample", "sample_stats"],
    stateHistory: true,
    stateLedger: true,
  });
  (agent as any).executePostStepChanges = async () => {
    for (const op of (agent as any).workflowState.getAllOperators())
      (agent as any).snapshotStorage.setOperatorResult((agent as any).head, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: ROWS[op.operatorID] ?? 5,
        totalRowCount: ROWS[op.operatorID] ?? 5,
        resultMode: "table",
        result: [{ k: 1, value: `r-${op.operatorID}` }],
        resultSchema: [
          { name: "k", type: "int" },
          { name: "value", type: "str" },
        ],
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
  return { agent, outcomes, context };
}

const receiptText = (outcome: DataflowActionsResult) => renderDataflowActionsResult(outcome);

test("restore and fork assignments are split out of an edit and nothing else is", () => {
  const { rest, versions } = splitVersionCommands(
    "score = at(score, task=2)\na = limit(score, 3)\nranking_t1 = at( ranking , task = 1 )  # copy\nb = limit(a, 2)\nc = filter(at(score, task=2), lambda row: True)"
  );
  expect(versions).toEqual([
    { line: 1, id: "score", task: 2 },
    { line: 3, id: "ranking", task: 1, as: "ranking_t1" },
  ]);
  expect(rest).toBe("a = limit(score, 3)\nb = limit(a, 2)\nc = filter(at(score, task=2), lambda row: True)");
});

test("answering writes the ledger, reuse shows provenance, limited and subset inputs get notes, restore and fork bring back a version", async () => {
  const s = agentWith([
    // Task 1: a population, a filter, a top-8 report; answer.
    [
      [
        {
          type: "edit",
          changes:
            'units = scan("data/units.csv")\neligible = filter(units, lambda row: row["k"] > 0, doc="Units with positive k")\ntop8 = limit(eligible, 8)',
        },
        { type: "execute" },
        { type: "retrieve", operator_id: "top8", view: "full" },
      ],
      [{ type: "answer", content: '{"top":8}' }],
    ],
    // Task 2: join the population to the report (the classic mistake) and score it; answer.
    [
      [
        {
          type: "edit",
          changes:
            'joined = join(eligible, top8, on="k", how="inner")\nscore = map(joined, lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")',
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: '{"scored":8}' }],
    ],
    // Task 3: revise the score rule in place; answer.
    [
      [
        {
          type: "edit",
          changes: 'score = map(joined, lambda row: {**row, "score": row["k"] * 3}, doc="Tripled k")',
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: '{"scored":"v2"}' }],
    ],
    // Task 4: roll the rule back in place and keep the v2 rule beside it.
    [
      [
        { type: "edit", changes: "score = at(score, task=2)\nscore_t3 = at(score, task=3)" },
        { type: "execute", operator_ids: ["score"] },
      ],
      [{ type: "answer", content: '{"restored":true}' }],
    ],
  ]);

  await s.agent.sendMessage("Task 1");
  const seal1 = receiptText(s.outcomes[1]);
  expect(seal1).toContain("#### Task 1\n3 tables created.");
  expect(seal1).toMatch(/\*\*units\*\* \(scan, created\)[\s\S]*100 rows × 2 columns/);
  expect(seal1).toMatch(/\*\*eligible\*\* \(filter, created\)[\s\S]*inputs: `units`[\s\S]*70 rows × 2 columns/);
  expect(seal1).toMatch(
    /\*\*top8\*\* \(limit, created\)[\s\S]*inputs: `eligible`[\s\S]*8 rows × 2 columns[\s\S]*note: limited table/
  );
  expect(seal1).not.toContain('{"top":8}');
  // The answer is in the tool call once; the ledger replaced the echo and the assistant text.
  const rendered = JSON.stringify(s.context());
  expect(rendered.split('{\\"top\\":8}').length - 1).toBe(1);
  expect(rendered).toContain("#### Task 1");

  await s.agent.sendMessage("Task 2");
  const edit2 = receiptText(s.outcomes[2]);
  expect(edit2).toContain("inputs from earlier tasks:");
  expect(edit2).toMatch(/\*\*eligible\*\* \(filter, executed\)[\s\S]*origin: task 1[\s\S]*used by: `joined`/);
  expect(edit2).toMatch(/\*\*top8\*\* \(limit, executed\)[\s\S]*origin: task 1[\s\S]*used by: `joined`/);
  const exec2 = s.outcomes[2].actions[1].output as any;
  const joinedNotes: string[] = exec2.operators.find((op: any) => op.id === "joined").checks;
  expect(joinedNotes.join("\n")).toContain(
    "input top8 (right) is a limited table (8 rows); its unlimited parent is eligible (70 rows)"
  );
  expect(joinedNotes.join("\n")).toContain(
    "inner join of 70 left and 8 right rows produced 8 rows. 62 left rows found no match."
  );
  expect(receiptText(s.outcomes[2])).toContain("note: input top8 (right) is a limited table");
  const seal2 = receiptText(s.outcomes[3]);
  expect(seal2).toContain("#### Task 2");
  expect(seal2).toMatch(
    /\*\*joined\*\* \(join, created\)[\s\S]*inputs: left `eligible`, right `top8`[\s\S]*8 rows × 2 columns/
  );
  expect(seal2).not.toContain("**units**");

  await s.agent.sendMessage("Task 3");
  const seal3 = receiptText(s.outcomes[5]);
  expect(seal3).toMatch(
    /\*\*score\*\* \(map, updated\)[\s\S]*definition: `score = map\(joined, lambda row: \{\*\*row, "score": row\["k"\] \* 3/
  );

  await s.agent.sendMessage("Task 4");
  const edit4 = receiptText(s.outcomes[6]);
  expect(edit4).toContain("Restored score's task-2 definition in place; its inputs are today's (unchanged since then)");
  expect(edit4).toContain("Forked score from task 3 as score_t3 with its task-3 inputs (");
  expect(edit4).toContain("joined → score_t3__joined");
  const score = s.agent.getWorkflowState().getOperator("score")!;
  expect(score.nativeOp!.source).toContain('row["k"] * 2');
  expect(s.agent.getWorkflowState().getOperator("score_t3")!.nativeOp!.source).toContain('row["k"] * 3');
  expect(s.agent.getWorkflowState().getOperator("score_t3__joined")).toBeDefined();
  const seal4 = receiptText(s.outcomes[7]);
  // The catalog names the gesture, not just the change in definition.
  expect(seal4).toMatch(/\*\*score\*\* \(map, restored from task 2\)/);
  expect(seal4).toMatch(/\*\*score_t3\*\* \(map, forked from task 3\)/);
  expect(seal4).toMatch(/1 restored; 2 forked|2 forked; 1 restored|restored[\s\S]*forked/);
});

test("an empty result gets a block in the execute receipt without the ledger, flow or checks", async () => {
  const s = agentWith([
    [
      [{ type: "edit", changes: 'empty_units = scan("data/none.csv")' }, { type: "execute" }],
      [{ type: "answer", content: "none" }],
    ],
  ]);
  s.agent.updateSettings({ stateHistory: false, stateLedger: false, flowEvidence: false, nativeChecks: false });
  await s.agent.sendMessage("Task 1");
  expect(receiptText(s.outcomes[0])).toMatch(
    /\*\*empty_units\*\* \(scan, executed\)\n  - result: 0 rows × 2 columns[\s\S]*- note: empty table\./
  );
});

test("ledger text is stable: the same receipt renders the same bytes on replay", async () => {
  const s = agentWith([
    [
      [{ type: "edit", changes: 'empty_units = scan("data/none.csv")' }, { type: "execute" }],
      [{ type: "answer", content: "none" }],
    ],
  ]);
  await s.agent.sendMessage("Task 1");
  const first = receiptText(s.outcomes[1]);
  expect(first).toMatch(/\*\*empty_units\*\* \(scan, created\)[\s\S]*0 rows × 2 columns[\s\S]*note: empty table/);
  expect(renderDataflowActionsResult(structuredClone(s.outcomes[1]))).toBe(first);
});

test("semi and anti joins get membership notes, not inner-join arithmetic", async () => {
  const s = agentWith([
    [
      [
        {
          type: "edit",
          changes:
            'units = scan("data/units.csv")\ntop8 = limit(units, 8)\nkept = join(units, top8, on="k", how="semi")\ndropped = join(units, top8, on="k", how="anti")',
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: "done" }],
    ],
  ]);
  await s.agent.sendMessage("Task 1");
  const operators = (s.outcomes[0].actions[1].output as any).operators;
  const notes = (id: string) => operators.find((op: any) => op.id === id).checks.join("\n");
  expect(notes("kept")).toContain("semi join kept 8 of 100 left rows, those with a match among 8 right rows.");
  expect(notes("dropped")).toContain("anti join kept 92 of 100 left rows, those with no match among 8 right rows.");
  expect(notes("kept") + notes("dropped")).not.toContain("found no match");
});

test("loaded state numbers tasks after it, marks unchanged tables as loaded, and fixes the prompt", async () => {
  const s = agentWith([
    [
      [
        {
          type: "edit",
          changes: 'scored = map(units, lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")',
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: "scored" }],
    ],
  ]);
  await s.agent.seedState('units = scan("data/units.csv")', 3);
  const prompt = s.agent.getSettings().systemPrompt;
  expect(prompt).toContain("### Earlier tasks in the session");
  await s.agent.sendMessage("Task 4");
  const edit = receiptText(s.outcomes[0]);
  expect(edit).toMatch(/inputs from earlier tasks:\n- \*\*units\*\* \(scan, \w+\)[\s\S]*origin: loaded/);
  expect(receiptText(s.outcomes[1])).toContain("#### Task 4\n1 table created.");
  expect(s.agent.getSettings().systemPrompt).toBe(prompt);
  await expect(s.agent.seedState('other = scan("data/units.csv")')).rejects.toThrow("before the first request");
});

test("the system prompt is decided at session start and does not change at the second request", async () => {
  const s = agentWith([[[{ type: "answer", content: "one" }]], [[{ type: "answer", content: "two" }]]]);
  s.agent.updateSettings({ multiTask: false, stateHistory: false, stateLedger: false });
  const prompt = s.agent.getSettings().systemPrompt;
  await s.agent.sendMessage("First request");
  await s.agent.sendMessage("Second request");
  expect(s.agent.getSettings().systemPrompt).toBe(prompt);
  expect(prompt).not.toContain("### Earlier tasks in the session");
});

test("retrieving a consumer of a failed operator reports that it did not run", async () => {
  const s = agentWith([
    [
      [
        {
          type: "edit",
          changes:
            'units = scan("data/units.csv")\ndoubled = map(units, lambda row: {**row, "d": row["kk"] * 2}, doc="Doubled")\ntop = limit(doubled, 3)',
        },
        { type: "execute" },
        { type: "retrieve", operator_id: "top", view: "full" },
      ],
      [{ type: "answer", content: "none" }],
    ],
  ]);
  const diagnostic = {
    version: 1 as const,
    operatorId: "doubled",
    operatorRevision: "",
    code: "MISSING_COLUMN",
    stage: "execute" as const,
    message: "The function read column 'kk', which the input table does not have.",
  };
  (s.agent as any).executePostStepChanges = async () => {
    const storage = (s.agent as any).snapshotStorage;
    const head = (s.agent as any).head;
    diagnostic.operatorRevision = s.agent.getWorkflowState().getOperator("doubled")!.nativeOp!.revision!;
    storage.setOperatorResult(head, "units", {
      state: "Completed",
      inputTuples: 0,
      outputTuples: 5,
      totalRowCount: 5,
      resultMode: "table",
      result: [{ k: 1 }],
      resultSchema: [{ name: "k", type: "int" }],
    });
    for (const id of ["doubled", "top"])
      storage.setOperatorResult(head, id, {
        state: "Failed",
        inputTuples: 0,
        outputTuples: 0,
        // The engine reports the upstream failure on its consumer too.
        error: "NATIVE_ERROR_V2:" + JSON.stringify(diagnostic),
      });
  };
  await s.agent.sendMessage("Task 1");
  const text = receiptText(s.outcomes[0]);
  expect(text).toContain("RESULT_NOT_RUN: `top` did not run because upstream `doubled` failed.");
  expect(text).not.toContain("RESULT_FAILED");
});

test("every answered task stays reachable: a restore is a new version, and the versions it skipped remain", async () => {
  const edit = (changes: string): DataflowAction[][] => [
    [{ type: "edit", changes }, { type: "execute" }],
    [{ type: "answer", content: "done" }],
  ];
  const s = agentWith([
    edit('units = scan("data/units.csv")\nscore = map(units, lambda row: {**row, "score": row["k"] * 1}, doc="k")'),
    edit('score = map(units, lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")'),
    edit('score = map(units, lambda row: {**row, "score": row["k"] * 3}, doc="Tripled k")'),
    edit("score = at(score, task=1)"),
    edit("score = at(score, task=3)"),
    edit("score = at(score, task=4)"),
    [
      [
        {
          type: "inspect",
          target: "state",
          operator_id: "score",
          task_id: null,
          include_implementation: false,
          view: null,
        },
      ],
      [{ type: "answer", content: "listed" }],
    ],
  ]);
  const definition = () => s.agent.getWorkflowState().getOperator("score")!.nativeOp!.source;
  const seen: string[] = [];
  for (let task = 1; task <= 6; task++) {
    await s.agent.sendMessage(`Task ${task}`);
    seen.push(definition()!.match(/\* (\d)/)![1]);
  }
  // Task 4 returns to task 1's rule, task 5 to task 3's (the version the
  // restore replaced), task 6 to the state task 4 itself left.
  expect(seen).toEqual(["1", "2", "3", "1", "3", "1"]);
  await s.agent.sendMessage("Task 7");
  const versions = receiptText(s.outcomes[s.outcomes.length - 2]);
  expect(versions).toContain("| 1 | created |");
  expect(versions).toContain("| 2 | updated |");
  expect(versions).toContain("| 3 | updated |");
  expect(versions).toContain("| 4 | restored from task 1 |");
  expect(versions).toContain("| 5 | restored from task 3 |");
  expect(versions).toContain("| 6 | restored from task 4 |");
});
