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

// Output uses plain markdown rather than XML-like tags to reduce format
// mimicry, where the model echoes the context shape into its output instead
// of calling tools via the native protocol.

import type { ModelMessage } from "ai";
import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, OperatorPortSchemaMap, PortSchema, WorkflowContent } from "../../types/workflow";
import type { ReActStep } from "../../types/agent";
import { AgentMode, ContextMode } from "../../types/agent";
import type { WorkflowCompilationResponse, WorkflowFatalError } from "../../api/compile-api";
import type { SnapshotData, WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { extractOperatorInputPortSchemaMap } from "./workflow-utils";
import { formatOperatorResult } from "../tools/result-formatting";
import { createLogger } from "../../logger";

const log = createLogger("ContextAssembler");

/* ============================================================================
 *  Public entry
 * ========================================================================= */

export interface AssembleContextOptions {
  /** Compilation result for the *current* workflowState. Schemas it carries
   *  are only attached to operators in the current (last) snapshot — we
   *  can't recompile historical snapshots cheaply, so non-current snapshots
   *  render without schema lines regardless of mode. */
  compilationResult?: WorkflowCompilationResponse | null;
  agentMode: AgentMode;
  /** When true, every non-error operator result whose `OperatorInfo` carries
   *  `columnStats` is followed by a `Column stats:` section listing
   *  per-column stats (one column per line). Off by default. */
  statsEnabled?: boolean;
}

/**
 * Build the assembled user-message context the LLM sees on the next
 * `prepareStep`. A context is a path on the snapshot tree from the root
 * (empty snapshot) to the leaf (current snapshot). The path is rendered
 * differently per mode:
 *
 *   - LATEST: only the leaf snapshot is rendered. The LLM sees the user
 *     task plus the current dataflow — no events, no per-turn history.
 *
 *   - FULL: each edge on the path is rendered as `## Agent Event N`
 *     (thought + actions) followed by the full snapshot of state after
 *     that event.
 *
 *   - DELTA: same shape as FULL but each post-event snapshot block shows
 *     only the operators that changed at that event (delta), plus the
 *     full link set so the DAG wiring stays visible.
 *
 * Action rendering (Full/Delta only): each tool call inside an event
 * renders as one natural-language line — `- create operator "X", result:
 * …` / `- modify operator "X", result: …` / `- delete operator "X",
 * result: …`. Create vs. modify is decided by walking the path: an op
 * id that hasn't been seen yet (or that was deleted) reads as `create`,
 * otherwise as `modify`. The submitted `code` and `summary` are NOT
 * included on event lines — the snapshot below carries the relevant
 * state.
 *
 * Snapshot trimming (paper §4.3): the operator's computation function
 * (`code` / `Properties:`) is dropped for every mode, every snapshot.
 * The user's `OperatorInfo` result already carries the source code on
 * error, so dropping `Properties:` doesn't hide what's needed to debug.
 */
export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  mode: ContextMode,
  options: AssembleContextOptions
): ModelMessage[] {
  const { path, initSnapshot } = buildPath(visibleSteps, snapshotStorage);

  // The latest user-message content lives in its own top-of-prompt
  // `# User Task` block — single source of truth, always present, never
  // duplicated. Its step id lets renderers skip rendering the same user
  // event inline in the events list. Older user messages (multi-task
  // continuation) still render inline as `## User Event N`.
  const latestUserStep = findLatestUserStepInPath(path);
  const latestUserContent = latestUserStep?.step.content;
  const latestUserStepId = latestUserStep?.step.id;

  const tasks = groupIntoTasks(path);

  // Per-step create-vs-modify flags. Linear walk over the path: each
  // `createOrModifyOperator` call records whether the op id was already
  // known (modify) or fresh (create). `deleteOperator` removes from the
  // known set so a later create-on-same-id reads as `create` again.
  const createFlagsByStep = buildCreateFlagsByStep(path);

  let content: string;
  switch (mode) {
    case ContextMode.FULL:
      content = renderInterleaved(
        tasks,
        "full",
        workflowState,
        options,
        initSnapshot,
        latestUserContent,
        latestUserStepId,
        createFlagsByStep
      );
      break;
    case ContextMode.DELTA:
      content = renderInterleaved(
        tasks,
        "delta",
        workflowState,
        options,
        initSnapshot,
        latestUserContent,
        latestUserStepId,
        createFlagsByStep
      );
      break;
    case ContextMode.LATEST: {
      // Latest = user task + the leaf snapshot. No events rendered at all
      // — context is defined as a single point on the snapshot tree, not
      // as an interleaved walk along its edges.
      const leafSnapshot =
        lastSnapshotOfPath(path) ?? initSnapshot ?? snapshotStorage.getRootSnapshot();
      content = renderLatest(workflowState, options, latestUserContent, leafSnapshot);
      break;
    }
  }

  log.debug(
    {
      mode,
      tasks: tasks.length,
      pathLength: path.length,
      actionBearing: path.filter(n => n.snapshot !== undefined).length,
      initExcluded: initSnapshot !== undefined,
    },
    "built context"
  );

  return [{ role: "user", content }];
}

