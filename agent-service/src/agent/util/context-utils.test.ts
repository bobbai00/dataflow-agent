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
import { computeDelta, type AssembleContextOptions } from "./context-utils";
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
      toolCalls: [{ toolName: "noop", toolCallId: "tc-t1", input: {} }],
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
      toolCalls: [{ toolName: "noop", toolCallId: "tc-t2", input: {} }],
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
    expect(after3).toContain("- operator filt updated");
    expect(after3).toContain("result:");
    // Unchanged operators (src, existing) aren't in this event's Δ → not listed.
    expect(after3).not.toContain("- operator src");
    expect(after3).not.toContain("- operator existing");
  });

  test("delta Observation: Links/Used by/Summary are not shown", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = render(steps, workflowState, storage);
    const after3 = c.slice(c.indexOf("## Agent Event 3"), c.indexOf("## Agent Event 4"));
    // The operator-block structural decorations belong to snapshot blocks.
    expect(after3).not.toContain("#### Links");
    expect(after3).not.toContain("Used by:");
    expect(after3).not.toContain("Summary:");
    // At data_level 0 (default opts) there is still no data-facet decoration.
    expect(after3).not.toContain("Schema (");
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
        toolCalls: [{ toolName: "noop", toolCallId: "tc1", input: {} }],
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
        toolCalls: [{ toolName: "modifyOperator", toolCallId: "tc2", input: { operatorId: "a" } }],
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
    expect(ev2).toContain("- operator a updated");
    expect(ev2).toContain("result:");
    // a2 is a no-op modify (same props, no new result) → empty Δ → "a" is not a
    // changed/re-executed operator, just a one-line "(no change)" outcome.
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
 *  Invariants of the events
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
    // Standard tool-call Action: the registered tool name.
    expect(c).toContain("Action:");
    expect(c).toContain("- noop");
    // Observation lists the affected operators.
    expect(c).toContain("Observation:");
    expect(c).toContain("- operator src updated");
    expect(c).toContain("- operator filt updated");
    expect(c).not.toContain("# Recent Agent Events");
  });

  // Single-step scenario for the property-rendering test: one agent step whose
  // snapshot holds `op` (built by the caller).
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

  test("a delta Observation renders no operator properties, a code operator's code included", () => {
    // Config rides on the Action's params, not on the Observation.
    for (const op of [
      makeOp("op1", "DataLoading", { code: "def load(): return secret_payload" }),
      makeOp("flt", "Filter", { predicate: "age > 18" }),
    ]) {
      const scenario = propScenario(op);
      const c = render(scenario.steps, scenario.workflowState, scenario.storage);
      expect(c).not.toContain("Properties:");
      expect(c).not.toContain("secret_payload");
      expect(c).not.toContain("age > 18");
    }
  });
});

/* ============================================================================
 *  Delta tool-call Action format + per-operator Observation
 * ========================================================================= */

describe("assembleContext — delta Action / Observation format", () => {
  test('deleteOperator renders as `delete operator "X"`', () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add",
        toolCalls: [{ toolName: "noop", toolCallId: "t1", input: {} }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "remove",
        toolCalls: [{ toolName: "deleteOperator", toolCallId: "t2", input: { id: "tmp" } }],
        toolResults: [{ toolCallId: "t2", output: "deleted operator `tmp`", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["tmp"]));
    storage.createSnapshot("a2", makeWorkflow([])); // empty after delete
    const c = render(steps, workflowState, storage);
    expect(c).toContain("- delete operator `tmp`");
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
        content: "try to delete an input that still has a consumer",
        toolCalls: [{ toolName: "deleteOperator", toolCallId: "t1", input: { id: "src" } }],
        toolResults: [
          {
            toolCallId: "t1",
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

  test("add → delete → re-add on same id reads as two separate adds", () => {
    const add = (id: string) => ({ toolName: "addOperators", toolCallId: id, input: { operators: [{ id: "op" }] } });
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add",
        toolCalls: [add("t1")],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "delete",
        toolCalls: [{ toolName: "deleteOperator", toolCallId: "t2", input: { id: "op" } }],
        toolResults: [{ toolCallId: "t2", output: "deleted operator `op`", isError: false }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        parentId: "a2",
        messageId: "m1",
        content: "re-add",
        toolCalls: [add("t3")],
        toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["op"]));
    storage.createSnapshot("a2", makeWorkflow([]));
    storage.createSnapshot("a3", makeWorkflow(["op"]));
    const c = render(steps, workflowState, storage);
    // Both adds read as `added` in the Observation (delete reset the id), and
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
        toolCalls: [{ toolName: "noop", toolCallId: "tc", input: {} }],
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
    expect(obs).toContain("- operator x updated");
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
        toolCalls: [{ toolName: "noop", toolCallId: "tc", input: {} }],
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
    // `Operator code:` block (kept so the failing line is shown in context).
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
