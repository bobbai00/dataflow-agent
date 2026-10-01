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

import { WorkflowState } from "../workflow-state";
import { WorkflowUtilService } from "../util/workflow-utils";
import { autoLayoutWorkflow } from "../util/auto-layout";
import type { WorkflowContent } from "../../types/workflow";
import type { ToolContext } from "./workflow-crud-tools";
import type { NativeBatchOutcome } from "./native-batch-tools";
import {
  NATIVE_BY_NAME,
  NATIVE_BY_TYPE,
  nativeOperatorName,
  type NativeOpView,
  type ParsedFunction,
  type ParsedStatement,
} from "../native/catalog";
import { normalizeStatement } from "../native/program";
import { compileNativeOp, nativeRevision, runNativePython, validateNativeOperators } from "../native/codegen";
import { computeStaleResultOps } from "../workflow-snapshot-storage";
import { nativeLineage } from "./native-upsert";

type Edge = { source: string; sourcePort: string; target: string; targetPort: string };
type Command = Edge & {
  operation: string;
  id: string;
  expression: string;
  statement: ParsedStatement;
  functions: Record<string, ParsedFunction>;
  line: number;
};
export interface GraphChangeReceipt {
  operation: string;
  operator_id?: string;
  edge?: string;
  deleted_edges?: string[];
}
export interface GraphEditPlan {
  workflow: WorkflowContent;
  operators: NativeBatchOutcome[];
  changes: GraphChangeReceipt[];
  unconnected_inputs: string[];
  invalidated_results: string[];
}

const edgeText = (e: Edge) => `${e.source}.${e.sourcePort} -> ${e.target}.${e.targetPort}`;
const indexed = (count: number) => Array.from({ length: count }, (_, i) => `in[${i}]`);
function ports(view: NativeOpView): string[] {
  if (view.graph) return view.graph.inputPorts;
  const arity = NATIVE_BY_TYPE.get(view.type)?.inputs;
  return arity === 0 ? [] : arity === 1 ? ["in"] : arity === 2 ? ["left", "right"] : indexed(view.inputs.length);
}
function edgesOf(workflow: WorkflowContent): Edge[] {
  const result: Edge[] = [];
  for (const op of workflow.operators) {
    const view = op.nativeOp;
    if (!view) continue;
    const names = ports(view);
    if (!view.graph) {
      // Legacy self-joins shared a physical port. Preserve both logical slots
      // when an archived expression workflow first receives a graph edit.
      view.inputs.forEach((source, i) =>
        result.push({ source, sourcePort: "out", target: op.operatorID, targetPort: names[i] })
      );
    } else {
      for (const link of workflow.links.filter(l => l.target.operatorID === op.operatorID)) {
        const i = op.inputPorts.findIndex(p => p.portID === link.target.portID);
        result.push({
          source: link.source.operatorID,
          sourcePort: "out",
          target: op.operatorID,
          targetPort: names[i] ?? link.target.portID,
        });
      }
    }
  }
  return result;
}
export function inspectGraph(workflow: WorkflowContent) {
  const edges = edgesOf(workflow);
  return {
    operators: workflow.operators.map(op => ({
      id: op.operatorID,
      type: op.nativeOp ? nativeOperatorName(op.nativeOp.type) : op.operatorType,
      ports: { inputs: op.nativeOp ? ports(op.nativeOp) : op.inputPorts.map(p => p.portID), outputs: ["out"] },
    })),
    edges: edges.map(edgeText),
    unconnected_inputs: workflow.operators.flatMap(op =>
      op.nativeOp
        ? ports(op.nativeOp)
            .filter(port => !edges.some(e => e.target === op.operatorID && e.targetPort === port))
            .map(port => `${op.operatorID}.${port}`)
        : []
    ),
  };
}
export function missingGraphInputs(workflow: WorkflowContent): string[] {
  return inspectGraph(workflow).unconnected_inputs;
}

function definition(command: Command, profileCollection?: boolean): NativeOpView {
  const def = NATIVE_BY_NAME.get(command.statement.op);
  if (!def) throw new Error(`Unknown operator ${command.statement.op}. Use an operator from the catalog.`);
  let names = def.inputs === 0 ? [] : def.inputs === 1 ? ["in"] : def.inputs === 2 ? ["left", "right"] : indexed(2);
  if (def.name === "process") {
    const fn = command.statement.kwargs.fn ?? command.statement.args[0];
    const params =
      fn?.kind === "lambda" ? fn.params : fn?.kind === "name" ? command.functions[fn.name]?.params : undefined;
    names = indexed(params?.length ?? 0);
  }
  const normalized = normalizeStatement(command.statement, command.functions, {
    profileCollection,
    explicitInputs: names.map((_, i) => `_unconnected_${i}`),
  });
  if (!normalized.view) throw new Error(normalized.error?.message ?? "Invalid operator expression.");
  return { ...normalized.view, inputs: names.map(() => ""), source: command.expression, graph: { inputPorts: names } };
}

