/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { ModelMessage } from "ai";
import type { ReActStep } from "../types/agent";
import type { HistoricalTask } from "./state-history";
import { readForkResult } from "./state-history";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type { DataflowActionsResult } from "./tools/dataflow-actions";
import { catalogResultSummary } from "./native/catalog-summary";
import {
  inlineCode,
  operatorBlock,
  shapeText,
  type OperatorBlock,
  type ObservationFormatOptions,
} from "./native/observation-format";
import { nativeOperatorName } from "./native/catalog";
import { collectTaskEdits, taskCatalogRecords, taskOperatorCatalog, type TaskFork } from "./task-catalog";

/** Immutable action-time access evidence, never inferred from model prose. */
export interface TaskReference {
  actionIndex: number;
  kind: "compute" | "read" | "definition" | "consultation";
  operatorId: string | null;
  operatorRevision?: string;
  subgraphHash?: string;
  resultVersion?: string;
  producingStepId?: string;
  /** Snapshot whose graph and result were actually read, including fork origins. */
  readStepId?: string;
  savedTaskId?: number;
}

export interface TaskHistory extends HistoricalTask {
  steps: readonly ReActStep[];
  status: "answered" | "incomplete";
}

export interface TaskOperator {
  operator_id: string;
  kind: string;
  revision?: string;
  inputs: string[];
  result_version?: string;
  rows?: number;
  available: boolean;
  change: string;
  result_summary?: string;
  /** Evaluator-visible provenance for a hidden exact-result input. */
  saved_result?: import("../types/workflow").OperatorPredicate["savedResult"];
}

export interface TaskRecord {
  task_id: number;
  request: string;
  answer: string;
  /** Exact answer selection, separate from the full working-table sources. */
  answer_from?: string;
  /** Operators with a completed result at the answer: readable later as `ID@task_id`. */
  saved_versions?: string[];
  status: "answered" | "incomplete";
  operators: TaskOperator[];
  /** First-edit order, with one final saved definition per changed operator. */
  operator_changes?: OperatorBlock[];
  operator_deletions?: OperatorBlock[];
  /** Bounded, frozen display text from records actually observed in this task. */
  operator_records?: Record<string, string>;
  forks?: TaskFork[];
  dependencies: Array<{
    task_id: number;
    references: Array<{
      operator_id: string | null;
      kind: TaskReference["kind"];
      revision?: string;
      result_version?: string;
      subgraph_hash?: string;
      evidence: "saved_task" | "result_version" | "producing_step" | "definition_revision";
    }>;
  }>;
  consulted_tasks: number[];
  unresolved_references: number;
  output_roots?: {
    basis: "answer" | "observed_reads" | "unknown";
    roots: Array<{
      operator_id: string;
      step_id: string;
      task_id: number;
      revision?: string;
      result_version?: string;
      subgraph_hash?: string;
    }>;
  };
}

function batches(step: ReActStep): DataflowActionsResult[] {
  return (step.toolResults ?? [])
    .map(r => r.output)
    .filter((r): r is DataflowActionsResult => !!r && typeof r === "object" && r.kind === "dataflow-actions");
}

/** Explicit answer sources take precedence over exploratory result reads.
 * Candidates remain labelled when an older/free-text answer named no sources. */
