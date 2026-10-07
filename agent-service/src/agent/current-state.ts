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

/**
 * The state a task starts from: every table as the previous task left it, in
 * input order, with the call that defines it, its size, and what each earlier
 * task did to it. Rendered once per task from saved snapshots, so it stays
 * byte-identical while the task runs.
 */
import type { OperatorPredicate } from "../types/workflow";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type { TaskHistory } from "./task-history";
import { inlineCode, topologicalOperators } from "./native/observation-format";
import { displayedOperatorId } from "./saved-versions";
import { pyLiteral } from "./tools/shared-functions";

type View = NonNullable<OperatorPredicate["nativeOp"]>;
const CALL_CHARS = 240;

/** The call that defines a table, with its input tables first. */
export function callText(view: View, inputs: readonly string[]): string {
  const source = view.source ?? "";
  const open = source.indexOf("(");
  if (view.variant?.of || !inputs.length || open < 0) return source;
  const rest = source.slice(open + 1);
  return `${source.slice(0, open + 1)}${inputs.join(", ")}${rest.startsWith(")") ? "" : ", "}${rest}`;
}

/** What one task changed in a table's definition. */
function change(previous: View, now: View): string {
  if (JSON.stringify([previous.type, previous.properties]) === JSON.stringify([now.type, now.properties])) return "changed its inputs";
  const sameCode =
    now.type === "Process" &&
    previous.type === "Process" &&
    previous.properties.code === now.properties.code &&
    previous.properties.entry === now.properties.entry;
  if (sameCode) {
    const before = previous.settings ?? {};
    const after = now.settings ?? {};
    const moved = Object.keys(after).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
    if (moved.length) return moved.map(name => `set ${name} ${pyLiteral(before[name])} to ${pyLiteral(after[name])}`).join(", ");
  }
  return "changed the definition";
}

/** `startStepId` is the step the new task starts from: its workflow is the
 * current state, and the earlier tasks' snapshots give each table's history. */
export function renderCurrentState(
  storage: WorkflowSnapshotStorage,
  tasks: readonly TaskHistory[],
  startStepId: string | undefined
): string | undefined {
  const last = tasks.at(-1);
  if (!last) return undefined;
  const snapshots = tasks.map(task => ({ taskId: task.taskId, workflow: storage.getWorkflow(task.stepId) }));
  const workflow = storage.getWorkflow(startStepId ?? last.stepId);
  const tables = topologicalOperators(workflow.operators).filter(
    op => op.nativeOp && !op.savedResult && !(op.nativeOp.variant && op.nativeOp.variant.name !== op.operatorID)
  );
  if (!tables.length) return undefined;
  const lines = tables.map(op => {
    const view = op.nativeOp!;
    let call = callText(view, view.inputs.map(id => displayedOperatorId(workflow, id)));
    if (call.length > CALL_CHARS) call = `${call.slice(0, CALL_CHARS)}…`;
    const info = storage.getOperatorResult(startStepId ?? last.stepId, op.operatorID);
    const done = !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);
    const rows = done ? `${(info!.totalRowCount ?? info!.outputTuples).toLocaleString("en-US")} rows` : "no result";
    const events: string[] = [];
    const seen: Array<{ taskId: number; revision?: string }> = [];
    let previous: View | undefined;
    for (const { taskId, workflow: saved } of snapshots) {
      const now = saved.operators.find(item => item.operatorID === op.operatorID && !item.savedResult)?.nativeOp;
      if (!now) {
        previous = undefined;
        continue;
      }
      if (!previous) events.push(`task ${taskId} created it`);
      else if (now.revision !== previous.revision) {
        const restored = seen.slice(0, -1).reverse().find(item => item.revision === now.revision);
        events.push(restored ? `task ${taskId} restored task ${restored.taskId}'s version` : `task ${taskId} ${change(previous, now)}`);
      }
      seen.push({ taskId, revision: now.revision });
      previous = now;
    }
    const doc = view.properties.shared === true && typeof view.properties.doc === "string" && view.properties.doc;
    return [`- ${inlineCode(op.operatorID)} = ${inlineCode(call)}; ${rows}; ${events.join("; ")}`, ...(doc ? [`  - doc: ${doc}`] : [])].join("\n");
  });
  return [
    "# Current state",
    "",
    `The tables as this task starts, inputs first. Change them by name; \`name@N\` is a table as it was at the end of task N.`,
    "",
    ...lines,
  ].join("\n");
}
