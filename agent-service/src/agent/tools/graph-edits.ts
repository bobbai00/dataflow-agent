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
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
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
import type { VersionCommand } from "../state-ledger";

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
  forks?: GraphForkReceipt[];
  versions?: Array<{ command: VersionCommand; state: string; note: string }>;
  /** Distinguishes command-order execution from older version-first traces. */
  ordered_versions?: true;
  applied?: number;
}

export interface GraphForkReceipt {
  task_id: number;
  step_id: string;
  operator_id: string;
  new_operator_id: string;
  mapping: Record<string, string>;
}

export interface VersionEditResolution {
  fork?: GraphEditPlan & { mapping: Record<string, string>; task_id: number };
  restore?: string;
  definition?: OperatorPredicate;
  inputs?: string[];
  state: string;
  note: string;
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
  if (def.name === "diff") names = indexed(2);
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
  context: ToolContext,
  resolveVersion?: (command: VersionCommand, current: WorkflowContent) => VersionEditResolution,
  resolveInput?: (address: string) => OperatorPredicate
): Promise<GraphEditPlan> {
  const parsed = (await runNativePython({ changes })) as { ok: boolean; commands?: Command[]; error?: string };
  if (!parsed.ok) throw new Error(`${parsed.error} No changes were applied.`);
  if (!context.metadataStore) throw new Error("Metadata store not available for graph editing.");
  const nodes = new Map<string, NativeOpView>();
  const templates = new Map<string, OperatorPredicate>(original.operators.map(op => [op.operatorID, op]));
  for (const op of original.operators) {
    if (!op.nativeOp) throw new Error(`Operator ${op.operatorID} is not a native operator.`);
    nodes.set(op.operatorID, { ...structuredClone(op.nativeOp), graph: { inputPorts: ports(op.nativeOp) } });
  }
  const edges = new Map(edgesOf(original).map(e => [edgeText(e), e]));
  const receipts: GraphChangeReceipt[] = [];
  const outcomes: NativeBatchOutcome[] = [];
  const changed = new Set<string>();
  const forks: NonNullable<GraphEditPlan["forks"]> = [];
  const versions: NonNullable<GraphEditPlan["versions"]> = [];
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
  const inputId = (address: string): string => {
    if (!address.includes("@")) return address;
    if (!resolveInput) throw new Error("Saved input references require stateHistory.");
    const source = resolveInput(address);
    if (!nodes.has(source.operatorID)) {
      nodes.set(source.operatorID, structuredClone(source.nativeOp!));
      templates.set(source.operatorID, source);
    }
    return source.operatorID;
  };
  // Version resolution needs the current private draft's IDs and bindings,
  // including preceding edits. Compilation/validation still happen once,
  // after every command, so temporary draft states never commit or execute.
  const stagedWorkflow = (): WorkflowContent => ({
    ...original,
    operators: [...nodes].map(([id, view]) => ({
      ...templates.get(id)!,
      operatorID: id,
      inputPorts: ports(view).map((name, i) => ({
        portID: `input-${i}`,
        displayName: name,
        disallowMultiInputs: true,
      })),
      outputPorts: [{ portID: "output-0", displayName: "out" }],
      nativeOp: {
        ...view,
        inputs: ports(view).map(
          port => [...edges.values()].find(edge => edge.target === id && edge.targetPort === port)?.source ?? ""
        ),
      },
    })),
    links: [...edges].map(([id, edge]) => ({
      linkID: id,
      source: { operatorID: edge.source, portID: "output-0" },
      target: { operatorID: edge.target, portID: `input-${ports(required(edge.target)).indexOf(edge.targetPort)}` },
    })),
  });
  try {
    const commands = [...parsed.commands!];
    for (const [index, command] of commands.entries()) {
      location = `Change ${index + 1} (line ${command.line}): `;
      const { operation, id } = command;
      if (operation === "fork_operator" || operation === "restore_operator" || operation === "copy_definition") {
        if (!resolveVersion) throw new Error("Saved-version commands require stateHistory.");
        const versionCommand = command as unknown as VersionCommand;
        // `fork … as …` and `update … from task N` were retired with the
        // saved-versions model; recorded edits still replay them.
        if ((operation === "fork_operator" || operation === "restore_operator") && !context.legacyVersionCommands)
          throw new Error(
            operation === "fork_operator"
              ? `Forks are not available. \`create operator ${versionCommand.as ?? "<new>"} from ${id}@${versionCommand.task}\` creates an editable copy with its saved direct inputs; \`create edge ${id}@${versionCommand.task}.out -> <target>.<port>\` connects the saved result.`
              : `Use \`update operator ${id} from ${id}@${versionCommand.task}\` to make the definition saved at the end of task ${versionCommand.task} current on today's inputs.`
          );
        const resolved = resolveVersion(versionCommand, stagedWorkflow());
        versions.push({
          command: {
            line: versionCommand.line,
            id,
            task: versionCommand.task,
            ...(versionCommand.sourceId ? { sourceId: versionCommand.sourceId, create: versionCommand.create } : {}),
            ...(versionCommand.as ? { as: versionCommand.as } : {}),
          },
          state: resolved.state,
          note: resolved.note,
        });
        if (resolved.definition) {
          if (versionCommand.create && nodes.has(id)) throw new Error(`Operator ${id} already exists.`);
          if (!versionCommand.create) required(id);
          if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
          const view = structuredClone(resolved.definition.nativeOp!);
          view.graph = { inputPorts: ports(view) };
          nodes.set(id, view);
          if (versionCommand.create) templates.set(id, { ...resolved.definition, operatorID: id, savedResult: undefined, stateOrigin: undefined });
          changed.add(id);
          receipts.push({ operation: versionCommand.create ? "create_operator" : "update_operator", operator_id: id });
          outcomes.push({ id, op: nativeOperatorName(view.type), status: versionCommand.create ? "added" : "modified", message: resolved.note });
          if (resolved.inputs) {
            for (const [i, address] of resolved.inputs.entries()) {
              const edge: Edge = { source: inputId(address), sourcePort: "out", target: id, targetPort: ports(view)[i] };
              edges.set(edgeText(edge), edge);
            }
          }
        } else if (resolved.fork) {
          const fork = resolved.fork;
          const copied = new Set(Object.values(fork.mapping));
          for (const op of fork.workflow.operators.filter(op => copied.has(op.operatorID))) {
            nodes.set(op.operatorID, structuredClone(op.nativeOp!));
            templates.set(op.operatorID, op);
            changed.add(op.operatorID);
          }
          for (const edge of edgesOf(fork.workflow).filter(edge => copied.has(edge.target)))
            edges.set(edgeText(edge), edge);
          outcomes.push(...fork.operators);
          receipts.push(...fork.changes);
          forks.push({
            task_id: fork.task_id,
            step_id: fork.workflow.operators.find(op => op.operatorID === versionCommand.as)!.stateOrigin!.stepId,
            operator_id: id,
            new_operator_id: versionCommand.as!,
            mapping: { ...fork.mapping },
          });
        } else if (resolved.restore) {
          const expanded = (await runNativePython({ changes: resolved.restore })) as typeof parsed;
          if (!expanded.ok) throw new Error(expanded.error);
          commands.splice(index + 1, 0, ...expanded.commands!.map(part => ({ ...part, line: command.line })));
        } else throw new Error("Saved-version resolver returned no changes.");
        continue;
      }
      if (operation === "create_operator" || operation === "update_operator") {
        if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
        const existing = nodes.get(id);
        if (operation === "create_operator" && existing)
          throw new Error(`Operator ${id} already exists; use update operator.`);
        if (operation === "update_operator") required(id);
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
        if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
        const removed = [...edges.values()].filter(e => e.source === id || e.target === id);
        for (const edge of removed) {
          edges.delete(edgeText(edge));
          if (edge.target !== id) changed.add(edge.target);
        }
        nodes.delete(id);
        templates.delete(id);
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
        edge.source = inputId(command.source);
        // A one-parameter process has one unambiguous input. Store its
        // canonical name so aliases cannot bypass occupancy or deletion.
        const target = required(edge.target);
        if (edge.targetPort === "in" && target.type === "Process" && ports(target).length === 1) {
          edge.targetPort = ports(target)[0];
        }
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
        receipts.push({ operation, edge: edgeText({ ...edge, source: command.source }) });
      }
    }
    // A saved-result handle exists only to feed an edge. One left without a
    // consumer (its edge or consumer was deleted) leaves the draft with it.
    for (const [id, template] of templates) {
      if (!template.savedResult || !nodes.has(id)) continue;
      if ([...edges.values()].some(edge => edge.source === id)) continue;
      nodes.delete(id);
      templates.delete(id);
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
      if (context.settings?.nativeChecks) {
        view.lineage = nativeLineage(draft, view);
        validationViews.get(id)!.lineage = view.lineage;
      }
      const compiled = compileNativeOp(validationViews.get(id)!, id);
      const old = templates.get(id);
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
      ...(versions.length
        ? { versions, forks, ordered_versions: true as const, applied: parsed.commands!.length }
        : {}),
    };
  } catch (error) {
    throw new Error(
      `${location}${(error instanceof Error ? error.message : String(error)).replace(/\bprogram\b/gi, "operator definition")} No changes were applied.`
    );
  }
}
