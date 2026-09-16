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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../../types/agent";
import { buildDossier } from "../summarize/dossier";
import { mapLegacyToParams, resolveOperatorParams } from "../summarize/params";
import { buildScenario, makeInfo, makeWorkflow } from "../summarize/fixtures";
import { applyFrontierDecay, parseFrontierDecayConfig } from "./frontier-decay";

function healthyChainDossier(sourceInfo = makeInfo(100)) {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "aggregate",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "agg" } }],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "answer",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "answer" } }],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
  ]);

  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "src", type: "DataLoading" }]));
  scenario.storage.setOperatorResult("a1", "src", sourceInfo);
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow(
      [
        { id: "src", type: "DataLoading" },
        { id: "agg", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["src", "agg"]]
    )
  );
  scenario.storage.setOperatorResult("a2", "agg", makeInfo(10));
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "src", type: "DataLoading" },
        { id: "agg", type: "DataProcessing", numInputPorts: 1 },
        { id: "answer", type: "DataProcessing", numInputPorts: 1 },
      ],
      [
        ["src", "agg"],
        ["agg", "answer"],
      ]
    )
  );
  scenario.storage.setOperatorResult("a3", "answer", makeInfo(1));
  return buildDossier(scenario.steps, scenario.storage);
}

function batchedFrontierDossier() {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load",
      toolCalls: ["src_a", "src_b"].map((operatorId, index) => ({
        toolName: "createOrModifyOperator",
        toolCallId: `load-${index}`,
        input: { operatorId },
      })),
      toolResults: ["src_a", "src_b"].map((_, index) => ({
        toolCallId: `load-${index}`,
        output: "ok",
        isError: false,
      })),
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "process both",
      toolCalls: ["child_a", "child_b"].map((operatorId, index) => ({
        toolName: "createOrModifyOperator",
        toolCallId: `child-${index}`,
        input: { operatorId },
      })),
      toolResults: ["child_a", "child_b"].map((_, index) => ({
        toolCallId: `child-${index}`,
        output: "ok",
        isError: false,
      })),
    },
  ]);

  scenario.storage.createSnapshot(
    "a1",
    makeWorkflow([
      { id: "src_a", type: "DataLoading" },
      { id: "src_b", type: "DataLoading" },
    ])
  );
  scenario.storage.setOperatorResult("a1", "src_a", makeInfo(100));
  scenario.storage.setOperatorResult("a1", "src_b", makeInfo(100));
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow(
      [
        { id: "src_a", type: "DataLoading" },
        { id: "src_b", type: "DataLoading" },
        { id: "child_a", type: "DataProcessing", numInputPorts: 1 },
        { id: "child_b", type: "DataProcessing", numInputPorts: 1 },
      ],
      [
        ["src_a", "child_a"],
        ["src_b", "child_b"],
      ]
    )
  );
  scenario.storage.setOperatorResult("a2", "child_a", makeInfo(10));
  scenario.storage.setOperatorResult("a2", "child_b", makeInfo(10));
  return buildDossier(scenario.steps, scenario.storage);
}

function fanOutDossier() {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "branch",
      toolCalls: ["left", "right"].map((operatorId, index) => ({
        toolName: "createOrModifyOperator",
        toolCallId: `branch-${index}`,
        input: { operatorId },
      })),
      toolResults: ["left", "right"].map((_, index) => ({
        toolCallId: `branch-${index}`,
        output: "ok",
        isError: false,
      })),
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "answer",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "answer" } }],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
  ]);

  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "src", type: "DataLoading" }]));
  scenario.storage.setOperatorResult("a1", "src", makeInfo(100));
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow(
      [
        { id: "src", type: "DataLoading" },
        { id: "left", type: "DataProcessing", numInputPorts: 1 },
        { id: "right", type: "DataProcessing", numInputPorts: 1 },
      ],
      [
        ["src", "left"],
        ["src", "right"],
      ]
    )
  );
  scenario.storage.setOperatorResult("a2", "left", makeInfo(10));
  scenario.storage.setOperatorResult("a2", "right", makeInfo(10));
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "src", type: "DataLoading" },
        { id: "left", type: "DataProcessing", numInputPorts: 1 },
        { id: "right", type: "DataProcessing", numInputPorts: 1 },
        { id: "answer", type: "DataProcessing", numInputPorts: 1 },
      ],
      [
        ["src", "left"],
        ["src", "right"],
        ["left", "answer"],
      ]
    )
  );
  scenario.storage.setOperatorResult("a3", "answer", makeInfo(1));
  return buildDossier(scenario.steps, scenario.storage);
}

