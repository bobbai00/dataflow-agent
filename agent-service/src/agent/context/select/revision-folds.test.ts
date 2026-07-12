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
import { assembleContext } from "../../util/context-utils";
import { buildDossier } from "../summarize/dossier";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../summarize/fixtures";
import { computeRevisionFolds, parseFoldResolvedRevisionsConfig } from "./revision-folds";

const CODE_V1 = "def load():\n    return pd.read_csv('data/damage.csv', encoding='utf-8')";
const CODE_V2 = "def load():\n    return pd.read_csv('data/damage.csv', encoding='cp1252')";
const CODE_CLEAN = "def process(loader):\n    return loader.dropna()";

/**
 * Trajectory (event indices):
 *   ev 1 — create `loader` v1 (CODE_V1) → EXEC ERROR (UnicodeDecodeError)
 *   ev 2 — modify `loader` v2 (CODE_V2) → healthy result (the resolution edit)
 *   ev 3 — create `clean` consuming loader → healthy result (consumption)
 *   ev 4 — create `report` consuming clean → healthy (grace elapses for ev-3 resolution)
 */
function resolvedLoaderScenario(): Scenario {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "load the damage table" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load with utf-8",
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "loader", code: CODE_V1 } },
      ],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "fix the encoding",
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "loader", code: CODE_V2 } },
      ],
      toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "clean it",
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "clean", code: CODE_CLEAN } },
      ],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
    {
      id: "a4",
      stepId: 4,
      role: "agent",
      messageId: "m",
      parentId: "a3",
      content: "report",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t4", input: { operatorId: "report" } }],
      toolResults: [{ toolCallId: "t4", output: "ok", isError: false }],
    },
  ]);

  const loaderOnly = makeWorkflow([{ id: "loader", type: "DataLoading" }]);
  scenario.storage.createSnapshot("a1", loaderOnly);
  scenario.storage.setOperatorResult(
    "a1",
    "loader",
    makeInfo(0, { error: "UnicodeDecodeError: 'utf-8' codec can't decode byte 0x92 in position 10" })
  );
  scenario.storage.createSnapshot("a2", loaderOnly);
  scenario.storage.setOperatorResult("a2", "loader", makeInfo(100));
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "loader", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["loader", "clean"]]
    )
  );
  scenario.storage.setOperatorResult("a3", "clean", makeInfo(90));
  scenario.storage.createSnapshot(
    "a4",
    makeWorkflow(
      [
        { id: "loader", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
        { id: "report", type: "DataProcessing", numInputPorts: 1 },
      ],
      [
        ["loader", "clean"],
        ["clean", "report"],
      ]
    )
  );
  scenario.storage.setOperatorResult("a4", "report", makeInfo(10));
  return scenario;
}

