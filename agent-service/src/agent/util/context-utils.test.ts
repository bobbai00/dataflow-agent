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
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { computeDelta, deckRowCap, estimateTokens, type AssembleContextOptions } from "./context-utils";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import type { ReActStep } from "../../types/agent";
import type { WorkflowContent } from "../../types/workflow";
import type { OperatorInfo } from "../../types/execution";
import { renderText } from "../context/summarize/fixtures";

/* ============================================================================
 *  Fixtures
 * ========================================================================= */

function makeOp(id: string, type = "TestOp", properties: Record<string, any> = {}) {
  return {
    operatorID: id,
    operatorType: type,
    operatorVersion: "1",
    operatorProperties: properties,
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: `${type} ${id}`,
  } as any;
}

function makeWorkflow(opIds: string[], links: Array<[string, string]> = []): WorkflowContent {
  return {
    operators: opIds.map(id => makeOp(id)),
    operatorPositions: {},
    links: links.map(([s, t]) => ({
      linkID: `link-${s}-${t}`,
      source: { operatorID: s, portID: "output-0" },
      target: { operatorID: t, portID: "input-0" },
    })),
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

function makeStep(overrides: Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">): ReActStep {
  return {
    messageId: "msg-default",
    parentId: undefined,
    timestamp: 1,
    content: "",
    isBegin: true,
    isEnd: true,
    ...overrides,
  };
}

function makeInfo(opId: string, rows: number, error?: string): OperatorInfo {
  return {
    operatorID: opId,
    state: error ? "Failed" : "Completed",
    inputTuples: 0,
    outputTuples: rows,
    inputPortShapes: undefined,
    totalRowCount: rows,
    result: error ? undefined : Array.from({ length: Math.min(rows, 3) }, (_, i) => ({ id: i + 1, value: `v${i}` })),
    error,
  } as unknown as OperatorInfo;
}

interface Scenario {
  steps: ReActStep[];
  storage: WorkflowSnapshotStorage;
  workflowState: WorkflowState;
}

/** Build a path walker that mirrors TexeraAgent.getAncestorPath: walks
 *  parentId chains in the test's step list. */
function buildScenario(stepsInput: Array<Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">>): Scenario {
  const steps = stepsInput.map(s => makeStep(s));
  const storage = new WorkflowSnapshotStorage(stepId => {
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = steps.find(s => s.id === cur)?.parentId;
    }
    return chain;
  });
  return { steps, storage, workflowState: new WorkflowState() };
}

/** Build the canonical 5-step scenario the paper uses (init → user → 2 agent actions → final reply). */
function buildCanonicalScenario() {
  const scenario = buildScenario([
    {
      id: "init",
      stepId: 0,
      role: "agent",
      messageId: "m-init",
      content: "Initialization",
      toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: { workflowId: 42 } }],
      toolResults: [{ toolCallId: "tc-init", output: "Initialization: state=Empty.", isError: false }],
    },
    { id: "user", stepId: 0, role: "user", messageId: "m-task", parentId: "init", content: "Build me a pipeline." },
    {
      id: "t1",
      stepId: 1,
      role: "agent",
      messageId: "m-task",
      parentId: "user",
      content: "I'll start with the source.",
      isBegin: true,
      isEnd: false,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc-t1", input: { operatorId: "src" } }],
      toolResults: [{ toolCallId: "tc-t1", output: "ok", isError: false }],
    },
    {
      id: "t2",
      stepId: 2,
      role: "agent",
      messageId: "m-task",
      parentId: "t1",
      content: "Now the filter.",
      isBegin: false,
      isEnd: false,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc-t2", input: { operatorId: "filt" } }],
      toolResults: [{ toolCallId: "tc-t2", output: "ok", isError: false }],
    },
    {
      id: "t3",
      stepId: 3,
      role: "agent",
      messageId: "m-task",
      parentId: "t2",
      content: "What should I do next?",
      isBegin: false,
      isEnd: false, // task still ongoing — exercises the # Ongoing Task header
      // thought-only — no toolCalls
    },
  ]);
  // Init loaded a single existing operator; t1 adds src; t2 adds filt.
  scenario.storage.createSnapshot("init", makeWorkflow(["existing"]));
  scenario.storage.setOperatorResult("init", "existing", makeInfo("existing", 5));
  scenario.storage.createSnapshot("t1", makeWorkflow(["existing", "src"]));
  scenario.storage.setOperatorResult("t1", "src", makeInfo("src", 100));
  scenario.storage.createSnapshot("t2", makeWorkflow(["existing", "src", "filt"], [["src", "filt"]]));
  scenario.storage.setOperatorResult("t2", "filt", makeInfo("filt", 12));
  return scenario;
}

/** The DELTA context the renderer produces, before the transcript frames it. */
function render(
  steps: ReActStep[],
  workflowState: WorkflowState,
  storage: WorkflowSnapshotStorage,
  options: AssembleContextOptions = {}
): string {
  return renderText({ steps, workflowState, storage }, options);
}