function invalidatedConsumerDossier() {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load both inputs",
      toolCalls: ["src_a", "src_b"].map((operatorId, index) => ({
        toolName: "createOrModifyOperator",
        toolCallId: `load-${index}`,
        input: { operatorId },
      })),
      toolResults: ["src_a", "src_b"].map((_, index) => ({
        toolCallId: `load-${index}`,
        output: "ok",
        isError: false,
      })),
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "join",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "join", input: { operatorId: "join" } }],
      toolResults: [{ toolCallId: "join", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "repair the other input",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "repair", input: { operatorId: "src_b" } }],
      toolResults: [{ toolCallId: "repair", output: "ok", isError: false }],
    },
  ]);

  const sources = [
    { id: "src_a", type: "DataLoading", properties: { version: 1 } },
    { id: "src_b", type: "DataLoading", properties: { version: 1 } },
  ];
  scenario.storage.createSnapshot("a1", makeWorkflow(sources));
  scenario.storage.setOperatorResult("a1", "src_a", makeInfo(100));
  scenario.storage.setOperatorResult("a1", "src_b", makeInfo(100));

  const joined = [...sources, { id: "join", type: "DataProcessing", numInputPorts: 2 }];
  scenario.storage.createSnapshot(
    "a2",
    makeWorkflow(joined, [
      ["src_a", "join", 0],
      ["src_b", "join", 1],
    ])
  );
  scenario.storage.setOperatorResult("a2", "join", makeInfo(50));

  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        sources[0],
        { ...sources[1], properties: { version: 2 } },
        { id: "join", type: "DataProcessing", numInputPorts: 2 },
      ],
      [
        ["src_a", "join", 0],
        ["src_b", "join", 1],
      ]
    )
  );
  scenario.storage.setOperatorResult("a3", "src_b", makeInfo(100));
  return buildDossier(scenario.steps, scenario.storage);
}

function firstHealthyConsumerDossier() {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load both inputs",
      toolCalls: ["src_a", "src_b"].map((operatorId, index) => ({
        toolName: "createOrModifyOperator",
        toolCallId: `load-${index}`,
        input: { operatorId },
      })),
      toolResults: ["src_a", "src_b"].map((_, index) => ({
        toolCallId: `load-${index}`,
        output: "ok",
        isError: false,
      })),
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "create a join that cannot materialize yet",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "join", input: { operatorId: "join" } }],
      toolResults: [{ toolCallId: "join", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "repair the input so the old join succeeds",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "repair", input: { operatorId: "src_b" } }],
      toolResults: [{ toolCallId: "repair", output: "ok", isError: false }],
    },
  ]);

  const workflowV1 = makeWorkflow(
    [
      { id: "src_a", type: "DataLoading", properties: { version: 1 } },
      { id: "src_b", type: "DataLoading", properties: { version: 1 } },
      { id: "join", type: "DataProcessing", numInputPorts: 2 },
    ],
    [
      ["src_a", "join", 0],
      ["src_b", "join", 1],
    ]
  );
  scenario.storage.createSnapshot(
    "a1",
    makeWorkflow(
      workflowV1.operators.slice(0, 2).map(operator => ({
        id: operator.operatorID,
        type: operator.operatorType,
        properties: operator.operatorProperties,
      }))
    )
  );
  scenario.storage.setOperatorResult("a1", "src_a", makeInfo(100));
  scenario.storage.setOperatorResult("a1", "src_b", makeInfo(100));
  scenario.storage.createSnapshot("a2", workflowV1);
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "src_a", type: "DataLoading", properties: { version: 1 } },
        { id: "src_b", type: "DataLoading", properties: { version: 2 } },
        { id: "join", type: "DataProcessing", numInputPorts: 2 },
      ],
      [
        ["src_a", "join", 0],
        ["src_b", "join", 1],
      ]
    )
  );
  scenario.storage.setOperatorResult("a3", "src_b", makeInfo(100));
  scenario.storage.setOperatorResult("a3", "join", makeInfo(50));
  return buildDossier(scenario.steps, scenario.storage);
}

