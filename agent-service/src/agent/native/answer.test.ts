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
import type { OperatorInfo } from "../../types/execution";
import { composeAnswer, parseAnswerFrom } from "./answer";
import { nativeTestTools } from "./test-support";
import { WorkflowState } from "../workflow-state";
import { selectNativeObservation } from "./evidence";
import { TexeraAgent } from "../texera-agent";
import { AgentMode, ContextMode } from "../../types/agent";
import type { DriverRunTurnInput } from "../llm-drivers/types";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { assembleContext } from "../util/context-utils";
import { validateNativeSettings, NativeCatalogSettingsError } from "./settings";
import { buildNativeModeSystemPrompt } from "../prompts";
import { nativeBatchSchema, dataflowToolDescription } from "../tools/native-batch-tools";

function table(rows: Array<Record<string, unknown>>, extra: Partial<OperatorInfo> = {}): OperatorInfo {
  return {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows.length,
    resultMode: "table",
    result: rows,
    totalRowCount: rows.length,
    truncated: false,
    ...extra,
  };
}

test("the answer is composed from the table by a fixed mapping", () => {
  expect(composeAnswer("t", table([{ mean_age: 34.2, n: 721, __row_index__: 0 }]))).toEqual({
    json: '{"mean_age":34.2,"n":721}',
    text: '**Final Answer: {"mean_age":34.2,"n":721}**',
  });
  expect(composeAnswer("t", table([{ region: "east", total: 10 }, { region: "west", total: 12.5 }]))).toEqual({
    json: '{"east":10,"west":12.5}',
    text: '**Final Answer: {"east":10,"west":12.5}**',
  });
  expect(composeAnswer("t", table([{ region: "east", total: 10 }, { region: "east", total: 12.5 }]))).toEqual({
    json: '{"t":[{"region":"east","total":10},{"region":"east","total":12.5}]}',
    text: '**Final Answer: {"t":[{"region":"east","total":10},{"region":"east","total":12.5}]}**',
  });
  expect(composeAnswer("names", table([{ name: "a" }, { name: "b" }]))).toEqual({
    json: '{"name":["a","b"]}',
    text: '**Final Answer: {"name":["a","b"]}**',
  });
  expect(composeAnswer("t", table([{ x: null, y: Number.NaN, z: undefined }]))).toEqual({
    json: '{"x":null,"y":null,"z":null}',
    text: '**Final Answer: {"x":null,"y":null,"z":null}**',
  });
});

test("an answer_from projection names the keys, picks the columns and rounds", () => {
  expect(parseAnswerFrom("python_mean")).toEqual({ id: "python_mean" });
  expect(parseAnswerFrom("python_mean[imputation_mean=mean_python:4, imputed_rows, baseline_row_count = n]")).toEqual({
    id: "python_mean",
    shape: [
      { name: "imputation_mean", column: "mean_python", digits: 4 },
      { name: "imputed_rows", column: "imputed_rows" },
      { name: "baseline_row_count", column: "n" },
    ],
  });
  expect(parseAnswerFrom('t["Duration (in seconds)":1]')).toEqual({ id: "t", shape: [{ name: "Duration (in seconds)", column: "Duration (in seconds)", digits: 1 }] });
  expect("error" in parseAnswerFrom("t[")).toBe(true);
  expect("error" in parseAnswerFrom("t[]")).toBe(true);
  expect("error" in parseAnswerFrom("t[a=b=c]")).toBe(true);
  const info = table([{ mean_python: 75.85333, imputed_rows: 2, n: 77, other: "x" }]);
  const shape = [
    { name: "imputation_mean", column: "mean_python", digits: 4 },
    { name: "imputed_rows", column: "imputed_rows" },
    { name: "baseline_row_count", column: "n" },
  ];
  expect(composeAnswer("python_mean", info, shape)).toEqual({
    json: '{"imputation_mean":75.8533,"imputed_rows":2,"baseline_row_count":77}',
    text: '**Final Answer: {"imputation_mean":75.8533,"imputed_rows":2,"baseline_row_count":77}**',
  });
  expect(composeAnswer("python_mean", info, [{ name: "x", column: "missing" }])).toEqual({
    reason: '`python_mean` has no column "missing" (columns: mean_python, imputed_rows, n, other)',
  });
  expect(composeAnswer("t", table([{ region: "east", total: 10.456 }, { region: "west", total: 12.5 }]), [{ name: "r", column: "region" }, { name: "t", column: "total", digits: 1 }])).toEqual({
    json: '{"east":10.5,"west":12.5}',
    text: '**Final Answer: {"east":10.5,"west":12.5}**',
  });
});

