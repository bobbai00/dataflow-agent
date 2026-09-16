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
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import type { WorkflowState } from "../workflow-state";
import { WorkflowUtilService } from "../util/workflow-utils";
import type { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

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

/** Session-owned bindings. Only the runtime creates them; model references
 * select existing data. Retention is independent of evictable engine caches. */
export class TaskHistory {
  private readonly tasks = new Map<number, Map<string, TaskOutput>>();
  private readonly retained = new Map<string, RetainedResult>();
  constructor(private readonly retain: (operator: string, info: OperatorInfo) => Promise<RetainedResult>) {}

  async seal(task: number, operators: OperatorPredicate[], results: Map<string, OperatorInfo>): Promise<string[]> {
    if (this.tasks.has(task)) throw new Error(`Task ${task} is already sealed`);
    const outputs = new Map<string, TaskOutput>();
    this.tasks.set(task, outputs);
    const errors: string[] = [];
    for (const operator of operators) {
      if (operator.taskSource) continue;
      const info = results.get(operator.operatorID);
      if (
        !info ||
        info.error ||
        !info.resultVersion?.id ||
        !info.materialization?.executionId ||
        !["Completed", "COMPLETED", "Cached", "CACHED"].includes(info.state)
      )
        continue;
      try {
        const key = info.resultVersion.id;
        let artifact = this.retained.get(key);
        if (!artifact) {
          artifact = await this.retain(operator.operatorID, info);
          if (!artifact.path || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.rowCount !== info.totalRowCount)
            throw new Error("Retention did not confirm the complete output");
          this.retained.set(key, artifact);
        }
        outputs.set(operator.operatorID, structuredClone({ operator, info, artifact }));
      } catch (error) {
        errors.push(`${operator.operatorID} at task ${task}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return errors;
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
  clear(): void {
    this.tasks.clear();
    this.retained.clear();
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
      throw new Error("Historical input requires {operator: string, atTask: positive integer}");
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