function firstHealthyConsumerAfterRewriteDossier() {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "build a working join",
      toolCalls: ["src_a", "src_b", "join"].map((operatorId, index) => ({
        toolName: "createOrModifyOperator",
        toolCallId: `build-${index}`,
        input: { operatorId },
      })),
      toolResults: ["src_a", "src_b", "join"].map((_, index) => ({
        toolCallId: `build-${index}`,
        output: "ok",
        isError: false,
      })),
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "rewrite the join and break it",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "rewrite", input: { operatorId: "join" } }],
      toolResults: [{ toolCallId: "rewrite", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "repair the sibling input",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "repair", input: { operatorId: "src_b" } }],
      toolResults: [{ toolCallId: "repair", output: "ok", isError: false }],
    },
  ]);

  const workflow = (sourceVersion: number, joinVersion: number) =>
    makeWorkflow(
      [
        { id: "src_a", type: "DataLoading", properties: { version: 1 } },
        { id: "src_b", type: "DataLoading", properties: { version: sourceVersion } },
        { id: "join", type: "DataProcessing", numInputPorts: 2, properties: { version: joinVersion } },
      ],
      [
        ["src_a", "join", 0],
        ["src_b", "join", 1],
      ]
    );

  scenario.storage.createSnapshot("a1", workflow(1, 1));
  scenario.storage.setOperatorResult("a1", "src_a", makeInfo(100));
  scenario.storage.setOperatorResult("a1", "src_b", makeInfo(100));
  scenario.storage.setOperatorResult("a1", "join", makeInfo(50));
  scenario.storage.createSnapshot("a2", workflow(1, 2));
  scenario.storage.setOperatorResult("a2", "join", makeInfo(0, { error: "broken rewrite" }));
  scenario.storage.createSnapshot("a3", workflow(2, 2));
  scenario.storage.setOperatorResult("a3", "src_b", makeInfo(100));
  scenario.storage.setOperatorResult("a3", "join", makeInfo(50));
  return buildDossier(scenario.steps, scenario.storage);
}

function richLatestParams() {
  return mapLegacyToParams(ContextMode.LATEST, {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    schemaInResult: true,
  });
}

