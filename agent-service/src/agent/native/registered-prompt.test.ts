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
import { buildRegisteredNativeSystemPrompt, registeredReferenceText } from "../prompts";
import { parseTurn } from "./turn-syntax";
import { asSchema } from "ai";
import { ContextMode, type RetrievalView } from "../../types/agent";
import { createRegisteredDataflowTool, prepareRegisteredDataflowActions } from "../tools/dataflow-actions";
import { TexeraAgent } from "../texera-agent";
import { compileNativeOp, nativePython } from "./codegen";
import { stageRegisteredEdit, type RegisteredStageInput } from "./registered";
import { spawnSync } from "node:child_process";

test("registered prompt examples obey the active tool envelope and enabled views", () => {
  for (const retrievalViews of [["full"], ["sample"], ["sample_stats"], ["sample_stats", "full"]] as const) {
    const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { retrievalViews: [...retrievalViews] });
    const calls = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      const result = prepareRegisteredDataflowActions(call, [...retrievalViews]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("pending");
    }
    expect(prompt).not.toContain("{{");
    if (!retrievalViews.includes("sample_stats" as never)) expect(prompt).not.toContain("statistics: full table");
  }
});

for (const view of ["full", "sample", "sample_stats"] as const)
  test(`text teaching examples respect a ${view}-only session`, () => {
    const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
      transport: "text",
      retrievalViews: [view],
      flowEvidence: true,
    });
    for (const [, text] of prompt.matchAll(/````turn\n([\s\S]*?)\n````/g)) {
      const parsed = parseTurn(text, { views: [view] });
      expect(parsed.ok).toBe(true);
    }
    expect(prompt).toContain("show schema <id> [from <index>]");
    expect(prompt).toContain("docstring");
    expect(prompt).not.toContain("statistics on every column");
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

test("registered instructions explain actionable observations without cache bookkeeping", () => {
  const prompt = buildRegisteredNativeSystemPrompt();
  expect(prompt).not.toMatch(/\bcach(?:e|ed|ing)\b/i);
  expect(prompt).toContain("action number");
  expect(prompt).toContain("operator ID");
  expect(prompt).toContain("completed");
  expect(prompt).toContain("No changes were applied");
  const schema = asSchema(createRegisteredDataflowTool().inputSchema).jsonSchema;
  expect(JSON.stringify(schema)).not.toMatch(/\bcach(?:e|ed|ing)\b/i);
});

for (const data of [false, true])
  for (const flow of [false, true])
    test(`registered prompt and live agent settings agree: data=${data}, flow=${flow}`, () => {
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
      expect(prompt.includes("Flow statistics report measured effects")).toBe(flow);
      expect(prompt.includes("also for results you did not request")).toBe(flow);
      if (flow) {
        expect(prompt).toContain("cast failures");
        expect(prompt).toContain("Python functions are not measured");
      }
      expect(prompt).toContain("Every record within 5000 characters");
      expect(prompt).toContain("Put the edits, execution, and retrieval of a known computation in one call");
      // The context holds every definition and receipt: inspection is for what it lacks.
      expect(prompt).toContain("Everything you defined and observed is already in your context");
      expect(prompt).not.toContain("preview=1), execute, and inspect source");

      const calls = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const call of calls) expect(prepareRegisteredDataflowActions(call, retrievalViews).status).toBe("pending");
      const examples = [...prompt.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]).join("\n");
      if (!flow) expect(examples).not.toMatch(/^\s*- flow\b/m);

      const schema = asSchema(createRegisteredDataflowTool(retrievalViews).inputSchema).jsonSchema as any;
      const reads = schema.properties.actions.items.anyOf.filter(
        (action: any) => action.properties.type.const === "retrieve"
      );
      expect(reads).toHaveLength(1);
      for (const read of reads) expect(read.properties.view.enum).toEqual(retrievalViews);
      expect(info.tools).toHaveLength(1);
      expect(info.tools[0].inputSchema).toEqual(schema);
    });

for (const data of [false, true])
  for (const flow of [false, true])
    test(`text transport prompt: turns parse and prepare, sections follow the settings: data=${data}, flow=${flow}`, () => {
      const retrievalViews: RetrievalView[] = data ? ["sample_stats", "full"] : ["sample", "full"];
      const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
        transport: "text",
        retrievalViews,
        dataEvidence: data,
        flowEvidence: flow,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 1000,
        maxResultRows: 5,
      });
      expect(prompt).not.toContain("{{");
      expect(prompt).toContain("Each message you send is one turn");
      expect(prompt).toContain("show result <id>, ... [view]");
      expect(prompt).toContain("Everything you defined and observed is already in your context");
      expect(prompt).not.toContain("```json");
      expect(prompt).not.toContain("Actions run in order.");
      expect(prompt.includes("plus collected column statistics")).toBe(data);
      expect(prompt.includes("Flow statistics report measured effects")).toBe(flow);
      // Every example turn parses and passes the registered validator.
      const turns = [...prompt.matchAll(/````turn\n([\s\S]*?)\n````/g)].map(match => match[1]);
      expect(turns.length).toBeGreaterThanOrEqual(3);
      for (const text of turns) {
        const parsed = parseTurn(text, { views: retrievalViews });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.turn.missingSummary).toBe(false);
        // The answer turn carries no summary; the driver sends a placeholder as the reasoning.
        expect(
          prepareRegisteredDataflowActions(
            { reasoning: parsed.turn.summary || "(no summary)", actions: parsed.turn.actions },
            retrievalViews
          ).status
        ).toBe("pending");
      }
      // The example receipt is real renderer output; statistics lines appear only with data on.
      const receipts = [...prompt.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]).join("\n");
      expect(receipts).toContain("## edits applied");
      expect(receipts).toContain("## show result report full");
      expect(receipts.includes("statistics:")).toBe(data);
      expect(receipts).not.toContain(": not run");
      const fullReport = receipts.split("## show result report full")[1].split("````")[0];
      expect(fullReport).not.toContain("statistics: full table");
      if (data) {
        expect(receipts).toContain("2 of 6 rows");
        expect(receipts).toContain("all: A 4; B 2");
      }
      if (flow) {
        expect(receipts).toContain("kept=2/4, rejected=2");
        expect(receipts).toContain("10 × 2");
      }
    });

test("synthetic teaching edits compile and their calculations and repair run in isolated Python operators", async () => {
  const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { flowEvidence: true });
  const calls = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
  let stage: RegisteredStageInput = { operators: {}, python: "", changes: "" };
  const compiled: Record<string, string> = {};
  for (const call of calls) {
    for (const action of call.actions) {
      if (action.type !== "edit") continue;
      stage = { ...(await stageRegisteredEdit({ ...stage, ...action })), python: "", changes: "" };
      for (const id of ["totals", "report", "kept", "total"]) {
        const op = stage.operators[id];
        if (!op) continue;
        const key =
          id === "kept" || id === "total" ? `${id}_${action.python?.includes(" >= ") ? "fixed" : "first"}` : id;
        compiled[key] ??= compileNativeOp(op, id).code;
      }
    }
  }
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
readings=pd.DataFrame({'value':[10,10,20,20]})
first=invoke('kept_first',readings)
fixed=invoke('kept_fixed',readings)
assert len(first)==2 and len(fixed)==4
assert invoke('total_first',first)['total'].iloc[0]==40
assert invoke('total_fixed',fixed)['total'].iloc[0]==60
print('verified')`,
    ],
    { input: JSON.stringify(compiled), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout.trim()).toBe("verified");
}, 30_000);