/** The compress compaction's deck, which renders each operator as a block. An
 *  extra event on the last event's dataflow and a window nothing fits fold
 *  every event into it. */
function renderDeck(scenario: Scenario): string {
  const last = scenario.steps[scenario.steps.length - 1];
  scenario.steps.push(
    makeStep({
      id: "fold",
      stepId: last.stepId + 1,
      role: "agent",
      messageId: last.messageId,
      parentId: last.id,
      toolCalls: [{ toolName: "noop", toolCallId: "tc-fold", input: {} }],
    })
  );
  scenario.storage.createSnapshot("fold", scenario.storage.getAssociatedSnapshot(last.id).workflow);
  return render(scenario.steps, scenario.workflowState, scenario.storage, {
    contextWindowTokens: 1,
    compactionStrategy: "compress",
  });
}

/* ============================================================================
 *  Delta mode
 * ========================================================================= */

describe("assembleContext — Delta", () => {
  test("event 3's Observation lists filt (changed) and omits unchanged src/existing", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = render(steps, workflowState, storage);
    // After init exclusion: t2 (was event 4) is now event 3. The Observation is a
    // minimal per-operator list; slice event 3's whole block.
    const after3 = c.slice(c.indexOf("## Agent Event 3"), c.indexOf("## Agent Event 4"));

    // The Δ operator (filt) is listed with its raw result.
    expect(after3).toContain("Observation:");
    expect(after3).toContain("- operator filt added");
    expect(after3).toContain("result:");
    // Unchanged operators (src, existing) aren't in this event's Δ → not listed.
    expect(after3).not.toContain("- operator src");
    expect(after3).not.toContain("- operator existing");
  });

  test("delta Observation: Inputs is shown; Links/Used by/Summary are not", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = render(steps, workflowState, storage);
    const after3 = c.slice(c.indexOf("## Agent Event 3"), c.indexOf("## Agent Event 4"));
    // Inputs (DAG adjacency from the LEAF snapshot) renders on the op's
    // most-recent edit — filt consumes src.
    expect(after3).toContain("Inputs: src");
    // The other operator-block structural decorations belong to snapshot blocks.
    expect(after3).not.toContain("#### Links");
    expect(after3).not.toContain("Used by:");
    expect(after3).not.toContain("Summary:");
    // At data_level 0 (default opts) there is still no data-facet decoration.
    expect(after3).not.toContain("Schema (");
  });

  test("delta Observation retains schema formatting independently of evidence", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = render(steps, workflowState, storage, { schemaInResult: true });
    const after3 = c.slice(c.indexOf("## Agent Event 3"), c.indexOf("## Agent Event 4"));
    // data_level >= 1 ⇒ the Δ result carries the Schema line.
    expect(after3).toContain("Schema (");
    expect(after3).toContain("Inputs: src");
    // Used by / Summary belong to snapshot blocks (not part of the data facet).
    expect(after3).not.toContain("Used by:");
    expect(after3).not.toContain("Summary:");
  });

  test("when Δ is empty (no operator added/modified/re-executed), the operators block is omitted", () => {
    // Build a scenario where the agent re-runs an action that doesn't touch
    // any operator: we manually create a snapshot identical to the prior one
    // (no new ops, no prop changes, no new results sourced at the new step).
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "first",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: "a" } }],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "second",
        // Same operator already exists; toolcall here is just to make this
        // step action-bearing so a snapshot is created.
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc2", input: { operatorId: "a" } }],
        toolResults: [{ toolCallId: "tc2", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["a"]));
    storage.setOperatorResult("a1", "a", makeInfo("a", 5));
    // a2's snapshot has the same op with the same properties and no new
    // sourceStepId result → empty Δ.
    storage.createSnapshot("a2", makeWorkflow(["a"]));
    const c = render(steps, workflowState, storage);
    // Event numbering: user=1, a1=2, a2=3. a1 added op "a" → event 2's
    // Observation renders its result-summary `#### Operators` block. a2 re-issues
    // a no-op modify on "a" (same props, no new sourceStepId result) → empty Δ →
    // event 3's Observation carries only the one-line action outcome, no
    // `#### Operators` result-summary block.
    const ev2 = c.slice(c.indexOf("## Agent Event 2"), c.indexOf("## Agent Event 3"));
    const ev3 = c.slice(c.indexOf("## Agent Event 3"));
    expect(ev2).toContain("- operator a added");
    expect(ev2).toContain("result:");
    // a2 is a no-op modify (same props, no new result) → empty Δ → "a" is not a
    // changed/re-executed operator, just a one-line "(no change)" outcome.
    expect(ev3).not.toContain("- operator a added");
    expect(ev3).not.toContain("- operator a updated");
    expect(ev3).toContain("- operator a (no change): ok");
  });

  test("no trailing # Current Dataflow block", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = render(steps, workflowState, storage);
    expect(c).not.toContain("# Current Dataflow");
  });
});

