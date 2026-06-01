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
import { levelsToFlags, runOperatorDecorators } from "../context/decorate/registry";
import type { DecorateLevel } from "../context/decorate/types";
import type { OperatorDecorateCtx } from "../context/decorate/decorator";
import { formatLoaderHint } from "../context/decorate/flow/loader-remediation";
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
  /** When true (the default), each operator's `operatorProperties` render as
   *  a `Properties:` line in the snapshot, EXCEPT the Python code operators
   *  in `CODE_OPERATOR_TYPES` (their `code` is large and already surfaced on
   *  error, so it is always stripped). When false, no properties render at
   *  all (legacy paper-§4.3 strip-everything behavior). Undefined ⇒ true. */
  includeOperatorProperties?: boolean;
  /** When true, a compact `Schema:` line (col + type, all columns) precedes
   *  each non-error operator result, derived from `columnStats`/headers.
   *  Off by default. Intended as a cheaper substitute for `statsEnabled`. */
  schemaInResult?: boolean;
  /** When true, a load-stage operator (`DataLoading`) that errored gets a
   *  compact `Loader hint:` remediation line appended to its Result, keyed on
   *  the exception class parsed from the error string. Off by default. */
  loaderHint?: boolean;
  /** When true, append a `Format hints:` line flagging string columns whose
   *  sample values look like currency/percent/thousands-separated/etc., with the
   *  cleaning to apply before numeric conversion. Targets silent coercion
   *  dataloss. Off by default. */
  valueFormatFlags?: boolean;
  /** When true, each operator result gets a `Lineage:` line: input→output row
   *  counts (kept %) plus a conservative alarm on empty-output / fan-out
   *  explosion. Derived from carried row counts; targets silent-cardinality
   *  wrong-answers and the cost spiral tail. Off by default. */
  lineageStats?: boolean;
  /** #28: on an errored (non-loader) operator, render its direct upstream inputs'
   *  schema + a few sample rows so the model fixes against real consumed data,
   *  not guessed columns. Render-time only. Default false. */
  lineageErrorContext?: boolean;
  /** When true, surface a `Join check ⚠` line for any degenerate merge the
   *  worker flagged (near-zero key match with an unmatched-key sample, or a
   *  many-to-many fan-out). Read from the reserved `__join_telemetry__` entry on
   *  columnStats. Alarm-only. Off by default. */
  joinTelemetry?: boolean;
  /** When true, a `DataLoading` operator whose output reaches NO downstream
   *  operator (a dead/forgotten load — pure typed-DAG reachability) gets a
   *  `Graph check ⚠` line telling the agent to wire it in or drop it. Current
   *  snapshot only. Uniquely enabled by the dataflow graph (a free-form script
   *  has no graph to audit). Off by default. */
  graphAudit?: boolean;
  /** When true, surface a coercion-dataloss line for any to_numeric/to_datetime
   *  (errors="coerce") the worker saw silently null a material block of values,
   *  with a sample of the dropped values. Read from `__coercion_telemetry__` on
   *  columnStats. Alarm-only. Off by default. */
  coercionTelemetry?: boolean;
  /** W1: cap the per-operator TSV sample to first+last N rows (true row count).
   *  0/undefined = no cap. */
  maxResultRows?: number;
  /** W4: render a compact per-column stats block (numeric null/min/max;
   *  categorical distinct/top-5) — high-signal subset of columnStats. Off by default. */
  compactStats?: boolean;
  /** #25/#26/#27: surface a `Data hints:` block of pre-emptive STRUCTURAL hints
   *  (grain/key, low-cardinality partition/gate columns, empty rows/cols + dups)
   *  computed name-agnostically by the worker. Render-time only. Default false. */
  tableStructureHint?: boolean;
  /** #30 frontier-render: 0=off (render all ops full); N>0 = render only ops within N hops of a sink in full, stub the rest to schema-line. */
  frontierDepth?: number;
  /** W3: in LATEST mode (which otherwise shows only a snapshot, no events),
   *  render a compact `# Recent steps` construction timeline — the last K
   *  create/modify/delete actions with their ok/ERROR status — so the model
   *  knows the trajectory it took. Off by default. */
  lineageTimeline?: boolean;
  /** Internal (computed in assembleContext, not a setting): the rendered recent
   *  construction timeline, fed to the LATEST renderer. */
  recentTimeline?: string;
  /** W2: few-shot best-practices prompt toggle. Not used by the assembler (it
   *  affects the SYSTEM prompt, applied in TexeraAgent.rebuildSystemPrompt) —
   *  declared here only so the settings pass-through type-checks. */
  fewShotPrompt?: boolean;
  /** When true, an operator edited >= the reflection threshold times gets an
   *  `Attempt reflection:` block on the current snapshot (edit count + latest
   *  symptom + current code, otherwise stripped in CODE mode + a change-strategy
   *  directive). Targets same-operator thrashing. Off by default. */
  attemptReflection?: boolean;
  /** Internal (computed in assembleContext, NOT a setting): per-operatorId count
   *  of `createOrModifyOperator` calls across the visible trajectory. Feeds the
   *  attempt-reflection render — LATEST shows no history, so it's reconstructed
   *  from `visibleSteps`. */
  editCountsByOp?: Map<string, number>;
  /** DECORATE ordinal levels (claude/CONTEXT-DESIGN.md §5). When set (>=0), the
   *  flow/data facet level expands — via the rung catalog (context/decorate/
   *  registry.levelsToFlags) — into the individual render flags above, OR-ing
   *  them on. This is the new ordinal knob replacing the per-lever booleans;
   *  the booleans remain valid and any explicitly-set boolean is preserved
   *  (the level only turns rungs ON, never off). Undefined ⇒ legacy boolean
   *  behavior, no expansion. */
  flowLevel?: number;
  dataLevel?: number;
}

