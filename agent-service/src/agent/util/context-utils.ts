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
  const path = buildPath(visibleSteps, snapshotStorage);
  const tasks = groupIntoTasks(path);

  let content: string;
  switch (mode) {
    case ContextMode.FULL:
      content = renderInterleaved(tasks, "full", workflowState, options);
      break;
    case ContextMode.DELTA:
      content = renderInterleaved(tasks, "delta", workflowState, options);
      break;
    case ContextMode.LATEST:
      content = renderLatest(tasks, snapshotStorage, workflowState, options);
      break;
  }

  log.debug(
    {
      mode,
      tasks: tasks.length,
      pathLength: path.length,
      actionBearing: path.filter(n => n.snapshot !== undefined).length,
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
 */
interface PathNode {
  step: ReActStep;
  snapshot: SnapshotData | undefined;
}

function buildPath(visibleSteps: ReActStep[], storage: WorkflowSnapshotStorage): PathNode[] {
  return visibleSteps.map(step => ({
    step,
    snapshot: storage.hasSnapshotFor(step.id) ? storage.getAssociatedSnapshot(step.id) : undefined,
  }));
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
  options: AssembleContextOptions
): string {
  // The "current" snapshot is the last one on the path — its operators
  // should carry compiled schemas, the rest should not.
  const lastSnapshotId = lastSnapshotIdOf(tasks);
  const sections: string[] = [];
  let completedCount = 0;
  let inOngoing = false;
  // For Delta: rolling reference to the previous snapshot for diffing.
  let prevSnapshot: SnapshotData | undefined;

  for (const task of tasks) {
    if (task.isCompleted) {
      if (completedCount === 0) sections.push("# Completed Tasks");
      sections.push("");
      sections.push(
        serializeTaskBody(
          task,
          "completed",
          flavour,
          workflowState,
          options,
          lastSnapshotId,
          () => prevSnapshot,
          s => {
            prevSnapshot = s;
          }
        )
      );
      completedCount++;
    } else {
      if (!inOngoing) {
        inOngoing = true;
        sections.push("");
        sections.push("# Ongoing Task");
      }
      sections.push(
        serializeTaskBody(
          task,
          "ongoing",
          flavour,
          workflowState,
          options,
          lastSnapshotId,
          () => prevSnapshot,
          s => {
            prevSnapshot = s;
          }
        )
      );
      sections.push("");
      sections.push(
        "Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow."
      );
    }
  }
  return sections.join("\n");
}

function renderLatest(
  tasks: TaskGroup[],
  storage: WorkflowSnapshotStorage,
  workflowState: WorkflowState,
  options: AssembleContextOptions
): string {
  const sections: string[] = [];
  let completedCount = 0;
  let inOngoing = false;

  for (const task of tasks) {
    if (task.isCompleted) {
      if (completedCount === 0) sections.push("# Completed Tasks");
      sections.push("");
      sections.push(serializeTaskEventsOnly(task, "completed"));
      completedCount++;
    } else {
      if (!inOngoing) {
        inOngoing = true;
        sections.push("");
        sections.push("# Ongoing Task");
      }
      sections.push(serializeTaskEventsOnly(task, "ongoing"));
      sections.push("");
      sections.push(
        "Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow."
      );
    }
  }

  // Trailing snapshot block — Latest's defining feature.
  const current = lastSnapshotOf(tasks) ?? storage.getRootSnapshot();
  const dag = serializeSnapshotFull(current, workflowState, options, /*isCurrent=*/ true);
  if (dag) {
    sections.push("");
    sections.push("# Current Dataflow");
    sections.push(dag);
  }
  return sections.join("\n");
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
  status: "completed" | "ongoing",
  flavour: "full" | "delta",
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  lastSnapshotId: string | undefined,
  getPrev: () => SnapshotData | undefined,
  setPrev: (s: SnapshotData) => void
): string {
  const lines: string[] = [];
  lines.push(`## Task (${status})`);
  lines.push("");

  const userStep = task.nodes.find(n => n.step.role === "user")?.step;
  if (userStep) {
    lines.push("### User request");
    lines.push("");
    lines.push(userStep.content);
    lines.push("");
  }

  for (const node of task.nodes) {
    if (node.step.role !== "agent") continue;
    lines.push(serializeTurn(node.step));

    if (node.snapshot) {
      const isCurrent = node.snapshot.id === lastSnapshotId;
      const body =
        flavour === "full"
          ? serializeSnapshotFull(node.snapshot, workflowState, options, isCurrent)
          : serializeSnapshotDelta(node.snapshot, getPrev(), workflowState, options, isCurrent);
      if (body) {
        lines.push(`#### Snapshot after turn ${node.step.stepId}`);
        lines.push(body);
        lines.push("");
      }
      setPrev(node.snapshot);
    }
  }
  return lines.join("\n").trimEnd();
}

/** Latest-mode task body: events only, no inline snapshots. */
function serializeTaskEventsOnly(task: TaskGroup, status: "completed" | "ongoing"): string {
  const lines: string[] = [];
  lines.push(`## Task (${status})`);
  lines.push("");

  const userStep = task.nodes.find(n => n.step.role === "user")?.step;
  if (userStep) {
    lines.push("### User request");
    lines.push("");
    lines.push(userStep.content);
    lines.push("");
  }

  for (const node of task.nodes) {
    if (node.step.role !== "agent") continue;
    lines.push(serializeTurn(node.step));
  }
  return lines.join("\n").trimEnd();
}

/* ============================================================================
 *  Turn rendering (shared)
 * ========================================================================= */

function serializeTurn(step: ReActStep): string {
  const lines: string[] = [];
  lines.push(`### Turn ${step.stepId}`);
  if (step.content) lines.push(`Thought: ${step.content}`);

  if (step.toolCalls && step.toolCalls.length > 0) {
    for (let i = 0; i < step.toolCalls.length; i++) {
      const tc = step.toolCalls[i];
      const tr = step.toolResults?.[i];
      const outputStr = stringifyOutput(tr?.output);
      const isFailure = !!tr?.isError || outputStr.startsWith("[ERROR]");
      const statusAttr = isFailure ? "failed" : "succeeded";
      const opIdParam = formatOperatorIdParam(tc.input);
      lines.push(`- ${tc.toolName}${opIdParam} (${statusAttr})`);
      if (isFailure && outputStr) {
        const errorBody = outputStr.replace(/^\[ERROR\]\s*/, "");
        lines.push("  Error:");
        for (const errLine of errorBody.split("\n")) lines.push(`    ${errLine}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n").trimEnd();
}

function formatOperatorIdParam(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const opId = (input as Record<string, unknown>).operatorId;
  if (typeof opId !== "string" || opId.length === 0) return "";
  return `(operatorId="${opId}")`;
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

function serializeSnapshotFull(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isCurrent: boolean
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const lines: string[] = [];
  const { sortedOps, allLinks } = topoSortDag(workflow);

  lines.push("## Operators");
  lines.push("");
  for (const op of sortedOps) {
    lines.push(serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks));
    lines.push("");
  }
  appendLinkLines(lines, sortedOps, allLinks);
  return lines.join("\n").trimEnd();
}

function serializeSnapshotDelta(
  snapshot: SnapshotData,
  prevSnapshot: SnapshotData | undefined,
  workflowState: WorkflowState,
  options: AssembleContextOptions,
  isCurrent: boolean
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const delta = computeDelta(prevSnapshot, snapshot);
  const lines: string[] = [];
  const { sortedOps, allLinks } = topoSortDag(workflow);

  lines.push("## Operators");
  lines.push("");
  for (const op of sortedOps) {
    if (delta.has(op.operatorID)) {
      lines.push(serializeOperatorFull(op, snapshot, workflowState, options, isCurrent, allLinks));
    } else {
      lines.push(serializeOperatorPlaceholder(op, snapshot));
    }
    lines.push("");
  }
  appendLinkLines(lines, sortedOps, allLinks);
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
  _allLinks: WorkflowContent["links"]
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const execText = info ? formatOperatorResult(op.operatorID, info, workflowState) : undefined;
  const hasError = execText !== undefined && execText.includes("[ERROR]");
  const status = execText ? (hasError ? "failed" : "executed") : "not-executed";

  const lines: string[] = [];
  lines.push(`### Operator \`${op.operatorID}\` (${op.operatorType}, ${status})`);
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

/**
 * Delta placeholder: id + type + execution status + description. No
 * properties, no result body. The point is to keep the dataflow's shape
 * visible without re-reading unchanged definitions; including the summary
 * gives the LLM a semantic anchor for each placeholder so it can still
 * reason about what the op does.
 */
function serializeOperatorPlaceholder(op: OperatorPredicate, snapshot: SnapshotData): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const status = info ? (info.error ? "failed" : "executed") : "not-executed";
  return [
    `### Operator \`${op.operatorID}\` (${op.operatorType}, ${status}, unchanged)`,
    `Summary: ${op.customDisplayName || op.operatorID}`,
  ].join("\n");
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

function appendLinkLines(lines: string[], sortedOps: OperatorPredicate[], allLinks: WorkflowContent["links"]): void {
  if (allLinks.length === 0) return;
  const opOrder = new Map(sortedOps.map((op, i) => [op.operatorID, i]));
  const sortedLinks = [...allLinks].sort((a, b) => {
    const srcA = opOrder.get(a.source.operatorID) ?? 0;
    const srcB = opOrder.get(b.source.operatorID) ?? 0;
    if (srcA !== srcB) return srcA - srcB;
    return (opOrder.get(a.target.operatorID) ?? 0) - (opOrder.get(b.target.operatorID) ?? 0);
  });
  lines.push("## Links");
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
