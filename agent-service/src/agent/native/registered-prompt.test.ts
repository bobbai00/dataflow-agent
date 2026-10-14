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
import { spawnSync } from "node:child_process";
import { buildRegisteredNativeSystemPrompt, registeredReferenceText } from "../prompts";
import { ContextMode, type RetrievalView } from "../../types/agent";
import { createDataflowTool, prepareDataflowCall } from "../tools/turn-tool";
import { TexeraAgent } from "../texera-agent";
import { compileNativeOp, nativePython } from "./codegen";
import { stageRegisteredEdit, type RegisteredStageInput } from "./registered";

/** The example calls a prompt shows, as the model would send them. */
const exampleCalls = (prompt: string) =>
  [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
/** The example receipts a prompt shows. */
const exampleReceipts = (prompt: string) =>
  [...prompt.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]).join("\n");

test("example calls are valid dataflow calls for every view setting", () => {
  for (const retrievalViews of [["full"], ["sample"], ["sample_stats"], ["sample_stats", "full"]] as const) {
    const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
      retrievalViews: [...retrievalViews],
      flowEvidence: true,
    });
    const calls = exampleCalls(prompt);
    // The reading example, two calls; flow evidence adds no example.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(Object.keys(call)).toEqual(["python", "statements"]);
      const result = prepareDataflowCall(call, [...retrievalViews]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("pending");
    }
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("show schema <id> [from <index>]");
    expect(prompt).toContain("docstring");
    expect(prompt).not.toContain("statistics on every column");
    if (!retrievalViews.includes("sample_stats" as never)) expect(prompt).not.toContain("statistics: full table");
  }
});

test("reference and initial prompt expose only retained built-ins with registered mappings", () => {
  const prompt = buildRegisteredNativeSystemPrompt();
  expect(prompt).toContain("columns={");
  expect(prompt).toContain("outputs={");
  expect(prompt).not.toContain("fn=");
  const reference = registeredReferenceText({ topic: "operators", operator_names: ["scan", "aggregate"] });
  expect(reference).toContain("comment");
  expect(reference).toContain("outputs");
  expect(() => registeredReferenceText({ topic: "operators", operator_names: ["process"] })).toThrow();
});

test("instructions describe receipts by statement, without cache bookkeeping", () => {
  const prompt = buildRegisteredNativeSystemPrompt();
  expect(prompt).not.toMatch(/\bcach(?:e|ed|ing)\b/i);
  expect(prompt).toContain("operator ID");
  expect(prompt).toContain("one section per statement");
  expect(prompt).toContain("An error names the statement and the cause.");
  expect(prompt).toContain("if one line is rejected, nothing changes and the tool result names the line");
  // The prompt calls what a call returns the tool result.
  expect(prompt.toLowerCase()).not.toContain("receipt");
  const schema = asSchema(createDataflowTool().inputSchema).jsonSchema;
  expect(JSON.stringify(schema)).not.toMatch(/\bcach(?:e|ed|ing)\b/i);
});

