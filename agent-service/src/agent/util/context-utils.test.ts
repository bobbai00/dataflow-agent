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
const { findLatestUserContentInPath } = __forTesting;
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
  test("emits # User Task + # Recent Agent Events + # Current Dataflow", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));

    // 1. # User Task block carries the latest user message verbatim.
    expect(c).toContain("# User Task");
    expect(c).toContain("Build me a pipeline.");

    // 2. # Recent Agent Events: only the AGENT events are rendered inline;
    //    the latest user event (Event 1) is hoisted to # User Task and not
    //    duplicated here.
    expect(c).toContain("# Recent Agent Events");
    expect(c).toContain("## Agent Event 2"); // t1
    expect(c).toContain("## Agent Event 3"); // t2
    expect(c).toContain("## Agent Event 4"); // t3
    expect(c).not.toContain("## User Event 1"); // hoisted, not rendered inline
    expect(c).not.toContain("# Event 1 (User Task)"); // legacy shape gone
    expect(c).not.toContain("# Event 2 (Agent Actions)"); // legacy shape gone
    expect(c).not.toContain("# Event 0"); // init hidden
    expect(c).not.toContain("- initialize"); // init's action line is hidden too
    // Old echo line at the bottom is gone — # User Task replaced it.
    expect(c).not.toContain("User's request is:");
    expect(c).not.toContain("Above is user's request");

    // 3. # Current Dataflow trailing block.
    expect(c).toContain("# Current Dataflow");

    // Each agent event's tool-call list is preceded by an "Actions:" label.
    expect(c).toContain("Actions:");
    expect(c).toContain('- createOrModifyOperator(operatorId="src") (result: ok)');
    expect(c).toContain('- createOrModifyOperator(operatorId="filt") (result: ok)');
    // No inline snapshot headers between events in LATEST mode.
    expect(c).not.toContain("Completed dataflow after event");
    expect(c).not.toContain("Dataflow changes after event");
    // Trailing block: # Current Dataflow (H1) → ## Operators (H2) → ### Operator X (H3).
    expect(c).toContain("### Operator `src` (TestOp)");
    expect(c).toContain("### Operator `filt` (TestOp)");
    expect(c).toContain("## Links");
    expect(c).toContain("- src → filt");
  });

  test("empty path → empty content", () => {
    const { steps, storage, workflowState } = buildScenario([]);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // No user task and no events; the snapshot fallback to storage.getRootSnapshot()
    // returns undefined for an empty storage too, so we get an empty body.
    // The minimal rendering still emits the # Recent Agent Events header (with
    // "(no agent actions yet)" inside), but nothing above or below.
    expect(c).not.toContain("# User Task");
    expect(c).not.toContain("# Current Dataflow");
    expect(c).toContain("# Recent Agent Events");
    expect(c).toContain("(no agent actions yet)");
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

    // # User Task + # Recent Agent Events headers apply to FULL mode too.
    expect(c).toContain("# User Task");
    expect(c).toContain("# Recent Agent Events");

    // Per-event snapshot headers — Full uses the "Completed dataflow" wording.
    // Inline snapshots now nest under ## Agent Event N (H2) → snapshot wrapper at H3.
    expect(c).toContain("### Completed dataflow after event 2"); // src added (t1)
    expect(c).toContain("### Completed dataflow after event 3"); // filt added (t2)
    // No snapshot for the user request (event 1) or the thought-only t3 (event 4).
    expect(c).not.toContain("### Completed dataflow after event 1");
    expect(c).not.toContain("### Completed dataflow after event 4");
    // Init is excluded entirely.
    expect(c).not.toContain("# Event 0");
    expect(c).not.toContain("- initialize");
    // No trailing "# Current Dataflow" block in Full mode
    expect(c).not.toContain("# Current Dataflow");
  });

  test("ordering: snapshot for event N appears AFTER event N's lines, BEFORE event N+1", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const event2 = c.indexOf("## Agent Event 2");
    const snap2 = c.indexOf("### Completed dataflow after event 2");
    const event3 = c.indexOf("## Agent Event 3");
    expect(event2).toBeGreaterThan(-1);
    expect(snap2).toBeGreaterThan(event2);
    expect(event3).toBeGreaterThan(snap2);
  });

  test("renders every operator in full at every snapshot — event 2's snapshot shows src; event 3's shows src+filt", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const after2 = c.slice(c.indexOf("### Completed dataflow after event 2"), c.indexOf("## Agent Event 3"));
    const after3 = c.slice(c.indexOf("### Completed dataflow after event 3"), c.indexOf("## Agent Event 4"));
    // Inline snapshots nest under ## Agent Event N (H2) → wrapper H3 → Operators H4 → Operator X H5.
    expect(after2).toContain("##### Operator `src`");
    expect(after2).not.toContain("##### Operator `filt`"); // filt doesn't exist yet at event 2's snapshot
    expect(after3).toContain("##### Operator `src`");
    expect(after3).toContain("##### Operator `filt`");
    // No "unchanged" markers in Full mode — every op is full.
    expect(after3).not.toContain("unchanged");
  });

  test("inline snapshot section headings sit two levels below the agent-event header", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const after3 = c.slice(c.indexOf("### Completed dataflow after event 3"), c.indexOf("## Agent Event 4"));
    // Snapshot wrapper at H3; Operators/Links at H4; Operator X at H5.
    expect(after3).toContain("#### Operators");
    expect(after3).toContain("#### Links");
    expect(after3).toContain("##### Operator `src`");
    expect(after3).toContain("##### Operator `filt`");
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
    // Inline snapshots nest at H3 in the new layout → Operator X at H5.
    const after3 = c.slice(c.indexOf("### Dataflow changes after event 3"), c.indexOf("## Agent Event 4"));

    // The Δ operator (filt) is rendered in full.
    expect(after3).toContain("##### Operator `filt` (TestOp)");
    expect(after3).not.toContain("executed");
    expect(after3).toContain("Result:");
    // Unchanged operators (src, existing) are dropped entirely — no
    // placeholder heading, no Summary, no "unchanged" marker. Their ids
    // still appear in the trailing Links section.
    expect(after3).not.toContain("##### Operator `src`");
    expect(after3).not.toContain("##### Operator `existing`");
    expect(after3).not.toContain("unchanged");
  });

  test("edges of the current snapshot are always emitted (even when only one endpoint is in delta)", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, opts));
    const after3 = c.slice(c.indexOf("### Dataflow changes after event 3"), c.indexOf("## Agent Event 4"));
    expect(after3).toContain("#### Links");
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
    expect(c).toContain("### Dataflow changes after event 2");
    expect(c).not.toContain("### Dataflow changes after event 3");
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
      // The latest user task is hoisted to # User Task at the top — its
      // content appears there (not as an inline event).
      "# User Task",
      "Build me a pipeline.",
      "# Recent Agent Events",
      // Init is Event 0 and excluded — visible events start at 1; only
      // agent events render inline (the user message at Event 1 was hoisted).
      "## Agent Event 2", // t1
      "## Agent Event 3", // t2
      "## Agent Event 4", // t3 (thought-only)
      '- createOrModifyOperator(operatorId="src") (result: ok)',
      '- createOrModifyOperator(operatorId="filt") (result: ok)',
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
    // makeOp gives `src` the customDisplayName "TestOp src", which is the
    // snapshot's `Summary:` text. The event's summary ("Load customers.csv
    // via pd.read_csv") differs from it, so the new equality-based dedup
    // does NOT fire — the historical line keeps the event's full summary in
    // every mode. FULL/DELTA modes never dedupe regardless.
    storage.createSnapshot("a", makeWorkflow(["src"]));
    const cLatest = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(cLatest).toContain(
      '- createOrModifyOperator(operatorId="src", summary="Load customers.csv via pd.read_csv") (result: Added operator src, input ports: 0, output ports: 1)'
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
    // `keeper`'s event summary ("The op that survives") also differs from
    // the snapshot's `Summary: TestOp keeper`, so it's kept too.
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
    // `tmp` no longer in snapshot → its historical action keeps the summary.
    expect(c).toContain('- createOrModifyOperator(operatorId="tmp", summary="Throwaway scratch loader")');
    // `keeper` is in snapshot but its event summary ≠ snapshot's Summary, so
    // also keeps the full summary — the dedup is equality-based now.
    expect(c).toContain('- createOrModifyOperator(operatorId="keeper", summary="The op that survives")');
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
    // Latest user message hoisted to # User Task.
    expect(c).toContain("# User Task");
    expect(c).toContain("hi");
    // Agent thought rendered inline as ## Agent Event 2.
    expect(c).toContain("## Agent Event 2");
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

/* The per-operator before/after trim machinery has been removed — the
 * modify result is now just `Operator X modified` (plus the optional
 * no-op WARNING line), and per-action code is rendered via the
 * `recentEventsCap` / `includeCodeInRecentEvents` path tested below. */

/* ============================================================================
 *  recentEventsCap + includeCodeInRecentEvents
 * ========================================================================= */

describe("assembleContext — recentEventsCap (event-count truncation)", () => {
  /** Build a long-ish scenario: 1 user + N agent steps, each a modify on
   *  operator `op_i` with a tiny code snippet so we can assert what's kept. */
  function buildLongScenario(n: number) {
    const inputs: Array<Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">> = [
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "Find the answer." },
    ];
    let prev = "u";
    for (let i = 1; i <= n; i++) {
      inputs.push({
        id: `a${i}`,
        stepId: i,
        role: "agent",
        messageId: "m1",
        parentId: prev,
        content: `Step ${i} thought`,
        isBegin: i === 1,
        isEnd: false,
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: `tc${i}`,
            input: { operatorId: `op${i}`, summary: `mod ${i}`, code: `def load(): return ${i}` },
          },
        ],
        toolResults: [{ toolCallId: `tc${i}`, output: `result-${i}`, isError: false }],
      });
      prev = `a${i}`;
    }
    return buildScenario(inputs);
  }

  test("cap=Infinity (default): every event is preserved (no truncation notice)", () => {
    const { steps, storage, workflowState } = buildLongScenario(6);
    storage.createSnapshot("a6", makeWorkflow(["op1", "op2", "op3", "op4", "op5", "op6"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // # User Task hoisted from the latest user event.
    expect(c).toContain("# User Task");
    expect(c).toContain("Find the answer.");
    // # Recent Agent Events header, no "(last K of N events)" suffix when no truncation.
    expect(c).toMatch(/# Recent Agent Events\n/);
    // All 6 agent events render; the user event is hoisted (not inline).
    expect(c).toContain("## Agent Event 2");
    expect(c).toContain("## Agent Event 7");
    expect(c).not.toContain("## User Event 1"); // hoisted
    expect(c).not.toContain("earlier event");
  });

  test("cap=3: only the 3 most-recent events appear, with truncation notice and (last K of N) header", () => {
    const { steps, storage, workflowState } = buildLongScenario(6);
    storage.createSnapshot("a6", makeWorkflow(["op1", "op2", "op3", "op4", "op5", "op6"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 3,
      })
    );
    // 1 user + 6 agent = 7 events; cap=3 drops the oldest 4.
    expect(c).toContain("# Recent Agent Events (last 3 of 7 events)");
    expect(c).toContain("4 earlier events omitted");
    // Earlier events dropped.
    expect(c).not.toContain("## Agent Event 2");
    expect(c).not.toContain("## Agent Event 4");
    // Three most-recent agent events kept.
    expect(c).toContain("## Agent Event 5");
    expect(c).toContain("## Agent Event 6");
    expect(c).toContain("## Agent Event 7");
    // # User Task still hoists the latest user message even though the
    // original user event sits outside the kept window.
    expect(c).toContain("# User Task");
    expect(c).toContain("Find the answer.");
  });

  test("cap=0: # Recent Agent Events becomes a placeholder paragraph, per-operator Event refs survive", () => {
    const { steps, storage, workflowState } = buildLongScenario(4);
    storage.createSnapshot("a4", makeWorkflow(["op1", "op2", "op3", "op4"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 0,
      })
    );
    // No agent or user events visible inline — per-event detail is omitted.
    expect(c).not.toContain("## Agent Event");
    expect(c).not.toContain("## User Event");
    // The Recent Agent Events section is BACK as a placeholder so the
    // operator-level "Created at Event N" refs below have something to point
    // to. Header carries the total event count + the "details omitted for
    // context compaction" tag.
    expect(c).toMatch(/# Recent Agent Events \(\d+ total — details omitted for context compaction\)/);
    expect(c).toContain("Per-event details (thought, tool calls, code) are omitted");
    expect(c).toContain('"Created at Event 3", "modified at Event 7"'); // example in paragraph
    // The legacy mid-section truncation notice (\"earlier events omitted to
    // keep context focused on recent work\") only fires when cap > 0 and
    // some events get dropped. Under cap=0 the placeholder paragraph above
    // takes its place — assert the old notice is absent so the two
    // mechanisms don't accidentally double-render.
    expect(c).not.toContain("earlier events omitted to keep context focused on recent work");
    // # User Task is the single source of truth for the question.
    expect(c).toContain("# User Task");
    expect(c).toContain("Find the answer.");
    // Snapshot still rendered, and every op carries its event-history line.
    expect(c).toContain("# Current Dataflow");
    expect(c).toContain("### Operator `op1`");
    expect(c).toContain("### Operator `op4`");
    expect(c).toMatch(/### Operator `op1`[\s\S]{0,200}Created at Event \d+/);
    expect(c).toMatch(/### Operator `op4`[\s\S]{0,200}Created at Event \d+/);
    // No legacy echo lines.
    expect(c).not.toContain("User's request is:");
    expect(c).not.toContain("Above is user's request");
  });

  test("cap=0 still hoists the latest user message into # User Task", () => {
    const { steps, storage, workflowState } = buildLongScenario(2);
    storage.createSnapshot("a2", makeWorkflow(["op1", "op2"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 0,
      })
    );
    // # User Task hoisted at top; the cap=0 placeholder Recent Agent Events
    // section sits between User Task and Current Dataflow.
    expect(c).toContain("# User Task");
    expect(c).toContain("Find the answer.");
    expect(c).toMatch(/# Recent Agent Events \(\d+ total — details omitted/);
    expect(c.indexOf("# User Task")).toBeLessThan(c.indexOf("# Recent Agent Events"));
    expect(c.indexOf("# Recent Agent Events")).toBeLessThan(c.indexOf("# Current Dataflow"));
  });

  test("cap >= path length: no truncation notice (cap is effectively off)", () => {
    const { steps, storage, workflowState } = buildLongScenario(3);
    storage.createSnapshot("a3", makeWorkflow(["op1", "op2", "op3"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 50,
      })
    );
    expect(c).not.toContain("earlier events omitted");
    expect(c).toContain("# User Task");
    expect(c).toContain("## Agent Event 2");
    expect(c).toContain("## Agent Event 4");
  });

  test("multi-task continuation: latest user message is hoisted; older user message renders inline as ## User Event N", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "first question" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m1",
        parentId: "u1",
        content: "first answer",
        isEnd: true,
      },
      { id: "u2", stepId: 2, role: "user", messageId: "m2", parentId: "a1", content: "second question" },
      {
        id: "a2",
        stepId: 3,
        role: "agent",
        messageId: "m2",
        parentId: "u2",
        content: "working on it",
      },
    ]);
    storage.createSnapshot("a2", makeWorkflow([]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // The LATEST user message is in # User Task.
    expect(c).toContain("# User Task");
    expect(c).toContain("second question");
    // The OLDER user message renders inline at its event index inside # Recent Agent Events.
    expect(c).toContain("## User Event 1");
    expect(c).toContain("first question");
    // The latest user message is NOT duplicated inline (no ## User Event 3).
    expect(c).not.toContain("## User Event 3");
    // The agent events surround the older user message in chronological order.
    const aEvent2Idx = c.indexOf("## Agent Event 2");
    const uEvent3Idx = c.indexOf("## User Event 3");
    expect(aEvent2Idx).toBeGreaterThan(-1);
    expect(uEvent3Idx).toBe(-1);
    expect(c.indexOf("## Agent Event 4")).toBeGreaterThan(c.indexOf("## User Event 1"));
  });
});

describe("assembleContext — includeCodeInRecentEvents (code restoration in kept window)", () => {
  function buildSmallCodeScenario() {
    return buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "Load and process." },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m1",
        parentId: "u",
        content: "Loading.",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc-a1",
            input: {
              operatorId: "src",
              summary: "Load source.csv",
              code: "def load() -> pd.DataFrame:\n    return pd.read_csv('src.csv', skiprows=2)",
            },
          },
        ],
        toolResults: [{ toolCallId: "tc-a1", output: "ok", isError: false }],
      },
    ]);
  }

  test("cap=Infinity: code stays hidden from past actions (existing contract)", () => {
    const { steps, storage, workflowState } = buildSmallCodeScenario();
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(c).not.toContain("pd.read_csv");
    expect(c).not.toContain("code:");
  });

  test("cap finite + includeCodeInRecentEvents=true (default): code appears for kept events", () => {
    const { steps, storage, workflowState } = buildSmallCodeScenario();
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 5,
      })
    );
    expect(c).toContain("code: |");
    expect(c).toContain("pd.read_csv('src.csv', skiprows=2)");
  });

  test("cap finite + includeCodeInRecentEvents=false: code stays hidden even within window", () => {
    const { steps, storage, workflowState } = buildSmallCodeScenario();
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 5,
        includeCodeInRecentEvents: false,
      })
    );
    expect(c).not.toContain("pd.read_csv");
    expect(c).not.toContain("code:");
  });

  test("code-restoration applies only to events INSIDE the kept window", () => {
    // 6 agent steps, cap=2 → only the last 2 events keep code; older ones are gone entirely.
    const inputs: Array<Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">> = [
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "Build it." },
    ];
    let prev = "u";
    for (let i = 1; i <= 6; i++) {
      inputs.push({
        id: `a${i}`,
        stepId: i,
        role: "agent",
        messageId: "m1",
        parentId: prev,
        content: `step ${i}`,
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: `tc${i}`,
            input: { operatorId: `op${i}`, code: `SENTINEL_${i} = ${i}` },
          },
        ],
        toolResults: [{ toolCallId: `tc${i}`, output: "ok", isError: false }],
      });
      prev = `a${i}`;
    }
    const { steps, storage, workflowState } = buildScenario(inputs);
    storage.createSnapshot("a6", makeWorkflow(["op1", "op2", "op3", "op4", "op5", "op6"]));
    const c = content(
      assembleContext(steps, workflowState, storage, ContextMode.LATEST, {
        ...opts,
        recentEventsCap: 2,
      })
    );
    // SENTINEL_1..4 belonged to dropped events — their code lines must be gone.
    for (let i = 1; i <= 4; i++) {
      expect(c).not.toContain(`SENTINEL_${i} = ${i}`);
    }
    // SENTINEL_5..6 are in the kept window — code must be visible.
    expect(c).toContain("SENTINEL_5 = 5");
    expect(c).toContain("SENTINEL_6 = 6");
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

    const c = content(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.LATEST, opts)
    );

    // Upstream renders its [ERROR] block normally.
    expect(c).toContain("[ERROR]");
    expect(c).toContain("Unmatched type for field 'Unnamed: 2'");

    // Downstream gets the skipped marker pointing at the errored upstream.
    expect(c).toContain(
      "Result: (skipped — upstream operator `climateMeasurements` errored; see [ERROR] above)"
    );
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
      makeWorkflow(["A", "B", "C"], [["A", "B"], ["B", "C"]])
    );
    scenario.storage.setOperatorResult("t1", "A", makeInfo("A", 0, "RuntimeError: bad"));
    // B and C: no info → transitively blocked by A

    const c = content(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.LATEST, opts)
    );

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
      makeWorkflow(["A", "B", "C"], [["A", "C"], ["B", "C"]])
    );
    scenario.storage.setOperatorResult("t1", "A", makeInfo("A", 0, "TypeError: A failed"));
    scenario.storage.setOperatorResult("t1", "B", makeInfo("B", 0, "ValueError: B failed"));
    // C: no info

    const c = content(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.LATEST, opts)
    );

    // Both upstreams referenced together (plural "operators"); order
    // tracks the link discovery order.
    expect(c).toMatch(
      /Result: \(skipped — upstream operators `A`, `B` errored; see \[ERROR\] above\)/
    );
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

    const c = content(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.LATEST, opts)
    );

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

    const c = content(
      assembleContext(scenario.steps, scenario.workflowState, scenario.storage, ContextMode.LATEST, opts)
    );

    // No skipped marker — B has its own error block.
    expect(c).not.toContain("Result: (skipped");
    // But both error messages should be present.
    expect(c).toContain("A failed");
    expect(c).toContain("B failed");
  });
});

