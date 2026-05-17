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
import { assembleContext, computeDelta, __forTesting } from "./context-utils";
const { computeBeforeAfterTrimSet, stripBeforeAfterBlock } = __forTesting;
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { WorkflowState } from "../workflow-state";
import { AgentMode, ContextMode, type ReActStep } from "../../types/agent";
import type { WorkflowContent } from "../../types/workflow";
import type { OperatorInfo } from "../../types/execution";

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
  const byId = new Map(steps.map(s => [s.id, s]));
  const storage = new WorkflowSnapshotStorage(stepId => {
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = byId.get(cur)?.parentId;
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

function content(messages: ReturnType<typeof assembleContext>): string {
  const first = messages[0];
  if (!first) return "";
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}

const opts = { compilationResult: null, agentMode: AgentMode.CODE };

/* ============================================================================
 *  Latest mode
 * ========================================================================= */

describe("assembleContext — Latest", () => {
  test("emits events without per-turn snapshots, plus one trailing # Current Dataflow block", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));

    // Init is Event 0 and excluded from the rendered context. Visible events
    // start at Event 1 (the user request), then the agent actions follow.
    expect(c).toContain("# Event 1 (User Task)"); // user request
    expect(c).toContain("# Event 2 (Agent Actions)"); // t1
    expect(c).toContain("# Event 3 (Agent Actions)"); // t2
    expect(c).toContain("# Event 4 (Agent Actions)"); // t3
    expect(c).not.toContain("# Event 0"); // init hidden
    expect(c).not.toContain("- initialize"); // init's action line is hidden too
    expect(c).toContain("# Current Dataflow");
    // The previous task-hierarchy headings are gone entirely.
    expect(c).not.toContain("# Completed Tasks");
    expect(c).not.toContain("# Ongoing Task");
    expect(c).not.toContain("## Task (completed)");
    expect(c).not.toContain("## Task (ongoing)");
    // Each agent event's tool-call list is preceded by an "Actions:" label
    expect(c).toContain("Actions:");
    // Action lines present, now showing the tool's returned result (no
    // (succeeded) label). The canonical fixture's tool output is "ok".
    expect(c).toContain('- createOrModifyOperator(operatorId="src") (result: ok)');
    expect(c).toContain('- createOrModifyOperator(operatorId="filt") (result: ok)');
    // No inline snapshot headers between events in LATEST mode.
    expect(c).not.toContain("Completed dataflow after event");
    expect(c).not.toContain("Dataflow changes after event");
    // Trailing block: # Current Dataflow (H1) → Operators (H2) → Operator X (H3)
    // Status labels were removed from the header — operator state lives only
    // in the `Result:` block now.
    expect(c).toContain("### Operator `src` (TestOp)");
    expect(c).toContain("### Operator `filt` (TestOp)");
    expect(c).not.toContain("executed");
    expect(c).not.toContain("failed");
    expect(c).not.toContain("not-executed");
    expect(c).toContain("## Links");
    expect(c).toContain("- src → filt");
  });

  test("empty path → empty content", () => {
    const { steps, storage, workflowState } = buildScenario([]);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(c).toBe("");
  });

  test("init-only path: init is excluded from events but its snapshot still drives # Current Dataflow", () => {
    // A path with ONLY the synthetic init step exercises the fallback in
    // renderLatest: no visible events render, but the trailing block should
    // still show the baseline workflow loaded at init time.
    const { steps, storage, workflowState } = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        messageId: "m-init",
        content: "Initialization",
        toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: { workflowId: 1 } }],
        toolResults: [{ toolCallId: "tc-init", output: "ok", isError: false }],
      },
    ]);
    storage.createSnapshot("init", {
      operators: [makeOp("baseline")],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    });
    storage.setOperatorResult("init", "baseline", makeInfo("baseline", 5));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(c).not.toContain("# Event 0");
    expect(c).not.toContain("# Event 1");
    expect(c).not.toContain("- initialize");
    // Init's snapshot bubbles up to the trailing block.
    expect(c).toContain("# Current Dataflow");
    expect(c).toContain("### Operator `baseline`");
  });
});

