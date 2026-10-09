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

import { expect, spyOn, test } from "bun:test";
import { AgentMode, ContextMode, type ReActStep } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { assembleContext } from "../util/context-utils";
import { compileProgram } from "./program";
import {
  planSeedSources,
  seedOperatorId,
  seedPerSourceChars,
  SEED_BUDGET_MULTIPLIER,
  SEED_MAX_SOURCES,
  SEED_MIN_CHARS_PER_SOURCE,
} from "./seed-sources";

test("seed ids are stable identifiers derived from the file stem and never collide", () => {
  const taken = new Set<string>();
  expect(seedOperatorId("data/archeology/input/roman_cities.csv", taken)).toBe("roman_cities");
  expect(seedOperatorId("data/x/roman-cities.xlsx", taken)).toBe("roman_cities_2");
  expect(seedOperatorId("data/legal/State MSA Fraud and Other Data/*.csv", taken)).toBe(
    "State_MSA_Fraud_and_Other_Data"
  );
  expect(seedOperatorId("data/2016 report.csv", taken)).toBe("src_2016_report");
  expect(seedOperatorId("data/***.csv", taken)).toBe("data");
  expect(seedOperatorId("data/***.csv", taken)).toBe("data_2");
  expect(seedOperatorId("***", taken)).toBe("source");
});

test("the seed program is a valid dataflow: tabular files auto-detect, text files read as raw lines, binaries are skipped", async () => {
  const plan = planSeedSources(
    [
      "data/a/cities.csv",
      "data/a/climate.xlsx",
      "data/a/notes.txt",
      "data/a/orbit.tle",
      "data/a/regions.gpkg",
      "data/a/cities.csv", // duplicate listing
    ],
    2000
  );
  expect(plan.operators.map(o => o.id)).toEqual(["cities", "climate", "notes", "orbit"]);
  expect(plan.operators.map(o => o.format)).toEqual([undefined, undefined, "lines", "lines"]);
  expect(plan.observe).toEqual(["cities", "climate", "notes", "orbit"]);
  expect(plan.skipped).toEqual([{ path: "data/a/regions.gpkg", reason: "binary format needs a process loader" }]);
  expect(plan.program.split("\n")).toEqual([
    'cities = scan("data/a/cities.csv")',
    'climate = scan("data/a/climate.xlsx")',
    'notes = scan("data/a/notes.txt", format="lines")',
    'orbit = scan("data/a/orbit.tle", format="lines")',
  ]);
  const compiled = await compileProgram(plan.program);
  expect(compiled.ok && compiled.statements.every(s => s.view)).toBe(true);
  // Four sources share the budget without shrinking below one result's limit.
  expect(plan.perSourceChars).toBe(2000);
});

test("the observation budget is shared: never above one result, never below a header and a row", () => {
  expect(seedPerSourceChars(1, 2000)).toBe(2000);
  expect(seedPerSourceChars(SEED_BUDGET_MULTIPLIER, 2000)).toBe(2000);
  expect(seedPerSourceChars(5, 2000)).toBe(1600);
  expect(seedPerSourceChars(6, 2000)).toBe(1333);
  expect(seedPerSourceChars(40, 2000)).toBe(SEED_MIN_CHARS_PER_SOURCE);
  expect(
    planSeedSources(["data/a/x.csv", "data/a/y.csv", "data/a/z.csv", "data/a/w.csv", "data/a/v.csv"], 2000)
      .perSourceChars
  ).toBe(1600);
});

test("tasks listing more sources than the cap are not seeded, and every path is reported", () => {
  const many = Array.from({ length: SEED_MAX_SOURCES + 1 }, (_, i) => `data/a/f${i}.csv`);
  const plan = planSeedSources(many, 2000);
  expect(plan.operators).toEqual([]);
  expect(plan.observe).toEqual([]);
  expect(plan.skipped).toHaveLength(SEED_MAX_SOURCES + 1);
  expect(plan.skipped[0]!.reason).toContain(`more than ${SEED_MAX_SOURCES}`);
  expect(planSeedSources([], 2000).operators).toEqual([]);
  expect(planSeedSources(["   "], 2000).operators).toEqual([]);
});

function seededAgent(settings: Record<string, unknown>, onPrepare?: (messages: unknown[]) => void) {
  const metadata = WorkflowSystemMetadata.getInstance();
  metadata.seedCodeModeDefaults();
  const initialized = spyOn(metadata, "isInitialized").mockReturnValue(true);
  let dispatched: unknown[] | undefined;
  const agent = new TexeraAgent({
    agentId: `seed-${Math.random().toString(36).slice(2, 8)}`,
    modelType: "test",
    contextAssembler: ({ visibleSteps, workflowState, snapshotStorage, settings: s }) =>
      assembleContext(visibleSteps, workflowState, snapshotStorage, s.contextMode, {
        agentMode: s.agentMode,
        dataEvidence: s.dataEvidence,
        flowEvidence: s.flowEvidence,
        maxOperatorResultCharLimit: s.maxOperatorResultCharLimit,
        messageLayout: s.messageLayout ?? (s.contextMode === ContextMode.LATEST ? "opSplit" : "native"),
      }),
    driver: {
      runTurn: async options => {
        const prepared = await options.prepareStep({ stepNumber: 0, messages: options.initialMessages } as any);
        dispatched = (prepared as any).messages;
        onPrepare?.(dispatched!);
        await options.onStepFinish({
          text: "**Final Answer: 1**",
          reasoningText: undefined,
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        } as any);
        return {
          text: "**Final Answer: 1**",
          messages: [],
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        };
      },
    },
  });
  agent.updateSettings({ agentMode: AgentMode.NATIVE, contextMode: ContextMode.DELTA, ...settings } as any);
  return { agent, restore: () => initialized.mockRestore(), dispatched: () => dispatched };
}