function outputRoots(storage: WorkflowSnapshotStorage, task: TaskHistory, tasks: readonly TaskHistory[]) {
  const answered: NonNullable<TaskRecord["output_roots"]>["roots"] = [];
  const observed: typeof answered = [];
  const declared = task.steps.some(step => batches(step).some(receipt => receipt.actions.some(item =>
    item.status === "ok" && item.action.type === "answer" && ("operator_ids" in item.action || "from" in item.action)
  )));
  for (const step of task.steps)
    for (const receipt of batches(step))
      for (const ref of receipt.references ?? []) {
        if (ref.kind !== "read" || !ref.operatorId) continue;
        const action = receipt.actions.find(a => a.index === ref.actionIndex);
        if (!action || action.status !== "ok" || (action.output as any)?.superseded_in_call) continue;
        const saved = ref.savedTaskId === undefined ? undefined : tasks.find(t => t.taskId === ref.savedTaskId);
        let stepId = ref.readStepId ?? saved?.stepId ?? step.id;
        if (!storage.hasSnapshotFor(stepId)) continue;
        const op = storage.getWorkflow(stepId).operators.find(o => o.operatorID === ref.operatorId);
        const info = storage.getOperatorResult(stepId, ref.operatorId);
        if (
          !op ||
          (ref.operatorRevision && op.nativeOp?.revision !== ref.operatorRevision) ||
          (ref.resultVersion && info?.resultVersion?.id !== ref.resultVersion)
        )
          continue;
        // Combine compatible reads at the task endpoint only when result identity
        // proves they still denote exactly the same saved computation.
        const endOp = storage.getWorkflow(task.stepId).operators.find(o => o.operatorID === ref.operatorId);
        const endInfo = storage.getOperatorResult(task.stepId, ref.operatorId);
        if (
          ref.resultVersion &&
          endInfo?.resultVersion?.id === ref.resultVersion &&
          endOp?.nativeOp?.revision === op.nativeOp?.revision &&
          endInfo.resultVersion?.subgraphHash === info?.resultVersion?.subgraphHash
        )
          stepId = task.stepId;
        const root = {
          operator_id: ref.operatorId,
          step_id: stepId,
          task_id: stepId === task.stepId ? task.taskId : (saved?.taskId ?? task.taskId),
          ...(ref.operatorRevision ? { revision: ref.operatorRevision } : {}),
          ...(ref.resultVersion ? { result_version: ref.resultVersion } : {}),
          ...(ref.subgraphHash ? { subgraph_hash: ref.subgraphHash } : {}),
        };
        const roots = action.action.type === "answer" ? answered : observed;
        if (!roots.some(r => r.operator_id === root.operator_id && r.step_id === root.step_id)) roots.push(root);
      }
  return {
    basis: declared || answered.length ? ("answer" as const) : observed.length ? ("observed_reads" as const) : ("unknown" as const),
    roots: declared || answered.length ? answered : observed,
  };
}

/** Number every user request, including unsuccessful ones; seed state is not a task. */
export function taskHistoryFromSteps(
  steps: readonly ReActStep[],
  storage: WorkflowSnapshotStorage,
  numbers?: ReadonlyMap<string, number>,
  offset = 0
): TaskHistory[] {
  const requests = steps.filter(s => s.role === "user" && s.isBegin && !s.synthetic);
  return requests.flatMap((request, i) => {
    const trajectory = steps.filter(s => s.messageId === request.messageId && !s.synthetic);
    // A provider failure can leave only the request. Keep it addressable as an
    // incomplete task; its inherited snapshot is the state before any action.
    const saved = [...trajectory].reverse().find(s => s.role === "agent" && storage.hasSnapshotFor(s.id)) ?? request;
    const end = [...trajectory]
      .reverse()
      .find(
        s => s.role === "agent" && s.isEnd && batches(s).some(r => r.status === "completed" && r.answer !== undefined)
      );
    return [
      {
        taskId: (numbers?.get(request.messageId) ?? i + 1) + offset,
        stepId: end?.id ?? saved.id,
        request: request.content,
        answer: end?.content ?? "",
        status: end ? ("answered" as const) : ("incomplete" as const),
        steps: trajectory.slice(0, trajectory.indexOf(end ?? saved) + 1),
      },
    ];
  });
}

/** Computational provenance includes reads and execution inputs; consultations
 * are separate. It establishes where state came from, not semantic correctness. */