/* ============================================================================
 *  Full mode
 * ========================================================================= */

describe("assembleContext — Full", () => {
  test("interleaves each action-bearing event with its destination snapshot, no trailing block", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));

    // Per-event snapshot headers — Full uses the "Completed dataflow" wording.
    // With init excluded (Event 0), the visible event indices in this
    // scenario are: user=1, t1=2, t2=3, t3=4. Snapshots exist for t1 and t2.
    expect(c).toContain("## Completed dataflow after event 2"); // src added (t1)
    expect(c).toContain("## Completed dataflow after event 3"); // filt added (t2)
    // No snapshot for the user request (event 1) or the thought-only t3 (event 4).
    expect(c).not.toContain("## Completed dataflow after event 1");
    expect(c).not.toContain("## Completed dataflow after event 4");
    // Init is excluded entirely.
    expect(c).not.toContain("# Event 0");
    expect(c).not.toContain("- initialize");
    // No trailing "# Current Dataflow" block in Full mode
    expect(c).not.toContain("# Current Dataflow");
  });

  test("ordering: snapshot for event N appears AFTER event N's lines, BEFORE event N+1", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const event2 = c.indexOf("# Event 2 (Agent Actions)");
    const snap2 = c.indexOf("## Completed dataflow after event 2");
    const event3 = c.indexOf("# Event 3 (Agent Actions)");
    expect(event2).toBeGreaterThan(-1);
    expect(snap2).toBeGreaterThan(event2);
    expect(event3).toBeGreaterThan(snap2);
  });

  test("renders every operator in full at every snapshot — event 2's snapshot shows src; event 3's shows src+filt", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const after2 = c.slice(c.indexOf("## Completed dataflow after event 2"), c.indexOf("# Event 3 (Agent Actions)"));
    const after3 = c.slice(c.indexOf("## Completed dataflow after event 3"), c.indexOf("# Event 4 (Agent Actions)"));
    // Inline snapshots nest under H2 → Operator heading is H4.
    expect(after2).toContain("#### Operator `src`");
    expect(after2).not.toContain("#### Operator `filt`"); // filt doesn't exist yet at event 2's snapshot
    expect(after3).toContain("#### Operator `src`");
    expect(after3).toContain("#### Operator `filt`");
    // No "unchanged" markers in Full mode — every op is full.
    expect(after3).not.toContain("unchanged");
  });

  test("inline snapshot section headings sit below the parent H2 wrapper (Operators H3, Operator X H4, Links H3)", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const after3 = c.slice(c.indexOf("## Completed dataflow after event 3"), c.indexOf("# Event 4 (Agent Actions)"));
    expect(after3).toContain("### Operators");
    expect(after3).toContain("### Links");
    expect(after3).toContain("#### Operator `src`");
    expect(after3).toContain("#### Operator `filt`");
  });
});

/* ============================================================================
 *  Delta mode
 * ========================================================================= */

describe("assembleContext — Delta", () => {
  test("event 3's snapshot renders filt in full and omits unchanged src entirely", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, opts));
    // After init exclusion: t2 (was event 4) is now event 3.
    const after3 = c.slice(c.indexOf("## Dataflow changes after event 3"), c.indexOf("# Event 4 (Agent Actions)"));

    // The Δ operator (filt) is rendered in full.
    expect(after3).toContain("#### Operator `filt` (TestOp)");
    expect(after3).not.toContain("executed");
    expect(after3).toContain("Result:");
    // Unchanged operators (src, existing) are dropped entirely — no
    // placeholder heading, no Summary, no "unchanged" marker. Their ids
    // still appear in the trailing Links section.
    expect(after3).not.toContain("#### Operator `src`");
    expect(after3).not.toContain("#### Operator `existing`");
    expect(after3).not.toContain("unchanged");
  });

  test("edges of the current snapshot are always emitted (even when only one endpoint is in delta)", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, opts));
    const after3 = c.slice(c.indexOf("## Dataflow changes after event 3"), c.indexOf("# Event 4 (Agent Actions)"));
    expect(after3).toContain("### Links");
    expect(after3).toContain("- src → filt");
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
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, opts));
    // Event numbering: user=1, a1=2, a2=3. a1 added op "a" → its snapshot at
    // event 2 has a non-empty Δ and DOES render. a2's snapshot at event 3
    // has an empty Δ (same op, same props, no new sourceStepId result) AND
    // no links — so the whole snapshot block is dropped.
    expect(c).toContain("## Dataflow changes after event 2");
    expect(c).not.toContain("## Dataflow changes after event 3");
  });

  test("no trailing # Current Dataflow block", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, opts));
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
 *  Cross-mode invariants
 * ========================================================================= */

