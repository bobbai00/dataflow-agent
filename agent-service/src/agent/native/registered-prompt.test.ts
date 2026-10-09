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
import { asSchema } from "ai";
import { ContextMode, type RetrievalView } from "../../types/agent";
import { createRegisteredDataflowTool, prepareRegisteredDataflowActions } from "../tools/dataflow-actions";
import { TexeraAgent } from "../texera-agent";

test("registered prompt examples obey the active tool envelope and enabled views", () => {
  for (const retrievalViews of [["full"], ["sample"], ["sample_stats", "full"]] as const) {
    const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { retrievalViews: [...retrievalViews] });
    const calls = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) {
      const result = prepareRegisteredDataflowActions(call, [...retrievalViews]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("pending");
    }
    expect(prompt).not.toContain("{{");
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
      expect(prompt.includes("Column statistics are collected")).toBe(data);
      expect(prompt.includes("### Use optional statistics")).toBe(data);
      expect(prompt.includes("sample_stats")).toBe(data);
      expect(prompt.includes("Flow statistics describe")).toBe(flow);
      expect(prompt.includes("requested operator's result table")).toBe(data);
      expect(prompt.includes("even when their result tables were not requested")).toBe(flow);
      if (flow) {
        expect(prompt).toContain("cast failures");
        expect(prompt).toContain("custom Python boundary");
        expect(prompt).toContain("does not provide filter rejection statistics");
      }
      expect(prompt).toContain("Every record within 5000 characters");
      expect(prompt).toContain("Batch actions whose arguments are known.");

      const calls = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
      expect(calls.length).toBeGreaterThan(2);
      for (const call of calls) expect(prepareRegisteredDataflowActions(call, retrievalViews).status).toBe("pending");
      const examples = [...prompt.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]).join("\n");
      expect(examples.includes("statistics: full table")).toBe(data);
      if (!flow) expect(examples).not.toMatch(/^\s*- flow\b/m);

      const schema = asSchema(createRegisteredDataflowTool(retrievalViews).inputSchema).jsonSchema as any;
      const reads = schema.properties.actions.items.anyOf.filter(
        (action: any) => action.properties.type.const === "retrieve"
      );
      expect(reads).toHaveLength(2);
      for (const read of reads) expect(read.properties.view.enum).toEqual(retrievalViews);
      expect(info.tools).toHaveLength(1);
      expect(info.tools[0].inputSchema).toEqual(schema);
    });
