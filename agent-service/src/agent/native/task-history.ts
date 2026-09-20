/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from "node:crypto";
import { isSuccessfulOperatorResult, type OperatorInfo } from "../../types/execution";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import type { WorkflowState } from "../workflow-state";
import { WorkflowUtilService } from "../util/workflow-utils";
import type { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { previewDependencies, type PreviewOrigin } from "./input-coverage";

export type TaskInput = string | { operator: string; atTask: number };
export interface RetainedResult {
  path: string;
  sha256: string;
  rowCount: number;
}
export interface TaskOutput {
  operator: OperatorPredicate;
  info: OperatorInfo;
  artifact: RetainedResult;
  previewSources: PreviewOrigin[];
}
/** What a task did to the graph, accumulated by the runtime while the task
 * runs: batch outcomes, the historical references its batches used, the
 * operators the post-step path executed or left invalid, the direct return. */
export interface TaskEffects {
  edited: Set<string>;
  executed: Set<string>;
  notExecuted: Set<string>;
  rejected: Map<string, string>;
  historical: Set<string>;
  returned?: string;
  returnedOperator?: string;
}

/** The sealed, immutable form rendered to later tasks. Every field is a
 * runtime fact, never model text; it says what changed, not what was meant. */
export interface TaskReceipt {
  edited: string[];
  executed: string[];
  notExecuted: string[];
  rejected: string[];
  historical: string[];
  returned?: string;
  /** The operator behind `returned`, for runtime checks rather than rendering. */
  returnedOperator?: string;
  retained: number;
}

export function emptyTaskEffects(): TaskEffects {
  return { edited: new Set(), executed: new Set(), notExecuted: new Set(), rejected: new Map(), historical: new Set() };
}

/** `{operator, atTask}` references in an operator spec's input slots. */
export function historicalReferences(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const record = spec as Record<string, unknown>;
  const slots = [record.input, record.left, record.right, ...(Array.isArray(record.inputs) ? record.inputs : [])];
  return slots.flatMap(slot =>
    slot &&
    typeof slot === "object" &&
    typeof (slot as any).operator === "string" &&
    Number.isInteger((slot as any).atTask)
      ? [`${(slot as any).operator}@task${(slot as any).atTask}`]
      : []
  );
}

export function receiptFromEffects(
  effects: TaskEffects | undefined,
  results: ReadonlyMap<string, Pick<OperatorInfo, "state" | "error">>,
  retained: number
): TaskReceipt {
  const e = effects ?? emptyTaskEffects();
  const sorted = (values: Iterable<string>) => [...values].sort();
  return {
    edited: sorted(e.edited),
    executed: sorted(e.executed),
    // Invalidated by an edit and never demanded: still without a valid result
    // when the task ended. Anything executed later, or whose result survived
    // (the edit produced an identical version), is not stale.
    notExecuted: sorted(
      [...e.notExecuted].filter(id => !e.executed.has(id) && !isSuccessfulOperatorResult(results.get(id)))
    ),
    rejected: sorted(e.rejected.keys()),
    historical: sorted(e.historical),
    ...(e.returned ? { returned: e.returned } : {}),
    ...(e.returnedOperator ? { returnedOperator: e.returnedOperator } : {}),
    retained,
  };
}

export function formatTaskReceipt(task: number, receipt: TaskReceipt): string {
  const list = (ids: string[]) =>
    ids.length ? ids.slice(0, 12).join(", ") + (ids.length > 12 ? ` …(+${ids.length - 12})` : "") : "none";
  const lines = [`# Task ${task} receipt`, `Edited: ${list(receipt.edited)}`, `Executed: ${list(receipt.executed)}`];
  if (receipt.notExecuted.length) lines.push(`Not re-executed (inputs changed): ${list(receipt.notExecuted)}`);
  if (receipt.rejected.length) lines.push(`Rejected at end of task: ${list(receipt.rejected)}`);
  if (receipt.historical.length) lines.push(`Historical inputs: ${list(receipt.historical)}`);
  lines.push(`Returned: ${receipt.returned ?? "answered in prose"}`);
  lines.push(`Retained outputs: ${receipt.retained}`);
  return lines.join("\n");
}

export const TASK_SOURCE_PREFIX = "task_archive_";
export function taskInputId(reference: Exclude<TaskInput, string>): string {
  return (
    TASK_SOURCE_PREFIX +
    createHash("sha256")
      .update(JSON.stringify({ operator: reference.operator, atTask: reference.atTask }))
      .digest("hex")
      .slice(0, 20)
  );
}
export const taskInputSchema = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      required: ["operator", "atTask"],
      properties: { operator: { type: "string", minLength: 1 }, atTask: { type: "integer", minimum: 1 } },
    },
  ],
  description:
    "Current operator id, or {operator, atTask} for its exact saved output at the end of a completed session task. Task numbers are listed in session context.",
};
export const taskInputSchemaWithFrames = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      required: ["operator"],
      properties: {
        operator: { type: "string", minLength: 1 },
        atTask: { type: "integer", minimum: 1 },
        frame: { type: "string", minLength: 1 },
      },
    },
  ],
  description:
    "Current operator id; {operator, atTask} for its exact saved output at the end of a completed task; {operator, frame} for a kept frame (an intermediate DataFrame listed after a udf's card) as that udf computes it now; {operator, atTask, frame} for that frame as computed at a completed task.",
};