describe("assembleContext — cross-mode invariants", () => {
  test("every turn line appears in every mode (snapshot rendering is the only axis that differs)", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const ofMode = (m: ContextMode) => content(assembleContext(steps, workflowState, storage, m, opts));
    const eventLines = [
      // Init is Event 0 and excluded — visible events start at 1.
      "# Event 1 (User Task)", // user request
      "# Event 2 (Agent Actions)", // t1
      "# Event 3 (Agent Actions)", // t2
      "# Event 4 (Agent Actions)", // t3 (thought-only)
      '- createOrModifyOperator(operatorId="src") (result: ok)',
      '- createOrModifyOperator(operatorId="filt") (result: ok)',
      "Build me a pipeline.",
    ];
    for (const mode of [ContextMode.FULL, ContextMode.DELTA, ContextMode.LATEST]) {
      const c = ofMode(mode);
      for (const line of eventLines) {
        expect(c).toContain(line);
      }
    }
  });

  test("operator computation properties (code) are dropped in every mode (paper-§4.3 trim)", () => {
    // Build a scenario with an op carrying a `code` property; assert no mode
    // surfaces it in the assembled context.
    const { storage } = buildScenario([
      { id: "x", stepId: 0, role: "agent", toolCalls: [{ toolName: "init", toolCallId: "tc", input: {} }] },
    ]);
    const wf: WorkflowContent = {
      operators: [makeOp("op1", "DataLoading", { code: "def load(): return secret_payload" })],
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    storage.createSnapshot("x", wf);
    const stepsAll: ReActStep[] = [
      makeStep({
        id: "x",
        stepId: 0,
        role: "agent",
        toolCalls: [{ toolName: "init", toolCallId: "tc", input: {} }],
        toolResults: [{ toolCallId: "tc", output: "ok", isError: false }],
      }),
    ];
    const ws = new WorkflowState();
    for (const mode of [ContextMode.FULL, ContextMode.DELTA, ContextMode.LATEST]) {
      const c = content(assembleContext(stepsAll, ws, storage, mode, opts));
      expect(c).not.toContain("secret_payload");
      expect(c).not.toContain("Properties:");
    }
  });
});

/* ============================================================================
 *  Action line format (params + result, no `(succeeded)` label)
 * ========================================================================= */

