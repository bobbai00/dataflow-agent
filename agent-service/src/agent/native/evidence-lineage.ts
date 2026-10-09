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

import type { OperatorPredicate } from "../../types/workflow";
import type { NativeEvidenceContext } from "./evidence";

const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const record = (x: unknown): Record<string, any> =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : {};

/** Translate a requested output column to declared dependencies on one input.
 * This ranks existing evidence; it does not claim cellwise equivalence. */
function inputColumns(context: NativeEvidenceContext, op: OperatorPredicate, port: number, name: string): string[] {
  const view = op.nativeOp;
  if (!view) return [];
  const p = view.properties;
  switch (view.type) {
    case "Project": {
      const original = Object.entries(record(p.rename)).find(([, value]) => value === name)?.[0] ?? name;
      return (Array.isArray(p.keep) && !p.keep.includes(original)) || names(p.drop).includes(original)
        ? []
        : [original];
    }
    case "Map": {
      // The function returns the whole row, so both the output columns and
      // their dependencies are measured at execution; before a result exists
      // a column is assumed to pass through under its own name.
      const measured = record(
        context.resolveInput(op.operatorID)?.tableProfile?.native?.operations?.columnDependencies
      );
      return name in measured ? names(measured[name]) : [name];
    }
    case "Aggregate": {
      if (names(p.groupBy).includes(name)) return [name];
      const a = record((Array.isArray(p.aggregations) ? p.aggregations : []).find(c => record(c).as === name));
      return typeof a.col === "string" ? [a.col] : [];
    }
    case "Window": {
      const c = record((Array.isArray(p.columns) ? p.columns : []).find(c => record(c).as === name));
      return Object.keys(c).length
        ? [
            ...(typeof c.col === "string" ? [c.col] : []),
            ...names(p.partitionBy),
            ...(Array.isArray(p.orderBy) ? p.orderBy : []).flatMap(c =>
              typeof record(c).col === "string" ? [record(c).col] : []
            ),
          ]
        : [name];
    }
    case "Unpivot":
      return name === (p.valueColumn ?? "value") || name === (p.nameColumn ?? "variable") ? names(p.columns) : [name];
    case "Pivot":
      return names(p.index).includes(name) ? [name] : names([p.values, p.columns]);
    case "Join": {
      const left = new Set(context.resolveInput(view.inputs[0])?.resultSchema?.map(c => c.name));
      const right = new Set(context.resolveInput(view.inputs[1])?.resultSchema?.map(c => c.name));
      const keys = typeof p.on === "string" ? [p.on] : Array.isArray(p.on) ? p.on : [];
      const sharedKey = keys.some(key => key === name || (Array.isArray(key) && key[0] === name && key[1] === name));
      if (sharedKey) return [name];
      if (port === 0) return left.has(name) ? [name] : [];
      if (right.has(name) && !left.has(name)) return [name];
      const suffix = typeof p.rightSuffix === "string" ? p.rightSuffix : "_right";
      const original = suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
      const coalesced = keys.some(
        key => key === original || (Array.isArray(key) && key[0] === original && key[1] === original)
      );
      return !coalesced && right.has(original) && left.has(original) ? [original] : [];
    }
    case "Cast":
    case "Filter":
    case "Distinct":
    case "Sort":
    case "Limit":
    case "Union":
      return [name];
    default:
      return []; // Process and unknown contracts are opaque, never parse code.
  }
}

/** Bounded downstream walk over this event's DAG only, not a future live DAG. */
export function downstreamRelevantColumns(
  context: NativeEvidenceContext,
  declared: (op: OperatorPredicate) => string[]
): Set<string> {
  type Edge = { op: OperatorPredicate; port: number };
  const consumers = new Map<string, Edge[]>();
  for (const op of context.workflow.operators)
    op.nativeOp?.inputs.forEach((id, port) => {
      const edges = consumers.get(id) ?? [];
      edges.push({ op, port });
      consumers.set(id, edges);
    });
  const relevant = new Set(declared(context.op));
  const queue: Array<{ id: string; path: Edge[] }> = [{ id: context.op.operatorID, path: [] }];
  let edges = 0;
  for (let visited = 0; queue.length && visited < 64; visited++) {
    const { id, path } = queue.shift()!;
    if (path.length >= 8) continue;
    for (const edge of consumers.get(id) ?? []) {
      if (++edges > 64) return relevant;
      if (
        !edge.op.nativeOp ||
        edge.op.nativeOp.type === "Process" ||
        edge.op.operatorID === context.op.operatorID ||
        path.some(e => e.op.operatorID === edge.op.operatorID)
      )
        continue;
      let dependencies = declared(edge.op);
      for (const step of [...path].reverse())
        dependencies = [...new Set(dependencies.flatMap(name => inputColumns(context, step.op, step.port, name)))];
      dependencies.forEach(name => relevant.add(name));
      queue.push({ id: edge.op.operatorID, path: [...path, edge] });
    }
  }
  return relevant;
}

/** A stored child must name the exact current input version, port and revision.
 * Mere matching row counts never authorize traversal. */
export function boundInputs(context: NativeEvidenceContext): NativeEvidenceContext[] {
  const v = context.info.resultVersion;
  const view = context.op.nativeOp;
  if (
    context.info.error ||
    !view ||
    !v?.complete ||
    v.operatorId !== context.op.operatorID ||
    v.operatorRevision !== view.revision ||
    v.inputs.length !== view.inputs.length
  )
    return [];
  return view.inputs.flatMap((id, i) => {
    const op = context.workflow.operators.find(o => o.operatorID === id);
    const info = context.resolveInput(id);
    const input = info?.resultVersion;
    const ref = v.inputs[i];
    if (
      !op ||
      !op.nativeOp ||
      !info ||
      info.error ||
      !input?.complete ||
      input.operatorId !== id ||
      input.operatorRevision !== op.nativeOp.revision ||
      input.workflowId !== v.workflowId ||
      ref.operatorId !== id ||
      ref.inputIndex !== i ||
      ref.outputPort !== input.outputPort ||
      ref.resultVersion !== input.id
    )
      return [];
    return [{ ...context, op, info, columns: undefined }];
  });
}