/* ============================================================================
 *  Budgeted context (contextWindowTokens + compaction)
 * ========================================================================= */

describe("estimateTokens / deckRowCap", () => {
  test("estimateTokens is chars/4, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("deckRowCap: ratio of rows, clamped to [3, cap]", () => {
    expect(deckRowCap(makeInfo("x", 1000), 0.1, 20)).toBe(20);
    expect(deckRowCap(makeInfo("x", 5), 0.1, 20)).toBe(3);
    expect(deckRowCap(makeInfo("x", 300), 0.1, 25)).toBe(25);
    expect(deckRowCap(makeInfo("x", 200), 0.1, 50)).toBe(20);
    expect(deckRowCap(makeInfo("x", 1000), undefined, undefined)).toBe(20);
    expect(deckRowCap(makeInfo("x", 0, "boom"), 0.1, 20)).toBe(3);
  });
});

describe("assembleContext — contextWindowTokens compaction (DELTA)", () => {
  // src@t1(100); filt edited at t2(50), t3(33), t4(12). Four snapshot-bearing
  // agent events — the unit both compaction strategies fold/evict from the front.
  function fourEventScenario() {
    const sc = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "mi",
        content: "init",
        toolCalls: [{ toolName: "initialize", toolCallId: "ti", input: { workflowId: 1 } }],
        toolResults: [{ toolCallId: "ti", output: "init", isError: false }],
      },
      { id: "u", stepId: 0, role: "user", messageId: "m", parentId: "init", content: "Task." },
      {
        id: "t1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        isBegin: true,
        content: "add src",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c1", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "c1", output: "ok", isError: false }],
      },
      {
        id: "t2",
        stepId: 2,
        role: "agent",
        messageId: "m",
        parentId: "t1",
        content: "add filt",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c2", input: { operatorId: "filt" } }],
        toolResults: [{ toolCallId: "c2", output: "ok", isError: false }],
      },
      {
        id: "t3",
        stepId: 3,
        role: "agent",
        messageId: "m",
        parentId: "t2",
        content: "fix filt v2",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c3", input: { operatorId: "filt" } }],
        toolResults: [{ toolCallId: "c3", output: "ok", isError: false }],
      },
      {
        id: "t4",
        stepId: 4,
        role: "agent",
        messageId: "m",
        parentId: "t3",
        content: "fix filt v3",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "c4", input: { operatorId: "filt" } }],
        toolResults: [{ toolCallId: "c4", output: "ok", isError: false }],
      },
    ]);
    sc.storage.createSnapshot("t1", makeWorkflow(["src"]));
    sc.storage.setOperatorResult("t1", "src", makeInfo("src", 100));
    sc.storage.createSnapshot("t2", makeWorkflow(["src", "filt"], [["src", "filt"]]));
    sc.storage.setOperatorResult("t2", "filt", makeInfo("filt", 50));
    const filtWf = (tag: number): any => ({
      operators: [makeOp("src"), makeOp("filt", "TestOp", { v: tag })],
      operatorPositions: {},
      links: [
        {
          linkID: "l",
          source: { operatorID: "src", portID: "output-0" },
          target: { operatorID: "filt", portID: "input-0" },
        },
      ],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    });
    sc.storage.createSnapshot("t3", filtWf(3));
    sc.storage.setOperatorResult("t3", "filt", makeInfo("filt", 33));
    sc.storage.createSnapshot("t4", filtWf(4));
    sc.storage.setOperatorResult("t4", "filt", makeInfo("filt", 12));
    return sc;
  }

  test("window 0 (off): unbounded lossless delta — no compaction", () => {
    const sc = fourEventScenario();
    const c = render(sc.steps, sc.workflowState, sc.storage);
    expect(c).not.toContain("omitted");
    expect(c).not.toContain("# Dataflow (compacted");
    expect(c).toContain("Output Table: 50 rows, 2 cols");
  });

  test("large window (>0, fits): raw delta, no compaction, Phase-A schema-only profile", () => {
    const sc = fourEventScenario();
    const c = render(sc.steps, sc.workflowState, sc.storage, {
      contextWindowTokens: 100000,
      compactionStrategy: "compress",
    });
    expect(c).not.toContain("# Dataflow (compacted");
    expect(c).not.toContain("omitted");
    expect(c).toContain("Output Table: 50 rows, 2 cols");
    expect(c).toContain("Output Table: 12 rows, 2 cols");
    expect(c).toContain("Schema (2 cols): id, value");
  });

  test("sliding, tiny window: drops oldest events, keeps most recent, reseeds delta", () => {
    const sc = fourEventScenario();
    const c = render(sc.steps, sc.workflowState, sc.storage, { contextWindowTokens: 1, compactionStrategy: "sliding" });
    expect(c).toContain("earlier events omitted");
    expect(c).toContain("Output Table: 12 rows, 2 cols");
    expect(c).toContain("- operator filt updated");
    expect(c).not.toContain("- operator filt added");
    expect(c).not.toContain("- operator src added");
    expect(c).not.toContain("Operator `src`");
  });

  test("compress, tiny window: folds prefix into a stats deck, PRESERVES folded operators", () => {
    const sc = fourEventScenario();
    const c = render(sc.steps, sc.workflowState, sc.storage, {
      contextWindowTokens: 1,
      compactionStrategy: "compress",
    });
    expect(c).toContain("# Dataflow (compacted");
    expect(c).not.toContain("earlier events omitted");
    expect(c).toContain("Operator `src`");
    expect(c).toContain("Operator `filt`");
    expect(c).toContain("Output Table: 12 rows, 2 cols");
  });

  test("compress vs sliding contrast at the same window: compress keeps src, sliding drops it", () => {
    const a = fourEventScenario();
    const slid = render(a.steps, a.workflowState, a.storage, { contextWindowTokens: 1, compactionStrategy: "sliding" });
    const b = fourEventScenario();
    const comp = render(b.steps, b.workflowState, b.storage, {
      contextWindowTokens: 1,
      compactionStrategy: "compress",
    });
    expect(slid).not.toContain("Operator `src`");
    expect(comp).toContain("Operator `src`");
  });

  test("compress, partial fold: deck prefix + raw-delta suffix coexist", () => {
    const ref = fourEventScenario();
    const lossless = render(ref.steps, ref.workflowState, ref.storage);
    const windowTokens = Math.floor(lossless.length / 4) - 1;
    const sc = fourEventScenario();
    const c = render(sc.steps, sc.workflowState, sc.storage, {
      contextWindowTokens: windowTokens,
      compactionStrategy: "compress",
    });
    expect(c).toContain("# Dataflow (compacted");
    expect(c).toContain("Operator `src`");
    expect(c).toContain("# Agent Events (since the compacted snapshot above)");
  });
});