describe("computeRevisionFolds", () => {
  test("folds the superseded revision's action and observation after resolution + grace", () => {
    const scenario = resolvedLoaderScenario();
    const folds = computeRevisionFolds(
      buildDossier(scenario.steps, scenario.storage),
      parseFoldResolvedRevisionsConfig({})
    );

    const actionFact = folds.actions.get(2)?.get("loader");
    expect(actionFact).toBeDefined();
    expect(actionFact).toContain("superseded revision");
    expect(actionFact).toContain("Event 3");

    const observationFact = folds.observations.get(2)?.get("loader");
    expect(observationFact).toBeDefined();
    expect(observationFact).toContain("UnicodeDecodeError");
    expect(observationFact).toContain("Event 3");

    // The resolving revision itself stays raw.
    expect(folds.actions.get(3)?.get("loader")).toBeUndefined();
    expect(folds.observations.get(3)?.get("loader")).toBeUndefined();
  });

  test("grace holds the fold back until an event has elapsed since consumption", () => {
    const scenario = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "v1",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "loader", code: CODE_V1 } },
        ],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        messageId: "m",
        parentId: "a1",
        content: "v2",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "loader", code: CODE_V2 } },
        ],
        toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        messageId: "m",
        parentId: "a2",
        content: "consume",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "clean", code: CODE_CLEAN } },
        ],
        toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
      },
    ]);
    const loaderOnly = makeWorkflow([{ id: "loader", type: "DataLoading" }]);
    scenario.storage.createSnapshot("a1", loaderOnly);
    scenario.storage.setOperatorResult("a1", "loader", makeInfo(0, { error: "boom" }));
    scenario.storage.createSnapshot("a2", loaderOnly);
    scenario.storage.setOperatorResult("a2", "loader", makeInfo(100));
    scenario.storage.createSnapshot(
      "a3",
      makeWorkflow(
        [
          { id: "loader", type: "DataLoading" },
          { id: "clean", type: "DataProcessing", numInputPorts: 1 },
        ],
        [["loader", "clean"]]
      )
    );
    scenario.storage.setOperatorResult("a3", "clean", makeInfo(90));
    const dossier = buildDossier(scenario.steps, scenario.storage);

    // Consumption lands at the current event (3): grace 1 → not yet.
    const graced = computeRevisionFolds(dossier, parseFoldResolvedRevisionsConfig({ graceEvents: 1 }));
    expect(graced.actions.size).toBe(0);
    expect(graced.observations.size).toBe(0);

    // grace 0 → folds immediately.
    const eager = computeRevisionFolds(dossier, parseFoldResolvedRevisionsConfig({ graceEvents: 0 }));
    expect(eager.actions.get(2)?.get("loader")).toBeDefined();
  });

  test("requires a sole healthy consumer — fan-out and consumerless ops never fold", () => {
    const scenario = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "v1",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "loader", code: CODE_V1 } },
        ],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        messageId: "m",
        parentId: "a1",
        content: "v2",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "loader", code: CODE_V2 } },
        ],
        toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        messageId: "m",
        parentId: "a2",
        content: "branch",
        toolCalls: ["left", "right"].map((operatorId, index) => ({
          toolName: "createOrModifyOperator",
          toolCallId: `b-${index}`,
          input: { operatorId, code: CODE_CLEAN },
        })),
        toolResults: ["left", "right"].map((_, index) => ({ toolCallId: `b-${index}`, output: "ok", isError: false })),
      },
      {
        id: "a4",
        stepId: 4,
        role: "agent",
        messageId: "m",
        parentId: "a3",
        content: "one more",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t4", input: { operatorId: "tail" } }],
        toolResults: [{ toolCallId: "t4", output: "ok", isError: false }],
      },
    ]);
    const loaderOnly = makeWorkflow([{ id: "loader", type: "DataLoading" }]);
    scenario.storage.createSnapshot("a1", loaderOnly);
    scenario.storage.setOperatorResult("a1", "loader", makeInfo(0, { error: "boom" }));
    scenario.storage.createSnapshot("a2", loaderOnly);
    scenario.storage.setOperatorResult("a2", "loader", makeInfo(100));
    const fanOut = makeWorkflow(
      [
        { id: "loader", type: "DataLoading" },
        { id: "left", type: "DataProcessing", numInputPorts: 1 },
        { id: "right", type: "DataProcessing", numInputPorts: 1 },
      ],
      [
        ["loader", "left"],
        ["loader", "right"],
      ]
    );
    scenario.storage.createSnapshot("a3", fanOut);
    scenario.storage.setOperatorResult("a3", "left", makeInfo(50));
    scenario.storage.setOperatorResult("a3", "right", makeInfo(50));
    scenario.storage.createSnapshot(
      "a4",
      makeWorkflow(
        [
          { id: "loader", type: "DataLoading" },
          { id: "left", type: "DataProcessing", numInputPorts: 1 },
          { id: "right", type: "DataProcessing", numInputPorts: 1 },
          { id: "tail", type: "DataProcessing", numInputPorts: 1 },
        ],
        [
          ["loader", "left"],
          ["loader", "right"],
          ["left", "tail"],
        ]
      )
    );
    scenario.storage.setOperatorResult("a4", "tail", makeInfo(5));

    const folds = computeRevisionFolds(
      buildDossier(scenario.steps, scenario.storage),
      parseFoldResolvedRevisionsConfig({})
    );
    expect(folds.actions.size).toBe(0);
    expect(folds.observations.size).toBe(0);
  });

  test("rejected submissions fold under the same resolution", () => {
    const scenario = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "v1",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "loader", code: CODE_V1 } },
        ],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        messageId: "m",
        parentId: "a1",
        content: "rejected edit",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "loader", code: "bad code" } },
        ],
        toolResults: [{ toolCallId: "t2", output: "[ERROR] invalid python", isError: true }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        messageId: "m",
        parentId: "a2",
        content: "v2 lands",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "loader", code: CODE_V2 } },
        ],
        toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
      },
      {
        id: "a4",
        stepId: 4,
        role: "agent",
        messageId: "m",
        parentId: "a3",
        content: "consume",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t4", input: { operatorId: "clean", code: CODE_CLEAN } },
        ],
        toolResults: [{ toolCallId: "t4", output: "ok", isError: false }],
      },
      {
        id: "a5",
        stepId: 5,
        role: "agent",
        messageId: "m",
        parentId: "a4",
        content: "tail",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t5", input: { operatorId: "report" } }],
        toolResults: [{ toolCallId: "t5", output: "ok", isError: false }],
      },
    ]);
    const loaderOnly = makeWorkflow([{ id: "loader", type: "DataLoading" }]);
    scenario.storage.createSnapshot("a1", loaderOnly);
    scenario.storage.setOperatorResult("a1", "loader", makeInfo(100));
    scenario.storage.createSnapshot("a3", loaderOnly);
    scenario.storage.setOperatorResult("a3", "loader", makeInfo(100));
    const chain = makeWorkflow(
      [
        { id: "loader", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["loader", "clean"]]
    );
    scenario.storage.createSnapshot("a4", chain);
    scenario.storage.setOperatorResult("a4", "clean", makeInfo(90));
    scenario.storage.createSnapshot(
      "a5",
      makeWorkflow(
        [
          { id: "loader", type: "DataLoading" },
          { id: "clean", type: "DataProcessing", numInputPorts: 1 },
          { id: "report", type: "DataProcessing", numInputPorts: 1 },
        ],
        [
          ["loader", "clean"],
          ["clean", "report"],
        ]
      )
    );
    scenario.storage.setOperatorResult("a5", "report", makeInfo(1));

    const folds = computeRevisionFolds(
      buildDossier(scenario.steps, scenario.storage),
      parseFoldResolvedRevisionsConfig({})
    );
    expect(folds.actions.get(2)?.get("loader")).toContain("superseded revision");
    expect(folds.actions.get(3)?.get("loader")).toContain("rejected submission");
    expect(folds.actions.get(4)?.get("loader")).toBeUndefined();
  });
});

