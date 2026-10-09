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

/**
 * MINIMAL-DAG EXTRACTION — what we ship to the execution service.
 *
 * The rule under test: an execution request carries the upstream closure of
 * the requested targets and NOTHING else, for any number of targets.
 *
 * This is not a cosmetic size preference. The single-target special case that
 * used to gate pruning meant a step touching two connected operators shipped
 * the whole workflow; past ~200 KB of plan JSON the execution service answers
 * `400 Unable to process JSON`, no results come back, every operator renders
 * `(not executed)`, and the model rewrites them in a loop until its step
 * budget is gone. Measured on the 215-operator NFL session: 5 burned turns,
 * ~$0.90 each, 312 such 400s in one log.
 */

import { describe, expect, test, spyOn } from "bun:test";
import { WorkflowState } from "../workflow-state";
import { buildLogicalPlanForTest, executeWorkflowAndPersist } from "./workflow-execution-tools";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import type { OperatorPredicate, OperatorLink } from "../../types/workflow";

/** A chain a→b→c plus an unrelated island x→y, and a diamond d→(e,f)→g. */
function makeState(extraOps = 0): WorkflowState {
  const ids = ["a", "b", "c", "x", "y", "d", "e", "f", "g"];
  for (let i = 0; i < extraOps; i++) ids.push(`filler_${i}`);
  const operators: OperatorPredicate[] = ids.map(id => ({
    operatorID: id,
    operatorType: id === "a" || id === "x" || id === "d" || id.startsWith("filler") ? "DataLoading" : "DataProcessing",
    operatorProperties: { code: `def f(): return ${id}` },
    inputPorts: id === "a" || id === "x" || id === "d" || id.startsWith("filler") ? [] : [{ portID: "input-0" }],
    outputPorts: [{ portID: "output-0" }],
  })) as any;
  const link = (s: string, t: string): OperatorLink =>
    ({
      linkID: `${s}->${t}`,
      source: { operatorID: s, portID: "output-0" },
      target: { operatorID: t, portID: "input-0" },
    }) as any;
  const ws = new WorkflowState();
  ws.setWorkflowContent({
    operators,
    operatorPositions: {},
    links: [
      link("a", "b"),
      link("b", "c"),
      link("x", "y"),
      link("d", "e"),
      link("d", "f"),
      link("e", "g"),
      link("f", "g"),
    ],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  return ws;
}

const idsOf = (plan: { operators: { operatorID: string }[] }): string[] => plan.operators.map(o => o.operatorID).sort();

describe("execution plan carries only the targets' upstream closure", () => {
  test("execution validation ignores an unrelated branch with missing inputs", async () => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const state = makeState();
    state.deleteLink("x->y");
    const requests: any[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true, state: "Completed", operators: {} });
    }) as unknown as typeof globalThis.fetch);
    try {
      const outcome = await executeWorkflowAndPersist(
        state,
        { userToken: "test", workflowId: 789 },
        { opsToViewResult: ["c"] }
      );
      expect(outcome.success).toBe(true);
      expect(requests).toHaveLength(1);
      expect(idsOf(requests[0].logicalPlan)).toEqual(["a", "b", "c"]);
      expect(state.getAllOperators()).toHaveLength(9);
    } finally {
      fetch.mockRestore();
    }
  });

  test("execution rejects a missing upstream input inside the requested branch", async () => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const state = makeState();
    state.deleteLink("b->c");
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("Must not execute");
    }) as unknown as typeof globalThis.fetch);
    try {
      const outcome = await executeWorkflowAndPersist(
        state,
        { userToken: "test", workflowId: 790 },
        { opsToViewResult: ["c"] }
      );
      expect(outcome.success).toBe(false);
      expect(outcome.errorText).toContain("Operator c");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test("mixed valid and unknown targets fail before any execution", async () => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ success: true, state: "Completed", operators: {} })) as unknown as typeof globalThis.fetch);
    try {
      const outcome = await executeWorkflowAndPersist(
        makeState(),
        { userToken: "test", workflowId: 791 },
        { opsToViewResult: ["c", "unknown"] }
      );
      expect(outcome.success).toBe(false);
      expect(outcome.errorText).toContain("unknown");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test("one target ships its ancestors, not the rest of the workflow", () => {
    const plan = buildLogicalPlanForTest(makeState(), ["c"]);
    expect(idsOf(plan)).toEqual(["a", "b", "c"]);
  });

  test("TWO CONNECTED targets stay pruned — the case that shipped everything", () => {
    // `e` and `f` are siblings under `d`: one dependency group, multiple
    // targets. This is the exact shape a parallel-tool-call step produces.
    const plan = buildLogicalPlanForTest(makeState(), ["e", "f"]);
    expect(idsOf(plan)).toEqual(["d", "e", "f"]);
    expect(idsOf(plan)).not.toContain("x");
    expect(idsOf(plan)).not.toContain("g");
  });

  test("two INDEPENDENT targets ship both closures and nothing else", () => {
    const plan = buildLogicalPlanForTest(makeState(), ["c", "y"]);
    expect(idsOf(plan)).toEqual(["a", "b", "c", "x", "y"]);
  });

  test("a shared ancestor is included exactly once", () => {
    const plan = buildLogicalPlanForTest(makeState(), ["e", "f", "g"]);
    expect(idsOf(plan)).toEqual(["d", "e", "f", "g"]);
    const dCount = plan.operators.filter(o => o.operatorID === "d").length;
    expect(dCount).toBe(1);
    // links deduped too: d→e and d→f appear once each, no repeats
    const keys = plan.links.map(l => `${l.fromOpId}->${l.toOpId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("plan size tracks the work, not the session — 200 idle operators cost nothing", () => {
    const plan = buildLogicalPlanForTest(makeState(200), ["e", "f"]);
    expect(plan.operators.length).toBe(3);
    // the whole point: JSON stays far below the execution service's limit
    expect(JSON.stringify(plan).length).toBeLessThan(20_000);
  });

  test("no targets ⇒ whole workflow (the legacy 'run everything' contract)", () => {
    const plan = buildLogicalPlanForTest(makeState(), []);
    expect(plan.operators.length).toBe(9);
  });

  test("opsToViewResult is filtered to operators actually in the plan", () => {
    const plan = buildLogicalPlanForTest(makeState(), ["c", "ghost"]);
    expect(plan.opsToViewResult).toEqual(["c"]);
  });

  test("every link's endpoints exist in the shipped operator set", () => {
    // A plan referencing an operator it does not carry is exactly what the
    // backend rejects; assert closure integrity on a multi-target request.
    const plan = buildLogicalPlanForTest(makeState(50), ["c", "g", "y"]);
    const ids = new Set(plan.operators.map(o => o.operatorID));
    for (const l of plan.links) {
      expect(ids.has(l.fromOpId)).toBe(true);
      expect(ids.has(l.toOpId)).toBe(true);
    }
  });
});

describe("execution phase metrics survive persistence summaries", () => {
  const phaseMetrics = {
    version: 1,
    compilation: "passed",
    compilationDurationMs: 7,
    runtimeStartAttempted: true,
  } as const;

  test.each([true, false])("single execution records engine metrics, success=%s", async success => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success,
        state: success ? "Completed" : "Failed",
        operators: {},
        executionId: "e1",
        phaseMetrics,
        ...(success ? {} : { errors: ["worker failed"] }),
      })
    );
    const runs: unknown[] = [];
    try {
      const outcome = await executeWorkflowAndPersist(
        makeState(),
        { userToken: "test", workflowId: 792 },
        {
          opsToViewResult: ["c"],
          onExecution: run => runs.push(run),
        }
      );
      expect(outcome.executionRuns).toEqual([
        { targets: ["c"], executionId: "e1", success, state: success ? "Completed" : "Failed", phaseMetrics },
      ]);
      expect(runs).toEqual(outcome.executionRuns!);
    } finally {
      fetch.mockRestore();
    }
  });

  test("independent groups retain failed and successful run metrics and results", async () => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const persisted: string[] = [];
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          success: false,
          state: "CompilationFailed",
          operators: {},
          executionId: "bad",
          compilationErrors: { c: "invalid type" },
          phaseMetrics: { ...phaseMetrics, compilation: "failed", runtimeStartAttempted: false },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          state: "Completed",
          executionId: "good",
          phaseMetrics,
          operators: {
            y: { state: "Completed", resultMode: "table", inputTuples: 0, outputTuples: 1, result: [{ x: 1 }] },
          },
        })
      );
    try {
      const outcome = await executeWorkflowAndPersist(
        makeState(),
        { userToken: "test", workflowId: 793 },
        {
          opsToViewResult: ["c", "y"],
          onResult: id => persisted.push(id),
        }
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(outcome.success).toBe(false);
      expect(outcome.executionRuns?.map(run => [run.targets, run.executionId, run.phaseMetrics?.compilation])).toEqual([
        [["c"], "bad", "failed"],
        [["y"], "good", "passed"],
      ]);
      expect(persisted).toEqual(["y"]);
    } finally {
      fetch.mockRestore();
    }
  });

  test("missing backend measurements are null, never fabricated zero", async () => {
    WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false, state: "Error", operators: {}, errors: ["offline"] })
    );
    try {
      const outcome = await executeWorkflowAndPersist(
        makeState(),
        { userToken: "test", workflowId: 794 },
        { opsToViewResult: ["c"] }
      );
      expect(outcome.executionRuns).toEqual([
        { targets: ["c"], executionId: null, success: false, state: "Error", phaseMetrics: null },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });
});