/* ============================================================================
 *  Δ computation
 * ========================================================================= */

describe("computeDelta", () => {
  test("everything in the first non-empty snapshot is added when prev is the empty root", () => {
    const { storage } = buildScenario([{ id: "x", stepId: 0, role: "agent", toolCalls: [] }]);
    const prev = storage.getRootSnapshot();
    const curr = storage.createSnapshot("x", makeWorkflow(["a", "b", "c"]));
    const delta = computeDelta(prev, curr);
    expect(delta).toEqual(new Set(["a", "b", "c"]));
  });

  test("modified operatorProperties mark an op as changed", () => {
    const { storage } = buildScenario([
      { id: "p", stepId: 0, role: "agent", toolCalls: [] },
      { id: "q", stepId: 1, role: "agent", parentId: "p", toolCalls: [] },
    ]);
    const wfP: WorkflowContent = {
      operators: [makeOp("a", "TestOp", { code: "v1" }), makeOp("b", "TestOp", { code: "v1" })],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    storage.createSnapshot("p", wfP);
    const wfQ: WorkflowContent = {
      operators: [makeOp("a", "TestOp", { code: "v1" }), makeOp("b", "TestOp", { code: "v2" })],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    const curr = storage.createSnapshot("q", wfQ);
    const delta = computeDelta(storage.getSnapshotById(storage.getRootSnapshot().id), curr);
    // Without supplying prev as p's snapshot, both a and b appear "added".
    expect(delta.has("a")).toBe(true);
    expect(delta.has("b")).toBe(true);

    // Now with prev as p's snapshot: only b is in delta.
    const prevP = storage.getAssociatedSnapshot("p");
    const delta2 = computeDelta(prevP, curr);
    expect(delta2).toEqual(new Set(["b"]));
  });

  test("newly-earned results at the snapshot's owning step are in delta even if workflow shape is unchanged", () => {
    const { storage } = buildScenario([
      { id: "p", stepId: 0, role: "agent", toolCalls: [] },
      { id: "q", stepId: 1, role: "agent", parentId: "p", toolCalls: [] },
    ]);
    // Identical workflow on both snapshots; only the results differ.
    const wf = makeWorkflow(["a", "b"]);
    storage.createSnapshot("p", wf);
    storage.setOperatorResult("p", "a", makeInfo("a", 1));
    storage.setOperatorResult("p", "b", makeInfo("b", 2));
    storage.createSnapshot("q", wf);
    storage.setOperatorResult("q", "b", makeInfo("b", 999)); // re-execute b at q
    const prev = storage.getAssociatedSnapshot("p");
    const curr = storage.getAssociatedSnapshot("q");
    const delta = computeDelta(prev, curr);
    expect(delta).toEqual(new Set(["b"])); // a inherited from p → not in delta
  });
});

/* ============================================================================
 *  Invariants of the events and the compacted deck
 * ========================================================================= */

describe("assembleContext — invariants", () => {
  test("DELTA keeps the request in place among the events", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();

    // Delta renders the events section, the request at its own position: each
    // agent event + its standard tool-call Action + its Observation.
    const c = render(steps, workflowState, storage);
    expect(c).not.toContain("# User Task");
    expect(c).toContain("## User Event 1\n\nBuild me a pipeline.");
    expect(c).toContain("# Agent Events");
    expect(c).toContain("## Agent Event 2");
    expect(c).toContain("## Agent Event 3");
    expect(c).toContain("## Agent Event 4");
    // Standard tool-call Action: registered tool name + key:value params.
    expect(c).toContain("Action:");
    expect(c).toContain("- createOrModifyOperator");
    expect(c).toContain("operatorId: src");
    expect(c).toContain("operatorId: filt");
    // Observation lists the affected operators.
    expect(c).toContain("Observation:");
    expect(c).toContain("- operator src added");
    expect(c).toContain("- operator filt added");
    expect(c).not.toContain("# Recent Agent Events");
  });

  // Shared single-step scenario builder for the property-rendering tests:
  // one agent step whose snapshot holds `op` (built by the caller).
  function propScenario(op: ReturnType<typeof makeOp>): Scenario {
    const scenario = buildScenario([
      {
        id: "x",
        stepId: 0,
        role: "agent",
        toolCalls: [{ toolName: "init", toolCallId: "tc", input: {} }],
        toolResults: [{ toolCallId: "tc", output: "ok", isError: false }],
      },
    ]);
    const wf: WorkflowContent = {
      operators: [op],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    scenario.storage.createSnapshot("x", wf);
    return scenario;
  }

  test("Python code operators' code is always stripped", () => {
    // DataLoading (a CODE_OPERATOR_TYPE) carries a `code` property; assert no
    // render surfaces it, though other operators' properties render.
    const scenario = propScenario(makeOp("op1", "DataLoading", { code: "def load(): return secret_payload" }));
    const cDelta = render(scenario.steps, scenario.workflowState, scenario.storage);
    const cDeck = renderDeck(scenario);
    expect(cDeck).toContain("### Operator `op1` (DataLoading)");
    for (const c of [cDelta, cDeck]) {
      expect(c).not.toContain("secret_payload");
      expect(c).not.toContain("Properties:");
    }
  });

  test("non-code operator properties render in the compacted deck", () => {
    const scenario = propScenario(makeOp("flt", "Filter", { predicate: "age > 18" }));

    // DELTA's minimal Observation never renders operator Properties — config rides
    // on the Action's params, not here.
    const cDelta = render(scenario.steps, scenario.workflowState, scenario.storage);
    expect(cDelta).not.toContain("Properties:");

    const cDeck = renderDeck(scenario);
    expect(cDeck).toContain("Properties:");
    expect(cDeck).toContain("age > 18");
  });

  test("empty-property operators never render a Properties line", () => {
    const c = renderDeck(propScenario(makeOp("noprops", "Filter", {})));
    expect(c).toContain("### Operator `noprops` (Filter)");
    expect(c).not.toContain("Properties:");
  });
});

/* ============================================================================
 *  Delta tool-call Action format + per-operator Observation
 * ========================================================================= */

describe("assembleContext — delta Action / Observation format", () => {
  test('first createOrModifyOperator call on an op renders as `create operator "X"`', () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "loading",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc",
            // code and summary are intentionally included in the input but
            // the new contract says they're NOT surfaced on the event line.
            input: { operatorId: "src", code: "def load(): ...", summary: "Load customers.csv" },
          },
        ],
        toolResults: [
          { toolCallId: "tc", output: "Added operator src, input ports: 0, output ports: 1", isError: false },
        ],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a", makeWorkflow(["src"]));

    const cFull = render(steps, workflowState, storage);
    // Standard tool-call Action: registered tool name + key:value params, code as a block.
    expect(cFull).toContain("Action:");
    expect(cFull).toContain("- createOrModifyOperator");
    expect(cFull).toContain("operatorId: src");
    expect(cFull).toContain("summary: Load customers.csv");
    expect(cFull).toContain("code:");
    expect(cFull).toContain("def load(): ..."); // code IS shown — the action is lossless
    // The tool RESULT is not inlined into the action; it lives in the Observation.
    expect(cFull).not.toContain(", result:");
    // Observation lists the created operator.
    expect(cFull).toContain("- operator src added");
  });

  test('subsequent createOrModifyOperator call on the same op renders as `modify operator "X"`', () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "create",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "t1", output: "Added operator src", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "rewrite",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "t2", output: "Updated operator src", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    storage.setOperatorResult("a1", "src", makeInfo("src", 3));
    storage.createSnapshot("a2", makeWorkflow(["src"]));
    // a2 re-executes src (new result sourced at a2) → src is in a2's Δ.
    storage.setOperatorResult("a2", "src", makeInfo("src", 4));
    const c = render(steps, workflowState, storage);
    // Both calls render in standard tool-call form...
    expect(c).toContain("- createOrModifyOperator");
    expect(c).toContain("operatorId: src");
    // ...and the create-vs-modify distinction shows in the Observation verb.
    expect(c).toContain("- operator src added");
    expect(c).toContain("- operator src updated");
    expect(c).not.toContain(", result:");
  });

  test('deleteOperator renders as `delete operator "X"`', () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add and remove",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "tmp" } },
          { toolName: "deleteOperator", toolCallId: "t2", input: { operatorId: "tmp" } },
        ],
        toolResults: [
          { toolCallId: "t1", output: "Added operator tmp", isError: false },
          { toolCallId: "t2", output: "Deleted operator tmp", isError: false },
        ],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow([])); // empty after delete
    const c = render(steps, workflowState, storage);
    // Both tool calls render in standard form (tool name + params)...
    expect(c).toContain("- createOrModifyOperator");
    expect(c).toContain("- deleteOperator");
    expect(c).toContain("operatorId: tmp");
    // ...and the delete surfaces in the Observation.
    expect(c).toContain("- operator tmp deleted");
  });

  test("a REFUSED delete renders as `not deleted` with the reason, never as a delete", () => {
    // `deleteOperator` is refused while another operator still reads the target
    // (the consumer guard). The observation used to report those as deletes, so
    // the model was told an operator was gone while it was still in the DAG —
    // and still rendering in every later observation.
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add a consumer, then try to delete its input",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } },
          { toolName: "deleteOperator", toolCallId: "t2", input: { operatorId: "src" } },
        ],
        toolResults: [
          { toolCallId: "t1", output: "Added operator src", isError: false },
          {
            toolCallId: "t2",
            output: "[ERROR] `src` still feeds `consumer`; re-point or delete those first.",
            isError: true,
          },
        ],
        isEnd: true,
      },
    ]);
    // The operator SURVIVED the refused delete: that snapshot is the fact.
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    const c = render(steps, workflowState, storage);
    expect(c).not.toContain("- operator src deleted");
    expect(c).toContain("- operator src (not deleted): [ERROR] `src` still feeds `consumer`");
  });

  test("create → delete → re-create on same id reads as two separate `create`s", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "create",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "op" } }],
        toolResults: [{ toolCallId: "t1", output: "Added operator op", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "delete",
        toolCalls: [{ toolName: "deleteOperator", toolCallId: "t2", input: { operatorId: "op" } }],
        toolResults: [{ toolCallId: "t2", output: "Deleted operator op", isError: false }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        parentId: "a2",
        messageId: "m1",
        content: "recreate",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "op" } }],
        toolResults: [{ toolCallId: "t3", output: "Added operator op", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["op"]));
    storage.createSnapshot("a2", makeWorkflow([]));
    storage.createSnapshot("a3", makeWorkflow(["op"]));
    const c = render(steps, workflowState, storage);
    // Both creations read as `added` in the Observation (delete reset the id), and
    // the delete shows once. Two `- operator op added` lines (a1 and a3).
    const matches = c.match(/- operator op added/g) ?? [];
    expect(matches.length).toBe(2);
    expect(c).toContain("- operator op deleted");
  });

  test('non-special tool name falls back to `<toolName> on operator "X"`', () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "run",
        toolCalls: [{ toolName: "executeOperator", toolCallId: "t", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "t", output: "Executed operator src", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a", makeWorkflow(["src"]));
    const c = render(steps, workflowState, storage);
    // Any tool renders by its registered name + params; the affected op shows in the Observation.
    expect(c).toContain("- executeOperator");
    expect(c).toContain("operatorId: src");
    expect(c).toContain("- operator src updated");
  });

  test("an errored operator's error surfaces in its Observation result, not inlined in the action", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "trying",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc", input: { operatorId: "x" } }],
        toolResults: [{ toolCallId: "tc", output: "[ERROR] something broke", isError: true }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a", makeWorkflow(["x"]));
    // In a real run the failed op's error lands in its snapshot result; the
    // Observation renders it via the operator's Result block (T/A/O), and the
    // Action line stays result-free.
    storage.setOperatorResult("a", "x", makeInfo("x", 0, "something broke\n  hint: try with encoding='latin-1'"));
    const c = render(steps, workflowState, storage);
    expect(c).toContain("Action:");
    expect(c).not.toContain(", result:");
    const obs = c.slice(c.indexOf("Observation:"));
    expect(obs).toContain("- operator x added");
    expect(obs).toContain("[ERROR] something broke");
    expect(obs).toContain("hint: try with encoding='latin-1'");
  });

  test("delta error result is self-contained: keeps exception + `at line N` + `Operator code:` block", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "trying",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc",
            input: { operatorId: "x", code: "def process(df):\n    return df['missing']" },
          },
        ],
        toolResults: [{ toolCallId: "tc", output: "[ERROR] KeyError", isError: true }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a", makeWorkflow(["x"]));
    // Engine-style error: exception + `at line N` pointer + an `Operator code:` block.
    const engineError =
      "KeyError: 'missing'\n  at line 2 in `process`\n\nOperator code:\n  1 | def process(df):\n> 2 |     return df['missing']";
    storage.setOperatorResult("a", "x", makeInfo("x", 0, engineError));

    // DELTA: the error result is self-contained — exception + line pointer + the
    // `Operator code:` block (kept so the failing line is shown in context, even
    // though the Action above also carries the code).
    const cDelta = render(steps, workflowState, storage);
    expect(cDelta).toContain("[ERROR] KeyError: 'missing'");
    expect(cDelta).toContain("at line 2 in `process`");
    expect(cDelta).toContain("Operator code:");
  });

  test("thought-only agent event renders no `Actions:` block", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "thinking out loud, no tools",
        // no toolCalls — exercises the thought-only branch
        isEnd: true,
      },
    ]);
    const c = render(steps, workflowState, storage);
    expect(c).toContain("## Agent Event 2");
    expect(c).toContain("Thought: thinking out loud, no tools");
    // No `Actions:` label, no event line, no `result:` text.
    expect(c).not.toContain("Actions:");
    expect(c).not.toContain(", result:");
  });
});