/* ============================================================================
 *  Path & task grouping
 * ========================================================================= */

/**
 * One node on the event path: the ReAct step itself plus its destination
 * snapshot when the step is action-bearing (carries tool calls). Action-less
 * steps (user message, plain reply, parse error) have `snapshot = undefined`.
 *
 * `eventIndex` is a 1-based counter assigned in path order. It drives the
 * `# Event N (...)` heading so users see a single flat numbering across the
 * whole context — independent of the underlying ReAct step IDs (which restart
 * per messageId and are 0-based).
 */
interface PathNode {
  step: ReActStep;
  snapshot: SnapshotData | undefined;
  eventIndex: number;
}

/**
 * The synthetic `initialize` step (Event 0) is the baseline workflow load,
 * not a user-visible action. We strip it from the rendered path so the LLM
 * doesn't see the init event, but we preserve its snapshot separately so
 * the first real action can still diff against it (Delta) and so the
 * Latest-mode trailing block can fall back to it when no other action has
 * produced a snapshot yet.
 *
 * Identified by the synthetic `initialize` tool call; matches what
 * `recordInitializationStep` emits in texera-agent.ts.
 */
function isInitStep(step: ReActStep): boolean {
  if (step.role !== "agent") return false;
  if (!step.toolCalls || step.toolCalls.length !== 1) return false;
  return step.toolCalls[0].toolName === "initialize";
}

interface BuiltPath {
  /** Visible events in chronological order. The init step (Event 0) is
   *  filtered out here, so `eventIndex` numbers start at 1. */
  path: PathNode[];
  /** Snapshot captured at the init step, if it was on the input path. Used
   *  to seed delta diffing and the Latest-mode trailing fallback. */
  initSnapshot: SnapshotData | undefined;
}

/** Pick the latest user-role node from a full path. Used to hoist the
 *  latest user message into the `# User Task` block at the top of the
 *  rendered context, and to skip rendering the same node inline within
 *  `# Recent Agent Events` (older user messages still render inline as
 *  `## User Event N`). */
function findLatestUserStepInPath(path: PathNode[]): PathNode | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i];
    if (n.step.role === "user" && n.step.content) return n;
  }
  return undefined;
}

/** Exposed for unit tests. */
export const __forTesting = {
  findLatestUserStepInPath,
};

function buildPath(visibleSteps: ReActStep[], storage: WorkflowSnapshotStorage): BuiltPath {
  let initSnapshot: SnapshotData | undefined;
  const remaining: ReActStep[] = [];
  for (const step of visibleSteps) {
    if (isInitStep(step)) {
      // Capture init's snapshot once for downstream use, then drop the step.
      if (storage.hasSnapshotFor(step.id)) {
        initSnapshot = storage.getAssociatedSnapshot(step.id);
      }
      continue;
    }
    remaining.push(step);
  }
  const path: PathNode[] = remaining.map((step, i) => ({
    step,
    snapshot: storage.hasSnapshotFor(step.id) ? storage.getAssociatedSnapshot(step.id) : undefined,
    eventIndex: i + 1,
  }));
  return { path, initSnapshot };
}