/* ============================================================================
 *  Idea 1: per-operator event-history line in the snapshot
 *  ("Created at Event X, modified at Event Y, …")
 * ========================================================================= */

describe("assembleContext — per-operator event-history line", () => {
  test("operator touched once renders only 'Created at Event X'", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "create op",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc1",
            input: { operatorId: "src", summary: "load source" },
          },
        ],
        toolResults: [{ toolCallId: "tc1", output: "Added operator src", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(c).toMatch(/### Operator `src`[\s\S]{0,200}Created at Event 2\nSummary:/);
    // No "modified at" segment when the op was only created.
    expect(c).not.toMatch(/Created at Event 2.*modified at/);
  });

  test("operator modified multiple times chains 'Created' + repeating 'modified'", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "create",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: "src", summary: "v1" } },
        ],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "edit again",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc2", input: { operatorId: "src", summary: "v2" } },
        ],
        toolResults: [{ toolCallId: "tc2", output: "ok", isError: false }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        parentId: "a2",
        messageId: "m1",
        content: "final edit",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc3", input: { operatorId: "src", summary: "v3" } },
        ],
        toolResults: [{ toolCallId: "tc3", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a3", makeWorkflow(["src"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // Three event indices: 2 (create), 3 (modify), 4 (modify). User step is Event 1.
    expect(c).toContain("Created at Event 2, modified at Event 3, modified at Event 4");
  });

  test("operator inherited from initial workflow (no createOrModify event) has no Events line", () => {
    // Scenario: workflow already has `seeded` before any agent step. The
    // agent only adds `addedByAgent`. The snapshot contains both, but only
    // `addedByAgent` has an event-history line; `seeded` doesn't.
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add new",
        toolCalls: [
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc1",
            input: { operatorId: "addedByAgent", summary: "fresh load" },
          },
        ],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["seeded", "addedByAgent"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // addedByAgent → has the line.
    expect(c).toMatch(/### Operator `addedByAgent`[\s\S]{0,200}Created at Event \d+/);
    // seeded → no event line between header and Summary.
    expect(c).toMatch(/### Operator `seeded` \(TestOp\)\nSummary:/);
  });

  test("Full + Delta modes IGNORE recentEventsCap and render every event", () => {
    // cap is a Latest-mode concept — Full/Delta inherently want to surface
    // every per-event inline snapshot, and capping them would defeat the
    // purpose. cap=0 + Full/Delta in particular would produce a context
    // with zero workflow state (no inline snapshots, no trailing
    // # Current Dataflow). assembleContext force-uncaps non-Latest modes
    // before applying any truncation logic.
    //
    // Build a 5-action scenario inline — buildLongScenario lives in a
    // different describe block. Each agent step creates one op opK; the
    // trailing snapshot has all 5 plus they're linked in a chain.
    const stepDefs: any[] = [{ id: "u", stepId: 0, role: "user", messageId: "m1", content: "task" }];
    for (let i = 1; i <= 5; i++) {
      stepDefs.push({
        id: `a${i}`,
        stepId: i,
        role: "agent",
        parentId: i === 1 ? "u" : `a${i - 1}`,
        messageId: "m1",
        content: `step ${i}`,
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: `tc${i}`, input: { operatorId: `op${i}`, summary: `summary${i}` } },
        ],
        toolResults: [{ toolCallId: `tc${i}`, output: `Added op${i}`, isError: false }],
        isEnd: i === 5,
      });
    }
    const { steps, storage, workflowState } = buildScenario(stepDefs);
    // Snapshot at each step accumulates one more op.
    for (let i = 1; i <= 5; i++) {
      const ids = Array.from({ length: i }, (_, j) => `op${j + 1}`);
      storage.createSnapshot(`a${i}`, makeWorkflow(ids));
    }

    const optsWithCap0 = { ...opts, recentEventsCap: 0 };

    const cFull = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, optsWithCap0));
    const cDelta = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, optsWithCap0));

    // Every agent event survives in the recent-events section.
    for (const mode of [cFull, cDelta]) {
      expect(mode).toContain("## Agent Event 2");
      expect(mode).toContain("## Agent Event 3");
      expect(mode).toContain("## Agent Event 4");
      expect(mode).toContain("## Agent Event 5");
      expect(mode).toContain("## Agent Event 6");
      // Cap=0 placeholder does NOT fire — the section header is the normal one.
      expect(mode).not.toContain("details omitted for context compaction");
      // Truncation notice doesn't fire either.
      expect(mode).not.toContain("earlier events omitted");
    }
    // Full mode renders an inline snapshot after each event.
    expect(cFull).toContain("Completed dataflow after event 2");
    expect(cFull).toContain("Completed dataflow after event 6");
    // Delta mode renders delta inline snapshots — each newly-created op
    // shows up exactly once.
    expect(cDelta).toContain("Dataflow changes after event 2");
    expect(cDelta).toContain("Dataflow changes after event 6");

    // For comparison: Latest mode WITH cap=0 still honors the cap and emits
    // the placeholder paragraph (this is the case the cap is actually
    // designed for).
    const cLatest = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, optsWithCap0));
    expect(cLatest).toMatch(/# Recent Agent Events \(\d+ total — details omitted/);
    expect(cLatest).not.toContain("## Agent Event");
  });

  test("Full + Delta modes SUPPRESS the per-operator event line; Latest mode KEEPS it", () => {
    // `eventIndicesByOpId` is built from the FULL path and would over-report
    // future modifications if attached to a per-event inline snapshot
    // (e.g. event-2's inline snapshot showing "modified at Event 4" before
    // event 4 has happened). The line is therefore Latest-mode-only — the
    // trailing snapshot there is the only place the index list is correct
    // end-to-end. Full/Delta inline snapshots get no line at all.
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "create then modify",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: "src", summary: "v1" } },
        ],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "second edit",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc2", input: { operatorId: "src", summary: "v2" } },
        ],
        toolResults: [{ toolCallId: "tc2", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    storage.createSnapshot("a2", makeWorkflow(["src"]));

    const cFull = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    const cDelta = content(assembleContext(steps, workflowState, storage, ContextMode.DELTA, opts));
    const cLatest = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));

    // Full / Delta: inline snapshots must NOT carry "Created at Event N" lines.
    expect(cFull).not.toContain("Created at Event");
    expect(cFull).not.toContain("modified at Event");
    expect(cDelta).not.toContain("Created at Event");
    expect(cDelta).not.toContain("modified at Event");

    // Latest: the trailing # Current Dataflow snapshot DOES carry the line.
    expect(cLatest).toContain("Created at Event 2, modified at Event 3");
  });

  test("cap > 0: 'Created at Event N' indices match the # Recent Agent Events block above", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "first",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: "src", summary: "v1" } },
        ],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["src"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // Both surfaces should reference the same index ("Agent Event 2" up top,
    // "Created at Event 2" in the snapshot below).
    expect(c).toContain("## Agent Event 2");
    expect(c).toContain("Created at Event 2");
  });
});