/* ============================================================================
 *  Action-less steps don't own snapshots
 * ========================================================================= */

describe("assembleContext — action-less steps", () => {
  test("user steps and thought-only agent steps don't trigger snapshot rendering", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      { id: "a", stepId: 1, role: "agent", parentId: "u", messageId: "m1", content: "hi back", isEnd: true },
    ]);
    const c = render(steps, workflowState, storage);
    // No snapshots created → no inline snapshot headers (either flavour name).
    expect(c).not.toContain("Completed dataflow after event");
    expect(c).not.toContain("Dataflow changes after event");
    // The user message stays in place as ## User Event 1.
    expect(c).not.toContain("# User Task");
    expect(c).toContain("## User Event 1\n\nhi");
    // Agent thought rendered inline as ## Agent Event 2.
    expect(c).toContain("## Agent Event 2");
    expect(c).toContain("Thought: hi back");
  });
});

/* ============================================================================
 *  Skipped-upstream Result placeholder
 *  --------------------------------------------------------------------------
 *  When upstream errors, Amber stops the entire workflow execution
 *  (`AllForOneStrategy` supervision in Controller.scala). Downstream ops
 *  that were scheduled in the same batch end up with no `info` entry at
 *  all — from the agent's view this looks identical to "not yet built".
 *  The renderer adds a `Result: (skipped — upstream operator ... errored)`
 *  marker so the model can distinguish "blocked" from "missing".
 *
 *  Mirrors the archeology trace's symptom: a batch creates two
 *  independent loaders (radiocarbon + climateMeasurements), climate
 *  fails in framework code, and downstream ops that depend on either
 *  loader end up with no Result block.
 * ========================================================================= */
