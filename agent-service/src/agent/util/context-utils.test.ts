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
import { assembleContext, computeDelta } from "./context-utils";
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
  test("emits ONLY # User Task + # Current Dataflow (no events section at all)", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));

    // 1. # User Task block carries the latest user message verbatim.
    expect(c).toContain("# User Task");
    expect(c).toContain("Build me a pipeline.");

    // 2. Latest mode renders NO events section — the LLM sees just the
    // leaf snapshot. Neither the new `# Agent Events` header nor the legacy
    // `# Recent Agent Events` header should appear, and no `## Agent Event`
    // blocks either.
    expect(c).not.toContain("# Agent Events");
    expect(c).not.toContain("# Recent Agent Events");
    expect(c).not.toContain("## Agent Event");
    expect(c).not.toContain("## User Event");
    expect(c).not.toContain("Actions:");

    // 3. # Current Dataflow trailing block.
    expect(c).toContain("# Current Dataflow");
    // No inline snapshot headers between events in Latest mode (there are
    // no events at all here).
    expect(c).not.toContain("Completed dataflow after event");
    expect(c).not.toContain("Dataflow changes after event");
    // Trailing block: # Current Dataflow (H1) → ## Operators (H2) → ### Operator X (H3).
    expect(c).toContain("### Operator `src` (TestOp)");
    expect(c).toContain("### Operator `filt` (TestOp)");
    expect(c).toContain("## Links");
    expect(c).toContain("- src → filt");

    // No legacy echo lines.
    expect(c).not.toContain("User's request is:");
    expect(c).not.toContain("Above is user's request");
  });

  test("empty path → empty content", () => {
    const { steps, storage, workflowState } = buildScenario([]);
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.LATEST, opts));
    // No user task and no snapshot — everything is empty.
    expect(c).not.toContain("# User Task");
    expect(c).not.toContain("# Agent Events");
    expect(c).not.toContain("# Recent Agent Events");
    expect(c).not.toContain("# Current Dataflow");
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

    // # User Task + # Agent Events headers apply to FULL mode too.
    expect(c).toContain("# User Task");
    expect(c).toContain("# Agent Events");
    expect(c).not.toContain("# Recent Agent Events"); // renamed

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
  test("# User Task is hoisted in EVERY mode; events are present in Full/Delta but absent in Latest", () => {
    const { steps, storage, workflowState } = buildCanonicalScenario();
    const ofMode = (m: ContextMode) => content(assembleContext(steps, workflowState, storage, m, opts));

    // # User Task is universally present.
    for (const mode of [ContextMode.FULL, ContextMode.DELTA, ContextMode.LATEST]) {
      const c = ofMode(mode);
      expect(c).toContain("# User Task");
      expect(c).toContain("Build me a pipeline.");
    }

    // Full + Delta render the events section with each agent event + its
    // natural-language action lines.
    for (const mode of [ContextMode.FULL, ContextMode.DELTA]) {
      const c = ofMode(mode);
      expect(c).toContain("# Agent Events");
      expect(c).toContain("## Agent Event 2");
      expect(c).toContain("## Agent Event 3");
      expect(c).toContain("## Agent Event 4");
      expect(c).toContain('- create operator "src", result: ok');
      expect(c).toContain('- create operator "filt", result: ok');
      // Legacy `# Recent Agent Events` header is gone (renamed).
      expect(c).not.toContain("# Recent Agent Events");
    }

    // Latest mode renders NO events section at all.
    const cLatest = ofMode(ContextMode.LATEST);
    expect(cLatest).not.toContain("# Agent Events");
    expect(cLatest).not.toContain("# Recent Agent Events");
    expect(cLatest).not.toContain("## Agent Event");
    expect(cLatest).not.toContain('- create operator "src"');
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
  test("first createOrModifyOperator call on an op renders as `create operator \"X\"`", () => {
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

    // Latest mode renders no events, so Full mode is the place to assert
    // the natural-language line shape.
    const cFull = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    expect(cFull).toContain('- create operator "src", result: Added operator src, input ports: 0, output ports: 1');

    // Code and summary are NOT on the event line.
    expect(cFull).not.toContain("def load");
    expect(cFull).not.toContain("summary=");
    expect(cFull).not.toContain('"Load customers.csv"');
    // No legacy function-call shape.
    expect(cFull).not.toContain('createOrModifyOperator(operatorId="src")');
    // No legacy status label / arrow.
    expect(cFull).not.toContain("(succeeded)");
    expect(cFull).not.toContain("(failed)");
  });

  test("subsequent createOrModifyOperator call on the same op renders as `modify operator \"X\"`", () => {
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
    storage.createSnapshot("a2", makeWorkflow(["src"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    expect(c).toContain('- create operator "src", result: Added operator src');
    expect(c).toContain('- modify operator "src", result: Updated operator src');
  });

  test("deleteOperator renders as `delete operator \"X\"`", () => {
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
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    expect(c).toContain('- create operator "tmp", result: Added operator tmp');
    expect(c).toContain('- delete operator "tmp", result: Deleted operator tmp');
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
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    // Both creations render as `create operator "op"` — not `modify`.
    // Use a regex-count: should see two `- create operator "op"` lines.
    const matches = c.match(/- create operator "op"/g) ?? [];
    expect(matches.length).toBe(2);
    expect(c).toContain('- delete operator "op"');
  });

  test("non-special tool name falls back to `<toolName> on operator \"X\"`", () => {
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
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    expect(c).toContain('- executeOperator on operator "src", result: Executed operator src');
  });

  test("multi-line tool output is broken onto an indented block under `, result:`", () => {
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
        toolResults: [
          { toolCallId: "tc", output: "[ERROR] something broke\n  hint: try with encoding='latin-1'", isError: true },
        ],
        isEnd: true,
      },
    ]);
    storage.createSnapshot("a", makeWorkflow(["x"]));
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
    expect(c).toContain('- create operator "x", result:');
    expect(c).toContain("    [ERROR] something broke");
    expect(c).toContain("      hint: try with encoding='latin-1'");
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
    const c = content(assembleContext(steps, workflowState, storage, ContextMode.FULL, opts));
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

/* ============================================================================
 *  Idea 2: equality-based summary dedup in event lines
 *  (abbreviateSummary when event.summary == snapshot.customDisplayName)
 * ========================================================================= */

