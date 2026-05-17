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
  /** When true, each in-progress task's continuation block is prefixed with
   *  a verbatim re-statement of that task's last user message. Re-anchors
   *  the model on the immediate target adjacent to where it resumes
   *  generation, at the cost of one extra copy of the task prompt. */
  userTaskDuplicatedAtEnd?: boolean;
  /** When true, every non-error operator result whose `OperatorInfo` carries
   *  `columnStats` is followed by a `Column stats:` section listing
   *  per-column stats (one column per line). Off by default. */
  statsEnabled?: boolean;
}

/**
 * Build the assembled user-message context the LLM sees on the next
 * `prepareStep`. Dispatches to one of three snapshot-selection policies
 * (paper §5 — Full / Delta / Latest).
 *
 * Common to all modes:
 *   - Events are grouped by `messageId` into tasks (`## Task (status)`).
 *   - Each agent step is rendered as `### Turn N` with a thought line and
 *     a `- toolName(operatorId="X") (succeeded|failed)` line per tool call.
 *   - Failures inline the verbatim error body.
 *
 * Modes differ in **which** snapshots they emit and **where**:
 *   - FULL: every action-bearing turn is followed by its destination
 *     snapshot in full.
 *   - DELTA: every action-bearing turn is followed by its destination
 *     snapshot rendered against the previous snapshot: operators touched
 *     by this step's actions are full; the rest are id+description
 *     placeholders. All edges of the current snapshot are emitted.
 *   - LATEST: no per-turn snapshots. A trailing `# Current Dataflow`
 *     block renders the snapshot at the current HEAD in full.
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
  const tasks = groupIntoTasks(path);

  // Mode-orthogonal: for every createOrModifyOperator call that carries a
  // before/after code block, keep only the most-recent N per operatorId
  // intact when rendering the event list. Older mods' results get trimmed to
  // just the "Operator X modified" line. Without this cap, long thrash
  // sequences accumulate before/after blocks across turns and compound
  // context bloat — paying for diff signal we've already surfaced once.
  const beforeAfterTrimSet = computeBeforeAfterTrimSet(path);

  let content: string;
  switch (mode) {
    case ContextMode.FULL:
      content = renderInterleaved(tasks, "full", workflowState, options, initSnapshot, beforeAfterTrimSet);
      break;
    case ContextMode.DELTA:
      content = renderInterleaved(tasks, "delta", workflowState, options, initSnapshot, beforeAfterTrimSet);
      break;
    case ContextMode.LATEST:
      content = renderLatest(tasks, snapshotStorage, workflowState, options, initSnapshot, beforeAfterTrimSet);
      break;
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

/**
 * Global cap (per operatorId) on how many recent createOrModifyOperator
 * before/after blocks are kept intact in the rendered event list. The
 * before/after block is appended to every modifyOperator tool result by
 * `code-op-tools.ts` (Design C). Without a cap, long thrash sequences
 * accumulate per-mod before/after pairs in the past-action history, which
 * compounds context bloat across turns — we pay for diff signal we've
 * already surfaced once. Trim is mode-orthogonal: every mode renders the
 * event list with the same shape, so this cap applies everywhere uniformly.
 *
 * `1` means "only the most recent mod's before/after stays visible per op";
 * all older mods' results get stripped down to their headline message.
 * Tune by changing this constant.
 */
const MAX_RECENT_BEFORE_AFTER_PER_OPERATOR = 1;

/**
 * Sentinel substrings that mark the start of a before/after block inside a
 * modify-operator tool result. Both forms exist:
 *   - `\nWARNING: ...` — the no-op warning (Design C's loud signal)
 *   - `\nBefore code:` — the always-on before/after block header
 * The WARNING (when present) comes before the Before code block, so the
 * earliest match is the cut point.
 */
const BEFORE_AFTER_BLOCK_MARKERS = ["\nWARNING:", "\nBefore code:"];