test("a table that cannot be the answer is refused with the reason", () => {
  expect(composeAnswer("t", undefined)).toEqual({ reason: "`t` has no result" });
  expect(composeAnswer("t", table([], { totalRowCount: 0 }))).toEqual({ reason: "`t` is empty (0 rows)" });
  expect(composeAnswer("t", table([{ a: 1 }], { error: "boom" }))).toEqual({ reason: "`t` failed" });
  expect(composeAnswer("t", table([{ a: 1 }, { a: 2 }], { totalRowCount: 900, truncated: true }))).toEqual({
    reason: "only 2 of 900 rows of `t` are held; the answer needs the complete table",
  });
  const many = Array.from({ length: 60 }, (_, i) => ({ k: `k${i}`, v: i }));
  expect(composeAnswer("t", table(many))).toEqual({ reason: "`t` has 60 rows; an answer table holds at most 50 (aggregate, project or limit it)" });
  const wide = [{ text: "x".repeat(5000) }];
  expect(composeAnswer("t", table(wide))).toEqual({ reason: "the answer composed from `t` is 5011 characters; keep it under 4000" });
});

test("the tool records answer_from, observes the answer table, projects observed columns and echoes expectations", async () => {
  const { tools, state } = nativeTestTools(new WorkflowState(), {
    settings: { nativeAnswerFrom: true, nativeContractFlags: true, nativeLeanContext: true },
  });
  const receipt = await tools.dataflow.execute({
    edits: 'orders = scan("data/orders.csv")\nsummary = aggregate(orders, n=count())',
    observe: ["orders[region, amount]", "orders[total]"],
    answer_from: "summary[order_count=n]",
    expect: { summary: { rows: 1 }, orders: { nonempty: true, unique: ["id"] } },
  });
  expect(receipt.operators.map((o: any) => [o.id, o.status])).toEqual([["orders", "added"], ["summary", "added"]]);
  expect(receipt.observe).toEqual(["orders", "summary"]);
  expect(receipt.observeColumns).toEqual({ orders: ["region", "amount", "total"] });
  expect(receipt.answerFrom).toBe("summary");
  expect(receipt.answerShape).toEqual([{ name: "order_count", column: "n" }]);
  expect(JSON.stringify(await tools.dataflow.execute({ edits: "", answer_from: "summary[" }))).toContain("must be a table id");
  expect(receipt.expect).toEqual({ summary: { rows: 1 }, orders: { nonempty: true, unique: ["id"] } });
  expect(state.getOperator("summary")).toBeDefined();
  // The answer table must exist: a wrong id is an observation error, the turn goes on.
  const missing = await tools.dataflow.execute({ edits: "", answer_from: "nothing" });
  expect(missing.observationErrors).toEqual(["answer_from: no table `nothing`; write the final answer yourself."]);
  expect(missing.answerFrom).toBeUndefined();
  // Off: the fields are refused rather than ignored.
  const off = nativeTestTools(new WorkflowState()).tools;
  expect(JSON.stringify(await off.dataflow.execute({ edits: "", answer_from: "x" }))).toContain("nativeAnswerFrom");
  expect(JSON.stringify(await off.dataflow.execute({ edits: "", expect: { x: { rows: 1 } } }))).toContain("nativeContractFlags");
  expect(JSON.stringify(await off.dataflow.execute({ edits: "", expect: { x: 3 } }))).toContain("expect takes");
  // Schema and description follow the settings.
  const schema = nativeBatchSchema({ answerFrom: true, contractFlags: true, leanContext: true }) as any;
  expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["answer_from", "expect"]));
  expect(schema.properties.observe.description).toContain("table[col1,col2]");
  expect(Object.keys((nativeBatchSchema() as any).properties)).not.toContain("answer_from");
  expect(dataflowToolDescription({ answerFrom: true })).toContain("`answer_from` names a table");
});

test("an observed column projection shows the complete projected rows", () => {
  const info = table([
    { id: 1, region: "east", amount: 3, note: "long" },
    { id: 2, region: "west", amount: 4, note: "long" },
  ]);
  info.resultSchema = ["id", "region", "amount", "note"].map(name => ({ name, type: name === "region" || name === "note" ? "str" : "int64", encoding: "plain" }));
  const op = { operatorID: "orders", nativeOp: { type: "Scan", inputs: [], properties: {} } } as any;
  const projected = selectNativeObservation({
    op,
    info,
    workflow: { operators: [op], links: [] } as any,
    resolveInput: () => undefined,
    data: false,
    flow: false,
    maxChars: 2000,
    columns: ["region", "amount", "unknown"],
  });
  expect(projected.text).toBe(
    'Output Table: 2 rows, 4 cols\nColumns: "region":str\t"amount":int64\nComplete table (all rows; 2 of 4 columns):\n"east"\t3\n"west"\t4'
  );
  const whole = selectNativeObservation({
    op,
    info,
    workflow: { operators: [op], links: [] } as any,
    resolveInput: () => undefined,
    data: false,
    flow: false,
    maxChars: 2000,
    columns: ["nothing"],
  });
  expect(whole.text).toContain("Complete table (all rows):");
  expect(whole.text).toContain('"id":int64');
});