describe("assembleContext — action line format", () => {
  test("action lines include summary in params and the tool's returned result", () => {
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
            input: { operatorId: "src", code: "def load(): ...", summary: "Load customers.csv via pd.read_csv" },
          },
        ],
        toolResults: [
          { toolCallId: "tc", output: "Added operator src, input ports: 0, output ports: 1", isError: false },
        ],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a", makeWorkflow(["src"]));
    // In Latest mode the historical action's `summary` is dropped when its
    // operator is still alive in the trailing snapshot (the snapshot's
    // `Summary:` line already carries the latest version). FULL and DELTA
    // modes don't dedupe — they keep the summary on every historical line.
    const cLatest = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(cLatest).toContain(
      '- createOrModifyOperator(operatorId="src") (result: Added operator src, input ports: 0, output ports: 1)'
    );
    // The trailing snapshot still carries the operator's Summary line.
    expect(cLatest).toContain("Summary: TestOp src");

    const cFull = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    expect(cFull).toContain(
      '- createOrModifyOperator(operatorId="src", summary="Load customers.csv via pd.read_csv") (result: Added operator src, input ports: 0, output ports: 1)'
    );

    // No legacy status label and no legacy arrow, in any mode.
    for (const c of [cLatest, cFull]) {
      expect(c).not.toContain("(succeeded)");
      expect(c).not.toContain("(failed)");
      expect(c).not.toContain(") -> ");
      // The `code` field is not surfaced in the action line.
      expect(c).not.toContain("def load");
    }
  });

  test("Latest mode KEEPS summary when the action's operator is no longer in the current snapshot", () => {
    // Scenario: agent added `tmp`, then deleted it. The trailing snapshot
    // contains only `keeper`, so `tmp` is gone — its historical action must
    // still carry the summary because the snapshot won't show it anywhere.
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "add",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add tmp",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc1",
            input: { operatorId: "tmp", summary: "Throwaway scratch loader" },
          },
        ],
        toolResults: [{ toolCallId: "tc1", output: "Added operator tmp", isError: false }],
      },
      {
        id: "del",
        stepId: 2,
        role: "agent",
        parentId: "add",
        messageId: "m1",
        content: "delete tmp; add keeper",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc2",
            input: { operatorId: "keeper", summary: "The op that survives" },
          },
        ],
        toolResults: [{ toolCallId: "tc2", output: "Added operator keeper", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("add", makeWorkflow(["tmp"]));
    storage.createSnapshot("del", makeWorkflow(["keeper"])); // trailing snapshot lacks tmp
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // `tmp` no longer in snapshot → its historical action must keep the summary.
    expect(c).toContain('- createOrModifyOperator(operatorId="tmp", summary="Throwaway scratch loader")');
    // `keeper` is in the snapshot → its summary is dropped on the action line.
    expect(c).toContain('- createOrModifyOperator(operatorId="keeper") (result: Added operator keeper)');
  });

  test("multi-line tool output is broken onto an indented block", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "trying",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "tc", input: { operatorId: "x", summary: "x" } }],
        toolResults: [
          { toolCallId: "tc", output: "[ERROR] something broke\n  hint: try with encoding='latin-1'", isError: true },
        ],
        isEnd: true,
      },
    ]);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(c).toContain('- createOrModifyOperator(operatorId="x", summary="x") (result:');
    expect(c).toContain("    [ERROR] something broke");
    expect(c).toContain("      hint: try with encoding='latin-1'");
    // The block is closed by a `)` on its own line at the same depth as `result:`.
    expect(c).toMatch(/\n  \)(\n|$)/);
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
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    // No snapshots created → no inline snapshot headers (either flavour name).
    expect(c).not.toContain("Completed dataflow after event");
    expect(c).not.toContain("Dataflow changes after event");
    // But the events still render — user step as event 1 and agent thought as event 2.
    expect(c).toContain("# Event 1 (User Task)");
    expect(c).toContain("Thought: hi back");
  });
});

/* ============================================================================
 *  Per-operator before/after block trimming (Design C cap)
 *
 *  Mode-orthogonal: tested on every ContextMode below. The cap keeps only
 *  the most-recent modify result's before/after block for each operatorId
 *  intact in the rendered event list; older mods for that op get trimmed
 *  down to just their headline message (`Operator X modified`). ADDs are
 *  ignored — they don't carry a before/after block, so they don't compete
 *  with MODIFYs for the budget.
 * ========================================================================= */