describe("frontier decay", () => {
  test("reduces rows and stats only for a healthy operator outside the active frontier", () => {
    const params = applyFrontierDecay(
      richLatestParams(),
      healthyChainDossier(),
      parseFrontierDecayConfig({ sampleRows: 3, minStepsSinceEdit: 1 })
    );

    const source = resolveOperatorParams(params, "src");
    expect(source.result.latest.detail).toBe("sample");
    expect(source.result.latest.tuple.sampleRows).toBe(3);
    expect(source.result.latest.column.schema).toBe(true);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);

    const nearFrontier = resolveOperatorParams(params, "agg");
    expect(nearFrontier.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(nearFrontier.result.latest.column ?? {}, "stats")).toBe(false);

    const frontier = resolveOperatorParams(params, "answer");
    expect(frontier.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(frontier.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("validates the conservative row and age bounds", () => {
    expect(() => parseFrontierDecayConfig({ sampleRows: 0 })).toThrow();
    expect(() => parseFrontierDecayConfig({ minStepsSinceEdit: -1 })).toThrow();
    expect(() => parseFrontierDecayConfig({ minConsumerStepsSinceEdit: -1 })).toThrow();
    expect(() => parseFrontierDecayConfig({ minConsumerStepsSinceHealthy: -1 })).toThrow();
    expect(() => parseFrontierDecayConfig({ minConsumerStepsSinceHealthy: 0 })).toThrow();
  });

  test("protects every direct parent of operators edited in the latest batch", () => {
    const params = applyFrontierDecay(
      richLatestParams(),
      batchedFrontierDossier(),
      parseFrontierDecayConfig({ minStepsSinceEdit: 0, minConsumerStepsSinceEdit: 0 })
    );

    for (const sourceId of ["src_a", "src_b"]) {
      const source = resolveOperatorParams(params, sourceId);
      expect(source.result.latest.tuple.sampleRows).toBe(0);
      expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
    }
  });

  test("protects fan-out operators even when one branch is settled", () => {
    const params = applyFrontierDecay(richLatestParams(), fanOutDossier(), parseFrontierDecayConfig({}));
    const source = resolveOperatorParams(params, "src");

    expect(source.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("protects dirty loads whose generic headers may need raw rows", () => {
    const dirtyLoad = makeInfo(100, {
      sampleRows: [
        { "Unnamed: 0": "header", "Unnamed: 1": "value" },
        { "Unnamed: 0": "A", "Unnamed: 1": "1" },
      ],
    });
    const params = applyFrontierDecay(richLatestParams(), healthyChainDossier(dirtyLoad), parseFrontierDecayConfig({}));
    const source = resolveOperatorParams(params, "src");

    expect(source.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("requires the sole consumer to be healthy in the current leaf snapshot", () => {
    const dossier = invalidatedConsumerDossier();
    expect(dossier.leafSnapshot.results.has("src_a")).toBe(true);
    expect(dossier.leafSnapshot.results.has("join")).toBe(false);

    const params = applyFrontierDecay(richLatestParams(), dossier, parseFrontierDecayConfig({}));
    const source = resolveOperatorParams(params, "src_a");
    expect(source.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("keeps parents on the consumer's first healthy materialization event", () => {
    const params = applyFrontierDecay(richLatestParams(), firstHealthyConsumerDossier(), parseFrontierDecayConfig({}));
    const source = resolveOperatorParams(params, "src_a");
    expect(source.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("ignores healthy consumer results that predate a later rewrite", () => {
    const params = applyFrontierDecay(
      richLatestParams(),
      firstHealthyConsumerAfterRewriteDossier(),
      parseFrontierDecayConfig({})
    );
    const source = resolveOperatorParams(params, "src_a");
    expect(source.result.latest.tuple.sampleRows).toBe(0);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("does not apply the current-snapshot policy to delta history", () => {
    const delta = mapLegacyToParams(ContextMode.DELTA, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      schemaInResult: true,
    });

    expect(applyFrontierDecay(delta, healthyChainDossier(), parseFrontierDecayConfig({}))).toEqual(delta);
  });

  test("never raises a cheaper base detail level", () => {
    const base = richLatestParams();
    const dossier = healthyChainDossier();
    for (const detail of ["shape", "omit"] as const) {
      const patched = applyFrontierDecay(
        {
          ...base,
          operators: {
            ...base.operators,
            overrides: {
              src: { result: { latest: { detail } } },
            },
          },
        },
        dossier,
        parseFrontierDecayConfig({})
      );
      expect(resolveOperatorParams(patched, "src").result.latest.detail).toBe(detail);
    }
  });

  test("never raises an existing smaller sample cap", () => {
    const base = richLatestParams();
    const patched = applyFrontierDecay(
      {
        ...base,
        operators: {
          ...base.operators,
          overrides: {
            src: { result: { latest: { tuple: { sampleRows: 2 } } } },
          },
        },
      },
      healthyChainDossier(),
      parseFrontierDecayConfig({ sampleRows: 3 })
    );
    const source = resolveOperatorParams(patched, "src");
    expect(source.result.latest.tuple.sampleRows).toBe(2);
    expect(Object.hasOwn(source.result.latest.column ?? {}, "stats")).toBe(false);
  });
});