/** Session-owned bindings. Only the runtime creates them; model references
 * select existing data. Retention is independent of evictable engine caches. */
export class TaskHistory {
  private readonly tasks = new Map<number, Map<string, TaskOutput>>();
  private readonly retained = new Map<string, RetainedResult>();
  private readonly receipts = new Map<number, TaskReceipt>();
  constructor(private readonly retain: (operator: string, info: OperatorInfo) => Promise<RetainedResult>) {}

  async seal(
    task: number,
    operators: OperatorPredicate[],
    results: Map<string, OperatorInfo>,
    links: readonly OperatorLink[] = []
  ): Promise<string[]> {
    if (this.tasks.has(task)) throw new Error(`Task ${task} is already sealed`);
    const outputs = new Map<string, TaskOutput>();
    this.tasks.set(task, outputs);
    const errors: string[] = [];
    for (const operator of operators) {
      if (operator.taskSource) continue;
      const info = results.get(operator.operatorID);
      if (!info || !isSuccessfulOperatorResult(info) || !info.resultVersion?.id || !info.materialization?.executionId)
        continue;
      try {
        const previewSources = previewDependencies(operator.operatorID, operators, this, links).map(origin => ({
          ...origin,
          atTask: origin.atTask ?? task,
        }));
        const artifact = await this.materialize(operator.operatorID, info);
        outputs.set(operator.operatorID, structuredClone({ operator, info, artifact, previewSources }));
      } catch (error) {
        errors.push(`${operator.operatorID} at task ${task}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return errors;
  }

  /** The complete engine output behind a display result, copied once per
   * result version. A direct return and the later seal of the same task share
   * the copy, so delivering a whole answer never retains anything twice. */
  async materialize(operator: string, info: OperatorInfo): Promise<RetainedResult> {
    if (!isSuccessfulOperatorResult(info) || !info.resultVersion?.id || !info.materialization?.executionId)
      throw new Error(`${operator} has no complete engine materialization to retain`);
    const key = info.resultVersion.id;
    let artifact = this.retained.get(key);
    if (!artifact) {
      artifact = await this.retain(operator, info);
      if (!artifact.path || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.rowCount !== info.totalRowCount)
        throw new Error("Retention did not confirm the complete output");
      this.retained.set(key, artifact);
    }
    return artifact;
  }

  resolve(reference: Exclude<TaskInput, string>): TaskOutput {
    const output =
      Number.isSafeInteger(reference.atTask) && reference.atTask > 0
        ? this.tasks.get(reference.atTask)?.get(reference.operator)
        : undefined;
    if (!output)
      throw new Error(
        `Historical output ${reference.operator} at task ${reference.atTask} is unavailable. Choose an existing recorded task output; current data is not a substitute.`
      );
    return structuredClone(output);
  }

  available(operator: string): number[] {
    return [...this.tasks].filter(([, outputs]) => outputs.has(operator)).map(([task]) => task);
  }
  catalog(): Array<{ task: number; operators: string[] }> {
    return [...this.tasks].map(([task, outputs]) => ({ task, operators: [...outputs.keys()] }));
  }
  record(task: number, receipt: TaskReceipt): void {
    if (this.receipts.has(task)) throw new Error(`Task ${task} already has a receipt`);
    this.receipts.set(task, structuredClone(receipt));
  }
  receipt(task: number): TaskReceipt | undefined {
    const receipt = this.receipts.get(task);
    return receipt && structuredClone(receipt);
  }

  /** The completed task that already delivered this operator as its answer.
   * An answer belongs to the question that asked for it. */
  answeredBy(operator: string): number | undefined {
    for (const [task, receipt] of [...this.receipts].sort(([a], [b]) => b - a))
      if (receipt.returnedOperator === operator) return task;
    return undefined;
  }
  clear(): void {
    this.tasks.clear();
    this.retained.clear();
    this.receipts.clear();
  }
  has(task: number): boolean {
    return this.tasks.has(task);
  }

  /** Runtime-only source: no live edge back to the producer, so revisions
   * cannot invalidate this fixed input. Files never enter the model catalog. */
  source(
    reference: Exclude<TaskInput, string>,
    state: WorkflowState,
    metadata: WorkflowSystemMetadata,
    profiles = false
  ): string {
    const output = this.resolve(reference);
    const id = taskInputId(reference);
    const existing = state.getOperator(id);
    if (existing) {
      if (existing.taskSource?.operator !== reference.operator || existing.taskSource.atTask !== reference.atTask)
        throw new Error("Historical source collision");
      return id;
    }
    const code = [
      "def load():",
      "    import hashlib, pandas as pd, pyarrow as pa, pyarrow.ipc as ipc",
      `    path = ${JSON.stringify(output.artifact.path)}`,
      "    with open(path, 'rb') as stream:",
      "        digest = hashlib.file_digest(stream, 'sha256').hexdigest()",
      `    if digest != ${JSON.stringify(output.artifact.sha256)}:`,
      "        raise ValueError('Retained task output is missing or has changed')",
      "    with pa.memory_map(path, 'r') as stream:",
      "        table = ipc.open_file(stream).read_all()",
      "    types = {pa.int32(): pd.Int64Dtype(), pa.int64(): pd.Int64Dtype(), pa.bool_(): pd.BooleanDtype(), pa.float64(): pd.Float64Dtype(), pa.string(): pd.StringDtype()}",
      "    return table.to_pandas(types_mapper=types.get)",
    ].join("\n");
    const util = new WorkflowUtilService(metadata, state);
    const base = util.getNewOperatorPredicate("DataLoading", `${reference.operator} at task ${reference.atTask}`);
    state.addOperator({
      ...base,
      operatorID: id,
      operatorProperties: { ...base.operatorProperties, code },
      taskSource: reference,
      nativeOp: {
        type: "TaskResult",
        properties: reference,
        inputs: [],
        version: "v2",
        revision: output.artifact.sha256.slice(0, 16),
        profileCollection: profiles,
      },
    });
    return id;
  }
}

/** Resolve only operator-input slots; column lists and callback text are data. */
export function resolveTaskInputs(
  params: Record<string, unknown>,
  arity: number | "many",
  history: TaskHistory,
  state: WorkflowState,
  metadata: WorkflowSystemMetadata,
  profiles = false
): { params: Record<string, unknown>; references: TaskInput[] } {
  const references: TaskInput[] = [];
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.startsWith(TASK_SOURCE_PREFIX))
        throw new Error("Internal historical sources must be referenced with {operator, atTask}");
      references.push(value);
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const ref = value as Exclude<TaskInput, string>;
    if (
      Object.keys(ref).sort().join() !== "atTask,operator" ||
      typeof ref.operator !== "string" ||
      !Number.isSafeInteger(ref.atTask) ||
      ref.atTask < 1
    )
      throw new Error(
        "Historical input requires {operator: string, atTask: positive integer}; a kept frame is {operator, frame} or {operator, atTask, frame}."
      );
    references.push(ref);
    return history.source(ref, state, metadata, profiles);
  };
  const next = { ...params };
  if (arity === 1) next.input = resolve(next.input);
  else if (arity === 2) {
    next.left = resolve(next.left);
    next.right = resolve(next.right);
  } else if (arity === "many" && Array.isArray(next.inputs)) next.inputs = next.inputs.map(resolve);
  return { params: next, references };
}