describe("stripBeforeAfterBlock", () => {
  test("strips a complete before/after block", () => {
    const out = "Operator foo modified\nBefore code:\ndef load(): return 1\nAfter code:\ndef load(): return 2";
    expect(stripBeforeAfterBlock(out)).toBe("Operator foo modified");
  });

  test("strips a WARNING + before/after block (cuts at the earlier marker)", () => {
    const out =
      "Operator foo modified\nWARNING: no-op detected, pivot strategy\nBefore code:\ndef load(): return 1\nAfter code:\ndef load(): return 1";
    expect(stripBeforeAfterBlock(out)).toBe("Operator foo modified");
  });

  test("is idempotent on outputs without a block (e.g. ADD results, errors)", () => {
    expect(stripBeforeAfterBlock("Added operator foo, input ports: 0, output ports: 1")).toBe(
      "Added operator foo, input ports: 0, output ports: 1"
    );
    expect(stripBeforeAfterBlock("[ERROR] something went wrong")).toBe("[ERROR] something went wrong");
  });
});

describe("computeBeforeAfterTrimSet", () => {
  function pathNode(stepId: string, calls: Array<{ op: string; out: string }>): any {
    return {
      step: {
        id: stepId,
        role: "agent",
        toolCalls: calls.map(c => ({ toolName: "createOrModifyOperator", input: { operatorId: c.op } })),
        toolResults: calls.map(c => ({ output: c.out })),
      },
    };
  }

  test("keeps the most-recent mod per operatorId intact, trims earlier ones", () => {
    const before = "OK\nBefore code:\nx\nAfter code:\ny";
    const path = [
      pathNode("s1", [{ op: "loader", out: before }]),
      pathNode("s2", [{ op: "loader", out: before }]),
      pathNode("s3", [{ op: "loader", out: before }]),
    ];
    const trim = computeBeforeAfterTrimSet(path);
    // First two are trimmed; the latest stays intact.
    expect(trim.has("s1:0")).toBe(true);
    expect(trim.has("s2:0")).toBe(true);
    expect(trim.has("s3:0")).toBe(false);
  });

  test("budget is per operatorId — different ops don't compete", () => {
    const before = "OK\nBefore code:\nx\nAfter code:\ny";
    const path = [
      pathNode("s1", [{ op: "loader", out: before }]),
      pathNode("s2", [{ op: "cleaner", out: before }]),
      pathNode("s3", [{ op: "loader", out: before }]),
      pathNode("s4", [{ op: "cleaner", out: before }]),
    ];
    const trim = computeBeforeAfterTrimSet(path);
    // For "loader": s1 is older → trim; s3 is latest → keep.
    expect(trim.has("s1:0")).toBe(true);
    expect(trim.has("s3:0")).toBe(false);
    // For "cleaner": s2 is older → trim; s4 is latest → keep.
    expect(trim.has("s2:0")).toBe(true);
    expect(trim.has("s4:0")).toBe(false);
  });

  test("ADD results (no before/after marker) are NOT counted toward the per-op budget", () => {
    const addOut = "Added operator loader, input ports: 0, output ports: 1";
    const modOut = "Operator loader modified\nBefore code:\nx\nAfter code:\ny";
    const path = [
      pathNode("s1", [{ op: "loader", out: addOut }]), // ADD — not counted
      pathNode("s2", [{ op: "loader", out: modOut }]),
      pathNode("s3", [{ op: "loader", out: modOut }]),
    ];
    const trim = computeBeforeAfterTrimSet(path);
    // ADD is never in the trim set (it has nothing to trim anyway).
    expect(trim.has("s1:0")).toBe(false);
    // First MOD is trimmed, second (latest) is kept.
    expect(trim.has("s2:0")).toBe(true);
    expect(trim.has("s3:0")).toBe(false);
  });

  test("non-createOrModifyOperator tool calls are ignored entirely", () => {
    const path = [
      pathNode("s1", [{ op: "loader", out: "OK\nBefore code:\nx\nAfter code:\ny" }]),
      // Simulate an unrelated tool call by adding a node with toolName=other.
      {
        step: {
          id: "s2",
          role: "agent",
          toolCalls: [{ toolName: "deleteOperator", input: { operatorId: "loader" } }],
          toolResults: [{ output: "Deleted operator: loader" }],
        },
      } as any,
      pathNode("s3", [{ op: "loader", out: "OK\nBefore code:\nx\nAfter code:\ny" }]),
    ];
    const trim = computeBeforeAfterTrimSet(path);
    expect(trim.has("s1:0")).toBe(true); // older MOD
    expect(trim.has("s3:0")).toBe(false); // latest MOD
  });
});