interface TaskGroup {
  /** Path nodes belonging to this task, in chronological order. */
  nodes: PathNode[];
  /** `true` once any agent step in the group has `isEnd=true` — i.e. the
   *  LLM declared the task done. */
  isCompleted: boolean;
}

function groupIntoTasks(path: PathNode[]): TaskGroup[] {
  const byMessageId = new Map<string, PathNode[]>();
  const order: string[] = [];
  for (const node of path) {
    let g = byMessageId.get(node.step.messageId);
    if (!g) {
      g = [];
      byMessageId.set(node.step.messageId, g);
      order.push(node.step.messageId);
    }
    g.push(node);
  }
  return order.map(id => {
    const nodes = byMessageId.get(id)!;
    return { nodes, isCompleted: nodes.some(n => n.step.role === "agent" && n.step.isEnd) };
  });
}

/* ============================================================================
 *  Create / modify / delete flag computation
 *
 *  A single linear walk over the full path classifies every
 *  `createOrModifyOperator` tool call as either "create" (the op id was not
 *  already known in the path's accumulated state) or "modify" (it was).
 *  `deleteOperator` calls remove the id from the known set so a later
 *  `createOrModifyOperator` on the same id reads as `create` again, which
 *  matches the workflow's actual lifecycle.
 *
 *  The output is keyed by `step.id` so renderers can look up per-event
 *  flags without re-walking the path each time.
 * ========================================================================= */

function buildCreateFlagsByStep(fullPath: PathNode[]): Map<string, Map<string, boolean>> {
  const result = new Map<string, Map<string, boolean>>();
  const known = new Set<string>();
  for (const node of fullPath) {
    if (node.step.role !== "agent" || !node.step.toolCalls) continue;
    const eventFlags = new Map<string, boolean>();
    for (const tc of node.step.toolCalls) {
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
      if (!opId) continue;
      if (tc.toolName === "createOrModifyOperator") {
        const isCreate = !known.has(opId);
        eventFlags.set(opId, isCreate);
        known.add(opId);
      } else if (tc.toolName === "deleteOperator") {
        known.delete(opId);
      }
    }
    if (eventFlags.size > 0) result.set(node.step.id, eventFlags);
  }
  return result;
}

/**
 * Render a single tool-call line as a natural-language statement. Three
 * special tool names get the short verb-noun form; everything else falls
 * back to `<toolName> on operator "X"` (or just `<toolName>` when no
 * operator id is present).
 *
 *   - createOrModifyOperator → `- create operator "X"` or `- modify operator "X"`
 *     (decided by the create-flag map; default to `create` if absent)
 *   - deleteOperator         → `- delete operator "X"`
 *   - any other tool         → `- <toolName> on operator "X"` (or `- <toolName>`)
 *
 * The trailing `, result: ...` is appended by the caller — this helper
 * returns the head only, so the caller can decide between inline and
 * indented multi-line result rendering.
 */
function renderActionHead(
  tc: { toolName: string; input?: unknown },
  createFlags: Map<string, boolean> | undefined
): string {
  const inp = (tc.input ?? {}) as Record<string, unknown>;
  const rawOpId = typeof inp.operatorId === "string" ? inp.operatorId : "";
  const opId = rawOpId.length > 0 ? rawOpId : "";
  const tool = tc.toolName;
  if (tool === "createOrModifyOperator" && opId) {
    const isCreate = createFlags?.get(opId) ?? true;
    return `- ${isCreate ? "create" : "modify"} operator "${escapeQuotes(opId)}"`;
  }
  if (tool === "deleteOperator" && opId) {
    return `- delete operator "${escapeQuotes(opId)}"`;
  }
  if (opId) {
    return `- ${tool} on operator "${escapeQuotes(opId)}"`;
  }
  return `- ${tool}`;
}

/* ============================================================================
 *  Rendering: interleaved (FULL & DELTA) + trailing-snapshot (LATEST)
 * ========================================================================= */

