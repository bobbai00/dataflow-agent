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
import { TexeraAgent } from "../texera-agent";
import { AgentMode, ContextMode } from "../../types/agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planRestores, verifyRestore } from "./task-restore";
import type { NativeBatchResult } from "../tools/native-batch-tools";

/** A native agent driven through the debug path: each Function call is one
 * dataflow call, each plain text starts a task; results are stamped by hand
 * because no engine runs here. */
function fixture() {
  const agent = new TexeraAgent({
    agentId: "restore",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  }) as any;
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  agent.metadataStore = metadata;
  agent.updateSettings({ agentMode: AgentMode.NATIVE, contextMode: ContextMode.DELTA, nativeTaskHistory: true });
  agent.taskHistory.retain = async (_id: string, info: any) => ({
    path: "/test/retained.arrow",
    sha256: "a".repeat(64),
    rowCount: info.totalRowCount ?? 0,
  });
  agent.tools = agent.createTools();
  const call = async (input: Record<string, unknown>): Promise<NativeBatchResult> => {
    await agent.handleDebugInput(`Function(name="dataflow", arguments=${JSON.stringify(JSON.stringify(input))})`);
    return agent.getAllSteps().find((step: any) => step.id === agent.getHead()).toolResults[0].output;
  };
  const completed = (id: string, rows: number, columns: string[]) =>
    agent.getSnapshotStorage().setOperatorResult(agent.getHead(), id, {
      state: "Completed",
      resultMode: "table",
      result: [],
      totalRowCount: rows,
      inputTuples: 0,
      outputTuples: rows,
      resultSchema: columns.map(name => ({ name, type: "int64", encoding: "plain" })),
      resultVersion: { id: `${id}-${rows}` },
      materialization: { executionId: "execution", outputPort: 0, cached: false },
    } as any);
  return { agent, call, completed };
}

const SOURCE = 'source = scan("data/fixture.csv")';
const KEEP = (cutoff: number) =>
  `kept = filter(source, lambda row: row["id"] >= ${cutoff}, doc="Keeps rows with id at least ${cutoff}")`;
const TOTAL = 'total = aggregate(kept, n=count(), amount=sum("value"))';

test("a restore rebuilds the sealed definition, shares unchanged inputs and copies changed ones", async () => {
  const { agent, call, completed } = fixture();
  await agent.handleDebugInput("Task one: the first cohort.");
  await call({ edits: [SOURCE, KEEP(1000), TOTAL].join("\n") });
  completed("source", 2000, ["id", "value"]);
  completed("kept", 1000, ["id", "value"]);
  completed("total", 1, ["n", "amount"]);
  await agent.handleDebugInput("Task two: change eligibility.");
  await call({ edits: KEEP(1800) }); // the default moves; `total` recomputes on it
  completed("kept", 200, ["id", "value"]);
  completed("total", 1, ["n", "amount"]);
  await agent.handleDebugInput("Task three: compare with the original.");
  const result = await call({
    edits: 'compare = join(total_t1, total, how="cross", suffix="_now")',
    restore: [{ operator: "total", task: 1, as: "total_t1" }],
    observe: ["compare"],
  });
  const byId = Object.fromEntries(result.operators.map(op => [op.id, op]));
  // `source` is unchanged since task 1 and is shared; `kept` changed and is copied.
  expect(byId.total_t1.op).toBe("restore");
  expect(byId.total_t1.status).toBe("added");
  expect(byId.total_t1.message).toContain("shares source");
  expect(byId.total_t1.message).toContain("copies kept_t1");
  expect(byId.kept_t1.message).toContain("copied `kept_t1` as saved at task 1");
  expect(byId.compare.status).toBe("added");
  expect(result.restored).toEqual([
    { operator: "total", task: 1, as: "total_t1", created: ["total_t1", "kept_t1"], shared: ["source"] },
  ]);
  const state = agent.getWorkflowState();
  expect(state.getOperator("kept_t1").nativeOp.source).toBe(KEEP(1000).replace("kept =", "kept_t1 ="));
  expect(state.getOperator("total_t1").nativeOp.inputs).toEqual(["kept_t1"]);
  expect(state.getOperator("kept").nativeOp.source).toBe(KEEP(1800)); // the current line is untouched
  // The verification note compares the rebuilt table with the saved one.
  const sealed = agent.taskHistory.definition("total", 1);
  expect(
    verifyRestore({ state: "Completed", totalRowCount: 1, resultSchema: sealed.info.resultSchema } as any, sealed, {
      operator: "total",
      task: 1,
      as: "total_t1",
    })
  ).toContain("verified");
  expect(
    verifyRestore({ state: "Completed", totalRowCount: 3 } as any, sealed, {
      operator: "total",
      task: 1,
      as: "total_t1",
    })
  ).toContain("rows 3 vs 1 saved");
});

test("restore with the same id reverts the current definition; refusals leave the graph alone", async () => {
  const { agent, call, completed } = fixture();
  await agent.handleDebugInput("Task one.");
  await call({ edits: [SOURCE, KEEP(1000)].join("\n") });
  completed("source", 2000, ["id", "value"]);
  completed("kept", 1000, ["id", "value"]);
  await agent.handleDebugInput("Task two.");
  await call({ edits: KEEP(1800) });
  completed("kept", 200, ["id", "value"]);
  await agent.handleDebugInput("Task three.");
  const before = structuredClone(agent.getWorkflowState().getWorkflowContent());
  const refused = await call({
    edits: "",
    restore: [
      { operator: "kept", task: 7, as: "kept_t7" },
      { operator: "nowhere", task: 1, as: "x" },
      { operator: "kept", task: 1, as: "source" },
    ],
  });
  expect(refused.operators.map(op => [op.id, op.status])).toEqual([
    ["kept_t7", "error"],
    ["x", "error"],
    ["source", "error"],
  ]);
  expect(refused.operators[0].message).toContain("saved at task 1, 2");
  expect(refused.operators[1].message).toContain("nothing was retained");
  expect(refused.operators[2].message).toContain("already exists");
  expect(agent.getWorkflowState().getWorkflowContent()).toEqual(before);
  const reverted = await call({ edits: "", restore: [{ operator: "kept", task: 1, as: "kept" }] });
  expect(reverted.operators.map(op => [op.id, op.op, op.status])).toEqual([["kept", "restore", "modified"]]);
  expect(agent.getWorkflowState().getOperator("kept").nativeOp.source).toBe(KEEP(1000));
});

test("restore requires task history and refuses invalid targets", async () => {
  const { agent, call } = fixture();
  agent.settings.nativeTaskRestore = false;
  agent.tools = agent.createTools();
  await agent.handleDebugInput("Task one.");
  const result = await call({ edits: SOURCE, restore: [{ operator: "source", task: 1, as: "again" }] });
  expect(result.operators[0]).toMatchObject({ id: "again", op: "restore", status: "error" });
  expect(result.operators[0].message).toContain("no task history");
  const plans = await planRestores(
    [{ operator: "source", task: 1, as: "task_archive_x" }],
    agent.taskHistory,
    agent.getWorkflowState()
  );
  expect(plans.refusals[0].message).toContain("not a valid new id");
});