/**
 * Python code operators whose `operatorProperties` (chiefly the `code` blob)
 * are always stripped from the assembled context: their source is large and
 * already surfaced inline on error, so echoing it in every snapshot is pure
 * token cost. All other operator types render their properties when
 * `includeOperatorProperties` is on.
 */
const CODE_OPERATOR_TYPES = new Set(["PythonUDFV2", "DataLoading", "DataProcessing"]);

/**
 * plan3 — minimum cumulative edits to one operator before an `Attempt
 * reflection:` block is injected. 3 aligns with the prompt rule "change strategy
 * after 2 attempts" (reflect on the 3rd+). A general default, not eval-fit.
 */
const ATTEMPT_REFLECTION_THRESHOLD = 3;

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
 * Snapshot trimming (paper §4.3): the Python code operators'
 * (`CODE_OPERATOR_TYPES`) computation function (`code`) is always dropped —
 * the user's `OperatorInfo` result already carries the source code on error,
 * so dropping it doesn't hide what's needed to debug. All other operators
 * render their `operatorProperties` as a `Properties:` line when
 * `options.includeOperatorProperties` is on (the default); set it false to
 * restore the legacy strip-everything behavior.
 */
export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  mode: ContextMode,
  options: AssembleContextOptions
): ModelMessage[] {
  // DECORATE levels → render flags (claude/CONTEXT-DESIGN.md §5). When the
  // caller supplies ordinal facet levels, expand them through the rung catalog
  // and OR the resulting rung flags onto `options`. Levels only turn rungs ON;
  // an explicitly-set boolean is never cleared. Undefined levels ⇒ no-op, so
  // existing boolean-only callers are unaffected.
  if (options.flowLevel !== undefined || options.dataLevel !== undefined) {
    const clamp = (n: number | undefined): DecorateLevel =>
      (Math.max(0, Math.min(3, Math.floor(n ?? 0))) as DecorateLevel);
    const expanded = levelsToFlags(clamp(options.flowLevel), clamp(options.dataLevel));
    const bag = options as unknown as Record<string, unknown>;
    for (const flag of Object.keys(expanded)) {
      bag[flag] = true;
    }
  }

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
  // plan3: per-operator cumulative edit counts from the trajectory, for the
  // attempt-reflection render. LATEST mode shows no history, so reconstruct
  // from visibleSteps here. Stash on options so the per-operator serializer
  // (which doesn't see the path) can read it.
  options.editCountsByOp = buildEditCountsByOp(path);
  // W3: compact construction timeline for LATEST mode (rendered only when the
  // lineageTimeline flag is on). Cheap to compute; gated at render time.
  options.recentTimeline = buildTimeline(path);

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
 * Per-operatorId cumulative count of `createOrModifyOperator` calls across the
 * visible trajectory (plan3). A high count signals same-operator thrashing —
 * the agent re-deriving variants because CODE mode strips its prior code. Used
 * by the attempt-reflection render. Counts every well-formed edit (create seeds
 * the count at 1); not decremented on delete (total churn is what matters).
 */
function buildEditCountsByOp(fullPath: PathNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of fullPath) {
    if (node.step.role !== "agent" || !node.step.toolCalls) continue;
    for (const tc of node.step.toolCalls) {
      if (tc.toolName !== "createOrModifyOperator") continue;
      const opId = (tc.input as Record<string, unknown> | undefined)?.operatorId;
      if (typeof opId === "string" && opId) counts.set(opId, (counts.get(opId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * W3 — compact construction timeline. LATEST mode renders only the current
 * snapshot (no events), so the model can't see the trajectory it took. This
 * walks the path's operator edits in order and renders the last K as
 * `created/modified/deleted \`op\` → ok|ERROR: …`, so the model sees what it
 * already tried (cheaply — one short line per event, not full FULL-mode
 * snapshots). Returns undefined when there are no edits yet.
 */
function buildTimeline(fullPath: PathNode[], maxEvents = 14): string | undefined {
  const events: string[] = [];
  const known = new Set<string>();
  for (const node of fullPath) {
    if (node.step.role !== "agent" || !node.step.toolCalls) continue;
    const trs = node.step.toolResults ?? [];
    node.step.toolCalls.forEach((tc, i) => {
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
      if (!opId) return;
      let verb: string;
      if (tc.toolName === "createOrModifyOperator") {
        verb = known.has(opId) ? "modified" : "created";
        known.add(opId);
      } else if (tc.toolName === "deleteOperator") {
        verb = "deleted";
        known.delete(opId);
      } else return;
      const out = trs[i]?.output;
      const txt = typeof out === "string" ? out : out ? JSON.stringify(out) : "";
      const errM = /\[ERROR\][^\n]*/.exec(txt);
      const status = errM ? `ERROR ${errM[0].replace("[ERROR]", "").trim().slice(0, 80)}` : "ok";
      events.push(`${verb} \`${escapeQuotes(opId)}\` → ${status}`);
    });
  }
  if (events.length === 0) return undefined;
  const shown = events.slice(-maxEvents);
  const omitted = events.length - shown.length;
  const lines = shown.map((e, i) => `${omitted + i + 1}. ${e}`);
  return (omitted > 0 ? `(… ${omitted} earlier steps …)\n` : "") + lines.join("\n");
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

  // 1b. W3: # Recent steps — the construction timeline (LATEST otherwise shows
  //     no events). Gated by the lineageTimeline flag.
  if (options.lineageTimeline && options.recentTimeline) {
    sections.push("# Recent steps (your construction trajectory so far)");
    sections.push("");
    sections.push(options.recentTimeline);
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

/**
 * Stage-aware loader-remediation hint (plan4, goal.md lever D / Direction-1).
 * Maps the exception CLASS parsed from a load-stage operator's error string to
 * a compact, GENERAL pandas remediation directive. Keyed only on the exception
 * class — never a task/column/domain/answer literal — so it generalizes from
 * the (stage=DataLoading, error-class) structure alone. Returns `undefined`
 * for classes that aren't a known load-failure mode (then no hint renders).
 *
 * Motivation (baseline traces): the agent already SEES the `[ERROR]` block with
 * its own code, yet loops without fixing it (e.g. legal-hard-18 retried 8 steps
 * on a `0x93` byte that is plainly Windows-1252). The missing ingredient is
 * remediation knowledge, not visibility — so we inject the fix pattern once,
 * localized to the failing loader operator.
 */
// `formatLoaderHint` now lives in context/decorate/flow/loader-remediation and
// is re-exported here for back-compat with any existing importers.
export { formatLoaderHint } from "../context/decorate/flow/loader-remediation";

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
  // #30 frontier-render: when frontierDepth>0, only operators within that many
  // hops of a sink render in full; the rest are "stubbed" to schema-line only.
  // Recomputed per render (small DAGs); 0/undefined = render all in full (no-op).
  const frontierStub =
    (options.frontierDepth ?? 0) > 0 &&
    !workflowState.getFrontierOperators(options.frontierDepth as number).includes(op.operatorID);
  const execText = info
    ? formatOperatorResult(op.operatorID, info, workflowState, {
        statsEnabled: options.statsEnabled,
        schemaInResult: options.schemaInResult,
        valueFormatFlags: options.valueFormatFlags,
        lineageStats: options.lineageStats,
        joinTelemetry: options.joinTelemetry,
        coercionTelemetry: options.coercionTelemetry,
        maxResultRows: options.maxResultRows,
        compactStats: options.compactStats,
        tableStructureHint: options.tableStructureHint,
        frontierStub,
      })
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
  // Context + flag predicate for the operator-attached DECORATE rungs (migrated
  // out of inline gates into context/decorate/flow/*). `isFlagEnabled` reads the
  // resolved options so the registry stays decoupled from AssembleContextOptions.
  const decorateCtx: OperatorDecorateCtx = {
    op,
    snapshot,
    workflowState,
    allLinks,
    info,
    isCurrent,
    editCount: options.editCountsByOp?.get(op.operatorID) ?? 0,
  };
  const isFlagEnabled = (flag: string): boolean =>
    (options as unknown as Record<string, unknown>)[flag] === true;

  const opHash = "#".repeat(operatorLevel);
  const lines: string[] = [];
  lines.push(`${opHash} Operator \`${op.operatorID}\` (${op.operatorType})`);
  lines.push(`Summary: ${op.customDisplayName || op.operatorID}`);

  // Operator properties (config). Rendered for every operator except the
  // Python code operators (whose `code` is stripped — see CODE_OPERATOR_TYPES)
  // and only when the toggle is on (default) and there is at least one
  // property to show. Empty-property operators render nothing.
  const includeProps = options.includeOperatorProperties !== false;
  if (
    includeProps &&
    !CODE_OPERATOR_TYPES.has(op.operatorType) &&
    op.operatorProperties &&
    Object.keys(op.operatorProperties).length > 0
  ) {
    lines.push(`Properties: ${JSON.stringify(op.operatorProperties)}`);
  }

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
    // In-result DECORATE rungs (loader-remediation flow-L2, lineage error-context
    // flow-L2). Migrated out of inline gates into context/decorate/flow/*; the
    // registry runs each enabled rung whose `applies` is true, in render order.
    for (const l of runOperatorDecorators("in-result", decorateCtx, isFlagEnabled)) {
      lines.push("  " + l);
    }
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

  // Post-block DECORATE rungs (graph-audit flow-L3). Migrated out of the inline
  // gate into context/decorate/flow/graph-audit.
  for (const l of runOperatorDecorators("post-block", decorateCtx, isFlagEnabled)) {
    lines.push(l);
  }

  // plan3: attempt reflection. On the CURRENT snapshot, when this operator has
  // been edited >= the threshold, surface its attempt history so the agent
  // stops re-deriving blind variants (the 38-edit thrash pattern). The current
  // code is otherwise stripped in CODE mode; an [ERROR] block already carries
  // it, so only re-add code when there's no error (avoid duplication).
  if (options.attemptReflection && isCurrent) {
    const editCount = options.editCountsByOp?.get(op.operatorID) ?? 0;
    if (editCount >= ATTEMPT_REFLECTION_THRESHOLD) {
      lines.push(
        `Attempt reflection: you have edited operator \`${op.operatorID}\` ${editCount} times; ` +
          `${editCount - 1} prior variant(s) did not converge.`
      );
      if (info?.error) {
        lines.push(`Latest result: [ERROR] ${info.error.split("\n")[0].slice(0, 200)}`);
      } else if (info) {
        lines.push("Latest result: produced output but the task is not yet solved.");
      }
      lines.push(
        "Do NOT submit another near-variant. Change strategy: inspect this operator's UPSTREAM " +
          "result/columns for a wrong assumption, try a DIFFERENT decomposition, or build the answer " +
          "from a different operator."
      );
      if (!info?.error) {
        const code = String((op.operatorProperties as Record<string, unknown> | undefined)?.code ?? "").trim();
        if (code) {
          lines.push("Current code:");
          for (const l of code.split("\n")) lines.push("  " + l);
        }
      }
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

// `buildLineageErrorContext` (#28) now lives in context/decorate/flow/error-context.

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