/**
 * Layout (shared across all modes):
 *
 *   # User Task
 *
 *   <latest user-message content>
 *
 *   # Recent Agent Events (last K of N events)
 *
 *   (... M earlier events omitted ...)
 *
 *   ## Agent Event N
 *   Thought: ...
 *   Actions:
 *   - createOrModifyOperator(operatorId="...", summary="...")
 *       code: |
 *         ...
 *       (result: ...)
 *
 *   ## User Event N   ← only when an older user-message lies inside the
 *                       cap window (multi-task continuation). The latest
 *                       user message is hoisted to `# User Task` above.
 *
 *   # Current Dataflow   ← FULL/DELTA modes also emit inline snapshots
 *                          between events under "Recent Agent Events"
 *                          (`### Dataflow ... after event N`).
 *   ## Operators
 *   ### Operator `x` (Type)
 *   ...
 */
function renderInterleaved(
  tasks: TaskGroup[],
  flavour: "full" | "delta",
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  latestUserContent: string | undefined,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const lastSnapshotId = lastSnapshotIdOf(tasks);
  const sections: string[] = [];

  // 1. # User Task
  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }

  // 2. # Agent Events — every event in the path, each followed by its
  // destination snapshot (full or delta depending on `flavour`).
  sections.push("# Agent Events");
  sections.push("");

  // For Delta: rolling reference to the previous snapshot for diffing. The
  // init snapshot (hidden Event 0) seeds it so the first real action diffs
  // against the loaded workflow rather than appearing as a from-scratch add.
  let prevSnapshot: SnapshotData | undefined = initSnapshot;
  let renderedAny = false;
  for (const task of tasks) {
    const body = serializeTaskBody(
      task,
      flavour,
      workflowState,
      options,
      lastSnapshotId,
      () => prevSnapshot,
      s => {
        prevSnapshot = s;
      },
      latestUserStepId,
      createFlagsByStep
    );
    if (body) {
      sections.push(body);
      sections.push("");
      renderedAny = true;
    }
  }
  if (!renderedAny) {
    sections.push("(no agent actions yet)");
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function renderLatest(
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  latestUserContent: string | undefined,
  leafSnapshot: SnapshotData
): string {
  const sections: string[] = [];

  // 1. # User Task
  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }

  // 2. # Current Dataflow — the leaf snapshot of the path. Latest mode
  //    is defined as a single point on the snapshot tree, so no events
  //    are rendered above this.
  const dag = serializeSnapshotFull(
    leafSnapshot,
    workflowState,
    options,
    /*isCurrent=*/ true,
    /*sectionLevel=*/ 2
  );
  if (dag) {
    sections.push("# Current Dataflow");
    sections.push(dag);
  }
  return sections.join("\n").trimEnd();
}

/* ============================================================================
 *  Per-task serialization (events ± inline snapshots)
 * ========================================================================= */

/**
 * Serialize one task's user request + turns. When `flavour !== "events-only"`
 * each action-bearing turn is followed by its snapshot inline.
 */
function serializeTaskBody(
  task: TaskGroup,
  flavour: "full" | "delta",
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  lastSnapshotId: string | undefined,
  getPrev: () => SnapshotData | undefined,
  setPrev: (s: SnapshotData) => void,
  latestUserStepId: string | undefined,
  createFlagsByStep: Map<string, Map<string, boolean>>
): string {
  const lines: string[] = [];

  for (const node of task.nodes) {
    if (node.step.role === "user") {
      // The latest user message is hoisted into the top-level `# User Task`
      // block by the caller. Skip it here so it doesn't appear twice.
      if (node.step.id === latestUserStepId) continue;
      lines.push(serializeUserEventInline(node));
      lines.push("");
      continue;
    }
    if (node.step.role !== "agent") continue;

    lines.push(serializeTurn(node, createFlagsByStep.get(node.step.id)));
    lines.push("");

    if (node.snapshot) {
      const isCurrent = node.snapshot.id === lastSnapshotId;
      // Events render as `## Agent Event N` at H2 (nested under H1
      // `# Agent Events`), so the inline snapshot wrapper goes at H3
      // and the snapshot's own section headings start at H4.
      const snapshotHeadingLevel = 3;
      const snapshotSectionLevel = snapshotHeadingLevel + 1;
      const body =
        flavour === "full"
          ? serializeSnapshotFull(node.snapshot, workflowState, options, isCurrent, snapshotSectionLevel)
          : serializeSnapshotDelta(node.snapshot, getPrev(), workflowState, options, isCurrent, snapshotSectionLevel);
      if (body) {
        const snapshotHash = "#".repeat(snapshotHeadingLevel);
        const snapshotTitle =
          flavour === "full"
            ? `Completed dataflow after event ${node.eventIndex}`
            : `Dataflow changes after event ${node.eventIndex}`;
        lines.push(`${snapshotHash} ${snapshotTitle}`);
        lines.push("");
        lines.push(body);
        lines.push("");
      }
      setPrev(node.snapshot);
    }
  }
  return lines.join("\n").trimEnd();
}