for (const data of [false, true])
  for (const flow of [false, true])
    test(`prompt and live agent settings agree: data=${data}, flow=${flow}`, () => {
      const retrievalViews: RetrievalView[] = data ? ["sample_stats", "full"] : ["sample", "full"];
      // Explicit retrieval choices are authoritative even when the historical
      // dataEvidence flag disagrees. A false flag alone is not a stats-off arm.
      const settings = {
        retrievalViews,
        dataEvidence: !data,
        flowEvidence: flow,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 2000,
        maxResultRows: 5,
        dataEvidenceCharLimit: 2000,
        flowEvidenceCharLimit: 2000,
      };
      const agent = new TexeraAgent({
        agentId: `registered-evidence-${data}-${flow}`,
        modelType: "test",
        driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
        contextAssembler: () => [],
      });
      agent.updateSettings(settings);
      const info = agent.getSystemInfo();
      const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, settings);
      expect(info.systemPrompt).toBe(prompt);
      expect(prompt).not.toContain("{{");
      expect(prompt.includes("Column statistics in `sample_stats`")).toBe(data);
      expect(prompt.includes("sample_stats")).toBe(data);
      // With flow evidence, the prompt says once what `- runtime stats:` lines are and how to use them.
      expect(prompt.includes("Flow lines report what upstream steps did")).toBe(false);
      expect(prompt.includes("Runtime stats are very helpful for validating your result")).toBe(flow);
      expect(prompt.includes("runtime stats")).toBe(flow);
      // With statistics, one sentence: the sample and its statistics first, `full` for a small table.
      expect(
        prompt.includes(
          "`show result <id>` gives the schema, at most 5 example records and column statistics; ask for `show result <id> full`, every record within 5000 characters, only for a small table whose every row you need."
        )
      ).toBe(data);
      expect(prompt.includes("Look at a result without `full` first")).toBe(!data);
      expect(prompt).toContain("every record within 5000 characters");
      expect(prompt).toContain("Put the definitions, statements, and `show result` of a known computation in one call");
      // The context holds every definition and receipt: lookups are for what it lacks.
      expect(prompt).toContain("Everything you defined and observed is already in your context");
      expect(prompt).not.toContain("preview=1), execute, and inspect source");

      for (const call of exampleCalls(prompt)) expect(prepareDataflowCall(call, retrievalViews).status).toBe("pending");
      expect(exampleReceipts(prompt)).not.toMatch(/^\s*- flow\b/m);

      const schema = asSchema(createDataflowTool(retrievalViews).inputSchema).jsonSchema;
      expect(info.tools).toHaveLength(1);
      expect(info.tools[0].name).toBe("dataflow");
      expect(info.tools[0].inputSchema).toEqual(schema);
    });

for (const data of [false, true])
  for (const flow of [false, true])
    test(`one protocol: calls prepare, sections follow the settings, size stays bounded: data=${data}, flow=${flow}`, () => {
      const retrievalViews: RetrievalView[] = data ? ["sample_stats", "full"] : ["sample", "full"];
      const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
        retrievalViews,
        dataEvidence: data,
        flowEvidence: flow,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 1000,
        maxResultRows: 5,
      });
      expect(prompt).not.toContain("{{");
      expect(prompt).toContain(
        'Use the `dataflow` tool: `python` (definitions, or `""`) and `statements` (one per line).'
      );
      expect(prompt).toContain("show result <id>, ... [view]");
      expect(prompt).toContain("reply without calling the tool");
      expect(prompt).toContain("There is no answer statement.");
      expect(prompt).toContain("Everything you defined and observed is already in your context");
      // No summary field, no answer statement, no raw-text framing, no JSON action list.
      expect(prompt).not.toContain("`summary`");
      expect(prompt).not.toContain('"summary"');
      expect(prompt).not.toContain("answer: <text to the end of the turn>");
      expect(prompt).not.toContain("````turn");
      expect(prompt).not.toContain('"actions"');
      expect(prompt).not.toContain("Actions run in order.");
      expect(prompt).not.toContain("Engine receipt:");
      expect(prompt.includes("at most 5 example records and column statistics")).toBe(data);
      expect(prompt.includes("Flow lines report what upstream steps did")).toBe(false);
      expect(prompt).not.toContain("Use upstream measurements to repair a condition");
      // Every example call is valid for this session.
      const calls = exampleCalls(prompt);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(Object.keys(call)).toEqual(["python", "statements"]);
        const result = prepareDataflowCall(call, retrievalViews);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe("pending");
      }
      // The receipts are real renderer output, introduced as tool results.
      expect(prompt.match(/^Tool result:$/gm)).toHaveLength(2);
      const receipts = exampleReceipts(prompt);
      expect(receipts).toContain("## edits applied");
      expect(receipts).toContain("## show result report full");
      expect(receipts).not.toContain(": not run");
      expect(receipts.includes("statistics:")).toBe(data);
      expect(receipts.split("## show result report full")[1].split("```")[0]).not.toContain("statistics: full table");
      if (data) {
        expect(receipts).toContain("2 of 6 rows");
        expect(receipts).toContain("all: A 4; B 2");
      }
      // Kept and rejected counts restate the row counts; the rejected values do not.
      expect(receipts).not.toContain("kept=2/4, rejected=2");
      expect(receipts).not.toContain("contract;");
      expect(receipts).not.toContain("10 × 2");
      // The answer is a reply without the tool.
      expect(prompt).toContain("Reply, without the tool: `Group A: 60; group B: 70.`");
      expect(prompt).not.toContain("Reply, without the tool: `60`");
      expect(prompt).toContain(
        "If the user asks for a `Final Answer:` label, put it in the reply, for example `**Final Answer: 60**`."
      );
      const examples = prompt.slice(prompt.indexOf("## 4. Worked examples"));
      expect(examples.length).toBeLessThan(2500);
      expect(prompt.length).toBeLessThan(18000);
    });

