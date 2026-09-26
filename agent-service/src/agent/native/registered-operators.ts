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
 * The operators a model defines: a `def` with a docstring, called by name
 * like any operator (`top_edu = band_report(cleaned, band_column="prevEducation")`).
 * Its parameters are its arguments, its docstring is its doc written over
 * them, and it is listed in the index the way the built-ins are listed in the
 * catalog: signature, doc, one example call. Registration is a fact of the
 * graph, not a declaration: the def persists with the tables that call it
 * (shared functions); a def made by `lift` waits in the registry until called.
 */
import type { NativeOpView } from "./catalog";
import { docstringOf, signatureOfSource } from "./catalog";
import type { WorkflowState } from "../workflow-state";
import type { DefinitionRegistry } from "./definition-registry";

export interface RegisteredOperator {
  name: string;
  /** `band_report(T, band_column, value, top=5)`: the parameters with their defaults. */
  signature: string;
  /** The docstring: the doc written over the parameters. */
  doc?: string;
  source: string;
  /** Tables that call it, in graph order. */
  consumers: string[];
  /** The statement of the first table that calls it. */
  example?: string;
  /** Made by `lift` from this def. */
  from?: string;
}

/** A process compiled from a registered call. */
export function isRegisteredCall(view: Pick<NativeOpView, "type" | "properties"> | undefined): boolean {
  return (
    !!view && view.type === "Process" && view.properties.params !== undefined && typeof view.properties.entry === "string"
  );
}

/** The defs called as operators in the current graph, with their consumers,
 * plus the lifted defs the registry holds that nothing calls yet. */
export function registeredOperators(
  state: WorkflowState,
  registry?: Pick<DefinitionRegistry, "liftedOperators">
): RegisteredOperator[] {
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
      ...(view.source ? { example: view.source } : {}),
    });
  }
  for (const item of registry?.liftedOperators() ?? []) {
    const current = byName.get(item.name);
    if (current) {
      current.from = item.from;
      continue;
    }
    byName.set(item.name, {
      name: item.name,
      signature: signatureOfSource(item.source, item.name),
      doc: docstringOf(item.source, item.name),
      source: item.source,
      consumers: [],
      from: item.from,
    });
  }
  return [...byName.values()];
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

/** The `Your operators` block of an index, in the catalog's own format:
 * `T2 = signature`, then the doc, an example call, the version and the
 * tables that call it. Empty when none exist. */
export function renderRegisteredOperators(
  state: WorkflowState,
  version?: (name: string) => number,
  registry?: Pick<DefinitionRegistry, "liftedOperators">
): string[] {
  const list = registeredOperators(state, registry);
  if (!list.length) return [];
  return [
    "Your operators (call them like any operator; the doc reads with the arguments of the call):",
    ...list.map(item => {
      const k = version?.(item.name) ?? 1;
      const used =
        item.consumers.slice(0, 4).join(", ") + (item.consumers.length > 4 ? ` +${item.consumers.length - 4}` : "");
      const tail = [
        item.example ? `Example: \`${clip(item.example, 160)}\`.` : "",
        k > 1 ? `v${k}.` : "",
        item.consumers.length ? `Used by ${used}.` : `Not called yet${item.from ? ` (lifted from ${item.from})` : ""}.`,
      ]
        .filter(Boolean)
        .join(" ");
      return `T2 = ${item.signature}\n    ${item.doc ? clip(item.doc, 220) + " " : ""}${tail}`;
    }),
  ];
}
