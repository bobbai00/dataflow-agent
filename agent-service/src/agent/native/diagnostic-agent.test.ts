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
import { AgentMode, ContextMode } from "../../types/agent";
import { TexeraAgent } from "../texera-agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { createNativeTools } from "../tools/native-batch-tools";
import { programOf, type LegacySpec } from "./test-support";
import { assembleContext } from "../util/context-utils";
import * as executionTools from "../tools/workflow-execution-tools";

async function fixture() {
  const agent = new TexeraAgent({
    agentId: "diagnostics",
    modelType: "test",
    driver: {
      runTurn: async () => {
        throw new Error("No LLM in this local integration test");
      },
    },
    contextAssembler: () => [],
  }) as any;
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  agent.metadataStore = metadata;
  Object.assign(agent.settings, { agentMode: AgentMode.NATIVE });
  // Exercise diagnostics retained for archived assignment-based traces.
  const currentTools = agent.createTools.bind(agent);
  agent.createTools = () => ({
    ...currentTools(),
    ...createNativeTools(agent.workflowState, {
      metadataStore: agent.metadataStore,
      nativeValidationRepair: agent.nativeValidationRepair,
      settings: agent.settings,
    }),
  });
  agent.tools = agent.createTools();
  // Tests describe operators as small objects; the tool receives the expressions.
  const call = async (name: string, args: any) => {
    const expressions = name === "dataflow" ? programOf(args.operators as LegacySpec[]) : "";
    const input =
      name === "dataflow" ? { edits: expressions, ...(args.observe ? { observe: args.observe } : {}) } : args;
    const result = await agent.handleDebugInput(
      `Function(name=${JSON.stringify(name)}, arguments=${JSON.stringify(JSON.stringify(input))})`
    );
    const output = agent.getAllSteps().find((step: any) => step.id === agent.getHead()).toolResults[0].output;
    expect(result.error).toBe(output.error);
    expect(output.error ?? "").not.toContain("Invalid dataflow arguments");
    return agent.getHead() as string;
  };
  await agent.handleDebugInput("Test a failing revision and its repair.");
  const first = await call("dataflow", {
    operators: [
      { op: "scan", id: "source", files: "data/fixture.csv" },
      { op: "filter", id: "answer", input: "source", columns: ["x"], func: "def apply(row):\n    return row['x'] > 0" },
      { op: "project", id: "final", input: "answer", keep: ["x"] },
      { op: "project", id: "independent", input: "source", keep: ["x"] },
    ],
    observe: [],
  });
  for (const id of ["source", "answer", "final", "independent"])
    agent.snapshotStorage.setOperatorResult(first, id, {
      state: "Completed",
      resultMode: "table",
      inputTuples: 1,
      outputTuples: 1,
      result: [{ x: "OLD_SUCCESS" }],
    });
  const bad = {
    op: "filter",
    id: "answer",
    input: "source",
    columns: ["x"],
    func: "def apply(row, *REJECTED_SOURCE):\n    return True",
  };
  return { agent, call, first, bad };
}

test("production debug/post-step path pins a rejected revision and blocks stale descendants", async () => {
  const { agent, call, first, bad } = await fixture();
  const before = agent.getWorkflowState().getWorkflowContent();
  const head = await call("dataflow", { operators: [bad], observe: ["final"] });
  const storage = agent.getSnapshotStorage();
  const inspected = storage.inspectNativeError(head, { operatorId: "answer" });
  const outcome = agent.getAllSteps().find((step: any) => step.id === head).toolResults[0].output.operators[0];
  expect(inspected.found).toBe(true);
  expect(inspected.summary?.operatorRevision).toBe(outcome.attempted.revision);
  expect(inspected.summary?.diagnostic.code).toBe("CALLBACK_SIGNATURE");
  expect(inspected.text).toContain("REJECTED_SOURCE");
  expect(inspected.summary?.executionId).toBeNull();
  expect(agent.getWorkflowState().getWorkflowContent()).toEqual(before);
  expect(storage.getOperatorResult(head, "answer")?.result).toBeUndefined();
  expect(storage.getOperatorResult(head, "final")?.state).toBe("Blocked");
  expect(storage.getOperatorResult(head, "final")?.result).toBeUndefined();
  expect(storage.getOperatorResult(head, "independent")?.result?.[0].x).toBe("OLD_SUCCESS");
  expect(storage.getOperatorResult(first, "final")?.result?.[0].x).toBe("OLD_SUCCESS");
  expect(storage.getAssociatedSnapshot(head).nativeObservations?.final).toBeUndefined();
  const observed = await call("dataflow", { operators: [], observe: ["final"] });
  expect(storage.getOperatorResult(observed, "final")?.result).toBeUndefined();
  expect(storage.inspectNativeError(observed, { operatorId: "answer" }).summary).toEqual(inspected.summary);
});