function agentFixture() {
  const turns: DriverRunTurnInput[] = [];
  const agent = new TexeraAgent({
    agentId: "answer-from",
    modelType: "test",
    contextAssembler: input => [{ role: "user" as const, content: input.visibleSteps.map(s => s.content).join("|") }],
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
  });
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  (agent as any).metadataStore = metadata;
  agent.updateSettings({ agentMode: AgentMode.NATIVE, contextMode: ContextMode.DELTA, nativeAnswerFrom: true });
  return { agent, turns };
}

test("answer_from ends the turn without another model call: the composed answer is the final step and the response", async () => {
  const { agent } = agentFixture();
  const stops: boolean[] = [];
  let steps = 0;
  (agent as any).executePostStepChanges = async (toolCalls: unknown[] | undefined) => {
    if (!toolCalls?.length) return;
    // The engine's result for the answer table, as the post-step path would record it.
    agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, "summary", {
      state: "Completed",
      resultMode: "table",
      result: [{ mean_amount: 12.5, n: 4 }],
      totalRowCount: 1,
      truncated: false,
      inputTuples: 4,
      outputTuples: 1,
      resultSchema: [
        { name: "mean_amount", type: "float64", encoding: "plain" },
        { name: "n", type: "int64", encoding: "plain" },
      ],
    } as OperatorInfo);
  };
  (agent as any).driver = {
    runTurn: async (input: DriverRunTurnInput) => {
      await input.prepareStep({ stepNumber: 0, messages: input.initialMessages });
      const args = {
        edits: 'orders = scan("data/orders.csv")\nsummary = aggregate(orders, mean_amount=mean("amount"), n=count())',
        answer_from: "summary",
      };
      const output = await input.tools.dataflow.execute(args);
      steps++;
      stops.push(input.shouldStop!());
      await input.onStepFinish({
        text: "",
        toolCalls: [{ toolName: "dataflow", toolCallId: "c1", input: args }],
        toolResults: [{ toolCallId: "c1", output }],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      });
      stops.push(input.shouldStop!());
      if (input.shouldStop!()) return { text: "", messages: [], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      throw new Error("the driver should have stopped");
    },
  };
  const result = await agent.sendMessage("What is the mean amount?");
  expect(stops).toEqual([false, true]);
  expect(steps).toBe(1);
  expect(result.response).toBe('**Final Answer: {"mean_amount":12.5,"n":4}**');
  const agentSteps = agent.getAllSteps().filter(s => s.role === "agent");
  expect(agentSteps).toHaveLength(2);
  expect(agentSteps[0]!.isEnd).toBe(false);
  expect(agentSteps[1]!).toMatchObject({ content: '**Final Answer: {"mean_amount":12.5,"n":4}**', isEnd: true });
  expect(agentSteps[1]!.usage).toBeUndefined();
  expect(agentSteps[1]!.toolCalls).toBeUndefined();
  // The answer table was observed even though the call did not list it.
  expect(agentSteps[0]!.toolResults![0]!.output.observe).toEqual(["summary"]);
  // A later turn starts clean.
  (agent as any).driver = { runTurn: async () => ({ text: "plain answer", messages: [], usage: {} }) };
  expect((await agent.sendMessage("Next")).response).toBe("plain answer");
});