export function buildTaskGraph(
  storage: WorkflowSnapshotStorage,
  tasks: readonly TaskHistory[],
  options: Pick<ObservationFormatOptions, "catalogStatistics" | "catalogRecords"> & { stateHistory?: boolean } = {}
): TaskRecord[] {
  const includeResultStatistics = options.catalogStatistics === true;
  const recordLimit = options.catalogRecords ?? 0;
  const ordered = [...tasks].sort((a, b) => a.taskId - b.taskId);
  const stepTasks = new Map(ordered.flatMap(t => t.steps.map(s => [s.id, t.taskId] as const)));
  const resultOwners = new Map<string, number>();
  const definitionOwners = new Map<string, number>();
  const records: TaskRecord[] = [];
  const indexResults = (task: TaskHistory) => {
    // Index every snapshot earned in this task, not just its final answer.
    // A cached/inherited result keeps its earliest known producer.
    for (const step of task.steps) {
      if (!storage.hasSnapshotFor(step.id)) continue;
      const snap = storage.getAssociatedSnapshot(step.id);
      for (const op of snap.workflow.operators) {
        const info = storage.getResolvedOperatorResult(step.id, op.operatorID);
        const version = info?.value.resultVersion?.id;
        const producer = info?.sourceStepId ? stepTasks.get(info.sourceStepId) : undefined;
        if (version && producer !== undefined && producer <= task.taskId && !resultOwners.has(version))
          resultOwners.set(version, producer);
      }
    }
  };
  for (const task of ordered) {
    const cached = storage.getAssociatedSnapshot(task.stepId).nativeTaskCatalog;
    // Definitions created in this task belong to it, even when an execution
    // references them before the task has a completed answer. Index snapshots
    // before resolving access receipts so self-references are not unknown.
    for (const step of task.steps) {
      if (!storage.hasSnapshotFor(step.id)) continue;
      const snap = storage.getAssociatedSnapshot(step.id);
      const parent = snap.parentId ? storage.getSnapshotById(snap.parentId)?.workflow : undefined;
      const parentRevisions = new Map(parent?.operators.map(op => [op.operatorID, op.nativeOp?.revision]));
      for (const op of snap.workflow.operators) {
        const rev = op.nativeOp?.revision;
        if (rev && rev !== parentRevisions.get(op.operatorID) && !definitionOwners.has(`${op.operatorID}:${rev}`))
          definitionOwners.set(`${op.operatorID}:${rev}`, task.taskId);
      }
    }
    if (cached?.task_id === task.taskId && task.status === "answered") {
      records.push(cached);
      indexResults(task);
      continue;
    }
    const previous = new Set(records.map(t => t.task_id));
    const edges = new Map<number, TaskRecord["dependencies"][number]["references"]>();
    const consulted = new Set<number>();
    const touched = new Map<string, string>();
    const delta = collectTaskEdits(storage, task);
    for (const [id, edit] of delta.edits) touched.set(id, edit.state);
    let unresolved = 0;
    for (const step of task.steps)
      for (const receipt of batches(step)) {
        for (const item of receipt.actions) {
          if (item.status !== "ok") continue;
          if (item.action.type === "retrieve")
            touched.set(item.action.operator_id, touched.get(item.action.operator_id) ?? "read");
          if (item.action.type === "execute")
            for (const id of item.action.operator_ids ?? []) touched.set(id, touched.get(id) ?? "executed");
          if (item.action.type === "inspect" && item.action.target === "state")
            for (const id of Array.isArray(item.action.operator_id)
              ? item.action.operator_id
              : [item.action.operator_id])
              touched.set(id, touched.get(id) ?? "inspected");
        }
        for (const ref of receipt.references ?? []) {
          const action = receipt.actions.find(a => a.index === ref.actionIndex);
          // Successful independent results after a partial execution failure are
          // real accesses; rejected edits and skipped actions are not.
          if (!action || (action.status !== "ok" && !(action.status === "error" && action.action.type === "execute")))
            continue;
          let owner: number | undefined;
          let evidence: TaskRecord["dependencies"][number]["references"][number]["evidence"] = "producing_step";
          if (ref.savedTaskId !== undefined) {
            owner = ref.savedTaskId;
            evidence = "saved_task";
          } else if (ref.kind === "definition" && ref.operatorRevision && ref.operatorId) {
            owner = definitionOwners.get(`${ref.operatorId}:${ref.operatorRevision}`);
            evidence = "definition_revision";
          } else if (ref.resultVersion && resultOwners.has(ref.resultVersion)) {
            owner = resultOwners.get(ref.resultVersion);
            evidence = "result_version";
          } else if (ref.producingStepId) owner = stepTasks.get(ref.producingStepId);
          if (owner === task.taskId) continue;
          if (owner === undefined || !previous.has(owner)) {
            unresolved++;
            continue;
          }
          if (ref.kind === "consultation") {
            consulted.add(owner);
            continue;
          }
          const references = edges.get(owner) ?? [];
          const value = {
            operator_id: ref.operatorId,
            kind: ref.kind,
            ...(ref.operatorRevision ? { revision: ref.operatorRevision } : {}),
            ...(ref.resultVersion ? { result_version: ref.resultVersion } : {}),
            ...(ref.subgraphHash ? { subgraph_hash: ref.subgraphHash } : {}),
            evidence,
          };
          if (!references.some(r => JSON.stringify(r) === JSON.stringify(value))) references.push(value);
          edges.set(owner, references);
        }
      }
    const workflow = storage.getWorkflow(task.stepId);
    // What the answer saved: every visible operator whose result was complete
    // at that step. Hidden saved-result handles are references, not versions.
    const savedVersions = options.stateHistory
      ? workflow.operators
          .filter(op => !op.savedResult)
          .filter(op => {
            const info = storage.getOperatorResult(task.stepId, op.operatorID);
            return !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);
          })
          .map(op => op.operatorID)
      : undefined;
    const operatorRecords = taskCatalogRecords(storage, task, touched.keys(), recordLimit);
    const operators = [...touched].map(([id, change]): TaskOperator => {
      const op = workflow.operators.find(o => o.operatorID === id);
      const current = op ? storage.getOperatorResult(task.stepId, id) : undefined;
      const saved = op && !current ? readForkResult(workflow, storage, id, task.stepId) : undefined;
      const info = current ?? saved?.info;
      const original = saved?.workflow.operators.find(item => item.operatorID === saved.operatorId);
      return {
        operator_id: id,
        kind: op?.nativeOp?.type ?? op?.operatorType ?? "deleted",
        revision: op?.nativeOp?.revision,
        inputs: [...(op?.nativeOp?.inputs ?? [])],
        change,
        ...(op?.savedResult ? { saved_result: { ...op.savedResult } } : {}),
        result_version: info?.resultVersion?.id,
        rows: info?.totalRowCount,
        available: !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state),
        ...(info && (includeResultStatistics || operatorRecords[id])
          ? {
              result_summary: includeResultStatistics
                ? catalogResultSummary(original?.nativeOp ?? op?.nativeOp, info)
                : shapeText(info.totalRowCount, info.resultSchema?.length),
            }
          : {}),
      };
    });
    const roots = outputRoots(storage, task, ordered);
    records.push({
      task_id: task.taskId,
      request: task.request,
      answer: task.answer,
      ...(() => {
        const action = task.steps.flatMap(step => batches(step).flatMap(batch => batch.actions))
          .filter(item => item.status === "ok" && item.action.type === "answer" && "from" in item.action).at(-1)?.action;
        return action?.type === "answer" && "from" in action ? { answer_from: action.from } : {};
      })(),
      status: task.status,
      ...(savedVersions ? { saved_versions: savedVersions } : {}),
      operators,
      ...taskOperatorCatalog(storage, task, delta, roots, includeResultStatistics, ordered),
      ...(Object.keys(operatorRecords).length ? { operator_records: operatorRecords } : {}),
      dependencies: [...edges].sort(([a], [b]) => a - b).map(([task_id, references]) => ({ task_id, references })),
      consulted_tasks: [...consulted].sort((a, b) => a - b),
      unresolved_references: unresolved,
      output_roots: roots,
    });
    indexResults(task);
  }
  return records;
}

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [answer clipped; inspect this task for the original]`;

const TASK_HISTORY_INTRO =
  "# Prior Tasks\n\nEarlier agent answers are unverified outputs. Operator blocks show added or modified operators in first-edit order, with their final saved definitions for that task. Dependencies record computation and reads, not correctness or every semantic dependency. Read relevant ID@task definitions (view=null) or completed results; include_implementation supplies process bodies on demand. Saved result addresses are immutable. Each entry's Saved versions line names what that task saved; an operator unchanged since an earlier task is also readable under that earlier number.";

function taskQuestion(task: TaskRecord): string {
  return `## Task ${task.task_id} (${task.status})\nQuestion: ${task.request}`;
}