test("unknown operator edits also supersede old successful values without pretending to have operator semantics", async () => {
  const { agent, call } = await fixture();
  const head = await call("dataflow", {
    operators: [{ op: "not_a_real_operator", id: "answer", input: "source" }],
    observe: ["final"],
  });
  const storage = agent.snapshotStorage;
  expect(storage.inspectNativeError(head, { operatorId: "answer" }).found).toBe(true);
  expect(storage.getOperatorResult(head, "final")?.result).toBeUndefined();
  expect(storage.getOperatorResult(head, "answer")?.nativeError?.diagnostic.stage).toBe("validate");
  expect(agent.getWorkflowState().getOperator("answer").nativeOp.type).toBe("Filter");
});

test("there is no inspection tool; a rejected edit's diagnostic is rendered in every layout", async () => {
  const { agent, call, bad } = await fixture();
  await call("dataflow", { operators: [bad], observe: [] });
  expect(agent.tools.inspectError).toBeUndefined();
  expect(agent.tools.deleteOperator).toBeUndefined();
  const failed = agent.getAllSteps().find((step: any) => step.id === agent.getHead());
  const outcome = failed.toolResults[0].output.operators[0];
  expect(outcome.status).toBe("error");
  expect(outcome.diagnostic?.code).toBeDefined();
  for (const mode of [ContextMode.DELTA, ContextMode.LATEST])
    for (const messageLayout of [undefined, "native", "block", "blockSplit", "opSplit", "turnSplit"] as const) {
      const rendered = JSON.stringify(
        assembleContext(agent.getReActSteps(), agent.workflowState, agent.snapshotStorage, mode, {
          agentMode: AgentMode.NATIVE,
          messageLayout,
        })
      );
      expect(rendered).toContain(outcome.diagnostic.code);
      expect(rendered).not.toContain("GENERATED_RUNTIME_NOT_FOR_THE_MODEL");
    }
  agent.settings.agentMode = AgentMode.CODE;
  expect(agent.createTools().inspectError).toBeUndefined();
});

test("late or aborted post-step callbacks cannot attach attempt diagnostics to another HEAD", async () => {
  for (const aborted of [true, false]) {
    const { agent, bad } = await fixture();
    const head = agent.getHead();
    agent.abortController = new AbortController();
    agent.executePostStepChanges = async () => {
      if (aborted) agent.abortController.abort();
      else agent.head = "another-head";
    };
    await agent.runPostStepExecution(
      [{ toolName: "dataflow", toolCallId: "late", input: { edits: programOf([bad as LegacySpec]), observe: [] } }],
      [
        {
          toolCallId: "late",
          output: {
            kind: "native-batch",
            operators: [{ id: "answer", op: "filter", status: "error", message: "Invalid parameters" }],
            observe: [],
            observationErrors: [],
          },
        },
      ]
    );
    expect(agent.snapshotStorage.inspectNativeError(head, { operatorId: "answer" }).found).toBe(false);
  }
});