test("every context mode, evidence setting and table format keeps the section order and closes every fence", () => {
  for (const mode of [ContextMode.DELTA, ContextMode.LATEST])
    for (const data of [false, true])
      for (const flow of [false, true])
        for (const tableFormat of ["markdown", "tsv"] as const) {
          const views: RetrievalView[] = data ? ["sample_stats", "full"] : ["sample", "full"];
          const prompt = buildRegisteredNativeSystemPrompt(mode, {
            retrievalViews: views,
            flowEvidence: flow,
            tableFormat,
          });
          const order = [
            "## 1. Role and objective",
            "## 2. Your resources",
            "## 3. Working with Dataflows",
            "### Built-in operators",
            "### Python functions",
            "### Reading results",
            "## 4. Worked examples",
          ];
          expect(prompt.startsWith(order[0])).toBe(true);
          for (let i = 1; i < order.length; i++)
            expect(prompt.indexOf(order[i - 1])).toBeLessThan(prompt.indexOf(order[i]));
          expect(prompt).not.toMatch(/texera|\{\{|\}\}/i);
          expect((prompt.match(/^```/gm) ?? []).length % 2).toBe(0);
          const receipts = exampleReceipts(prompt);
          expect(/^\s*- flow\b/m.test(receipts)).toBe(false);
          expect(/^statistics: full table/m.test(receipts)).toBe(data);
          expect(/^\|---/m.test(receipts)).toBe(tableFormat === "markdown");
          for (const call of exampleCalls(prompt)) expect(prepareDataflowCall(call, views).status).toBe("pending");
        }
});

test("synthetic teaching edits compile and their calculations run in isolated Python operators", async () => {
  const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { flowEvidence: true });
  let stage: RegisteredStageInput = { operators: {}, python: "", changes: "" };
  const compiled: Record<string, string> = {};
  for (const call of exampleCalls(prompt)) {
    const prepared = prepareDataflowCall(call);
    expect(prepared.status).toBe("pending");
    for (const { action } of prepared.actions) {
      if (action.type !== "edit") continue;
      stage = { ...(await stageRegisteredEdit({ ...stage, ...action })), python: "", changes: "" };
      for (const id of ["totals", "report"]) {
        const op = stage.operators[id];
        if (op) compiled[id] ??= compileNativeOp(op, id).code;
      }
    }
  }
  expect(Object.keys(compiled).sort()).toEqual(["report", "totals"]);
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys,pandas as pd
code=json.load(sys.stdin)
def invoke(name,*tables):
    scope={}
    exec(code[name],scope)
    return scope['process'](*tables)
records=pd.DataFrame({'group':['A','A','B','B','A','A'],'value':[10,20,30,40,10,20]})
assert invoke('report',invoke('totals',records)).to_dict('records') == [{'group':'A','total':60},{'group':'B','total':70}]
print('verified')`,
    ],
    { input: JSON.stringify(compiled), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout.trim()).toBe("verified");
}, 30_000);
