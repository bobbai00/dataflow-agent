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

/**
 * Canvas actions: the user edits or runs one native operator directly. Each
 * is recorded as a user step carrying the equivalent `dataflow` call, so the
 * edit and the execution take exactly the path the agent's own calls take,
 * and the step's content tells the model what the user did and what came of
 * it, at the point in the conversation where it happened.
 */
import type { WorkflowContent } from "../types/workflow";
import { nativeAssignmentText } from "./native/catalog";
import { renderDataflowActionsResult, type DataflowActionsResult } from "./tools/dataflow-actions";

export type UserActionRequest =
  | { kind: "edit"; operatorId: string; statement: string; python?: string; run?: boolean }
  | { kind: "run"; operatorId: string };

/** A canvas action that cannot be applied; nothing was recorded. */
export class UserActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/** The `dataflow` call a canvas action makes. Showing a result computes what is stale first. */
export function userActionCall(action: UserActionRequest): { python: string; statements: string } {
  const show = `show result ${action.operatorId}`;
  if (action.kind === "run") return { python: "", statements: show };
  return {
    python: action.python?.trim() ? action.python : "",
    statements: [action.statement.trim(), ...(action.run ? [show] : [])].join("\n"),
  };
}

/** Rows of the operator's result after the call, when it computed one. */
export function userActionRows(result: DataflowActionsResult, operatorId: string): number | undefined {
  for (const item of [...result.actions].reverse()) {
    if (item.action.type !== "execute" || item.status === "skipped") continue;
    const outcome = (item.output as { operators?: Array<{ id: string; rows?: number }> } | undefined)?.operators?.find(
      operator => operator.id === operatorId
    );
    if (typeof outcome?.rows === "number") return outcome.rows;
  }
  return undefined;
}

/** The last version the call made: its edit's, run's or show's, whichever came last. */
export function userActionVersion(result: DataflowActionsResult): number | undefined {
  let last: number | undefined;
  for (const item of result.actions) {
    const output = item.output as { versions?: Array<{ version: number }>; version?: { version: number } } | undefined;
    last = output?.versions?.at(-1)?.version ?? output?.version?.version ?? last;
  }
  return last;
}

/** What the model reads: what the user did, then the receipt the call produced
 * (absent while the call is still running). `respond`: the agent responds to
 * the result in a turn of its own (AgentSettings.respondToCanvasRuns). */
export function userActionContent(
  action: UserActionRequest,
  previous: string | undefined,
  result?: DataflowActionsResult,
  respond = false,
  /** The edit changed the definition but kept the doc written for the old one. */
  staleDoc = false
): string {
  const id = `\`${action.operatorId}\``;
  const lines: string[] = [];
  if (action.kind === "run") lines.push(`I ran ${id} on the canvas.`);
  else {
    const statement = action.statement.trim();
    lines.push(`I ${action.run ? "edited and ran" : "edited"} ${id} on the canvas. Its definition is now:`, statement);
    if (action.python?.trim()) lines.push("with this Python definition:", action.python.trim());
    if (previous && previous.trim() !== statement) lines.push(`It was: ${previous.trim()}`);
    lines.push(`Keep my change when you restate ${id}.`);
    // The canvas shows the doc, so it must say what the operator now does.
    if (staleDoc) lines.push(`Its doc still describes the earlier definition: restate ${id} with a doc that fits.`);
  }
  if (respond) lines.push("What does this result mean for my request?");
  return result ? `${lines.join("\n")}\n\n${renderDataflowActionsResult(result)}` : lines.join("\n");
}

/** What the model reads when the user restores a version from the middle of
 * one of its calls: which of that call's edits are undone. */
export function restoreContent(
  version: number,
  operatorId: string | undefined,
  restored: WorkflowContent,
  undone: WorkflowContent
): string {
  const now = new Map(restored.operators.map(op => [op.operatorID, op]));
  const was = new Map(undone.operators.map(op => [op.operatorID, op]));
  const removed = [...was.keys()].filter(id => !now.has(id));
  const back = [...now.keys()].filter(
    id => !was.has(id) || JSON.stringify(was.get(id)!.nativeOp) !== JSON.stringify(now.get(id)!.nativeOp)
  );
  const lines = [
    `I restored v${version} of the dataflow${operatorId ? `, as it was right after your edit of \`${operatorId}\`` : ""}; the later edits of that call are undone.`,
  ];
  if (removed.length) lines.push(`No longer defined: ${removed.map(id => `\`${id}\``).join(", ")}.`);
  const statements = back.flatMap(id => {
    const view = now.get(id)!.nativeOp;
    const text = view ? nativeAssignmentText(id, view) : undefined;
    return text ? [text] : [];
  });
  if (statements.length) lines.push("Defined as before:", ...statements);
  return lines.join("\n");
}