function taskOutcome(task: TaskRecord, answerChars: number, includeOperatorChanges = true): string {
  const recordText = (id: string) =>
    task.operator_records && Object.hasOwn(task.operator_records, id) ? task.operator_records[id] : undefined;
  const collapsed = new Set(
    task.forks?.flatMap(fork => fork.collapsed_operator_ids.filter(id => !recordText(id))) ?? []
  );
  const saved = task.saved_versions ? new Set(task.saved_versions) : undefined;
  const versionLine = (block: OperatorBlock) =>
    !saved || block.state.startsWith("deleted")
      ? []
      : [saved.has(block.id) ? `  - saved as ${inlineCode(`${block.id}@${task.task_id}`)}` : "  - saved: no completed result"];
  const blockWithRecords = (block: OperatorBlock) =>
    [
      operatorBlock(block),
      ...versionLine(block),
      ...(recordText(block.id)
        ?.split("\n")
        .map(line => `  ${line}`) ?? []),
    ].join("\n");
  const changes = (task.operator_changes ?? []).filter(
    block => !collapsed.has(block.id) && !block.state.startsWith("deleted")
  );
  const deletions = task.operator_deletions?.length
    ? task.operator_deletions
    : (task.operator_changes ?? []).filter(block => block.state.startsWith("deleted"));
  const changedIds = new Set((task.operator_changes ?? []).map(block => block.id));
  const referenced = task.operators.filter(op => op.result_summary && !changedIds.has(op.operator_id));
  return [
    ...(includeOperatorChanges && changes.length ? ["Operators:", ...changes.map(blockWithRecords)] : []),
    ...(includeOperatorChanges && deletions.length
      ? ["Deleted operators:", ...deletions.map(block => operatorBlock({ ...block, state: "deleted" }))]
      : []),
    `Answer: ${task.answer ? clip(task.answer, answerChars) : "No completed answer."}`,
    ...(task.answer_from ? [`Selection: ${task.answer_from}`] : []),
    `Dependencies: ${task.dependencies.map(d => `task ${d.task_id}`).join(", ") || "none recorded"}`,
    `Answer sources: ${task.output_roots?.basis === "answer" ? task.output_roots.roots.map(root => inlineCode(`${root.operator_id}@${root.task_id}`)).join(", ") || "[] (explicitly no table)" : "not declared"}`,
    ...(saved ? [savedVersionsLine(task.task_id, saved, changedIds)] : []),
    ...(includeOperatorChanges && referenced.length
      ? [
          "Referenced results:",
          ...referenced.map(op =>
            blockWithRecords({
              id: op.operator_id,
              kind: nativeOperatorName(op.kind),
              state: "referenced",
              result: op.result_summary,
            })
          ),
        ]
      : []),
    ...(task.unresolved_references
      ? [`Some accesses have no known earlier-task provenance (${task.unresolved_references}).`]
      : []),
  ]
    .join("\n")
    .trimEnd();
}