/* ============================================================================
 *  Turn rendering (shared)
 * ========================================================================= */

/** Inline render of an older user-role step inside `# Agent Events`.
 *  Emits H2 `## User Event N` to nest under the H1 wrapper. The latest
 *  user step is never rendered here — it lives in the top-level
 *  `# User Task` block. */
function serializeUserEventInline(node: PathNode): string {
  const lines: string[] = [];
  lines.push(`## User Event ${node.eventIndex}`);
  lines.push("");
  if (node.step.content) lines.push(node.step.content);
  return lines.join("\n").trimEnd();
}

/**
 * Render one agent event as `## Agent Event N` + optional `Thought:` +
 * optional `Actions:` block. Each tool call becomes a single
 * natural-language line: `- create operator "X", result: …` /
 * `- modify operator "X", result: …` / `- delete operator "X", result: …`
 * (or `- <toolName> on operator "X", result: …` for non-special tools).
 *
 * Multi-line tool outputs (e.g. an [ERROR] block with stack trace + code)
 * break onto an indented continuation after `, result:`. Single-line
 * outputs stay inline.
 *
 * `createFlags` is the per-event create/modify map for this step (from
 * `buildCreateFlagsByStep`); `undefined` is treated as "everything is a
 * create" — a safe fallback when the step has no recorded calls.
 */