describe("assembleContext — before/after trim applied to rendered event list", () => {
  function makeMod(
    id: string,
    stepId: number,
    parentId: string,
    opId: string,
    summary: string,
    code: string,
    out: string
  ): Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role"> {
    return {
      id,
      stepId,
      role: "agent",
      parentId,
      messageId: "m1",
      content: "",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: `tc-${id}`,
          input: { operatorId: opId, code, summary } as any,
        },
      ],
      toolResults: [{ toolCallId: `tc-${id}`, output: out, isError: false }],
    };
  }

  const modOut1 =
    "Operator loader modified\nBefore code:\ndef load(): return pd.read_csv('a', skiprows=1)\nAfter code:\ndef load(): return pd.read_csv('a', skiprows=2)";
  const modOut2 =
    "Operator loader modified\nBefore code:\ndef load(): return pd.read_csv('a', skiprows=2)\nAfter code:\ndef load(): return pd.read_csv('a', skiprows=3)";
  const modOut3 =
    "Operator loader modified\nBefore code:\ndef load(): return pd.read_csv('a', skiprows=3)\nAfter code:\ndef load(): return pd.read_csv('a', skiprows=4)";

  for (const mode of [ContextMode.FULL, ContextMode.DELTA, ContextMode.LATEST]) {
    test(`mode ${ContextMode[mode]}: keeps only the most-recent mod's before/after for an operator`, () => {
      const { steps, storage, workflowState } = buildScenario([
        { id: "u", stepId: 0, role: "user", messageId: "m1", content: "go" },
        makeMod("a1", 1, "u", "loader", "first mod", "code-1", modOut1),
        makeMod("a2", 2, "a1", "loader", "second mod", "code-2", modOut2),
        makeMod("a3", 3, "a2", "loader", "third mod", "code-3", modOut3),
      ]);
      storage.createSnapshot("a3", makeWorkflow(["loader"]));
      const c = content(assembleContext(steps, workflowState, storage, mode, opts));
      // Latest mod's content is fully present.
      expect(c).toContain("skiprows=3"); // before code of latest = after code of mod 2
      expect(c).toContain("skiprows=4"); // after code of latest
      // Older mods' before/after blocks must be stripped. Earlier-version
      // skiprows values that would only appear in trimmed blocks must NOT show up.
      expect(c).not.toContain("skiprows=1");
      // Older mods' headline lines (one per mod) are still present so the chain is visible.
      const modifiedHits = (c.match(/Operator loader modified/g) || []).length;
      expect(modifiedHits).toBe(3); // all three mods still render their headline
    });
  }

  test("budget is per operatorId — modifying a different op does not consume the loader budget", () => {
    const cleanerModOut =
      "Operator cleaner modified\nBefore code:\ndef process(x): return x\nAfter code:\ndef process(x): return x.dropna()";
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "go" },
      makeMod("a1", 1, "u", "loader", "first loader mod", "c", modOut1),
      makeMod("a2", 2, "a1", "cleaner", "first cleaner mod", "c", cleanerModOut),
      makeMod("a3", 3, "a2", "loader", "second loader mod", "c", modOut2),
    ]);
    storage.createSnapshot("a3", makeWorkflow(["loader", "cleaner"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // Latest loader mod kept (modOut2 carries skiprows=3 in its After code).
    expect(c).toContain("skiprows=3");
    // Earlier loader mod trimmed: skiprows=1 (its Before) and skiprows=2's role-as-After do NOT
    // appear in any trimmed-but-now-removed block. skiprows=2 IS still present (it's the
    // Before code of the kept mod), so we don't assert against it.
    expect(c).not.toContain("skiprows=1");
    // Cleaner mod kept (only one mod for that op).
    expect(c).toContain("dropna");
  });
});