test("with seedSources on, a message that names its sources gets a zero-usage seed step before the first model step", async () => {
  const { agent, restore, dispatched } = seededAgent({ seedSources: true });
  try {
    await agent.initialize();
    const result = await agent.sendMessage("Question about the cities.", "chat", {
      sources: ["data/archeology/input/roman_cities.csv", "data/archeology/input/notes.txt"],
    });
    expect(result.error).toBeUndefined();
    const steps = agent.getReActSteps().filter(s => !TexeraAgent.isInitializationStep(s));
    const [user, seed, model] = steps;
    expect(user!.role).toBe("user");
    expect(seed!.role).toBe("agent");
    expect(seed!.synthetic).toBe("seed");
    expect(seed!.stepId).toBe(1);
    expect(seed!.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    });
    expect(seed!.toolCalls).toHaveLength(1);
    expect(seed!.toolCalls![0]!.toolName).toBe("dataflow");
    expect(seed!.toolCalls![0]!.input).toEqual({
      reasoning: "Load the supplied source files.",
      actions: [
        {
          type: "edit",
          changes:
            'create operator roman_cities: scan("data/archeology/input/roman_cities.csv")\ncreate operator notes: scan("data/archeology/input/notes.txt", format="lines")',
        },
        { type: "execute", operator_ids: ["roman_cities", "notes"] },
        { type: "retrieve", operator_id: "roman_cities", view: "sample_stats" },
        { type: "retrieve", operator_id: "notes", view: "sample_stats" },
      ],
    });
    const batch = seed!.toolResults![0]!.output as {
      operators: Array<{ status: string; message: string }>;
      observe: string[];
    };
    expect(batch.operators.map(o => `${o.status}: ${o.message}`)).toEqual([
      "added: added scan operator `roman_cities`",
      "added: added scan operator `notes`",
    ]);
    // This fixture has no engine connection: execution is an explicit error,
    // retrieval reports unavailable results, and the sources remain available for repair.
    expect(batch.observe).toEqual([]);
    expect((seed!.toolResults![0]!.output as any).actions.map((a: any) => a.status)).toEqual([
      "ok",
      "error",
      "error",
      "error",
    ]);
    expect(seed!.operatorAccess?.[0]?.addedOperatorIds).toEqual(["roman_cities", "notes"]);
    // The scans are real operators of the DAG the model then builds on.
    expect(agent.getWorkflowState().getOperator("roman_cities")).toBeDefined();
    expect(agent.getWorkflowState().getOperator("notes")).toBeDefined();
    // The model's first step follows the seed and is numbered after it.
    expect(model!.role).toBe("agent");
    expect(model!.synthetic).toBeUndefined();
    expect(model!.stepId).toBe(2);
    expect(model!.isBegin).toBe(false);
    expect(model!.isEnd).toBe(true);
    // The model's first request already carries the seed as a prior tool call
    // and tool result — the same messages its own opening scan would produce.
    const messages = dispatched() as Array<{ role: string; content: unknown }>;
    expect(messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes('"roman_cities"'))).toBe(
      true
    );
    expect(messages.some(m => m.role === "tool" && JSON.stringify(m.content).includes("dataflow-actions"))).toBe(true);
  } finally {
    restore();
  }
});

test("seeding is inert unless the arm opts in and the message names sources", async () => {
  for (const [settings, sources] of [
    [{ seedSources: false }, ["data/a/x.csv"]],
    [{ seedSources: true }, undefined],
    [{ seedSources: true }, []],
  ] as Array<[Record<string, unknown>, string[] | undefined]>) {
    const { agent, restore } = seededAgent(settings);
    try {
      await agent.initialize();
      await agent.sendMessage("Question.", "chat", { sources });
      const steps = agent.getReActSteps().filter(s => !TexeraAgent.isInitializationStep(s));
      expect(steps.map(s => s.role)).toEqual(["user", "agent"]);
      expect(steps.some(s => s.synthetic)).toBe(false);
      expect(steps[1]!.stepId).toBe(1);
      expect(steps[1]!.isBegin).toBe(true);
      expect(agent.getWorkflowState().getAllOperators()).toHaveLength(0);
    } finally {
      restore();
    }
  }
});

test("seeding requires native mode and records nothing in code mode", async () => {
  const { agent, restore } = seededAgent({ seedSources: true, agentMode: AgentMode.CODE });
  try {
    await agent.initialize();
    await agent.sendMessage("Question.", "chat", { sources: ["data/a/x.csv"] });
    const steps = agent.getReActSteps().filter(s => !TexeraAgent.isInitializationStep(s));
    expect(steps.some(s => s.synthetic)).toBe(false);
    expect(agent.getWorkflowState().getAllOperators()).toHaveLength(0);
  } finally {
    restore();
  }
});

test("a listing above the source cap leaves the turn untouched", async () => {
  const { agent, restore } = seededAgent({ seedSources: true });
  try {
    await agent.initialize();
    const many = Array.from({ length: SEED_MAX_SOURCES + 1 }, (_, i) => `data/a/f${i}.csv`);
    await agent.sendMessage("Question.", "chat", { sources: many });
    const steps: ReActStep[] = agent.getReActSteps().filter(s => !TexeraAgent.isInitializationStep(s));
    expect(steps.some(s => s.synthetic)).toBe(false);
    expect(agent.getWorkflowState().getAllOperators()).toHaveLength(0);
  } finally {
    restore();
  }
});