/** Validate and compile against a private draft. The caller commits the returned
 * workflow only after checking cancellation/HEAD ownership. No mutation occurs here. */
export async function planGraphEdit(
  original: WorkflowContent,
  changes: string,
  context: ToolContext
): Promise<GraphEditPlan> {
  const parsed = (await runNativePython({ changes })) as { ok: boolean; commands?: Command[]; error?: string };
  if (!parsed.ok) throw new Error(`${parsed.error} No changes were applied.`);
  if (!context.metadataStore) throw new Error("Metadata store not available for graph editing.");
  const nodes = new Map<string, NativeOpView>();
  for (const op of original.operators) {
    if (!op.nativeOp) throw new Error(`Operator ${op.operatorID} is not a native operator.`);
    nodes.set(op.operatorID, { ...structuredClone(op.nativeOp), graph: { inputPorts: ports(op.nativeOp) } });
  }
  const edges = new Map(edgesOf(original).map(e => [edgeText(e), e]));
  const receipts: GraphChangeReceipt[] = [];
  const outcomes: NativeBatchOutcome[] = [];
  const changed = new Set<string>();
  let location = "";
  const required = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Operator ${id} does not exist.`);
    return node;
  };
  const validateEdge = (edge: Edge, grow = false) => {
    required(edge.source);
    const target = required(edge.target);
    if (edge.sourcePort !== "out") throw new Error(`Unknown output port ${edge.source}.${edge.sourcePort}; use out.`);
    if (target.type === "Union" && /^in\[(0|[1-9]\d*)\]$/.test(edge.targetPort) && grow) {
      const i = Number(edge.targetPort.slice(3, -1));
      if (i >= 256) throw new Error("Union supports input indices 0 through 255.");
      if (i >= ports(target).length) target.graph = { inputPorts: indexed(i + 1) };
    }
    if (!ports(target).includes(edge.targetPort))
      throw new Error(
        `Unknown input port ${edge.target}.${edge.targetPort}; expected ${ports(target).join(", ") || "no inputs"}.`
      );
  };
  try {
    for (const [index, command] of parsed.commands!.entries()) {
      location = `Change ${index + 1} (line ${command.line}): `;
      const { operation, id } = command;
      if (operation === "create_operator" || operation === "update_operator") {
        const existing = nodes.get(id);
        if (operation === "create_operator" && existing)
          throw new Error(`Operator ${id} already exists; use update operator.`);
        if (operation === "update_operator") required(id);
        if (original.operators.find(op => op.operatorID === id)?.taskImport)
          throw new Error(
            `Imported operator ${id} is immutable. Add a downstream operator or import another saved result.`
          );
        const view = definition(command, existing?.profileCollection ?? context.settings?.nativeProfileCollection);
        nodes.set(id, view);
        changed.add(id);
        outcomes.push({
          id,
          op: command.statement.op,
          status: existing ? "modified" : "added",
          message: `${existing ? "updated" : "added"} ${command.statement.op} operator \`${id}\``,
        });
        receipts.push({ operation, operator_id: id });
      } else if (operation === "delete_operator") {
        const node = required(id);
        const removed = [...edges.values()].filter(e => e.source === id || e.target === id);
        for (const edge of removed) {
          edges.delete(edgeText(edge));
          if (edge.target !== id) changed.add(edge.target);
        }
        nodes.delete(id);
        changed.add(id);
        receipts.push({ operation, operator_id: id, deleted_edges: removed.map(edgeText) });
        outcomes.push({
          id,
          op: nativeOperatorName(node.type),
          status: "deleted",
          message: `deleted operator \`${id}\``,
        });
      } else {
        const edge: Edge = {
          source: command.source,
          sourcePort: command.sourcePort,
          target: command.target,
          targetPort: command.targetPort,
        };
        const key = edgeText(edge);
        if (operation === "delete_edge") {
          if (!edges.delete(key)) throw new Error(`Edge ${key} does not exist.`);
        } else {
          validateEdge(edge, true);
          if ([...edges.values()].some(e => e.target === edge.target && e.targetPort === edge.targetPort))
            throw new Error(
              `Input ${edge.target}.${edge.targetPort} is occupied. Delete its existing edge before creating a new one.`
            );
          edges.set(key, edge);
        }
        changed.add(edge.target);
        receipts.push({ operation, edge: key });
      }
    }
    location = "Resulting graph: ";
    for (const [id, view] of nodes) {
      if (view.type === "Union") {
        const indices = [...edges.values()]
          .filter(e => e.target === id)
          .map(e => Number(e.targetPort.match(/^in\[(\d+)\]$/)?.[1] ?? -1));
        view.graph = { inputPorts: indexed(Math.max(2, ...indices.map(i => i + 1))) };
      }
    }
    for (const edge of edges.values()) validateEdge(edge);
    const pending = new Set(nodes.keys());
    const ordered: string[] = [];
    while (pending.size) {
      const roots = [...pending].filter(id => ![...edges.values()].some(e => e.target === id && pending.has(e.source)));
      if (!roots.length) throw new Error(`Edges create a cycle involving ${[...pending].join(", ")}.`);
      roots.forEach(id => {
        pending.delete(id);
        ordered.push(id);
      });
    }
    for (const [id, view] of nodes) {
      view.inputs = ports(view).map(
        port => [...edges.values()].find(e => e.target === id && e.targetPort === port)?.source ?? ""
      );
      if (!original.operators.find(op => op.operatorID === id)?.taskImport) view.revision = nativeRevision(view);
    }
    // Missing inputs are permitted in an editable draft, never in execution.
    // Placeholders validate local parameter/Python contracts without pretending
    // that an unconnected node has a materialized upstream table.
    const validationViews = new Map(
      [...nodes]
        .filter(([id]) => !original.operators.find(op => op.operatorID === id)?.taskImport)
        .map(([id, view]) => [
          id,
          {
            ...view,
            inputs: view.inputs.map((up, i) => up || `_unconnected_${i}`),
          },
        ])
    );
    const validation = await validateNativeOperators([...validationViews].map(([id, view]) => ({ id, view })));
    const failure = validation.findIndex(d => d !== undefined);
    if (failure >= 0) throw new Error(`${[...validationViews.keys()][failure]}: ${validation[failure]!.message}`);
    const draft = new WorkflowState();
    draft.setWorkflowContent(original);
    for (const old of draft.getAllOperators()) if (!nodes.has(old.operatorID)) draft.deleteOperator(old.operatorID);
    for (const link of draft.getAllLinks()) draft.deleteLink(link.linkID);
    const util = new WorkflowUtilService(context.metadataStore, draft);
    for (const id of ordered) {
      const view = nodes.get(id)!;
      if (draft.getOperator(id)?.taskImport) continue;
      if (context.settings?.nativeChecks) {
        view.lineage = nativeLineage(draft, view);
        validationViews.get(id)!.lineage = view.lineage;
      }
      const compiled = compileNativeOp(validationViews.get(id)!, id);
      const old = draft.getOperator(id);
      const template =
        old?.operatorType === compiled.operatorType ? old : util.getNewOperatorPredicate(compiled.operatorType, id);
      draft.addOperator(
        {
          ...template,
          operatorID: id,
          nativeOp: view,
          customDisplayName: `${id}: ${view.source ?? nativeOperatorName(view.type)}`,
          operatorProperties: { ...template.operatorProperties, code: compiled.code },
          inputPorts: ports(view).map((name, i) => ({
            portID: `input-${i}`,
            displayName: name,
            disallowMultiInputs: true,
            isDynamicPort: i > 0,
          })),
          outputPorts: [{ portID: "output-0", displayName: "out" }],
        },
        draft.getOperatorPosition(id)
      );
    }
    for (const [id, edge] of edges)
      draft.addLink({
        linkID: id,
        source: { operatorID: edge.source, portID: "output-0" },
        target: { operatorID: edge.target, portID: `input-${ports(nodes.get(edge.target)!).indexOf(edge.targetPort)}` },
      });
    for (const id of changed) {
      if (nodes.has(id) && !outcomes.some(o => o.id === id))
        outcomes.push({
          id,
          op: nativeOperatorName(nodes.get(id)!.type),
          status: "modified",
          message: `changed input connections for \`${id}\``,
        });
    }
    autoLayoutWorkflow(draft);
    const workflow = draft.getWorkflowContent();
    return {
      workflow,
      operators: outcomes,
      changes: receipts,
      unconnected_inputs: missingGraphInputs(workflow),
      invalidated_results: [...computeStaleResultOps(original, workflow)].filter(id =>
        original.operators.some(o => o.operatorID === id)
      ),
    };
  } catch (error) {
    throw new Error(
      `${location}${(error instanceof Error ? error.message : String(error)).replace(/\bprogram\b/gi, "operator definition")} No changes were applied.`
    );
  }
}