test("a later downstream edit cannot execute the old DAG across an unrepaired rejected revision", async () => {
  const { agent, call, bad } = await fixture();
  await call("dataflow", { operators: [bad], observe: [] });
  agent.delegateConfig = { workflowId: 17, userToken: "test", computingUnitId: 18 };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      throw new Error("Must not execute across a rejected revision");
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    const head = await call("dataflow", {
      operators: [{ op: "project", id: "new_answer", input: "final", keep: ["x"] }],
      observe: ["new_answer"],
    });
    expect(requests).toBe(0);
    const info = agent.snapshotStorage.getOperatorResult(head, "new_answer");
    expect(info?.state).toBe("Blocked");
    expect(info?.result).toBeUndefined();
    expect(info?.nativeError?.diagnostic.stage).toBe("dependency");
    expect(info?.nativeError?.diagnostic.message).toContain("answer");
    expect(info?.nativeError?.executionId).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V2 error details bypass successful-result omission and do not claim rejected edits executed", async () => {
  const { agent, call, bad } = await fixture();
  await call("dataflow", { operators: [bad], observe: [] });
  for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
    const rendered = JSON.stringify(
      assembleContext(agent.getReActSteps(), agent.workflowState, agent.snapshotStorage, mode, {
        agentMode: AgentMode.NATIVE,
        opExtras: () => ({ detail: "omit", column: {}, tuple: {}, codeHistory: [], resultHistory: [] }) as any,
      })
    );
    expect(rendered).toContain("CALLBACK_SIGNATURE");
    expect(rendered).toContain("UPSTREAM_FAILED");
    expect(rendered).not.toContain("operator `answer` re-executed");
    expect(rendered).not.toContain("operator `final` re-executed");
  }
});

test("an upstream rerun preserves rejected definitions, independent execution, and explicit same-code repair", async () => {
  const { agent, call, bad } = await fixture();
  const rejectedHead = await call("dataflow", { operators: [bad], observe: [] });
  const original = agent.snapshotStorage.inspectNativeError(rejectedHead, { operatorId: "answer" }).summary;
  agent.delegateConfig = { workflowId: 17, userToken: "test", computingUnitId: 18 };
  const targetSets: string[][] = [];
  const execution = spyOn(executionTools, "executeWorkflowAndPersist").mockImplementation(
    async (_state, _config, options = {}) => {
      const targets = options.opsToViewResult ?? [];
      targetSets.push(targets);
      for (const id of targets)
        options.onResult?.(id, {
          state: "Completed",
          resultMode: "table",
          inputTuples: 1,
          outputTuples: 1,
          result: [{ x: 7 }],
        });
      return { success: true, state: "Completed", opCount: targets.length, errorCount: 0 };
    }
  );
  try {
    const head = await call("dataflow", {
      operators: [{ op: "scan", id: "source", files: "data/revised.csv" }],
      execute: true,
      observe: [],
    });
    expect(targetSets).toEqual([["source", "independent"]]);
    expect(agent.snapshotStorage.getOperatorResult(head, "answer")?.nativeError).toEqual(original);
    expect(agent.snapshotStorage.getOperatorResult(head, "final")?.state).toBe("Blocked");
    expect(agent.snapshotStorage.getOperatorResult(head, "independent")?.error).toBeUndefined();
    expect(agent.snapshotStorage.inspectNativeError(head, { operatorId: "answer" }).summary).toEqual(original);
    // Deliberately restore the old accepted function, which did not change the
    // DAG hash while the rejected attempt was pending. This is still a repair.
    const repaired = await call("dataflow", {
      operators: [{ ...bad, func: "def apply(row):\n    return row['x'] > 0" }],
      execute: true,
      observe: ["final"],
    });
    // The archived editor executes changed operators; accepted ancestors remain cached.
    expect(targetSets[1]).toEqual(["answer", "final"]);
    expect(agent.snapshotStorage.getAssociatedSnapshot(repaired).nativeRejectedEdits?.answer).toBeUndefined();
    expect(agent.snapshotStorage.inspectNativeError(repaired, { operatorId: "answer" }).found).toBe(false);
    expect(agent.snapshotStorage.getOperatorResult(repaired, "final")?.result).toEqual([{ x: 7 }]);
    expect(
      agent.snapshotStorage.inspectNativeError(repaired, { operatorId: "answer", diagnosticId: original.diagnosticId })
        .text
    ).toContain("Historical error");
  } finally {
    execution.mockRestore();
  }
});