describe("fold-resolved-revisions rendering (DELTA)", () => {
  test("flag off renders the superseded code verbatim; flag on folds it to the resolution fact", () => {
    const scenario = resolvedLoaderScenario();
    const baseOptions = {
      compilationResult: null,
      agentMode: AgentMode.CODE,
      includeOperatorProperties: true,
      maxResultRows: 10,
    } as const;

    const off = assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
      ...baseOptions,
    });
    const offText = String(off[0].content);
    expect(offText).toContain("encoding='utf-8'");
    expect(offText).toContain("UnicodeDecodeError");
    expect(offText).not.toContain("(folded — superseded revision");

    const on = assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
      ...baseOptions,
      foldResolvedRevisions: true,
    });
    const onText = String(on[0].content);
    // The superseded v1 code body is folded; the resolving v2 code stays raw.
    expect(onText).not.toContain("encoding='utf-8'");
    expect(onText).toContain("encoding='cp1252'");
    expect(onText).toContain("(folded — superseded revision; resolved by the revision at Event 3)");
    expect(onText).toContain("failed: UnicodeDecodeError");
    // Everything after the fold region is unchanged.
    expect(onText).toContain("def process(loader)");
  });

  test("flag on with no resolved revisions renders byte-identically to flag off", () => {
    // A single healthy revision per operator — nothing to fold.
    const scenario = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "load",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "loader", code: CODE_V2 } },
        ],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "loader", type: "DataLoading" }]));
    scenario.storage.setOperatorResult("a1", "loader", makeInfo(100));

    const opts = { compilationResult: null, agentMode: AgentMode.CODE, maxResultRows: 10 } as const;
    const off = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, { ...opts })[0]
        .content
    );
    const on = String(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.DELTA, {
        ...opts,
        foldResolvedRevisions: true,
      })[0].content
    );
    expect(on).toBe(off);
  });
});