/**
 * Per-operator step+toolCall index → "trim this one's before/after block".
 *
 * Walks every action-bearing node in chronological order, grouping
 * createOrModifyOperator calls by `input.operatorId`, then for each group
 * marks all-but-the-last-N calls as trimmable. ADD calls (whose results
 * carry no before/after block) are excluded from the count via the marker
 * check so the budget is spent only on results that actually carry the
 * block we're trying to dedupe.
 *
 * Returns a `Set<string>` of `"${stepId}:${toolCallIdx}"` keys.
 */
function computeBeforeAfterTrimSet(path: PathNode[]): Set<string> {
  const callsByOp = new Map<string, string[]>();
  for (const node of path) {
    if (node.step.role !== "agent") continue;
    const tcs = node.step.toolCalls ?? [];
    const trs = node.step.toolResults ?? [];
    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs[i];
      if (!tc || tc.toolName !== "createOrModifyOperator") continue;
      const opId = (tc.input as { operatorId?: unknown })?.operatorId;
      if (typeof opId !== "string" || opId.length === 0) continue;
      const out = String(trs[i]?.output ?? "");
      // Only count results that actually carry a before/after block. ADDs
      // don't, so they don't compete with MODIFYs for the budget.
      if (!BEFORE_AFTER_BLOCK_MARKERS.some(m => out.includes(m))) continue;
      const key = `${node.step.id}:${i}`;
      const arr = callsByOp.get(opId) ?? [];
      arr.push(key);
      callsByOp.set(opId, arr);
    }
  }
  const toTrim = new Set<string>();
  for (const [, keys] of callsByOp) {
    const trimCount = Math.max(0, keys.length - MAX_RECENT_BEFORE_AFTER_PER_OPERATOR);
    for (let i = 0; i < trimCount; i++) toTrim.add(keys[i]);
  }
  return toTrim;
}

/**
 * Strip the before/after block (and any preceding `\nWARNING:` line) from a
 * modify-operator tool result, returning just the headline message
 * (`Operator X modified` etc.). Idempotent on outputs that have no block.
 */
