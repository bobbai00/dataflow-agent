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

/** What the model reads: what the user did, then the receipt the call produced
 * (absent while the call is still running). */
export function userActionContent(
  action: UserActionRequest,
  previous: string | undefined,
  result?: DataflowActionsResult
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
  }
  return result ? `${lines.join("\n")}\n\n${renderDataflowActionsResult(result)}` : lines.join("\n");
}
