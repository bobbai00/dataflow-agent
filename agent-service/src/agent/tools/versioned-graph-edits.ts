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

import type { WorkflowContent } from "../../types/workflow";
import type { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { ToolContext } from "./workflow-crud-tools";
import { forkState, historicalTask, type HistoricalTask } from "../state-history";
import { restoreCommands, upstreamDrift } from "../state-ledger";
import { planGraphEdit } from "./graph-edits";
import { displayedOperatorId, resolveSavedOperator, savedResultSource } from "../saved-versions";

/** Version commands share the ordinary atomic draft and command order. No
 * snapshots, results or live graph are changed until the caller commits it. */
export function planVersionedGraphEdit(
  original: WorkflowContent,
  changes: string,
  context: ToolContext,
  storage: WorkflowSnapshotStorage,
  tasks: readonly HistoricalTask[]
) {
  return planGraphEdit(original, changes, context, (command, current) => {
    if (!context.settings?.stateHistory) throw new Error("Saved-version commands require stateHistory.");
    const task = historicalTask(tasks, command.task);
    if (command.sourceId) {
      const saved = resolveSavedOperator(storage, tasks, `${command.sourceId}@${command.task}`, false);
      if (!saved.op.nativeOp) throw new Error("Saved operator has no native definition.");
      const target = current.operators.find(op => op.operatorID === command.id);
      const drift = target ? upstreamDrift(storage, task, current, command.sourceId) : [];
      return {
        definition: saved.op,
        ...(command.create ? { inputs: saved.op.nativeOp.inputs.map(id => {
          const displayed = displayedOperatorId(saved.workflow, id);
          return displayed === id ? `${id}@${command.task}` : displayed;
        }) } : {}),
        state: command.create ? `created from ${saved.address}` : `updated from ${saved.address}`,
        note: command.create
          ? `Created ${command.id} from ${saved.address}'s definition, with saved direct inputs. It is a separate editable branch.`
          : `Updated ${command.id} from ${saved.address}'s definition on current inputs${drift.length ? `; inputs changed since then: ${drift.join(", ")}` : ""}. Execute affected targets to recompute.`,
      };
    }
    if (command.as) {
      const fork = forkState(current, storage, tasks, task.taskId, command.id, command.as);
      const copiedInputs = Object.entries(fork.mapping)
        .filter(([id]) => id !== command.id)
        .map(([from, to]) => `${from} → ${to}`);
      return {
        fork,
        state: `forked from task ${task.taskId}`,
        note: `Forked ${command.id} from task ${task.taskId} as ${command.as}${copiedInputs.length ? ` with its task-${task.taskId} inputs (${copiedInputs.join(", ")})` : ""}; retrieve ${command.as} for the saved result, or execute it after changing it.`,
      };
    }
    const restored = restoreCommands(storage, task, current, command.id);
    const drift = restored.existed ? upstreamDrift(storage, task, current, command.id) : [];
    return {
      restore: restored.commands,
      state: `restored from task ${task.taskId}`,
      note: restored.existed
        ? `Restored ${command.id}'s task-${task.taskId} definition in place; its inputs are today's${drift.length ? ` (changed since task ${task.taskId}: ${drift.join(", ")})` : " (unchanged since then)"}. Dependents are invalidated; execute to recompute.`
        : `Re-created ${command.id} from its task-${task.taskId} definition${restored.restoredInputs.length ? ` with edges from ${restored.restoredInputs.join(", ")}` : ""}.`,
    };
  }, address => {
    if (!context.settings?.stateHistory) throw new Error("Saved input references require stateHistory.");
    return savedResultSource(resolveSavedOperator(storage, tasks, address, true));
  });
}
