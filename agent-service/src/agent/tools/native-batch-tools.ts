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
 * Receipt accounting shared by the `dataflow` tool's results: which operators a
 * call changed and which results it read. The tool itself is in
 * tools/turn-tool.ts.
 */

import type { ReActStep } from "../../types/agent";
import type { NativeOpView } from "../native/catalog";
import type { NativeDiagnostic } from "../native/diagnostics";
import { asDataflowActionsResult } from "./dataflow-actions";

export const TOOL_NAME_DATAFLOW = "dataflow";

export interface NativeBatchOutcome {
  id: string;
  /** Surface operator name (`filter`), or whatever was written when unknown. */
  op: string;
  status: "added" | "modified" | "deleted" | "error" | "blocked";
  message: string;
  diagnostic?: NativeDiagnostic;
  /** For error/blocked outcomes: the definition as written, for diagnostics. */
  attempted?: NativeOpView;
}

/** Stored as the tool result on the owning ReAct event. Observation choices
 * are event facts, never mutable preferences on an operator. */
export interface NativeBatchResult {
  kind: "dataflow-actions";
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
}

export function asNativeBatchResult(output: unknown): NativeBatchResult | undefined {
  if (!output || typeof output !== "object") return undefined;
  const r = output as NativeBatchResult;
  return r.kind === "dataflow-actions" && Array.isArray(r.operators) && Array.isArray(r.observe) ? r : undefined;
}

export function nativeBatchResults(step: Pick<ReActStep, "toolCalls" | "toolResults">): NativeBatchResult[] {
  return (step.toolCalls ?? []).flatMap(tc => {
    if (tc.toolName !== TOOL_NAME_DATAFLOW) return [];
    const result = asNativeBatchResult(step.toolResults?.find(tr => tr.toolCallId === tc.toolCallId)?.output);
    return result ? [result] : [];
  });
}

export function batchObservedIds(step: Pick<ReActStep, "toolCalls" | "toolResults">): Set<string> | undefined {
  const results = nativeBatchResults(step).filter(result => {
    const actions = asDataflowActionsResult(result);
    // Structural inspection does not change which tables were read.
    return !actions || actions.actions.some(item => ["edit", "execute", "retrieve"].includes(item.action.type));
  });
  return results.length ? new Set(results.flatMap(r => r.observe)) : undefined;
}
