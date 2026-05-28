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
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, OperatorPortSchemaMap, PortSchema, WorkflowContent } from "../../types/workflow";
import type { ReActStep } from "../../types/agent";
import { AgentMode, ContextMode, OperatorContextScope, OperatorResultRendering } from "../../types/agent";
import type { WorkflowCompilationResponse, WorkflowFatalError } from "../../api/compile-api";
import type { SnapshotData, WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { OperatorInfo } from "../../types/execution";
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
  /** Successful result rendering policy. Defaults to row previews. */
  resultRendering?: OperatorResultRendering;
  /** Operator detail scope inside the current snapshot. Defaults to the
   *  whole DAG. `active-lineage` only affects LATEST mode when a frontier can
   *  be inferred from snapshot/event provenance. */
  contextScope?: OperatorContextScope;
  /** When true (the default), each operator's `operatorProperties` render as
   *  a `Properties:` line in the snapshot, EXCEPT the Python code operators
   *  in `CODE_OPERATOR_TYPES` (their `code` is large and already surfaced on
   *  error, so it is always stripped). When false, no properties render at
   *  all (legacy paper-§4.3 strip-everything behavior). Undefined ⇒ true. */
  includeOperatorProperties?: boolean;
  /** One-shot harness guidance that should survive even in LATEST mode,
   *  which intentionally omits the event/tool-result history. */
  contextNotices?: string[];
  /** Repeat compact final-metric/provenance guidance in assembled context.
   *  This keeps the rule visible in LATEST mode without relying only on the
   *  system prompt. */
  metricEvidenceGuidance?: boolean;
  /** Render current-snapshot compiler schemas in CODE mode as well as
   *  GENERAL mode. */
  schemaFirstCodeMode?: boolean;
  /** Render compact DataLoading structure hints when the successful output
   *  looks like a semi-structured file rather than one clean rectangular
   *  table. Off by default. */
  tableStructureHints?: boolean;
  /** Render compact raw-source provenance for DataLoading operators that read
   *  literal relative file paths. Off by default. */
  rawLoaderProvenance?: boolean;
  /** Render compact fallback-contract hints next to dependency/runtime
   *  capability failures. Off by default. */
  fallbackContractGuidance?: boolean;
  /** Render compact cardinality-pressure hints next to large/wide successful
   *  intermediate results. Off by default. */
  cardinalityPressureGuidance?: boolean;
  /** Render compact key-hygiene hints next to high-cardinality string columns
   *  that may become grouping/joining/deduplication/distinct-count keys. Off
   *  by default. */
  entityKeyHygieneGuidance?: boolean;
  /** Render compact component-grain hints next to high-cardinality string
   *  labels whose values may encode sub-entity or sampling-location
   *  components. Off by default. */
  componentGrainGuidance?: boolean;
}

/**
 * Python code operators whose `operatorProperties` (chiefly the `code` blob)
 * are always stripped from the assembled context: their source is large and
 * already surfaced inline on error, so echoing it in every snapshot is pure
 * token cost. All other operator types render their properties when
 * `includeOperatorProperties` is on.
 */
const CODE_OPERATOR_TYPES = new Set(["PythonUDFV2", "DataLoading", "DataProcessing"]);

const METRIC_EVIDENCE_CONTEXT_NOTICE = [
  "Metric evidence: for rate/share/percentage/fraction/ratio/concentration or any superlative over a derived metric,",
  "the final operator must return candidate/group, numerator, denominator, metric value, and provenance columns,",
  "then sort/filter by the metric. A raw count alone is not a valid final selection for a derived metric.",
  "If a loader reads a wildcard or multiple sources, add source_path/source_file provenance columns before concatenation",
  "and prefer preserved provenance over reparsing display labels.",
].join(" ");

const FALLBACK_CONTRACT_CONTEXT_NOTICE = [
  "Fallback contract: dependency, package, API, or runtime-capability failures do not permit a looser proxy final answer.",
  "Use an exact equivalent with validation evidence, or return a diagnostic DataFrame with semantic_contract_preserved=false.",
].join(" ");

const CARDINALITY_PRESSURE_CONTEXT_NOTICE = [
  "Cardinality pressure: large or wide intermediate tables are dataflow evidence for execution risk.",
  "Before expensive row-wise calls, all-pairs joins, simulations, or full-table loops, reduce to the task-required row grain or add a bounded probe with row-count evidence.",
].join(" ");

const ENTITY_KEY_HYGIENE_CONTEXT_NOTICE = [
  "Entity-key hygiene: high-cardinality string columns may carry label variants.",
  "Before grouping, joining, deduplicating, or counting distinct entities on raw labels, add compact evidence for raw vs normalized keys and variant/collision checks.",
].join(" ");

const COMPONENT_GRAIN_CONTEXT_NOTICE = [
  "Component grain: high-cardinality string labels may combine base entities with sub-entities, sampling locations, suffixes, prefixes, or other components.",
  "Before entity-level grouping or distinct counts, compare whole-label keys with component-derived candidate keys using compact DataFrame evidence.",
].join(" ");

