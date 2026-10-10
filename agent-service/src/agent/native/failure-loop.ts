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
import type { ReActStep } from "../../types/agent";
import type { WorkflowContent } from "../../types/workflow";

/**
 * A model call that fails the same way as the previous one, against the same
 * graph, is a loop, not progress. In the 2026-10-08 pilots Qwen repeated
 * `execute *` 20 times and `retrieve r` 22 times, and DeepSeek sent 25
 * execute-only calls on an empty graph; each repetition is a full-context
 * request. After {@link REPEATED_FAILURE_WARNING} identical failures the model
 * receives one correction; after {@link REPEATED_FAILURE_LIMIT} the turn ends.
 * Any successful call, a different failure, or a changed graph resets the count.
 */
export const REPEATED_FAILURE_WARNING = 2;
export const REPEATED_FAILURE_LIMIT = 4;

export interface RepeatedFailure {
  /** Identity of the failure: what was attempted, how it failed, and against which graph. */
  signature: string;
  /** The first failure's message head, for the correction and the final error. */
  head: string;
  emptyGraph: boolean;
}

interface Receipt {
  kind: "dataflow-actions";
  protocol?: string;
  status: string;
  error?: string;
  actions: Array<{ action: { type: string }; status: string; output?: unknown }>;
}

function receipt(output: unknown): Receipt | undefined {
  const r = output as Receipt | undefined;
  return r && typeof r === "object" && r.kind === "dataflow-actions" && Array.isArray(r.actions) ? r : undefined;
}

function head(text: string): string {
  return text.split("\n")[0].trim().slice(0, 240);
}

function errorText(output: unknown): string {
  if (typeof output === "string") return output;
  const error = (output as { error?: unknown } | undefined)?.error;
  return typeof error === "string" ? error : JSON.stringify(output ?? "");
}

/** The failure identity of a step, or undefined when any of its dataflow calls
 * succeeded or it made none. Volatile details (timings, ids) are not part of a
 * receipt's error head, so equal heads mean the same rejection. */
export function repeatedFailure(step: ReActStep, workflow: WorkflowContent): RepeatedFailure | undefined {
  const calls = step.toolCalls ?? [];
  if (!calls.length) return undefined;
  const receipts = calls.map(call => receipt(step.toolResults?.find(r => r.toolCallId === call.toolCallId)?.output));
  if (receipts.some(r => !r || r.status !== "error")) return undefined;
  const failures = receipts.map(r => ({
    protocol: r!.protocol ?? "expression",
    error: head(r!.error ?? ""),
    actions: r!.actions.map(a => [a.action.type, a.status, a.status === "error" ? head(errorText(a.output)) : ""]),
  }));
  const graph = {
    operators: workflow.operators.map(op => [op.operatorID, op.nativeOp?.revision ?? op.operatorType]),
    namespace: workflow.nativeNamespace?.revision ?? "",
  };
  const first = failures[0];
  return {
    signature: createHash("sha256")
      .update(JSON.stringify([failures, graph]))
      .digest("hex"),
    head: first.error || first.actions.find(a => a[2])?.[2] || "the call failed",
    emptyGraph: workflow.operators.length === 0,
  };
}

/** One correction, appended as a user-role feedback step after the second identical failure. */
export function repeatedFailureFeedback(failure: RepeatedFailure, workflow: WorkflowContent): string {
  const operators = workflow.operators
    .slice(0, 12)
    .map(
      op => `${op.operatorID} (${op.nativeOp?.registeredName ?? op.nativeOp?.type?.toLowerCase() ?? op.operatorType})`
    );
  const functions = Object.values(workflow.nativeNamespace?.functions ?? {})
    .filter(f => f.exported)
    .map(f => f.name);
  const state = failure.emptyGraph
    ? "The graph is empty: execute and show result have nothing to compute until a set statement declares operators (set id: operator(...))."
    : `Current operators: ${operators.join(", ")}${workflow.operators.length > 12 ? ", …" : ""}.`;
  return (
    `The last two calls failed the same way: ${failure.head} Repeating the same call will fail again. ${state}` +
    (functions.length ? ` Registered functions: ${functions.join(", ")}.` : "") +
    " Fix the reported cause in the next call. Two more identical failures end this turn."
  );
}

export function repeatedFailureError(failure: RepeatedFailure): string {
  return `REPEATED_FAILURE_LOOP: ${REPEATED_FAILURE_LIMIT} consecutive model calls failed identically (${failure.head}). The turn ended without an answer. Correct the call or provider configuration before retrying.`;
}