function serializeTurn(
  node: PathNode,
  createFlags: Map<string, boolean> | undefined
): string {
  const step = node.step;
  const lines: string[] = [];
  lines.push(`## Agent Event ${node.eventIndex}`);
  lines.push("");
  if (step.content) {
    lines.push(`Thought: ${step.content}`);
    lines.push("");
  }

  if (step.toolCalls && step.toolCalls.length > 0) {
    lines.push("Actions:");
    for (let i = 0; i < step.toolCalls.length; i++) {
      const tc = step.toolCalls[i];
      const tr = step.toolResults?.[i];
      const head = renderActionHead(tc, createFlags);
      const output = stringifyOutput(tr?.output).trim();
      if (output.length === 0) {
        // No tool output recorded — emit just the call line so the trace
        // still notes the action.
        lines.push(head);
      } else if (!output.includes("\n")) {
        // Single-line output: keep it inline after `, result:`.
        lines.push(`${head}, result: ${output}`);
      } else {
        // Multi-line output (typical for [ERROR] blocks carrying a stack
        // trace + the user's code): break onto its own indented block
        // following the `, result:` header. Indentation matches what the
        // tool itself emits (the engine indents the error body by two).
        lines.push(`${head}, result:`);
        for (const l of output.split("\n")) lines.push(`    ${l}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/* ============================================================================
 *  Snapshot rendering (Full and Delta variants of the per-snapshot DAG)
 * ========================================================================= */

/**
 * `sectionLevel` controls the depth of the "Operators" / "Links" headings (and,
 * derived, the per-operator headings one level deeper). It exists because the
 * snapshot is rendered in two contexts whose enclosing heading lives at
 * different depths:
 *   - Inline after a turn: parent heading is `#### Completed dataflow after
 *     turn N` (H4) → pass `sectionLevel = 5` so Operators is H5 and Operator
 *     `X` is H6, properly nested under the parent.
 *   - LATEST mode trailing block: parent heading is `# Current Dataflow` (H1)
 *     → pass `sectionLevel = 2` so Operators is H2 and Operator `X` is H3.
 */
function serializeSnapshotFull(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isCurrent: boolean,
  sectionLevel: number
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const lines: string[] = [];
  const { sortedOps, allLinks } = topoSortDag(workflow);
  const sectionHash = "#".repeat(sectionLevel);
  const operatorLevel = sectionLevel + 1;

  lines.push(`${sectionHash} Operators`);
  lines.push("");
  for (const op of sortedOps) {
    lines.push(
      serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks, operatorLevel)
    );
    lines.push("");
  }
  appendLinkLines(lines, sortedOps, allLinks, sectionLevel);
  return lines.join("\n").trimEnd();
}

/**
 * Delta snapshot: only render operators that are in Δ. Unchanged operators
 * are omitted entirely — no placeholder, no summary, no heading entry.
 *
 * Rationale: every unchanged operator costs ~2 lines × N turns in the rolling
 * context. The agent already saw each operator in full in the snapshot that
 * introduced or last modified it, and the trailing `### Links` block keeps the
 * graph wiring visible so it can recall what each unchanged op-id is. This is
 * a token-vs-semantic-anchor trade we make in favour of tokens; if the agent
 * ever struggles to recall what an unchanged op did, swap this back to the
 * placeholder form (see git blame for the previous implementation).
 *
 * If Δ is empty AND there are no links (e.g. a pure deleteOperator that
 * leaves an empty workflow), the whole snapshot block is dropped — the
 * caller's `if (body)` check then skips emitting the heading too.
 */
function serializeSnapshotDelta(
  snapshot: SnapshotData,
  prevSnapshot: SnapshotData | undefined,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isCurrent: boolean,
  sectionLevel: number
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const delta = computeDelta(prevSnapshot, snapshot);
  const lines: string[] = [];
  const { sortedOps, allLinks } = topoSortDag(workflow);
  const sectionHash = "#".repeat(sectionLevel);
  const operatorLevel = sectionLevel + 1;

  const deltaOps = sortedOps.filter(op => delta.has(op.operatorID));
  if (deltaOps.length > 0) {
    lines.push(`${sectionHash} Operators`);
    lines.push("");
    for (const op of deltaOps) {
      lines.push(
        serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks, operatorLevel)
      );
      lines.push("");
    }
  }

  appendLinkLines(lines, sortedOps, allLinks, sectionLevel);

  if (lines.length === 0) return null;
  return lines.join("\n").trimEnd();
}

/**
 * Δᵢ = operators in snapshot S_i that differ from S_{i-1}.
 *
 * An operator is in Δ when (a) it didn't exist in the previous snapshot,
 * (b) its operatorProperties differ from the previous snapshot's
 * version, or (c) it has a newly-earned execution result at this
 * snapshot. (c) is detected via `ResultEntry.sourceStepId === snapshot's
 * reactStepId`, which the snapshot storage preserves through inheritance.
 *
 * (a) handles add; (b) handles modify; (c) handles "the action also
 * refreshed results downstream" — e.g. `runPostStepExecution` re-running
 * a sink after a modifyOperator on an ancestor.
 */
export function computeDelta(prev: SnapshotData | undefined, curr: SnapshotData): Set<string> {
  const delta = new Set<string>();
  const prevOps = new Map<string, OperatorPredicate>();
  if (prev) for (const op of prev.workflow.operators) prevOps.set(op.operatorID, op);

  for (const op of curr.workflow.operators) {
    const before = prevOps.get(op.operatorID);
    if (!before) {
      delta.add(op.operatorID); // newly added
      continue;
    }
    // Cheap structural compare; properties is the only mutable shape of
    // an operator the agent edits in place.
    if (JSON.stringify(before.operatorProperties) !== JSON.stringify(op.operatorProperties)) {
      delta.add(op.operatorID); // modified
    }
  }
  // Newly-earned results at this snapshot's owning step.
  if (curr.reactStepId !== undefined) {
    for (const [opId, entry] of curr.results) {
      if (entry.sourceStepId === curr.reactStepId) delta.add(opId);
    }
  }
  return delta;
}

/* ============================================================================
 *  Per-operator serialization
 * ========================================================================= */

function serializeOperatorFull(
  op: OperatorPredicate,
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isCurrent: boolean,
  allLinks: WorkflowContent["links"],
  operatorLevel: number
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const execText = info
    ? formatOperatorResult(op.operatorID, info, workflowState, { statsEnabled: options.statsEnabled })
    : undefined;

  // No status label in the header. Execution state is conveyed by the Result
  // section itself:
  //   - no info AND no errored upstream → no `Result:` block
  //     (operator hasn't been executed yet)
  //   - no info BUT an upstream op has info.error
  //                                    → `Result: (skipped — upstream
  //     operator `X` errored; …)` so the agent can distinguish "blocked
  //     by upstream failure" from "not yet built". Walks transitively
  //     through upstreams that themselves have no info, so a long
  //     skipped chain points back to the actual root-cause error.
  //   - successful info               → `Result:` block with the data preview
  //   - error info                    → `Result:` block beginning with
  //     `[ERROR] …`, which (per the Amber backend's format) carries the
  //     user's code + line marker inline.
  const opHash = "#".repeat(operatorLevel);
  const lines: string[] = [];
  lines.push(`${opHash} Operator \`${op.operatorID}\` (${op.operatorType})`);
  lines.push(`Summary: ${op.customDisplayName || op.operatorID}`);

  // Schemas only on the current (last) snapshot — compilation only runs
  // against the live workflow.
  const showSchemas = isCurrent && options.agentMode === AgentMode.GENERAL && options.compilationResult;
  if (showSchemas) {
    const outputSchemas = options.compilationResult!.operatorOutputSchemas ?? {};
    const allLinks = snapshot.workflow.links;
    const inputSchemaMap = extractOperatorInputPortSchemaMap(op.operatorID, op, outputSchemas, allLinks);
    if (inputSchemaMap) {
      for (const [portId, schema] of Object.entries(inputSchemaMap)) {
        if (schema) lines.push(`Input Schema (port ${parsePortIndex(portId)}): ${formatSchema(schema)}`);
      }
    }
    const outputSchemaMap = outputSchemas[op.operatorID];
    if (outputSchemaMap) {
      const firstSchema = Object.values(outputSchemaMap).find(s => s !== undefined) as PortSchema | undefined;
      if (firstSchema) lines.push(`Output Schema: ${formatSchema(firstSchema)}`);
    }
    const compilationError = options.compilationResult!.operatorErrors?.[op.operatorID] as
      | WorkflowFatalError
      | undefined;
    if (compilationError) lines.push(`Compilation Error: ${compilationError.message}`);
  }

  if (execText) {
    lines.push("Result:");
    for (const l of execText.split("\n")) lines.push("  " + l);
  } else if (!info) {
    // No own result/error AND no info entry for this op. Distinguish
    // "blocked by upstream error" from "not yet executed" by walking
    // upstreams transitively (through ops that also have no info) to
    // find any ancestor with info.error.
    const failedUpstreams = collectFailedUpstreamRoots(op.operatorID, snapshot, allLinks);
    if (failedUpstreams.length > 0) {
      const noun = failedUpstreams.length === 1 ? "operator" : "operators";
      const list = failedUpstreams.map(id => `\`${id}\``).join(", ");
      lines.push(
        `Result: (skipped — upstream ${noun} ${list} errored; see [ERROR] above)`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Walk upstream from `opId` and return the set of ancestor operators
 * whose `info.error` is set, when this op has no info of its own.
 *
 * Traversal rules:
 *   - If an ancestor has `info.error` → record it, do not traverse past it
 *     (it's the chain's root cause for this branch).
 *   - If an ancestor has an `info` without an error → traversal of this
 *     branch stops (that ancestor ran successfully; it's not why our
 *     op was blocked).
 *   - If an ancestor has no `info` → keep walking; the error might be
 *     further up.
 *
 * Returns deduplicated upstream IDs in DAG-link discovery order.
 */
function collectFailedUpstreamRoots(
  opId: string,
  snapshot: SnapshotData,
  allLinks: WorkflowContent["links"]
): string[] {
  const childToParents = new Map<string, string[]>();
  for (const link of allLinks) {
    const arr = childToParents.get(link.target.operatorID) ?? [];
    arr.push(link.source.operatorID);
    childToParents.set(link.target.operatorID, arr);
  }
  const visited = new Set<string>();
  const failed: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...(childToParents.get(opId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const upInfo = snapshot.results.get(cur)?.info;
    if (upInfo?.error) {
      if (!seen.has(cur)) {
        seen.add(cur);
        failed.push(cur);
      }
      continue;
    }
    if (upInfo) {
      // Ran successfully — not why we're blocked.
      continue;
    }
    for (const p of childToParents.get(cur) ?? []) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  return failed;
}

/* ============================================================================
 *  Shared helpers
 * ========================================================================= */

function topoSortDag(workflow: WorkflowContent) {
  const allOperators = workflow.operators;
  const allLinks = workflow.links;
  const opIds = new Set(allOperators.map(o => o.operatorID));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of opIds) {
    inDegree.set(id, 0);
    children.set(id, []);
  }
  for (const link of allLinks) {
    children.get(link.source.operatorID)?.push(link.target.operatorID);
    inDegree.set(link.target.operatorID, (inDegree.get(link.target.operatorID) ?? 0) + 1);
  }
  const queue: string[] = [...opIds].filter(id => (inDegree.get(id) ?? 0) === 0);
  const topoOrder = new Map<string, number>();
  let rank = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    topoOrder.set(node, rank++);
    for (const child of children.get(node) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }
  const sortedOps = [...allOperators].sort(
    (a, b) => (topoOrder.get(a.operatorID) ?? 0) - (topoOrder.get(b.operatorID) ?? 0)
  );
  return { sortedOps, allLinks, topoOrder };
}

function appendLinkLines(
  lines: string[],
  sortedOps: OperatorPredicate[],
  allLinks: WorkflowContent["links"],
  sectionLevel: number
): void {
  if (allLinks.length === 0) return;
  const opOrder = new Map(sortedOps.map((op, i) => [op.operatorID, i]));
  const sortedLinks = [...allLinks].sort((a, b) => {
    const srcA = opOrder.get(a.source.operatorID) ?? 0;
    const srcB = opOrder.get(b.source.operatorID) ?? 0;
    if (srcA !== srcB) return srcA - srcB;
    return (opOrder.get(a.target.operatorID) ?? 0) - (opOrder.get(b.target.operatorID) ?? 0);
  });
  const sectionHash = "#".repeat(sectionLevel);
  lines.push(`${sectionHash} Links`);
  for (const link of sortedLinks) {
    lines.push(`- ${link.source.operatorID} → ${link.target.operatorID}`);
  }
}

function lastSnapshotOf(tasks: TaskGroup[]): SnapshotData | undefined {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    for (let j = t.nodes.length - 1; j >= 0; j--) {
      if (t.nodes[j].snapshot) return t.nodes[j].snapshot;
    }
  }
  return undefined;
}

/** Find the most-recent attached snapshot across the original (untruncated)
 *  path. Used so the trailing `# Current Dataflow` block survives even when
 *  the recent-events cap drops every visible task. */
function lastSnapshotOfPath(path: PathNode[]): SnapshotData | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].snapshot) return path[i].snapshot;
  }
  return undefined;
}

function lastSnapshotIdOf(tasks: TaskGroup[]): string | undefined {
  return lastSnapshotOf(tasks)?.id;
}

function formatSchema(schema: PortSchema): string {
  const attrs = schema.map(a => `${a.attributeName}: ${a.attributeType}`);
  return `[${attrs.join(", ")}]`;
}

function parsePortIndex(portId: string): string {
  const idx = portId.indexOf("_");
  return idx >= 0 ? portId.substring(0, idx) : portId;
}
