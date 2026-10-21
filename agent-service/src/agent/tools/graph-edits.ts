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
import { stageRegisteredEdit } from "../native/registered";

type Edge = { source: string; sourcePort: string; target: string; targetPort: string };

/** One statement of an edit, as python/graph_parser.py returns it. */
export type EditStatement =
  | {
      kind: "assign";
      id: string;
      line: number;
      statement: ParsedStatement;
      functions: Record<string, ParsedFunction>;
      /** Source text of every positional and keyword argument, in call order. */
      positional: string[];
      keywords: string[];
    }
  | { kind: "delete"; ids: string[]; line: number };

/** One line of an edit receipt: `operator x created (filter)`, `edge a -> x removed`. */
export type GraphChangeReceipt =
  | {
      change: "operator";
      operator_id: string;
      operator: string;
      action: "created" | "updated" | "unchanged" | "deleted";
    }
  | { change: "edge"; edge: string; action: "created" | "removed" };
export interface GraphEditPlan {
  workflow: WorkflowContent;
  operators: NativeBatchOutcome[];
  changes: GraphChangeReceipt[];
  unconnected_inputs: string[];
  invalidated_results: string[];
  /** `signature` is set in sessions with several requests (AgentSettings.multiRequest). */
  registrations?: Array<{ name: string; kind: "registered" | "updated"; signature?: string }>;
}

const edgeKey = (e: Edge) => `${e.source}.${e.sourcePort} -> ${e.target}.${e.targetPort}`;
/** The receipt spelling: the port is named only when the target has several. */
const edgeLabel = (e: Edge, portCount: number) =>
  `${e.source} -> ${e.target}${portCount > 1 ? `.${e.targetPort}` : ""}`;
/** The source and target operator of an edge label such as `a -> b.left`. */
export function edgeEnds(label: string): { source: string; target: string } {
  const [source, target] = label.split(" -> ");
  return { source, target: target.split(".")[0] };
}
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
  const portsOf = new Map(workflow.operators.map(op => [op.operatorID, op.nativeOp ? ports(op.nativeOp) : []]));
  return {
    operators: workflow.operators.map(op => ({
      id: op.operatorID,
      type: op.nativeOp ? (op.nativeOp.registeredName ?? nativeOperatorName(op.nativeOp.type)) : op.operatorType,
      ports: { inputs: op.nativeOp ? ports(op.nativeOp) : op.inputPorts.map(p => p.portID), outputs: ["out"] },
    })),
    edges: edges.map(e => edgeLabel(e, portsOf.get(e.target)?.length ?? 1)),
    unconnected_inputs: workflow.operators.flatMap(op =>
      op.nativeOp
        ? ports(op.nativeOp)
            .filter(port => !edges.some(e => e.target === op.operatorID && e.targetPort === port))
            .map(port => `${op.operatorID}.${port}`)
        : []
    ),
  };
}

/** Stage a cumulative namespace and complete final graph before publishing
 * either. Generated engine code is private to the draft until the caller checks
 * snapshot ownership and commits. Python registration never executes the DAG. */
