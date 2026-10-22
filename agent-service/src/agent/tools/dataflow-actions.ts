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
 * The action list a `dataflow` call becomes (native/turn-syntax.ts), and the
 * receipt it produces. The agent resolves the list after the step's snapshot
 * exists (tools/dataflow-action-runtime.ts); the receipt is rendered by
 * statement (native/turn-receipt.ts).
 */
import type { NativeBatchOutcome } from "./native-batch-tools";
import type { RetrievalView } from "../../types/agent";
import type { ObservationFormatSettings } from "../native/observation-format";
import { renderTurnReceipt } from "../native/turn-receipt";
import type { TurnReceiptInfo } from "../native/turn-syntax";

export type DataflowAction =
  | { type: "inspect"; target: "reference"; topic: "operators"; operator_names: string[] }
  | { type: "inspect"; target: "namespace"; names: string[]; include_implementation: boolean }
  | { type: "inspect"; target: "schema"; operator_id: string; offset?: number; limit?: number }
  | { type: "inspect"; target: "operator"; operator_id: string; include_implementation: boolean }
  | { type: "edit"; python: string; changes: string }
  | { type: "execute"; operator_ids?: string[] }
  | { type: "retrieve"; operator_ids: string[]; view: RetrievalView; columns?: string[] };

export interface ActionOutcome {
  status: "ok" | "error";
  output: unknown;
}

export interface DataflowActionsResult {
  kind: "dataflow-actions";
  protocol: "registered-python-v1";
  status: "pending" | "completed" | "error";
  actions: Array<{
    index: number;
    action: DataflowAction;
    status: "pending" | "ok" | "error" | "skipped";
    output?: unknown;
  }>;
  // The snapshot renderers and access accounting use these receipts.
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
  error?: string;
  /** Frozen settings for this receipt; later settings changes do not rewrite it. */
  format?: ObservationFormatSettings;
  /** The statements of the call, so the receipt is rendered by statement. */
  turn?: TurnReceiptInfo;
  /** A later call of a response that ran as part of that response's first call. */
  mergedInto?: string;
  /** The reply an answer statement rendered (AgentSettings.answerStatement); it ends the request. */
  answer?: string;
  /** Why the call's answer statement rendered no reply. */
  answerError?: string;
}

export const EMPTY_DATAFLOW_ERROR = "The dataflow is empty. Add an operator before execute.";

/** A rejected call: nothing ran, and the receipt says why. */
export function rejectedActions(message: string, turn?: TurnReceiptInfo): DataflowActionsResult {
  return {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: "error",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
    error: `${message} No actions ran.`,
    ...(turn ? { turn } : {}),
  };
}

/** Check a parsed action list against this session before anything runs. */
export function prepareActions(
  actions: DataflowAction[],
  views: readonly RetrievalView[],
  turn?: TurnReceiptInfo
): DataflowActionsResult {
  for (const action of actions) {
    if (action.type === "edit" && !action.python.trim() && !action.changes.trim())
      return rejectedActions("An edit needs definitions or statements.", turn);
    const selected =
      action.type === "execute" || action.type === "retrieve"
        ? action.operator_ids
        : action.type === "inspect" && action.target === "namespace"
          ? action.names
          : action.type === "inspect" && action.target === "reference"
            ? action.operator_names
            : undefined;
    if (selected && new Set(selected).size !== selected.length)
      return rejectedActions("Selected names must be unique.", turn);
    if (action.type === "retrieve" && !views.includes(action.view))
      return rejectedActions(
        `The view ${JSON.stringify(action.view)} is unavailable; use ${views.join(" or ")}.`,
        turn
      );
  }
  return {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: "pending",
    actions: structuredClone(actions).map((action, i) => ({ index: i + 1, action, status: "pending" })),
    operators: [],
    observe: [],
    observationErrors: [],
    ...(turn ? { turn } : {}),
  };
}

export function asDataflowActionsResult(output: unknown): DataflowActionsResult | undefined {
  if (!output || typeof output !== "object") return undefined;
  const r = output as DataflowActionsResult;
  return r.kind === "dataflow-actions" && Array.isArray(r.actions) ? r : undefined;
}

/** Run the pending actions in order. After a failure the rest are skipped,
 * except that reads and executions still run after a failed execution, so the
 * results that did complete can be read. `settled` follows each action that ran. */
export async function runDataflowActions(
  result: DataflowActionsResult,
  settled: (() => void) | undefined,
  run: (action: DataflowAction, index: number) => Promise<ActionOutcome>
): Promise<void> {
  if (result.status !== "pending") return;
  let afterFailedExecution = false;
  for (const item of result.actions) {
    const canContinue = afterFailedExecution && item.action.type !== "edit";
    if (result.error && !canContinue) {
      item.status = "skipped";
      item.output = "Not run because an earlier action failed.";
      // A later execution may rely on this planned edit. Never run it against
      // the old graph after skipping the requested edit.
      if (item.action.type === "edit") afterFailedExecution = false;
      continue;
    }
    try {
      const outcome = await run(item.action, item.index);
      item.status = outcome.status;
      item.output = structuredClone(outcome.output);
      if (outcome.status === "error")
        result.error ??= `Action ${item.index} (${item.action.type}) failed: ${typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output)}`;
    } catch (error) {
      item.status = "error";
      item.output = error instanceof Error ? error.message : String(error);
      result.error ??= `Action ${item.index} (${item.action.type}) failed: ${item.output}`;
    }
    if (item.action.type === "execute" && item.status === "error") afterFailedExecution = true;
    settled?.();
  }
  result.status = result.error ? "error" : "completed";
}

export function renderDataflowActionsResult(result: DataflowActionsResult): string {
  return renderTurnReceipt(result, result.turn);
}