function stripBeforeAfterBlock(output: string): string {
  let cut = output.length;
  for (const marker of BEFORE_AFTER_BLOCK_MARKERS) {
    const idx = output.indexOf(marker);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  return output.substring(0, cut);
}

/** Exposed for unit tests. */
export const __forTesting = { computeBeforeAfterTrimSet, stripBeforeAfterBlock };

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
 *  Rendering: interleaved (FULL & DELTA) + trailing-snapshot (LATEST)
 * ========================================================================= */

function renderInterleaved(
  tasks: TaskGroup[],
  flavour: "full" | "delta",
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  beforeAfterTrimSet: Set<string>
): string {
  // The "current" snapshot is the last one on the path — its operators
  // should carry compiled schemas, the rest should not.
  const lastSnapshotId = lastSnapshotIdOf(tasks);
  const sections: string[] = [];
  // For Delta: rolling reference to the previous snapshot for diffing. The
  // init snapshot (hidden Event 0) seeds it so the first real action diffs
  // against the loaded workflow rather than appearing as a from-scratch add.
  let prevSnapshot: SnapshotData | undefined = initSnapshot;

  for (const task of tasks) {
    sections.push(
      serializeTaskBody(
        task,
        flavour,
        workflowState,
        options,
        lastSnapshotId,
        () => prevSnapshot,
        s => {
          prevSnapshot = s;
        },
        beforeAfterTrimSet
      )
    );
    sections.push("");
    if (!task.isCompleted) {
      sections.push(renderTaskContinuation(task, options));
    }
  }
  return sections.join("\n").trimEnd();
}

function renderLatest(
  tasks: TaskGroup[],
  storage: WorkflowSnapshotStorage,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  initSnapshot: SnapshotData | undefined,
  beforeAfterTrimSet: Set<string>
): string {
  const sections: string[] = [];

  // Trailing snapshot — picked early so we can compute which operator IDs
  // are still alive in the current dataflow. For every past tool call whose
  // `operatorId` is still in that set, the snapshot below already prints the
  // operator's latest Summary line; emitting the same `summary="..."` on the
  // historical action line is pure duplication. Drop it on that subset.
  const current = lastSnapshotOf(tasks) ?? initSnapshot ?? storage.getRootSnapshot();
  const liveOperatorIds = new Set(current.workflow.operators.map(o => o.operatorID));

  for (const task of tasks) {
    sections.push(serializeTaskEventsOnly(task, liveOperatorIds, beforeAfterTrimSet));
    sections.push("");
    if (!task.isCompleted) {
      sections.push(renderTaskContinuation(task, options));
    }
  }
  // The wrapper is at H1 (`# Current Dataflow`), so the snapshot's section
  // headings start at H2.
  const dag = serializeSnapshotFull(current, workflowState, options, /*isCurrent=*/ true, /*sectionLevel=*/ 2);
  if (dag) {
    sections.push("");
    sections.push("# Current Dataflow");
    sections.push(dag);
  }
  return sections.join("\n");
}

/**
 * Render the per-task "keep working" continuation block emitted after every
 * in-progress task body. Always carries the exhortation; when
 * `options.userTaskDuplicatedAtEnd` is set, prefixes it with a verbatim
 * `User's request is: ...` copy of the task's latest user message so the
 * objective sits adjacent to where the model resumes.
 */
function renderTaskContinuation(task: TaskGroup, options: AssembleContextOptions): string {
  const lines: string[] = [];
  if (options.userTaskDuplicatedAtEnd) {
    const lastUserContent = findLastUserContent(task);
    if (lastUserContent) {
      lines.push(`User's request is: ${lastUserContent}`);
      lines.push("");
    }
  }
  lines.push(
    "Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow."
  );
  return lines.join("\n");
}

function findLastUserContent(task: TaskGroup): string | undefined {
  for (let i = task.nodes.length - 1; i >= 0; i--) {
    const n = task.nodes[i];
    if (n.step.role === "user" && n.step.content) return n.step.content;
  }
  return undefined;
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
  beforeAfterTrimSet: Set<string>
): string {
  const lines: string[] = [];

  for (const node of task.nodes) {
    if (node.step.role === "user") {
      lines.push(serializeUserTurn(node));
      lines.push("");
      continue;
    }
    if (node.step.role !== "agent") continue;

    lines.push(serializeTurn(node, undefined, beforeAfterTrimSet));
    lines.push("");

    if (node.snapshot) {
      const isCurrent = node.snapshot.id === lastSnapshotId;
      // Each event is `# Event N (...)` at H1, so the inline snapshot
      // wrapper is H2 and the snapshot's own section headings start at H3.
      const snapshotHeadingLevel = 2;
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

/**
 * Latest-mode task body: events only, no inline snapshots.
 *
 * `omitSummaryForOpIds` (Latest-mode optimization): IDs whose operators still
 * exist in the trailing `# Current Dataflow` snapshot. Past tool calls that
 * touched those operators get rendered without their `summary="..."` param
 * because the snapshot's per-operator `Summary:` line already carries the
 * latest version — emitting it on the historical action line is duplicate
 * tokens. Pass `undefined` (or omit) to keep the summary on every call.
 */
function serializeTaskEventsOnly(
  task: TaskGroup,
  omitSummaryForOpIds?: Set<string>,
  beforeAfterTrimSet?: Set<string>
): string {
  const lines: string[] = [];

  for (const node of task.nodes) {
    if (node.step.role === "user") {
      lines.push(serializeUserTurn(node));
      lines.push("");
      continue;
    }
    if (node.step.role !== "agent") continue;
    lines.push(serializeTurn(node, omitSummaryForOpIds, beforeAfterTrimSet));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/* ============================================================================
 *  Turn rendering (shared)
 * ========================================================================= */

/** Render a user-role step as `# Event N (User Task)` plus its raw content. */
function serializeUserTurn(node: PathNode): string {
  const lines: string[] = [];
  lines.push(`# Event ${node.eventIndex} (User Task)`);
  lines.push("");
  if (node.step.content) lines.push(node.step.content);
  return lines.join("\n").trimEnd();
}

function serializeTurn(
  node: PathNode,
  omitSummaryForOpIds?: Set<string>,
  beforeAfterTrimSet?: Set<string>
): string {
  const step = node.step;
  const lines: string[] = [];
  lines.push(`# Event ${node.eventIndex} (Agent Actions)`);
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
      const params = formatActionParams(tc.input, omitSummaryForOpIds);
      const trimKey = `${step.id}:${i}`;
      const rawOutput = stringifyOutput(tr?.output);
      const trimmedOutput = beforeAfterTrimSet?.has(trimKey) ? stripBeforeAfterBlock(rawOutput) : rawOutput;
      const output = trimmedOutput.trim();
      const header = `- ${tc.toolName}${params}`;
      if (output.length === 0) {
        // No tool output recorded — emit just the call site so the line still
        // appears in the trace.
        lines.push(header);
      } else if (!output.includes("\n")) {
        // Single-line output: keep it inline next to the call.
        lines.push(`${header} (result: ${output})`);
      } else {
        // Multi-line output (typical for compile/runtime errors that carry a
        // stack trace + the user's code): break onto its own indented block,
        // close the parenthesis on its own line at the same depth as `result:`
        // so the block is unambiguously bracketed.
        lines.push(`${header} (result:`);
        for (const l of output.split("\n")) lines.push(`    ${l}`);
        lines.push("  )");
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render the call site of a tool invocation. We expose just the two parameters
 * that carry intent — `operatorId` (which op was touched) and `summary` (the
 * agent's own description of what the call does) — and drop everything else
 * (`code`, JSON props, …) to keep turn lines scannable. The summary is what
 * the agent told the user it was doing, so surfacing it next to the tool name
 * lets the LLM read its own breadcrumb trail without diving into the
 * downstream snapshot.
 *
 * Optimization (Latest mode): if `omitSummaryForOpIds` is provided AND this
 * call's `operatorId` is in it, drop `summary="..."` from the rendered line.
 * Used when the trailing `# Current Dataflow` snapshot already prints the
 * latest Summary for that operator, making the historical copy pure
 * duplication. Calls without an `operatorId` (or whose op was deleted) keep
 * the summary so the trail isn't lost.
 */
function formatActionParams(input: unknown, omitSummaryForOpIds?: Set<string>): string {
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  const params: string[] = [];
  const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
  if (opId.length > 0) {
    params.push(`operatorId="${escapeQuotes(opId)}"`);
  }
  const skipSummary = opId.length > 0 && omitSummaryForOpIds?.has(opId) === true;
  if (!skipSummary && typeof inp.summary === "string" && inp.summary.length > 0) {
    params.push(`summary="${escapeQuotes(inp.summary)}"`);
  }
  if (params.length === 0) return "";
  return `(${params.join(", ")})`;
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
    lines.push(serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks, operatorLevel));
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
      lines.push(serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks, operatorLevel));
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
  _allLinks: WorkflowContent["links"],
  operatorLevel: number
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const execText = info
    ? formatOperatorResult(op.operatorID, info, workflowState, { statsEnabled: options.statsEnabled })
    : undefined;

  // No status label in the header. Execution state is conveyed by the Result
  // section itself:
  //   - no info             → no `Result:` block (operator hasn't been executed)
  //   - successful info     → `Result:` block with the data preview
  //   - error info          → `Result:` block beginning with `[ERROR] …`,
  //                            which (per the Amber backend's format) carries
  //                            the user's code + line marker inline.
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
  }
  return lines.join("\n");
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