const LARGE_ROW_COUNT_THRESHOLD = 100_000;
const WIDE_COLUMN_COUNT_THRESHOLD = 100;
const ENTITY_KEY_MIN_DISTINCT = 20;
const ENTITY_KEY_MAX_HINT_COLUMNS = 4;
const COMPONENT_GRAIN_MIN_DISTINCT = 20;
const COMPONENT_GRAIN_MAX_HINT_COLUMNS = 4;
const COMPONENT_GRAIN_MAX_SAMPLES = 4;

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
      const leafSnapshot = lastSnapshotOfPath(path) ?? initSnapshot ?? snapshotStorage.getRootSnapshot();
      content = renderLatest(workflowState, options, latestUserContent, leafSnapshot, path);
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
  appendContextNotices(sections, options);

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
  leafSnapshot: SnapshotData,
  path: PathNode[]
): string {
  const sections: string[] = [];

  // 1. # User Task
  if (latestUserContent) {
    sections.push("# User Task");
    sections.push("");
    sections.push(latestUserContent);
    sections.push("");
  }
  appendContextNotices(sections, options);

  // 2. # Current Dataflow — the leaf snapshot of the path. Latest mode
  //    is defined as a single point on the snapshot tree, so no events
  //    are rendered above this.
  const focusOperatorIds = computeLatestFocusOperatorIds(path, leafSnapshot);
  const scopedOperatorIds = computeLatestScopedOperatorIds(leafSnapshot.workflow, focusOperatorIds, options);
  const dag = serializeSnapshotFull(
    leafSnapshot,
    workflowState,
    options,
    /*isCurrent=*/ true,
    /*sectionLevel=*/ 2,
    focusOperatorIds,
    scopedOperatorIds
  );
  if (dag) {
    sections.push("# Current Dataflow");
    sections.push(dag);
  }
  return sections.join("\n").trimEnd();
}

