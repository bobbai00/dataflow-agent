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
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { AgentMode, ContextMode, type ResultSelection } from "../types/agent";
import { buildNativeModeSystemPrompt } from "./prompts";
import { createNativeBatchTools, nativeBatchSchema } from "./tools/native-batch-tools";
import { NATIVE_OPERATORS } from "./native/catalog";
import { TexeraAgent } from "./texera-agent";
import { WorkflowState } from "./workflow-state";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";

const modes = [ContextMode.DELTA, ContextMode.LATEST];
const selections: ResultSelection[] = ["all", "rule", "scoped"];
const layouts = [
  {},
  { recall: true },
  { session: true },
  { session: true, recall: true },
  { versioned: true },
  { versioned: true, recall: true },
];

describe("native batch system prompt", () => {
  test("typed baseline prompt bytes remain unchanged with inspection disabled", () => {
    const prompts = modes.flatMap(mode =>
      selections.flatMap(selection =>
        layouts.map(layout => buildNativeModeSystemPrompt(mode, false, selection, layout))
      )
    );
    // Captured from baseline 41cd8ae before removal (36 inspection-off variants).
    expect(createHash("sha256").update(JSON.stringify(prompts)).digest("hex")).toBe(
      "0e5ca425fc87c773b0fc7851b82d725d2786d26f90fe655b184fd1a59045bc1d"
    );
  });

  test("batch variants describe operator objects, execution phase, and requested results without stale tool instructions", () => {
    const validate = new Ajv({ strict: false }).compile(nativeBatchSchema());
    for (const mode of modes) {
      for (const selection of selections) {
        for (const layout of layouts) {
          const prompt = buildNativeModeSystemPrompt(mode, false, selection, { ...layout, batch: true });
          expect(prompt).not.toContain("{{");
          expect(prompt).not.toContain("Licensed to the Apache");
          expect(prompt).not.toContain("parallel tool calls");
          expect(prompt).not.toContain("one tool each");
          expect(prompt).not.toContain("calling its tool again");
          expect(prompt).not.toContain("scan(id");
          expect(prompt).not.toContain("the whole dataflow executes");
          expect(prompt).toContain("one post-step execution phase");
          expect(prompt).toContain("separate backend requests");
          expect(prompt).toContain("explicitly include its id in `observe`");
          expect(prompt).toContain("Omitted `observe` or `observe: []`");
          expect(prompt).not.toContain("terminal outputs among successfully submitted operators");
          expect(prompt).toContain("dependent operators in one batch");
          expect(prompt).toContain("round trips");
          expect(prompt).toContain("observe: []");
          expect(prompt).not.toContain("inspectResult");
          expect(prompt).not.toContain("stats: true");
          expect(prompt).toContain("cannot request hidden statistics");
          expect(prompt).toContain("cached sample");
          expect(prompt).toContain("no matching sampled rows does not prove absence");
          expect(prompt.includes("recallState")).toBe(layout.recall === true);
          for (const op of NATIVE_OPERATORS) expect(prompt).toContain(`{op: "${op.type.toLowerCase()}"`);
          const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
          expect(examples.length).toBeGreaterThanOrEqual(5);
          for (const example of examples) {
            expect(validate(example)).toBe(true);
            expect(Array.isArray(example.observe)).toBe(true);
          }
        }
      }
    }
  });

  test("prompt tracks cached observations across DELTA, LATEST and explicit layouts", () => {
    const delta = buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", { batch: true });
    const latest = buildNativeModeSystemPrompt(ContextMode.LATEST, false, "all", { batch: true });
    expect(delta).toContain("Each event preserves its own observe choices");
    expect(delta).not.toContain("# Inspections");
    expect(latest).not.toContain("# Inspections");
    expect(latest).toContain("most recent batch's requested set");
    for (const layout of [{ session: true }, { messageLayout: "block" as const }]) {
      expect(buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", { ...layout, batch: true })).not.toContain(
        "# Inspections"
      );
    }
  });

  test("the prompt's examples compile and wire together against the existing DAG", async () => {
    const state = new WorkflowState();
    const metadata = new WorkflowSystemMetadata();
    metadata.seedCodeModeDefaults();
    const batch = createNativeBatchTools(state, { metadataStore: metadata }).dataflow;
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", { batch: true });
    const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
    for (const example of examples) {
      const receipt = await batch.execute(example);
      expect(receipt.operators.every((o: { status: string }) => ["added", "modified"].includes(o.status))).toBe(true);
      expect(receipt.observationErrors).toEqual([]);
      expect(receipt.observe).toEqual(example.observe);
    }
    expect(state.getOperator("recent")?.nativeOp?.properties.predicate).toBe("year = 2025");
    expect(state.getOperator("share")?.nativeOp?.inputs).toEqual(["totals"]);
    expect(state.getOperator("totals")?.nativeOp?.inputs).toEqual(["total", "all_sales"]);
    expect(state.getAllLinks().some(l => l.source.operatorID === "recent" && l.target.operatorID === "total")).toBe(
      true
    );
  });

  test("runtime mode/layout changes rebuild the matching prompt and expose only the batch mutation surface", () => {
    const agent = new TexeraAgent({
      agentId: "batch-prompt-test",
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    agent.updateSettings({
      agentMode: AgentMode.NATIVE,
      nativeToolMode: "batch",
      contextMode: ContextMode.DELTA,
      parallelToolCalls: true,
      enableInspectTool: false,
    });
    expect(agent.getSettings().parallelToolCalls).toBe(false);
    expect(Object.keys((agent as any).tools).sort()).toEqual(["dataflow", "deleteOperator"]);
    expect(agent.getSettings().systemPrompt).toContain("native tool-call transcript");
    agent.updateSettings({ messageLayout: "block" });
    expect(agent.getSettings().systemPrompt).toContain("# Agent Events");
    expect(agent.getSettings().systemPrompt).not.toContain("# Inspections");
    agent.updateSettings({ nativeToolMode: "typed", parallelToolCalls: true });
    expect(agent.getSettings().parallelToolCalls).toBe(true);
    expect((agent as any).tools.dataflow).toBeUndefined();
    expect((agent as any).tools.scan).toBeDefined();
    expect(agent.getSettings().systemPrompt).toContain("parallel tool calls");
  });
});
