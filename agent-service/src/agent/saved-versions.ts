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

import { createHash } from "node:crypto";
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";
import { compileNativeOp, nativeRevision } from "./native/codegen";
import type { NativeOpView } from "./native/catalog";
import { historicalTask, type HistoricalTask } from "./state-history";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";

export interface OperatorReference { operatorId: string; taskId?: number }

/** Task numbers are addresses, not part of the Python operator identifier. */
export function parseOperatorReference(text: string): OperatorReference {
  const match = /^([A-Za-z_]\w*)(?:@([1-9]\d*))?$/.exec(text);
  const taskId = match?.[2] === undefined ? undefined : Number(match[2]);
  if (!match || (taskId !== undefined && !Number.isSafeInteger(taskId)))
    throw new Error(`Invalid operator reference ${JSON.stringify(text)}; use an ID or ID@positive_task_number.`);
  return { operatorId: match[1], ...(taskId === undefined ? {} : { taskId }) };
}

export interface SavedOperator {
  address: string;
  task: HistoricalTask;
  workflow: WorkflowContent;
  op: OperatorPredicate;
  info?: OperatorInfo;
}

/** Definition reads remain possible after a failed execution. Data reads and
 * graph inputs require the matching completed result, never a current fallback. */
export function resolveSavedOperator(
  storage: WorkflowSnapshotStorage,
  tasks: readonly HistoricalTask[],
  address: string,
  requireResult: boolean
): SavedOperator {
  const ref = parseOperatorReference(address);
  if (ref.taskId === undefined) throw new Error(`Historical reference ${address} needs @task_number.`);
  const task = historicalTask(tasks, ref.taskId);
  const workflow = storage.getWorkflow(task.stepId);
  const op = workflow.operators.find(op => op.operatorID === ref.operatorId && !op.isDisabled);
  if (!op) throw new Error(`Operator ${ref.operatorId} did not exist at task ${ref.taskId}'s save point.`);
  const info = storage.getOperatorResult(task.stepId, op.operatorID);
  if (requireResult && (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state) || !Array.isArray(info.result)))
    throw new Error(`HISTORICAL_RESULT_UNAVAILABLE: ${address} has no matching completed result. Its definition can still be read with view=null.`);
  return { address, task, workflow, op, info };
}

/** One virtual source, backed by one exact engine result. The throwing body is
 * deliberate: a missing/evicted materialization must never rerun today's files. */
export function savedResultSource(saved: SavedOperator): OperatorPredicate {
  const producer = saved.op.savedResult;
  const executionId = producer?.executionId ?? saved.info?.materialization?.executionId ?? saved.info?.resultVersion?.executionId;
  const operatorId = producer?.operatorId ?? saved.op.operatorID;
  const outputPort = producer?.outputPort ?? saved.info?.materialization?.outputPort ?? saved.info?.resultVersion?.outputPort;
  if (!executionId || !/^[1-9]\d*$/.test(executionId) || outputPort === undefined || outputPort === null || !Number.isSafeInteger(outputPort) || outputPort < 0)
    throw new Error(`HISTORICAL_RESULT_UNAVAILABLE: ${saved.address} has no exact engine materialization identity.`);
  const digest = createHash("sha256").update(JSON.stringify([saved.task.taskId, operatorId, executionId, outputPort])).digest("hex").slice(0, 12);
  const id = `_saved_${operatorId.slice(0, 24)}_${digest}`;
  const view: NativeOpView = {
    type: "Process", inputs: [], graph: { inputPorts: [] }, profileCollection: false,
    source: saved.address,
    properties: {
      code: 'def unavailable():\n    raise RuntimeError("HISTORICAL_RESULT_UNAVAILABLE: retained materialization required")',
      entry: "unavailable", doc: `Read the immutable result ${saved.address}`,
    },
  };
  view.revision = nativeRevision(view);
  const compiled = compileNativeOp(view, id);
  return {
    ...saved.op, operatorID: id, operatorType: compiled.operatorType,
    operatorProperties: { ...saved.op.operatorProperties, code: compiled.code },
    inputPorts: [], outputPorts: [{ portID: "output-0", displayName: "out" }],
    nativeOp: view, stateOrigin: undefined, customDisplayName: saved.address,
    savedResult: {
      taskId: saved.task.taskId, stepId: saved.task.stepId, operatorId, executionId, outputPort,
      ...(saved.info?.resultVersion?.id ? { resultVersion: saved.info.resultVersion.id } : {}),
    },
  };
}

export function displayedOperatorId(workflow: WorkflowContent, id: string): string {
  const saved = workflow.operators.find(op => op.operatorID === id)?.savedResult;
  return saved ? `${saved.operatorId}@${saved.taskId}` : id;
}