test("a refused answer_from leaves the reason on the table's observation and the turn continues", async () => {
  const { agent } = agentFixture();
  (agent as any).executePostStepChanges = async (toolCalls: unknown[] | undefined) => {
    if (!toolCalls?.length) return;
    agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, "orders", {
      state: "Completed",
      resultMode: "table",
      result: [{ id: 1 }, { id: 2 }],
      totalRowCount: 900,
      truncated: true,
      inputTuples: 0,
      outputTuples: 900,
    } as OperatorInfo);
  };
  let secondStep = false;
  (agent as any).driver = {
    runTurn: async (input: DriverRunTurnInput) => {
      const args = { edits: 'orders = scan("data/orders.csv")', answer_from: "orders" };
      const output = await input.tools.dataflow.execute(args);
      await input.onStepFinish({
        text: "",
        toolCalls: [{ toolName: "dataflow", toolCallId: "c1", input: args }],
        toolResults: [{ toolCallId: "c1", output }],
      });
      expect(input.shouldStop!()).toBe(false);
      secondStep = true;
      await input.onStepFinish({ text: "There are 900 orders." });
      return { text: "There are 900 orders.", messages: [], usage: {} };
    },
  };
  const result = await agent.sendMessage("How many orders?");
  expect(secondStep).toBe(true);
  expect(result.response).toBe("There are 900 orders.");
  const head = agent.getAllSteps().filter(s => s.role === "agent")[0]!;
  expect(agent.getSnapshotStorage().getOperatorResult(head.id, "orders")?.answerNote).toBe(
    "answer_from not applied: only 2 of 900 rows of `orders` are held; the answer needs the complete table. Write the final answer yourself."
  );
  expect(agent.getSnapshotStorage().getOperatorResult(head.id, "orders")?.note).toBeUndefined();
  // The shared observation renderer shows the note under the table's line.
  const rendered = assembleContext(agent.getAllSteps(), agent.getWorkflowState(), agent.getSnapshotStorage(), ContextMode.DELTA, {
    agentMode: AgentMode.NATIVE,
    resultSelection: "all",
    dataEvidence: false,
    flowEvidence: false,
  })
    .map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
  expect(rendered).toContain("  answer_from: orders");
  expect(rendered).toContain("answer_from not applied: only 2 of 900 rows");
});

test("settings and prompt: the four session-shaped features validate and document themselves", () => {
  expect(() => validateNativeSettings({ agentMode: "code", nativeAnswerFrom: true })).toThrow(NativeCatalogSettingsError);
  expect(() => validateNativeSettings({ agentMode: "native", nativeRegisteredOperators: true })).toThrow("requires nativeAnalysisState");
  expect(() => validateNativeSettings({ agentMode: "native", nativeLeanContext: true })).toThrow("requires nativeTaskEfficiency");
  expect(() =>
    validateNativeSettings({
      agentMode: "native",
      nativeTaskHistory: true,
      nativeTaskContext: true,
      nativeAnalysisState: true,
      nativeTaskEfficiency: true,
      nativeLeanContext: true,
      nativeRegisteredOperators: true,
      nativeContractFlags: true,
      nativeAnswerFrom: true,
    })
  ).not.toThrow();
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, {
    taskCatalog: true,
    taskHistory: true,
    analysisState: true,
    taskEfficiency: true,
    answerFrom: true,
    registeredOperators: true,
    contractFlags: true,
    leanContext: true,
    compactCode: true,
  });
  expect(prompt).toContain("Answering from a table.");
  expect(prompt).toContain("Your own operators.");
  expect(prompt).toContain("Contract flags.");
  expect(prompt).toContain("Reading economically.");
  expect(prompt).toContain("Compact code.");
  expect(prompt).toContain("imputation_mean=mean_python:4");
  const plain = buildNativeModeSystemPrompt(ContextMode.DELTA, { taskCatalog: true, taskHistory: true, analysisState: true, taskEfficiency: true });
  for (const heading of ["Answering from a table.", "Registered operators.", "Contract flags.", "Reading economically.", "Compact code."])
    expect(plain).not.toContain(heading);
  expect(() => validateNativeSettings({ agentMode: "code", nativeCompactCode: true })).toThrow(NativeCatalogSettingsError);
});


test("composed answers carry numbers as written: binary float noise is removed, exact values stay", async () => {
  const { cleanNumber, composeAnswer } = await import("./answer");
  expect(cleanNumber(93.05000000000001)).toBe(93.05);
  expect(cleanNumber(2.9999999999999996)).toBe(3);
  expect(cleanNumber(0.30000000000000004)).toBe(0.3);
  expect(cleanNumber(4.202270000000013)).toBe(4.20227);
  expect(cleanNumber(6930.155123456789)).toBe(6930.15512346);
  expect(cleanNumber(238854)).toBe(238854);
  const composed = composeAnswer("medians", {
    state: "Completed",
    totalRowCount: 1,
    truncated: false,
    resultSchema: [
      { name: "non_feeder_median", type: "float64", encoding: "number" },
      { name: "schools", type: "int64", encoding: "number" },
    ],
    result: [{ non_feeder_median: 93.05000000000001, schools: 364 }],
  } as any);
  expect("text" in composed && composed.text).toBe('**Final Answer: {"non_feeder_median":93.05,"schools":364}**');
});