export async function planRegisteredGraphEdit(
  original: WorkflowContent,
  python: string,
  changes: string,
  context: ToolContext
): Promise<GraphEditPlan> {
  if (!context.metadataStore) throw new Error("Metadata store not available for graph editing.");
  const originalViews: Record<string, NativeOpView> = Object.create(null);
  for (const op of original.operators) {
    if (!op.nativeOp) throw new Error(`Operator ${op.operatorID} is not a native operator.`);
    originalViews[op.operatorID] = structuredClone(op.nativeOp);
  }
  const staged = await stageRegisteredEdit({
    python,
    changes,
    namespace: original.nativeNamespace,
    operators: originalViews,
    profileCollection: context.settings?.nativeProfileCollection,
    profileScope: context.settings?.nativeProfileScope === "full" ? "full" : undefined,
  });
  const nodes = new Map(Object.entries(staged.operators));
  const pending = new Set(nodes.keys());
  const ordered: string[] = [];
  while (pending.size) {
    const roots = [...pending].filter(id => !nodes.get(id)!.inputs.some(up => pending.has(up)));
    if (!roots.length)
      throw new Error(`The inputs form a cycle among ${[...pending].join(", ")}. No changes were applied.`);
    for (const id of roots) {
      const missing = nodes.get(id)!.inputs.find(up => !nodes.has(up));
      if (missing)
        throw new Error(
          `${id}'s input ${missing} does not exist. Rewire or delete its consumers in the same edit. No changes were applied.`
        );
      pending.delete(id);
      ordered.push(id);
    }
  }
  const draft = new WorkflowState();
  draft.setWorkflowContent({ ...original, nativeNamespace: staged.namespace });
  for (const old of draft.getAllOperators()) if (!nodes.has(old.operatorID)) draft.deleteOperator(old.operatorID);
  for (const link of draft.getAllLinks()) draft.deleteLink(link.linkID);
  const util = new WorkflowUtilService(context.metadataStore, draft);
  for (const id of ordered) {
    const view = nodes.get(id)!;
    if (context.settings?.nativeChecks || context.settings?.flowEvidence) view.lineage = nativeLineage(draft, view);
    if (context.settings?.pandasRound) view.pandasRound = true;
    const compiled = compileNativeOp(view, id);
    const old = draft.getOperator(id);
    const template =
      old?.operatorType === compiled.operatorType ? old : util.getNewOperatorPredicate(compiled.operatorType, id);
    draft.addOperator(
      {
        ...template,
        operatorID: id,
        nativeOp: view,
        customDisplayName: `${id}: ${view.source ?? view.registeredName ?? nativeOperatorName(view.type)}`,
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
    view.inputs.forEach((source, index) =>
      draft.addLink({
        linkID: `${source}.out -> ${id}.${ports(view)[index]}`,
        source: { operatorID: source, portID: "output-0" },
        target: { operatorID: id, portID: `input-${index}` },
      })
    );
  }
  autoLayoutWorkflow(draft);
  const workflow = draft.getWorkflowContent();
  const receipts: GraphChangeReceipt[] = [];
  const outcomes: NativeBatchOutcome[] = [];
  const names = (view: NativeOpView) => view.registeredName ?? nativeOperatorName(view.type);
  for (const [id, old] of Object.entries(originalViews))
    if (!nodes.has(id)) {
      receipts.push({ change: "operator", operator_id: id, operator: names(old), action: "deleted" });
      outcomes.push({ id, op: names(old), status: "deleted", message: `deleted operator \`${id}\`` });
    }
  for (const [id, view] of nodes) {
    const old = originalViews[id];
    if (old && JSON.stringify(old) === JSON.stringify(view)) continue;
    receipts.push({ change: "operator", operator_id: id, operator: names(view), action: old ? "updated" : "created" });
    outcomes.push({
      id,
      op: names(view),
      status: old ? "modified" : "added",
      message: `${old ? "updated" : "created"} operator \`${id}\``,
    });
  }
  const beforeEdges = new Map(edgesOf(original).map(edge => [edgeKey(edge), edge]));
  const afterEdges = new Map(edgesOf(workflow).map(edge => [edgeKey(edge), edge]));
  for (const [key, edge] of beforeEdges)
    if (!afterEdges.has(key))
      receipts.push({
        change: "edge",
        edge: edgeLabel(edge, ports(originalViews[edge.target]).length),
        action: "removed",
      });
  for (const [key, edge] of afterEdges)
    if (!beforeEdges.has(key))
      receipts.push({
        change: "edge",
        edge: edgeLabel(edge, ports(nodes.get(edge.target)!).length),
        action: "created",
      });
  return {
    workflow,
    operators: outcomes,
    changes: receipts,
    registrations: staged.registrations,
    unconnected_inputs: [],
    invalidated_results: [...computeStaleResultOps(original, workflow)].filter(id => id in originalViews),
  };
}
export function missingGraphInputs(workflow: WorkflowContent): string[] {
  return inspectGraph(workflow).unconnected_inputs;
}

/** Parse an edit; a syntax error rejects all of it. */
export async function parseGraphEdit(changes: string): Promise<EditStatement[]> {
  const parsed = (await runNativePython({ changes })) as { ok: boolean; statements?: EditStatement[]; error?: string };
  if (!parsed.ok) throw new Error(`${parsed.error} No changes were applied.`);
  return parsed.statements!;
}

/** What identifies a definition apart from its inputs. */
const definitionKey = (view: NativeOpView) =>
  JSON.stringify([view.type, view.properties, view.functions ?? {}, ports(view)]);

/** Validate and compile against a private draft. The caller commits the returned
 * workflow only after checking cancellation/HEAD ownership. No mutation occurs here.
 *
 * `name = operator(inputs, ...)` creates `name` or replaces its definition; its
 * inputs, in port order, become its incoming edges and replace the old ones.
 * `del name` deletes an operator and its edges. Names resolve against the
 * graph as it stands after the whole edit. */
export async function planGraphEdit(
  original: WorkflowContent,
  changes: string,
  context: ToolContext
): Promise<GraphEditPlan> {
  const statements = await parseGraphEdit(changes);
  if (!context.metadataStore) throw new Error("Metadata store not available for graph editing.");
  const nodes = new Map<string, NativeOpView>();
  for (const op of original.operators) {
    if (!op.nativeOp) throw new Error(`Operator ${op.operatorID} is not a native operator.`);
    nodes.set(op.operatorID, { ...structuredClone(op.nativeOp), graph: { inputPorts: ports(op.nativeOp) } });
  }
  const edges = new Map(edgesOf(original).map(e => [edgeKey(e), e]));
  const operatorChanges: GraphChangeReceipt[] = [];
  const edgeChanges: GraphChangeReceipt[] = [];
  const outcomes: NativeBatchOutcome[] = [];
  const changed = new Set<string>();
  const assigned = new Map<
    string,
    { inputs: string[]; line: number; definition: "created" | "updated" | "same"; previousPorts: number }
  >();
  const deleted = new Set<string>();
  let location = "";
  try {
    for (const statement of statements) {
      location = `Line ${statement.line}: `;
      if (statement.kind === "delete") {
        for (const id of statement.ids) {
          if (assigned.has(id)) throw new Error(`${id} is both assigned and deleted in this edit.`);
          const node = nodes.get(id);
          if (!node) throw new Error(`Operator ${id} does not exist.`);
          for (const [key, edge] of edges) {
            if (edge.source !== id && edge.target !== id) continue;
            edges.delete(key);
            edgeChanges.push({
              change: "edge",
              edge: edgeLabel(edge, ports(nodes.get(edge.target)!).length),
              action: "removed",
            });
            changed.add(edge.target);
          }
          nodes.delete(id);
          deleted.add(id);
          changed.add(id);
          const op = nativeOperatorName(node.type);
          operatorChanges.push({ change: "operator", operator_id: id, operator: op, action: "deleted" });
          outcomes.push({ id, op, status: "deleted", message: `deleted operator \`${id}\`` });
        }
        continue;
      }
      const { id, statement: parsed } = statement;
      if (assigned.has(id)) throw new Error(`${id} is assigned twice in this edit; write one definition.`);
      const existing = nodes.get(id);
      // An existing operator keeps the profile setting it was compiled with.
      const normalized = normalizeStatement(parsed, statement.functions, {
        profileCollection: existing?.profileCollection ?? context.settings?.nativeProfileCollection,
        profileScope: existing
          ? existing.profileScope
          : context.settings?.nativeProfileScope === "full"
            ? "full"
            : undefined,
      });
      if (!normalized.view) throw new Error(normalized.error?.message ?? "Invalid operator definition.");
      const inputs = normalized.view.inputs;
      if (inputs.includes(id))
        throw new Error(
          `${id} cannot be its own input. Give the new table its own name, for example \`${id}_2 = ${parsed.op}(${id}, ...)\`.`
        );
      const arity = NATIVE_BY_NAME.get(parsed.op)!.inputs;
      if (parsed.op === "union" && inputs.length < 2)
        throw new Error(`union takes two or more input tables: \`${id} = union(first, second, ...)\`.`);
      const inputPorts = arity === 1 ? ["in"] : arity === 2 ? ["left", "right"] : indexed(inputs.length);
      // The stored source omits the inputs: edges own them, so a fork or a
      // rewiring never leaves stale input names in a definition.
      const view: NativeOpView = {
        ...normalized.view,
        inputs: inputPorts.map(() => ""),
        source: `${parsed.op}(${[...statement.positional.slice(inputs.length), ...statement.keywords].join(", ")})`,
        graph: { inputPorts },
      };
      const definition = !existing ? "created" : definitionKey(existing) === definitionKey(view) ? "same" : "updated";
      assigned.set(id, {
        inputs,
        line: statement.line,
        definition,
        previousPorts: existing ? ports(existing).length : 0,
      });
      if (definition === "same") {
        // Reported as unchanged unless its inputs turn out to differ.
        operatorChanges.push({ change: "operator", operator_id: id, operator: parsed.op, action: "unchanged" });
        continue;
      }
      nodes.set(id, view);
      changed.add(id);
      operatorChanges.push({ change: "operator", operator_id: id, operator: parsed.op, action: definition });
      outcomes.push({
        id,
        op: parsed.op,
        status: existing ? "modified" : "added",
        message: `${existing ? "updated" : "added"} ${parsed.op} operator \`${id}\``,
      });
    }
    // Inputs become edges once every definition and deletion is known.
    for (const [id, { inputs, line, definition, previousPorts }] of assigned) {
      location = `Line ${line}: `;
      const missing = inputs.find(input => !nodes.has(input));
      if (missing)
        throw new Error(
          `${id}'s input \`${missing}\` is not an operator${deleted.has(missing) ? " (deleted in this edit)" : ""}. Operators: ${[...nodes.keys()].join(", ")}.`
        );
      const inputPorts = ports(nodes.get(id)!);
      const wanted: Edge[] = inputs.map((source, i) => ({
        source,
        sourcePort: "out",
        target: id,
        targetPort: inputPorts[i],
      }));
      const keys = new Set(wanted.map(edgeKey));
      let rewired = false;
      for (const [key, edge] of edges) {
        if (edge.target !== id || keys.has(key)) continue;
        edges.delete(key);
        edgeChanges.push({ change: "edge", edge: edgeLabel(edge, previousPorts), action: "removed" });
        rewired = true;
      }
      for (const edge of wanted) {
        if (edges.has(edgeKey(edge))) continue;
        edges.set(edgeKey(edge), edge);
        edgeChanges.push({ change: "edge", edge: edgeLabel(edge, inputPorts.length), action: "created" });
        rewired = true;
      }
      if (!rewired) continue;
      changed.add(id);
      if (definition === "same") {
        const unchanged = operatorChanges.findIndex(c => c.change === "operator" && c.operator_id === id);
        operatorChanges.splice(unchanged, 1);
      }
    }
    location = "Resulting graph: ";
    const pending = new Set(nodes.keys());
    const ordered: string[] = [];
    while (pending.size) {
      const roots = [...pending].filter(id => ![...edges.values()].some(e => e.target === id && pending.has(e.source)));
      if (!roots.length) throw new Error(`The inputs form a cycle among ${[...pending].join(", ")}.`);
      roots.forEach(id => {
        pending.delete(id);
        ordered.push(id);
      });
    }
    for (const [id, view] of nodes) {
      view.inputs = ports(view).map(
        port => [...edges.values()].find(e => e.target === id && e.targetPort === port)?.source ?? ""
      );
      view.revision = nativeRevision(view);
    }
    // Missing inputs are permitted in an editable draft, never in execution.
    // Placeholders validate local parameter/Python contracts without pretending
    // that an unconnected node has a materialized upstream table.
    const validationViews = new Map(
      [...nodes].map(([id, view]) => [
        id,
        {
          ...view,
          inputs: view.inputs.map((up, i) => up || `_unconnected_${i}`),
        },
      ])
    );
    const validation = await validateNativeOperators([...validationViews].map(([id, view]) => ({ id, view })));
    const failure = validation.findIndex(d => d !== undefined);
    if (failure >= 0) throw new Error(`${[...nodes.keys()][failure]}: ${validation[failure]!.message}`);
    const draft = new WorkflowState();
    draft.setWorkflowContent(original);
    for (const old of draft.getAllOperators()) if (!nodes.has(old.operatorID)) draft.deleteOperator(old.operatorID);
    for (const link of draft.getAllLinks()) draft.deleteLink(link.linkID);
    const util = new WorkflowUtilService(context.metadataStore, draft);
    for (const id of ordered) {
      const view = nodes.get(id)!;
      if (context.settings?.nativeChecks || context.settings?.flowEvidence) {
        view.lineage = nativeLineage(draft, view);
        validationViews.get(id)!.lineage = view.lineage;
      }
      if (context.settings?.pandasRound) view.pandasRound = validationViews.get(id)!.pandasRound = true;
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
    for (const [key, edge] of edges)
      draft.addLink({
        linkID: key,
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
      changes: [...operatorChanges, ...edgeChanges],
      unconnected_inputs: missingGraphInputs(workflow),
      invalidated_results: [...computeStaleResultOps(original, workflow)].filter(id =>
        original.operators.some(o => o.operatorID === id)
      ),
    };
  } catch (error) {
    throw new Error(`${location}${error instanceof Error ? error.message : String(error)} No changes were applied.`);
  }
}
