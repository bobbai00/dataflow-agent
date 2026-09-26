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

/**
 * Registered operators: a `def` the model calls by name as an operator
 * (`ranked = rank_by_score(scores, top=5)`). Registration is a fact of the
 * graph, not a declaration: the def persists with the tables that call it
 * (shared functions), so the index reads them from the current operators.
 */
import type { NativeOpView } from "./catalog";
import { docstringOf, signatureOfSource } from "./catalog";
import type { WorkflowState } from "../workflow-state";

export interface RegisteredOperator {
  name: string;
  /** `rank_by_score(scores, top=10)`: tables, then settings with defaults. */
  signature: string;
  doc?: string;
  source: string;
  /** Tables that call it, in graph order. */
  consumers: string[];
}

/** A process compiled from a registered call. */
export function isRegisteredCall(view: Pick<NativeOpView, "type" | "properties"> | undefined): boolean {
  return !!view && view.type === "Process" && view.properties.params !== undefined && typeof view.properties.entry === "string";
}

/** The defs called as operators in the current graph, with their consumers. */
export function registeredOperators(state: WorkflowState): RegisteredOperator[] {
  const byName = new Map<string, RegisteredOperator>();
  for (const op of state.getAllOperators()) {
    const view = op.nativeOp;
    if (!view || op.taskSource || !isRegisteredCall(view)) continue;
    const name = String(view.properties.entry);
    const source = view.functions?.[name];
    if (!source) continue;
    const current = byName.get(name);
    if (current) {
      current.consumers.push(op.operatorID);
      continue;
    }
    byName.set(name, {
      name,
      signature: signatureOfSource(source, name),
      doc: docstringOf(source, name),
      source,
      consumers: [op.operatorID],
    });
  }
  return [...byName.values()];
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

/** The `Your operators` block of a task-start index. Empty when none exist. */
export function renderRegisteredOperators(state: WorkflowState, version?: (name: string) => number): string[] {
  const list = registeredOperators(state);
  if (!list.length) return [];
  return [
    "Your operators (defs called by name, like any operator; settings shown with their defaults):",
    ...list.map(item => {
      const k = version?.(item.name) ?? 1;
      const used = item.consumers.slice(0, 4).join(", ") + (item.consumers.length > 4 ? ` +${item.consumers.length - 4}` : "");
      return `${item.signature}${item.doc ? ` "${clip(item.doc, 110)}"` : ""}${k > 1 ? ` v${k}` : ""} — used by ${used}`;
    }),
  ];
}