function appendContextNotices(sections: string[], options: AssembleContextOptions): void {
  const notices = [
    ...(options.metricEvidenceGuidance ? [METRIC_EVIDENCE_CONTEXT_NOTICE] : []),
    ...(options.fallbackContractGuidance ? [FALLBACK_CONTRACT_CONTEXT_NOTICE] : []),
    ...(options.cardinalityPressureGuidance ? [CARDINALITY_PRESSURE_CONTEXT_NOTICE] : []),
    ...(options.entityKeyHygieneGuidance ? [ENTITY_KEY_HYGIENE_CONTEXT_NOTICE] : []),
    ...(options.componentGrainGuidance ? [COMPONENT_GRAIN_CONTEXT_NOTICE] : []),
    ...(options.contextNotices ?? []),
  ]
    .map(n => n.trim())
    .filter(n => n.length > 0);
  if (notices.length === 0) return;
  sections.push("# Agent Guidance");
  sections.push("");
  for (const notice of notices) {
    const lines = notice.split("\n");
    sections.push(`- ${lines[0]}`);
    for (const line of lines.slice(1)) sections.push(`  ${line}`);
  }
  sections.push("");
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
function serializeTurn(node: PathNode, createFlags: Map<string, boolean> | undefined): string {
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
  sectionLevel: number,
  focusOperatorIds?: Set<string>,
  scopedOperatorIds?: Set<string>
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
    const isOutOfScope = scopedOperatorIds !== undefined && !scopedOperatorIds.has(op.operatorID);
    lines.push(
      isOutOfScope
        ? serializeOperatorContextDigest(op, snapshot, allLinks, operatorLevel, options)
        : serializeOperatorFull(
            op,
            snapshot,
            workflowState,
            options,
            isCurrent,
            allLinks,
            operatorLevel,
            focusOperatorIds
          )
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
  allLinks: WorkflowContent["links"],
  operatorLevel: number,
  focusOperatorIds?: Set<string>
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const renderDigest = shouldRenderResultDigest(op.operatorID, info, options, isCurrent, focusOperatorIds);
  const execText = info
    ? formatOperatorResult(op.operatorID, info, workflowState, {
        statsEnabled: options.statsEnabled,
        includeRows: !renderDigest,
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

  // Schemas only on the current (last) snapshot. GENERAL mode preserves its
  // legacy dependency on compiler output, while CODE mode's explicit
  // schema-first flag can still fall back to executed result metadata when
  // the compiler reports empty schemas for Python operators.
  const showSchemas =
    isCurrent &&
    ((options.agentMode === AgentMode.GENERAL && options.compilationResult) ||
      (options.agentMode === AgentMode.CODE && options.schemaFirstCodeMode === true));
  if (showSchemas) {
    const outputSchemas = options.compilationResult?.operatorOutputSchemas ?? {};
    const allLinks = snapshot.workflow.links;
    const compiledInputSchemaMap = extractOperatorInputPortSchemaMap(op.operatorID, op, outputSchemas, allLinks);
    const resultInputSchemaMap = deriveInputSchemaMapFromResults(op, snapshot, allLinks);
    const inputSchemaMap = mergeSchemaMaps(compiledInputSchemaMap, resultInputSchemaMap);
    if (inputSchemaMap) {
      for (const [portId, schema] of Object.entries(inputSchemaMap)) {
        if (isNonEmptySchema(schema)) {
          lines.push(`Input Schema (port ${parsePortIndex(portId)}): ${formatSchema(schema)}`);
        }
      }
    }
    const outputSchemaMap = outputSchemas[op.operatorID];
    const outputSchema = firstNonEmptySchema(outputSchemaMap) ?? schemaFromOperatorInfo(info);
    if (isNonEmptySchema(outputSchema)) lines.push(`Output Schema: ${formatSchema(outputSchema)}`);

    const compilationError = options.compilationResult?.operatorErrors?.[op.operatorID] as
      | WorkflowFatalError
      | undefined;
    if (compilationError) lines.push(`Compilation Error: ${compilationError.message}`);
  }

  const tableStructureHint = options.tableStructureHints ? buildTableStructureHint(op, info) : undefined;
  if (tableStructureHint) {
    lines.push("Table Structure Hint:");
    for (const l of tableStructureHint.split("\n")) lines.push("  " + l);
  }

  const rawLoaderProvenance = options.rawLoaderProvenance ? buildRawLoaderProvenance(op, info) : undefined;
  if (rawLoaderProvenance) {
    lines.push("Raw Loader Provenance:");
    for (const l of rawLoaderProvenance.split("\n")) lines.push("  " + l);
  }

  const cardinalityPressureHint = options.cardinalityPressureGuidance ? buildCardinalityPressureHint(info) : undefined;
  if (cardinalityPressureHint) {
    lines.push("Cardinality Pressure Hint:");
    for (const l of cardinalityPressureHint.split("\n")) lines.push("  " + l);
  }

  const entityKeyHygieneHint = options.entityKeyHygieneGuidance ? buildEntityKeyHygieneHint(info) : undefined;
  if (entityKeyHygieneHint) {
    lines.push("Entity Key Hygiene Hint:");
    for (const l of entityKeyHygieneHint.split("\n")) lines.push("  " + l);
  }

  const componentGrainHint = options.componentGrainGuidance ? buildComponentGrainHint(info) : undefined;
  if (componentGrainHint) {
    lines.push("Component Grain Hint:");
    for (const l of componentGrainHint.split("\n")) lines.push("  " + l);
  }

  const fallbackContractHint = options.fallbackContractGuidance ? buildFallbackContractHint(info) : undefined;
  if (fallbackContractHint) {
    lines.push("Fallback Contract Hint:");
    for (const l of fallbackContractHint.split("\n")) lines.push("  " + l);
  }

  if (execText) {
    lines.push(renderDigest ? "Result Digest:" : "Result:");
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
      lines.push(`Result: (skipped — upstream ${noun} ${list} errored; see [ERROR] above)`);
    }
  }
  return lines.join("\n");
}

function shouldRenderResultDigest(
  operatorId: string,
  info: OperatorInfo | undefined,
  options: AssembleContextOptions,
  isCurrent: boolean,
  focusOperatorIds: Set<string> | undefined
): boolean {
  if (!info || info.error) return false;
  const mode = options.resultRendering ?? OperatorResultRendering.ROWS;
  if (mode === OperatorResultRendering.DIGEST) return true;
  if (mode !== OperatorResultRendering.ADAPTIVE) return false;
  if (!isCurrent || !focusOperatorIds || focusOperatorIds.size === 0) return false;
  return !focusOperatorIds.has(operatorId);
}

function computeLatestFocusOperatorIds(path: PathNode[], leafSnapshot: SnapshotData): Set<string> | undefined {
  if (!leafSnapshot.reactStepId) return undefined;

  const focus = new Set<string>();
  const ownerNode = path.find(node => node.step.id === leafSnapshot.reactStepId);
  for (const tc of ownerNode?.step.toolCalls ?? []) {
    const input = (tc.input ?? {}) as Record<string, unknown>;
    const opId = typeof input.operatorId === "string" ? input.operatorId : "";
    if (opId.length > 0) focus.add(opId);
  }

  for (const [opId, entry] of leafSnapshot.results) {
    if (entry.sourceStepId === leafSnapshot.reactStepId) focus.add(opId);
  }

  return focus.size > 0 ? focus : undefined;
}

function computeLatestScopedOperatorIds(
  workflow: WorkflowContent,
  focusOperatorIds: Set<string> | undefined,
  options: AssembleContextOptions
): Set<string> | undefined {
  const scope = options.contextScope ?? OperatorContextScope.ALL;
  if (scope !== OperatorContextScope.ACTIVE_LINEAGE) return undefined;
  if (!focusOperatorIds || focusOperatorIds.size === 0) return undefined;

  const operatorIds = new Set(workflow.operators.map(op => op.operatorID));
  const scoped = new Set<string>();
  const queue: string[] = [];
  for (const opId of focusOperatorIds) {
    if (!operatorIds.has(opId)) continue;
    scoped.add(opId);
    queue.push(opId);
  }
  if (queue.length === 0) return undefined;

  const childToParents = new Map<string, string[]>();
  for (const link of workflow.links) {
    const parents = childToParents.get(link.target.operatorID) ?? [];
    parents.push(link.source.operatorID);
    childToParents.set(link.target.operatorID, parents);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of childToParents.get(current) ?? []) {
      if (!operatorIds.has(parent) || scoped.has(parent)) continue;
      scoped.add(parent);
      queue.push(parent);
    }
  }

  return scoped;
}

function serializeOperatorContextDigest(
  op: OperatorPredicate,
  snapshot: SnapshotData,
  allLinks: WorkflowContent["links"],
  operatorLevel: number,
  options: AssembleContextOptions
): string {
  const info = snapshot.results.get(op.operatorID)?.info;
  const opHash = "#".repeat(operatorLevel);
  const lines: string[] = [];
  lines.push(`${opHash} Operator \`${op.operatorID}\` (${op.operatorType})`);
  lines.push(`Summary: ${op.customDisplayName || op.operatorID}`);
  lines.push("Context Scope: outside active lineage; details compressed.");

  if (!info) {
    const failedUpstreams = collectFailedUpstreamRoots(op.operatorID, snapshot, allLinks);
    if (failedUpstreams.length > 0) {
      const noun = failedUpstreams.length === 1 ? "operator" : "operators";
      const list = failedUpstreams.map(id => `\`${id}\``).join(", ");
      lines.push(`Result Digest: skipped; upstream ${noun} ${list} errored.`);
    } else {
      lines.push("Result Digest: no execution result visible.");
    }
    return lines.join("\n");
  }

  if (info.error) {
    lines.push(`Result Digest: ERROR ${shortenDigestText(info.error, 220)}`);
    const fallbackContractHint = options.fallbackContractGuidance ? buildFallbackContractHint(info) : undefined;
    if (fallbackContractHint) {
      lines.push("Fallback Contract Hint:");
      for (const l of fallbackContractHint.split("\n")) lines.push("  " + l);
    }
    return lines.join("\n");
  }

  const columns = inferRenderableColumns(info);
  const rowCount = info.totalRowCount ?? info.outputTuples ?? "unknown";
  const columnCount = columns.length > 0 ? columns.length : "unknown";
  const columnText = columns.length > 0 ? `; columns=${formatValueList(columns, 12)}` : "";
  lines.push(`Result Digest: Completed; output shape=(${rowCount}, ${columnCount})${columnText}`);
  const cardinalityPressureHint = options.cardinalityPressureGuidance ? buildCardinalityPressureHint(info) : undefined;
  if (cardinalityPressureHint) {
    lines.push("Cardinality Pressure Hint:");
    for (const l of cardinalityPressureHint.split("\n")) lines.push("  " + l);
  }
  const entityKeyHygieneHint = options.entityKeyHygieneGuidance ? buildEntityKeyHygieneHint(info) : undefined;
  if (entityKeyHygieneHint) {
    lines.push("Entity Key Hygiene Hint:");
    for (const l of entityKeyHygieneHint.split("\n")) lines.push("  " + l);
  }
  const componentGrainHint = options.componentGrainGuidance ? buildComponentGrainHint(info) : undefined;
  if (componentGrainHint) {
    lines.push("Component Grain Hint:");
    for (const l of componentGrainHint.split("\n")) lines.push("  " + l);
  }
  return lines.join("\n");
}

function shortenDigestText(value: string, maxChars: number): string {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars - 3) + "...";
}

function buildFallbackContractHint(info: OperatorInfo | undefined): string | undefined {
  if (!info?.error) return undefined;
  const error = info.error;
  const signals = detectRuntimeCapabilitySignals(error);
  if (signals.length === 0) return undefined;

  const lines = [`Detected runtime-capability failure: ${signals.join(", ")}.`];
  lines.push("Do not answer from an approximation, proxy, heuristic, fitted surrogate, or partial substitute.");
  lines.push(
    "Next action: implement an exact equivalent with validation evidence, or return a diagnostic DataFrame with missing_capability, blocked_operation, alternatives_checked, semantic_contract_preserved=false, and affected_rows."
  );
  return lines.join("\n");
}

function detectRuntimeCapabilitySignals(error: string): string[] {
  const text = error.toLowerCase();
  const signals: string[] = [];

  if (
    text.includes("modulenotfounderror") ||
    text.includes("importerror") ||
    text.includes("no module named") ||
    text.includes("cannot import name")
  ) {
    signals.push("import unavailable");
  }
  if (
    text.includes("pip install") ||
    text.includes("calledprocesserror") ||
    text.includes("returned non-zero exit status") ||
    text.includes("could not find a version") ||
    text.includes("failed building wheel")
  ) {
    signals.push("package install failed");
  }
  if (
    text.includes("api/library call") ||
    text.includes("not implemented") ||
    text.includes("unsupported") ||
    text.includes("command not found") ||
    text.includes("permission denied")
  ) {
    signals.push("runtime capability unavailable");
  }

  return Array.from(new Set(signals));
}

function buildCardinalityPressureHint(info: OperatorInfo | undefined): string | undefined {
  if (!info || info.error) return undefined;

  const rowCount = info.totalRowCount ?? info.outputTuples;
  const columns = inferRenderableColumns(info);
  const columnCount = columns.length;
  const signals: string[] = [];

  if (Number.isFinite(rowCount) && rowCount >= LARGE_ROW_COUNT_THRESHOLD) {
    signals.push(`high row count=${rowCount}`);
  }
  if (columnCount >= WIDE_COLUMN_COUNT_THRESHOLD) {
    signals.push(`wide table columns=${columnCount}`);
  }
  if (signals.length === 0) return undefined;

  const lines = [`Detected large intermediate result: ${signals.join(", ")}.`];
  lines.push(
    "Before adding downstream row-wise model/API/library calls, all-pairs joins, nested loops, simulations, or full-table transformations, narrow to the task-required row grain or create a bounded probe."
  );
  lines.push(
    "Next action should keep row-count evidence visible: upstream rows, filtered/probed rows, key/date/group coverage, and the condition that makes full execution necessary."
  );
  return lines.join("\n");
}

interface EntityKeyCandidate {
  columnName: string;
  distinct: number;
}

interface ComponentGrainCandidate {
  columnName: string;
  distinct: number;
  samples: string[];
  signals: string[];
}

function buildEntityKeyHygieneHint(info: OperatorInfo | undefined): string | undefined {
  if (!info || info.error) return undefined;

  const candidates = findEntityKeyCandidates(info);
  if (candidates.length === 0) return undefined;

  const rowCount = info.totalRowCount ?? info.outputTuples;
  const rowText = Number.isFinite(rowCount) ? ` over ${rowCount} rows` : "";
  const candidateText = candidates
    .slice(0, ENTITY_KEY_MAX_HINT_COLUMNS)
    .map(c => `${JSON.stringify(c.columnName)} distinct=${c.distinct}`)
    .join(", ");

  const lines = [`Detected high-cardinality string key candidates${rowText}: ${candidateText}.`];
  lines.push(
    "Before grouping, joining, deduplicating, or counting distinct entities on raw string labels, create compact key-hygiene evidence."
  );
  lines.push(
    "Evidence should include raw distinct count, normalized distinct count, null/blank counts, variant signals (case/whitespace/punctuation/delimiters), and sample collision groups if normalization merges labels."
  );
  lines.push(
    "Only apply normalization when the evidence shows raw labels are variants of the same entity; otherwise preserve raw keys and record why."
  );
  return lines.join("\n");
}

function findEntityKeyCandidates(info: OperatorInfo): EntityKeyCandidate[] {
  const rowCount = info.totalRowCount ?? info.outputTuples;
  const candidates: EntityKeyCandidate[] = [];

  for (const [columnName, stat] of Object.entries(info.columnStats ?? {})) {
    if (!isRenderableColumn(columnName) || !isStringColumnStat(stat)) continue;
    const distinct = parseColumnStatNumber(stat, "distinct");
    if (!Number.isFinite(distinct) || distinct < ENTITY_KEY_MIN_DISTINCT) continue;
    if (Number.isFinite(rowCount) && distinct > rowCount) continue;
    candidates.push({ columnName, distinct });
  }

  candidates.sort((a, b) => b.distinct - a.distinct || a.columnName.localeCompare(b.columnName));
  return candidates;
}

function buildComponentGrainHint(info: OperatorInfo | undefined): string | undefined {
  if (!info || info.error) return undefined;

  const candidates = findComponentGrainCandidates(info);
  if (candidates.length === 0) return undefined;

  const rowCount = info.totalRowCount ?? info.outputTuples;
  const rowText = Number.isFinite(rowCount) ? ` over ${rowCount} rows` : "";
  const candidateText = candidates
    .slice(0, COMPONENT_GRAIN_MAX_HINT_COLUMNS)
    .map(c => {
      const pieces = [`${JSON.stringify(c.columnName)} distinct=${c.distinct}`];
      if (c.signals.length > 0) pieces.push(`signals=${formatValueList(c.signals, 4)}`);
      if (c.samples.length > 0) pieces.push(`samples=${formatValueList(c.samples, COMPONENT_GRAIN_MAX_SAMPLES)}`);
      return pieces.join("; ");
    })
    .join(" | ");

  const lines = [
    `Detected high-cardinality label columns with possible component-grain risk${rowText}: ${candidateText}.`,
  ];
  lines.push(
    "Before entity-level grouping, joining, deduplication, or distinct counts, compare raw whole-label keys, normalized whole-label keys, and component-derived candidate keys."
  );
  lines.push(
    "Evidence should include distinct counts for each candidate grain, coverage/null/blank counts, number of labels changed or split, and sample groups where multiple raw labels map to one component key."
  );
  lines.push(
    "Use a coarser or finer component key only when the task grain and DataFrame evidence justify it; otherwise preserve whole labels and record why."
  );
  return lines.join("\n");
}

function findComponentGrainCandidates(info: OperatorInfo): ComponentGrainCandidate[] {
  const rowCount = info.totalRowCount ?? info.outputTuples;
  const candidates: ComponentGrainCandidate[] = [];

  for (const [columnName, stat] of Object.entries(info.columnStats ?? {})) {
    if (!isRenderableColumn(columnName) || !isStringColumnStat(stat)) continue;
    if (looksTemporalOrProvenanceColumn(columnName)) continue;
    const distinct = parseColumnStatNumber(stat, "distinct");
    if (!Number.isFinite(distinct) || distinct < COMPONENT_GRAIN_MIN_DISTINCT) continue;
    if (Number.isFinite(rowCount) && distinct > rowCount) continue;

    const samples = sampleStringValues(info, columnName, COMPONENT_GRAIN_MAX_SAMPLES);
    const signals = detectComponentGrainSignals(columnName, samples);
    if (signals.length === 0) continue;
    candidates.push({ columnName, distinct, samples, signals });
  }

  candidates.sort((a, b) => {
    const signalDelta = b.signals.length - a.signals.length;
    if (signalDelta !== 0) return signalDelta;
    return b.distinct - a.distinct || a.columnName.localeCompare(b.columnName);
  });
  return candidates;
}

function sampleStringValues(info: OperatorInfo, columnName: string, limit: number): string[] {
  const samples: string[] = [];
  const seen = new Set<string>();
  for (const row of info.result ?? []) {
    const value = row?.[columnName];
    if (typeof value !== "string") continue;
    const normalized = normalizeCell(value);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    samples.push(normalized);
    if (samples.length >= limit) break;
  }
  return samples;
}

function detectComponentGrainSignals(columnName: string, samples: string[]): string[] {
  const signals: string[] = [];
  if (looksEntityLabelColumn(columnName)) signals.push("entity-label column name");
  if (samples.some(value => /[@|;]/.test(value))) signals.push("symbol delimiter");
  if (samples.some(value => /\([^)]{1,80}\)/.test(value))) signals.push("parenthetical qualifier");
  if (samples.some(value => /\s[-–—]\s/.test(value))) signals.push("spaced dash delimiter");
  if (samples.some(value => /[\\/]/.test(value))) signals.push("slash/path delimiter");
  if (samples.some(value => /::|: /.test(value))) signals.push("colon delimiter");
  return Array.from(new Set(signals));
}