/* ============================================================================
 *  Idea 2: equality-based summary dedup in event lines
 *  (abbreviateSummary when event.summary == snapshot.customDisplayName)
 * ========================================================================= */

describe("assembleContext — equality-based summary dedup in events", () => {
  // Helper: build a single-step scenario where the agent creates `opId` with
  // the given `summary`, and the trailing snapshot's `customDisplayName` for
  // that op equals `snapshotSummary`. Makes it easy to assert dedup behavior
  // across the (match × short-vs-long × superseded) matrix.
  function buildOneCreateScenario(opId: string, summary: string, snapshotSummary: string) {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "create",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: opId, summary } },
        ],
        toolResults: [{ toolCallId: "tc1", output: `Added operator ${opId}`, isError: false }],
        isEnd: true,
      },
    ]);
    // Construct the snapshot with a custom display name so the equality
    // check can fire (or fail to fire).
    const workflow = makeWorkflow([opId]);
    (workflow.operators[0] as { customDisplayName?: string }).customDisplayName = snapshotSummary;
    storage.createSnapshot("a1", workflow);
    return { steps, storage, workflowState };
  }

  test("LONG summary that matches snapshot Summary is abbreviated to '<head> … (same as current Summary)'", () => {
    const long =
      "Load 2024_CSN_Number_of_Reports_by_Type.csv via pd.read_csv with skiprows=2, header=0, UTF-8 encoding; promote first row to header and parse numeric fields.";
    const { steps, storage, workflowState } = buildOneCreateScenario("src", long, long);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // Abbreviated form: keep first sentence, then ellipsis + pointer.
    expect(c).toContain("(same as current Summary)");
    expect(c).toContain('summary="Load 2024_CSN_Number_of_Reports_by_Type'); // head fragment
    // The full original text should NOT appear in the event line — only in
    // the trailing snapshot's Summary line.
    const eventLineMatch = c.match(/- createOrModifyOperator\(operatorId="src", summary="[^"]+"\)/);
    expect(eventLineMatch).not.toBeNull();
    expect(eventLineMatch![0]).not.toContain("promote first row to header");
    // The snapshot still carries the full text.
    expect(c).toContain(`Summary: ${long}`);
  });

  test("SHORT summary that matches snapshot Summary is kept full (no dedup overhead)", () => {
    // The abbreviation phrase is ~33 chars; if the original summary is
    // ≤80 chars, dropping it for the phrase wastes tokens. So short
    // matches go through unchanged.
    const short = "Load customers.csv";
    const { steps, storage, workflowState } = buildOneCreateScenario("src", short, short);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    expect(c).toContain(`- createOrModifyOperator(operatorId="src", summary="${short}")`);
    expect(c).not.toContain("(same as current Summary)");
  });

  test("summary differs from current snapshot (superseded by later edit) is kept full", () => {
    // Two edits: first event's summary "v1" gets superseded by event 2's
    // "v2 final". Snapshot's customDisplayName equals "v2 final". Event 1's
    // summary differs from current → kept full. Event 2's matches → would
    // be abbreviated but it's short (<80 chars) → kept full too.
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "first",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: "src", summary: "v1 historical intent" } },
        ],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "rewrite",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc2", input: { operatorId: "src", summary: "v2 final" } },
        ],
        toolResults: [{ toolCallId: "tc2", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    const workflow = makeWorkflow(["src"]);
    (workflow.operators[0] as { customDisplayName?: string }).customDisplayName = "v2 final";
    storage.createSnapshot("a2", workflow);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // Event 1's old summary survives in full — that's the "supersession
    // preserved" property of equality-based dedup.
    expect(c).toContain('summary="v1 historical intent"');
    // Event 2's summary matches the snapshot but is short → kept full too.
    expect(c).toContain('summary="v2 final"');
    expect(c).not.toContain("(same as current Summary)");
  });

  test("operator deleted before the trailing snapshot keeps its event summary in full", () => {
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "add tmp",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc1", input: { operatorId: "tmp", summary: "Throwaway scratch loader for testing" } },
        ],
        toolResults: [{ toolCallId: "tc1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        parentId: "a1",
        messageId: "m1",
        content: "swap to keeper",
        toolCalls: [
          { toolName: "createOrModifyOperator", toolCallId: "tc2", input: { operatorId: "keeper", summary: "The op that survives" } },
        ],
        toolResults: [{ toolCallId: "tc2", output: "ok", isError: false }],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a1", makeWorkflow(["tmp"]));
    storage.createSnapshot("a2", makeWorkflow(["keeper"])); // trailing snapshot drops tmp
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // tmp's summary is preserved in full — it's not in the map, so dedup
    // can't fire even if the text were long enough.
    expect(c).toContain('summary="Throwaway scratch loader for testing"');
    expect(c).not.toContain("(same as current Summary)");
  });

  test("non-createOrModifyOperator tool calls are never abbreviated", () => {
    // The dedup pipeline only inspects createOrModifyOperator calls; other
    // tools (e.g. a hypothetical analytics-only inspect) pass through.
    const { steps, storage, workflowState } = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m1", content: "hi" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        parentId: "u",
        messageId: "m1",
        content: "delete then add",
        toolCalls: [
          {
            toolName: "deleteOperator",
            toolCallId: "tc1",
            input: { operatorId: "src", summary: "Should pass through verbatim, never abbreviated, because the tool is not createOrModifyOperator." },
          },
          {
            toolName: "createOrModifyOperator",
            toolCallId: "tc2",
            input: { operatorId: "src2", summary: "fresh" },
          },
        ],
        toolResults: [
          { toolCallId: "tc1", output: "Deleted", isError: false },
          { toolCallId: "tc2", output: "Added operator src2", isError: false },
        ],
        isEnd: true,
      },
    ]);
    const workflow = makeWorkflow(["src2"]);
    // deliberately set the snapshot display name to the deleteOperator's
    // summary string — even with that, the deleteOperator call should NOT
    // get abbreviated because we only inspect createOrModifyOperator calls.
    (workflow.operators[0] as { customDisplayName?: string }).customDisplayName =
      "Should pass through verbatim, never abbreviated, because the tool is not createOrModifyOperator.";
    storage.createSnapshot("a1", workflow);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // The full text is in the deleteOperator's line, NOT replaced with the
    // (same as current Summary) marker.
    expect(c).toContain('- deleteOperator(operatorId="src", summary="Should pass through verbatim, never abbreviated, because the tool is not createOrModifyOperator.")');
  });
});