/** The versions a task saved: the ones it changed first, then the rest of
 * the graph, which an earlier task may already have saved under its number. */
function savedVersionsLine(taskId: number, saved: ReadonlySet<string>, changed: ReadonlySet<string>): string {
  const name = (id: string) => inlineCode(`${id}@${taskId}`);
  if (!saved.size) return "Saved versions: none (no operator had a completed result).";
  const changedSaved = [...saved].filter(id => changed.has(id));
  const unchanged = [...saved].filter(id => !changed.has(id));
  const shown = unchanged.slice(0, Math.max(0, 12 - changedSaved.length));
  const more = unchanged.length - shown.length;
  return (
    `Saved versions: ${changedSaved.map(name).join(", ") || "none changed in this task"}` +
    (unchanged.length ? `; unchanged, still readable: ${shown.map(name).join(", ")}${more > 0 ? ` … +${more} more` : ""}` : "")
  );
}

export function renderTaskIndex(
  tasks: readonly TaskRecord[],
  answerChars = Infinity,
  includeOperatorChanges = true
): string {
  return tasks.length
    ? [
        TASK_HISTORY_INTRO,
        ...tasks.map(task => `${taskQuestion(task)}\n${taskOutcome(task, answerChars, includeOperatorChanges)}`),
      ].join("\n\n")
    : "";
}

/** Written once at answer time and reused verbatim by catalog context. The
 * original request is already a preserved user frame in either policy. */
export function renderTaskBoundary(task: TaskRecord): string {
  return `## Task ${task.task_id} (${task.status})\n${taskOutcome(task, Infinity)}`;
}

/** Preserve initial request frames and append immutable outcomes. Provider
 * cache reuse also depends on its cache policy and request serialization. */
export function renderTaskMessages(
  tasks: readonly TaskRecord[],
  requestMessages: ReadonlyMap<number, readonly ModelMessage[]>
): ModelMessage[] {
  return tasks.length
    ? [
        { role: "user", content: TASK_HISTORY_INTRO },
        ...tasks.flatMap(task => {
          const request = requestMessages.get(task.task_id);
          if (!request) throw new Error(`Missing initial request frames for task ${task.task_id}`);
          return [
            ...request,
            {
              role: "assistant" as const,
              content: renderTaskBoundary(task),
            },
          ];
        }),
      ]
    : [];
}

export function inspectTask(
  storage: WorkflowSnapshotStorage,
  tasks: readonly TaskHistory[],
  taskId: number
): TaskRecord {
  const record = buildTaskGraph(storage, tasks).find(t => t.task_id === taskId);
  if (!record)
    throw new Error(`UNKNOWN_TASK: no saved task ${taskId}. Inspect only an earlier task listed in Prior Tasks.`);
  // Inspection attaches selected sub-DAGs to its response; never mutate the
  // sealed catalog that supplies cacheable earlier frames.
  return structuredClone(record);
}