function looksEntityLabelColumn(columnName: string): boolean {
  const tokens = columnNameTokens(columnName);
  return tokens.some(token =>
    ["name", "label", "title", "entity", "identifier", "location", "place", "site", "station", "key", "id"].includes(
      token
    )
  );
}

function looksTemporalOrProvenanceColumn(columnName: string): boolean {
  const tokens = columnNameTokens(columnName);
  return tokens.some(token =>
    ["date", "time", "timestamp", "year", "month", "day", "source", "file", "filename", "path", "url", "uri"].includes(
      token
    )
  );
}

function columnNameTokens(columnName: string): string[] {
  return columnName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

function isStringColumnStat(stat: string | undefined): boolean {
  if (!stat) return false;
  const rawType = stat
    .match(/^\(([^)]+)\):/)?.[1]
    ?.trim()
    .toLowerCase();
  if (!rawType) return false;
  return rawType.includes("str") || rawType.includes("string") || rawType.includes("object");
}

function parseColumnStatNumber(stat: string, key: string): number {
  const match = stat.match(new RegExp(`(?:^|[\\s,{])"?${key}"?\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"));
  return match ? Number(match[1]) : Number.NaN;
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

function isNonEmptySchema(schema: PortSchema | undefined): schema is PortSchema {
  return Array.isArray(schema) && schema.length > 0;
}

function firstNonEmptySchema(schemaMap: OperatorPortSchemaMap | undefined): PortSchema | undefined {
  if (!schemaMap) return undefined;
  return Object.values(schemaMap).find(isNonEmptySchema);
}

function mergeSchemaMaps(
  primary: OperatorPortSchemaMap | undefined,
  fallback: OperatorPortSchemaMap | undefined
): OperatorPortSchemaMap | undefined {
  if (!primary && !fallback) return undefined;
  const merged: Record<string, PortSchema | undefined> = {};
  const portIds = new Set<string>([...Object.keys(primary ?? {}), ...Object.keys(fallback ?? {})]);
  for (const portId of portIds) {
    const schema = isNonEmptySchema(primary?.[portId]) ? primary?.[portId] : fallback?.[portId];
    if (isNonEmptySchema(schema)) merged[portId] = schema;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function deriveInputSchemaMapFromResults(
  op: OperatorPredicate,
  snapshot: SnapshotData,
  allLinks: WorkflowContent["links"]
): OperatorPortSchemaMap | undefined {
  if (op.inputPorts.length === 0) return undefined;
  const inputLinks = allLinks.filter(link => link.target.operatorID === op.operatorID);
  if (inputLinks.length === 0) return undefined;

  const inputSchemaMap: Record<string, PortSchema | undefined> = {};
  op.inputPorts.forEach((_, portIndex) => {
    const portId = `${portIndex}_false`;
    const linksToThisPort = inputLinks.filter(
      link => parseWorkflowPortIndex(link.target.portID, "input") === portIndex
    );
    for (const link of linksToThisPort) {
      const outputPort = parseWorkflowPortIndex(link.source.portID, "output");
      if (outputPort !== undefined && outputPort !== 0) continue;
      const schema = schemaFromOperatorInfo(snapshot.results.get(link.source.operatorID)?.info);
      if (isNonEmptySchema(schema)) {
        inputSchemaMap[portId] = schema;
        break;
      }
    }
  });

  return Object.values(inputSchemaMap).some(isNonEmptySchema) ? inputSchemaMap : undefined;
}

function schemaFromOperatorInfo(info: OperatorInfo | undefined): PortSchema | undefined {
  if (!info || info.error) return undefined;
  const statsSchema = schemaFromColumnStats(info.columnStats);
  if (isNonEmptySchema(statsSchema)) return statsSchema;
  return schemaFromRows(info.result);
}

function schemaFromColumnStats(stats: Record<string, string> | undefined): PortSchema | undefined {
  if (!stats) return undefined;
  const schema = Object.entries(stats)
    .filter(([columnName, stat]) => isRenderableColumn(columnName) && typeof stat === "string" && stat.length > 0)
    .map(([columnName, stat]) => ({
      attributeName: columnName,
      attributeType: attributeTypeFromStats(stat),
    }));
  return schema.length > 0 ? schema : undefined;
}

function schemaFromRows(rows: Record<string, any>[] | undefined): PortSchema | undefined {
  if (!rows || rows.length === 0) return undefined;
  const columnOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const columnName of Object.keys(row)) {
      if (!isRenderableColumn(columnName) || seen.has(columnName)) continue;
      seen.add(columnName);
      columnOrder.push(columnName);
    }
  }
  if (columnOrder.length === 0) return undefined;

  return columnOrder.map(columnName => ({
    attributeName: columnName,
    attributeType: attributeTypeFromRows(rows.map(row => row?.[columnName])),
  }));
}

function isRenderableColumn(columnName: string): boolean {
  return columnName.length > 0 && columnName !== "__row_index__" && columnName !== "__is_visualization__";
}

function attributeTypeFromStats(stat: string): PortSchema[number]["attributeType"] {
  const rawType =
    stat
      .match(/^\(([^)]+)\):/)?.[1]
      ?.trim()
      .toLowerCase() ?? "";
  if (rawType.includes("bool")) return "boolean";
  if (rawType.includes("datetime") || rawType.includes("timestamp") || rawType === "date") return "timestamp";
  if (rawType.includes("int")) return "long";
  if (
    rawType.includes("numeric") ||
    rawType.includes("float") ||
    rawType.includes("double") ||
    rawType.includes("decimal")
  ) {
    return "double";
  }
  if (rawType.includes("binary")) return "binary";
  return "string";
}

function attributeTypeFromRows(values: any[]): PortSchema[number]["attributeType"] {
  const value = values.find(v => v !== null && v !== undefined);
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint") return "long";
  if (typeof value === "number") return Number.isInteger(value) ? "long" : "double";
  return "string";
}

function parseWorkflowPortIndex(portId: string, expectedType: "input" | "output"): number | undefined {
  const match = portId.match(/^(input|output)-(\d+)$/);
  if (!match || match[1] !== expectedType) return undefined;
  return Number.parseInt(match[2], 10);
}

function buildTableStructureHint(op: OperatorPredicate, info: OperatorInfo | undefined): string | undefined {
  if (op.operatorType !== "DataLoading" || !info || info.error || !info.result || info.result.length === 0) {
    return undefined;
  }

  const columns = inferRenderableColumns(info);
  if (columns.length === 0) return undefined;

  const evidence: string[] = [];
  const generatedColumns = columns.filter(isGeneratedColumnName);
  if (generatedColumns.length > 0) {
    evidence.push(`generated/unnamed columns: ${formatValueList(generatedColumns, 6)}`);
  }

  const leadingMostlyEmpty = findLeadingMostlyEmptyRow(info.result, columns);
  if (leadingMostlyEmpty !== undefined) {
    evidence.push(`leading mostly-empty row at preview index ${leadingMostlyEmpty}`);
  }

  const headerRow = findHeaderLikeRow(info.result, columns);
  if (headerRow) {
    evidence.push(
      `embedded header-like row at preview index ${headerRow.index}: ${formatValueList(headerRow.values, 8)}`
    );
  }

  const footerRow = findFooterLikeRow(info.result, columns);
  if (footerRow) {
    evidence.push(`footer/source-note-like row at preview index ${footerRow.index}: ${shortenCell(footerRow.value)}`);
  }

  if (evidence.length === 0) return undefined;

  return [
    "- Loader output may include metadata/header/footer rows rather than one clean table.",
    ...evidence.map(item => `- Evidence: ${item}.`),
    "- Before downstream aggregation, normalize this loader: choose the real header/body rows, drop metadata/footer rows, and return one rectangular table with semantic column names.",
  ].join("\n");
}

function inferRenderableColumns(info: OperatorInfo): string[] {
  const resultColumns: string[] = [];
  const seen = new Set<string>();
  for (const row of info.result ?? []) {
    if (!row || typeof row !== "object") continue;
    for (const columnName of Object.keys(row)) {
      if (!isRenderableColumn(columnName) || seen.has(columnName)) continue;
      seen.add(columnName);
      resultColumns.push(columnName);
    }
  }
  if (resultColumns.length > 0) return resultColumns;
  return Object.keys(info.columnStats ?? {}).filter(isRenderableColumn);
}

function isGeneratedColumnName(columnName: string): boolean {
  return /^Unnamed(?::|\b)/i.test(columnName) || /^\d+$/.test(columnName) || /^column_?\d+$/i.test(columnName);
}

function findLeadingMostlyEmptyRow(rows: Record<string, any>[], columns: string[]): number | undefined {
  for (let i = 0; i < Math.min(rows.length, 3); i++) {
    if (emptyRatio(rows[i], columns) >= 0.75) return i;
  }
  return undefined;
}

function emptyRatio(row: Record<string, any>, columns: string[]): number {
  if (columns.length === 0) return 0;
  const emptyCount = columns.filter(columnName => isBlankCell(row?.[columnName])).length;
  return emptyCount / columns.length;
}

function findHeaderLikeRow(
  rows: Record<string, any>[],
  columns: string[]
): { index: number; values: string[] } | undefined {
  const hasGeneratedColumns = columns.some(isGeneratedColumnName);
  const maxRows = Math.min(rows.length, 8);
  for (let i = 0; i < maxRows; i++) {
    const values = columns
      .map(columnName => rows[i]?.[columnName])
      .filter(v => !isBlankCell(v))
      .map(normalizeCell);
    if (values.length < 2) continue;
    const labelCount = values.filter(looksLikeHeaderLabel).length;
    const matchesColumnNames = values.filter(v =>
      columns.some(c => normalizeForCompare(c) === normalizeForCompare(v))
    ).length;
    if (labelCount >= 2 && labelCount / values.length >= 0.6 && (hasGeneratedColumns || matchesColumnNames >= 2)) {
      return { index: i, values };
    }
  }
  return undefined;
}

function findFooterLikeRow(
  rows: Record<string, any>[],
  columns: string[]
): { index: number; value: string } | undefined {
  for (let i = 0; i < rows.length; i++) {
    for (const columnName of columns) {
      const value = normalizeCell(rows[i]?.[columnName]);
      if (/^(source|sources|note|notes|footnote|references?|copyright)\b[:\s-]*/i.test(value)) {
        return { index: i, value };
      }
    }
  }
  return undefined;
}

function looksLikeHeaderLabel(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (!/[A-Za-z#]/.test(trimmed)) return false;
  const numericChars = (trimmed.match(/[0-9.%$,\-]/g) ?? []).length;
  return numericChars / trimmed.length < 0.5;
}

function isBlankCell(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isNaN(value);
  const normalized = normalizeCell(value).toLowerCase();
  return normalized.length === 0 || normalized === "nan" || normalized === "none" || normalized === "null";
}

function normalizeCell(value: any): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9#]+/g, "");
}

function formatValueList(values: string[], limit: number): string {
  const shown = values.slice(0, limit).map(shortenCell);
  const suffix = values.length > shown.length ? `, ... ${values.length - shown.length} more` : "";
  return shown.join(", ") + suffix;
}

function shortenCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) return normalized;
  return normalized.slice(0, 77) + "...";
}

const RAW_PROVENANCE_MAX_PATHS = 2;
const RAW_PROVENANCE_HEAD_BYTES = 64 * 1024;
const RAW_PROVENANCE_FIRST_LINES = 8;
const RAW_PROVENANCE_MAX_BLOCKS = 5;

interface ResolvedSourcePath {
  literal: string;
  absolute: string;
}

interface RawLine {
  lineNumber: number;
  text: string;
}

function buildRawLoaderProvenance(op: OperatorPredicate, info: OperatorInfo | undefined): string | undefined {
  if (op.operatorType !== "DataLoading" || !info || info.error) return undefined;

  const code = typeof op.operatorProperties?.code === "string" ? op.operatorProperties.code : "";
  const paths = extractLiteralSourcePaths(code)
    .map(resolveReadableRelativePath)
    .filter((path): path is ResolvedSourcePath => path !== undefined)
    .slice(0, RAW_PROVENANCE_MAX_PATHS);

  if (paths.length === 0) return undefined;

  const sections = paths
    .map(path => buildRawFileProvenance(path))
    .filter((section): section is string => section !== undefined);
  return sections.length > 0 ? sections.join("\n") : undefined;
}

function extractLiteralSourcePaths(code: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const callPattern =
    /\b(?:pd\.)?(?:read_csv|read_table|read_excel|read_json|read_parquet|read_fwf|open)\s*\(\s*(['"])([^'"]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(code)) !== null) {
    const literal = match[2]?.trim();
    if (!literal || seen.has(literal)) continue;
    seen.add(literal);
    paths.push(literal);
  }
  return paths;
}

function resolveReadableRelativePath(literal: string): ResolvedSourcePath | undefined {
  if (!isSafeRelativeSourcePath(literal)) return undefined;

  const normalized = normalize(literal);
  const roots = uniqueRoots([process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")]);
  for (const root of roots) {
    const absolute = resolve(root, normalized);
    if (!isPathWithin(root, absolute)) continue;
    try {
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        return { literal, absolute };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function isSafeRelativeSourcePath(literal: string): boolean {
  if (literal.length === 0 || literal.includes("\0")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(literal)) return false;
  if (isAbsolute(literal)) return false;
  if (/[*?\[\]{}]/.test(literal)) return false;
  const normalized = normalize(literal);
  return normalized !== ".." && !normalized.startsWith(`..${sep}`) && normalized !== ".";
}

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots.map(r => resolve(r))) {
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildRawFileProvenance(path: ResolvedSourcePath): string | undefined {
  const lines = sampleTextLines(path.absolute);
  if (!lines || lines.length === 0) return undefined;

  const output: string[] = [`- Source path: ${path.literal}`];
  output.push("- First raw lines:");
  for (const line of lines.slice(0, RAW_PROVENANCE_FIRST_LINES)) {
    output.push(`  - ${formatRawLine(line)}`);
  }

  const blocks = findBlankSeparatedBlocks(lines);
  if (blocks.length > 0) {
    output.push(`- Blank-separated block starts: ${blocks.map(formatRawLine).join("; ")}`);
  }

  const header = findRawHeaderLikeLine(lines);
  if (header) {
    output.push(`- Candidate header line: ${formatRawLine(header.line)}`);
    const firstBody = findFirstBodyLineAfterHeader(lines, header);
    if (firstBody) output.push(`- First data-like line after candidate header: ${formatRawLine(firstBody)}`);
  }

  const footer = findRawFooterLikeLine(lines);
  if (footer) output.push(`- Trailing note/source-like line: ${formatRawLine(footer)}`);

  return output.join("\n");
}

function sampleTextLines(filePath: string): RawLine[] | undefined {
  let fd: number | undefined;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return undefined;

    const bytesToRead = Math.min(stat.size, RAW_PROVENANCE_HEAD_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return undefined;

    const text = slice.toString("utf8").replace(/^\uFEFF/, "");
    return text.split(/\r\n|\n|\r/).map((line, i) => ({ lineNumber: i + 1, text: line }));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors while rendering optional context evidence.
      }
    }
  }
}

function findBlankSeparatedBlocks(lines: RawLine[]): RawLine[] {
  const blocks: RawLine[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (isRawBlankLine(line.text)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      blocks.push(line);
      if (blocks.length >= RAW_PROVENANCE_MAX_BLOCKS) return blocks;
    }
    inBlock = true;
  }
  return blocks;
}

function findRawHeaderLikeLine(lines: RawLine[]): { line: RawLine; fields: string[] } | undefined {
  for (const line of lines.slice(0, 25)) {
    if (isRawBlankLine(line.text)) continue;
    const fields = parseDelimitedLine(line.text).filter(f => f.length > 0);
    if (fields.length < 2) continue;
    const labelCount = fields.filter(looksLikeHeaderLabel).length;
    if (labelCount >= 2 && labelCount / fields.length >= 0.6) {
      return { line, fields };
    }
  }
  return undefined;
}

function findFirstBodyLineAfterHeader(
  lines: RawLine[],
  header: { line: RawLine; fields: string[] }
): RawLine | undefined {
  const start = lines.findIndex(line => line.lineNumber === header.line.lineNumber);
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1, start + 12)) {
    if (isRawBlankLine(line.text)) continue;
    const fields = parseDelimitedLine(line.text).filter(f => f.length > 0);
    if (fields.length >= Math.min(2, header.fields.length)) return line;
  }
  return undefined;
}

function findRawFooterLikeLine(lines: RawLine[]): RawLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const fields = parseDelimitedLine(lines[i].text);
    if (fields.some(looksLikeFooterNote)) return lines[i];
  }
  return undefined;
}

function looksLikeFooterNote(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  return /^(source|sources|note|notes|footnote|references?|copyright)\b[:\s-]*/i.test(normalized);
}

function isRawBlankLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  const fields = parseDelimitedLine(line);
  return fields.length > 0 && fields.every(f => f.length === 0);
}

function parseDelimitedLine(line: string): string[] {
  const delimiter = chooseDelimiter(line);
  const fields: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === delimiter && !inQuote) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

function chooseDelimiter(line: string): string {
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = -1;
  for (const delimiter of candidates) {
    const count = countUnquotedDelimiter(line, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function countUnquotedDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') i++;
      else inQuote = !inQuote;
    } else if (ch === delimiter && !inQuote) {
      count++;
    }
  }
  return count;
}

function formatRawLine(line: RawLine): string {
  const trimmed = line.text.trim();
  if (isRawBlankLine(line.text)) {
    return trimmed.length === 0
      ? `L${line.lineNumber}: <blank>`
      : `L${line.lineNumber}: <blank-like ${shortenCell(trimmed)}>`;
  }
  return `L${line.lineNumber}: ${shortenCell(trimmed)}`;
}

function formatSchema(schema: PortSchema): string {
  const attrs = schema.map(a => `${a.attributeName}: ${a.attributeType}`);
  return `[${attrs.join(", ")}]`;
}

function parsePortIndex(portId: string): string {
  const idx = portId.indexOf("_");
  return idx >= 0 ? portId.substring(0, idx) : portId;
}