describe("assembleContext — skipped-upstream Result placeholder", () => {
  test("downstream of errored upstream renders a skipped marker", () => {
    const scenario = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "m-init",
        content: "init",
        toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: {} }],
        toolResults: [{ toolCallId: "tc-init", output: "ok", isError: false }],
      },
      { id: "user", stepId: 0, role: "user", messageId: "m-task", parentId: "init", content: "Build it." },
      {
        id: "t1",
        stepId: 1,
        role: "agent",
        messageId: "m-task",
        parentId: "user",
        content: "Loading climateMeasurements; then process to extract Potassium.",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc-load",
            input: { operatorId: "climateMeasurements" },
          },
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc-proc",
            input: { operatorId: "processClimate" },
          },
        ],
        toolResults: [
          { toolCallId: "tc-load", output: "ok", isError: false },
          { toolCallId: "tc-proc", output: "ok", isError: false },
        ],
      },
    ]);
    // Workflow: climateMeasurements → processClimate. Climate errored
    // (the `Unmatched type for field 'Unnamed: 2'` case from
    // archeology); processClimate has no info because Amber stopped
    // the whole DAG when climate's worker crashed.
    scenario.storage.createSnapshot(
      "t1",
      makeWorkflow(["climateMeasurements", "processClimate"], [["climateMeasurements", "processClimate"]])
    );
    scenario.storage.setOperatorResult(
      "t1",
      "climateMeasurements",
      makeInfo("climateMeasurements", 0, "TypeError: Unmatched type for field 'Unnamed: 2'")
    );
    // intentionally no setOperatorResult for processClimate

    const c = renderDeck(scenario);

    // Upstream renders its [ERROR] block normally.
    expect(c).toContain("[ERROR]");
    expect(c).toContain("Unmatched type for field 'Unnamed: 2'");

    // Downstream gets the skipped marker pointing at the errored upstream.
    expect(c).toContain("Result: (skipped — upstream operator `climateMeasurements` errored; see [ERROR] above)");
  });

  test("skipped marker walks transitively through ops with no info", () => {
    // A → B → C: A errored, B has no info (blocked), C has no info
    // (also blocked). C's marker should still point at A — the
    // root-cause ancestor — rather than at B (which has no error of
    // its own).
    const scenario = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "m-init",
        content: "init",
        toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: {} }],
        toolResults: [{ toolCallId: "tc-init", output: "ok", isError: false }],
      },
      { id: "user", stepId: 0, role: "user", messageId: "m-task", parentId: "init", content: "x" },
      {
        id: "t1",
        stepId: 1,
        role: "agent",
        messageId: "m-task",
        parentId: "user",
        content: "build A→B→C",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc-a", input: { operatorId: "A" } }],
        toolResults: [{ toolCallId: "tc-a", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot(
      "t1",
      makeWorkflow(
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["B", "C"],
        ]
      )
    );
    scenario.storage.setOperatorResult("t1", "A", makeInfo("A", 0, "RuntimeError: bad"));
    // B and C: no info → transitively blocked by A

    const c = renderDeck(scenario);

    // Both B and C should point at A as the root-cause ancestor.
    expect(c).toContain("Result: (skipped — upstream operator `A` errored; see [ERROR] above)");
    // The placeholder appears for both B and C — count occurrences.
    const matches = c.match(/Result: \(skipped — upstream operator `A` errored/g);
    expect(matches?.length ?? 0).toBe(2);
  });

  test("multiple errored direct upstreams are listed together", () => {
    // A → C, B → C; both A and B errored. C is blocked by both.
    const scenario = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "m-init",
        content: "init",
        toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: {} }],
        toolResults: [{ toolCallId: "tc-init", output: "ok", isError: false }],
      },
      { id: "user", stepId: 0, role: "user", messageId: "m-task", parentId: "init", content: "x" },
      {
        id: "t1",
        stepId: 1,
        role: "agent",
        messageId: "m-task",
        parentId: "user",
        content: "join two failing sources",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc-a", input: { operatorId: "A" } }],
        toolResults: [{ toolCallId: "tc-a", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot(
      "t1",
      makeWorkflow(
        ["A", "B", "C"],
        [
          ["A", "C"],
          ["B", "C"],
        ]
      )
    );
    scenario.storage.setOperatorResult("t1", "A", makeInfo("A", 0, "TypeError: A failed"));
    scenario.storage.setOperatorResult("t1", "B", makeInfo("B", 0, "ValueError: B failed"));
    // C: no info

    const c = renderDeck(scenario);

    // Both upstreams referenced together (plural "operators"); order
    // tracks the link discovery order.
    expect(c).toMatch(/Result: \(skipped — upstream operators `A`, `B` errored; see \[ERROR\] above\)/);
  });

  test("no placeholder when upstream ran successfully", () => {
    // A succeeded, B downstream has no info (e.g. workflow paused
    // before B was scheduled). We should NOT emit a skipped marker —
    // B genuinely hasn't been executed; nothing failed.
    const scenario = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "m-init",
        content: "init",
        toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: {} }],
        toolResults: [{ toolCallId: "tc-init", output: "ok", isError: false }],
      },
      { id: "user", stepId: 0, role: "user", messageId: "m-task", parentId: "init", content: "x" },
      {
        id: "t1",
        stepId: 1,
        role: "agent",
        messageId: "m-task",
        parentId: "user",
        content: "load A; B is queued for later",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc-a", input: { operatorId: "A" } }],
        toolResults: [{ toolCallId: "tc-a", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot("t1", makeWorkflow(["A", "B"], [["A", "B"]]));
    scenario.storage.setOperatorResult("t1", "A", makeInfo("A", 5));
    // B: no info, but A succeeded

    const c = renderDeck(scenario);

    expect(c).not.toContain("skipped");
    expect(c).not.toContain("Result: (skipped");
  });

  test("no placeholder when op has its own info (errored OR successful)", () => {
    // The placeholder only fires when an op has no info at all. If
    // the op itself errored, we already render the [ERROR] block.
    // If it succeeded, we render its data preview.
    const scenario = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "m-init",
        content: "init",
        toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: {} }],
        toolResults: [{ toolCallId: "tc-init", output: "ok", isError: false }],
      },
      { id: "user", stepId: 0, role: "user", messageId: "m-task", parentId: "init", content: "x" },
      {
        id: "t1",
        stepId: 1,
        role: "agent",
        messageId: "m-task",
        parentId: "user",
        content: "build A→B; both ran",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc-a", input: { operatorId: "A" } }],
        toolResults: [{ toolCallId: "tc-a", output: "ok", isError: false }],
      },
    ]);
    scenario.storage.createSnapshot("t1", makeWorkflow(["A", "B"], [["A", "B"]]));
    scenario.storage.setOperatorResult("t1", "A", makeInfo("A", 0, "TypeError: A failed"));
    scenario.storage.setOperatorResult("t1", "B", makeInfo("B", 0, "ValueError: B failed"));

    const c = renderDeck(scenario);

    // No skipped marker — B has its own error block.
    expect(c).not.toContain("Result: (skipped");
    // But both error messages should be present.
    expect(c).toContain("A failed");
    expect(c).toContain("B failed");
  });
});
