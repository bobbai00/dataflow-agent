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
 * Landing one native definition in the workflow: an UPSERT keyed by id. A new
 * id adds the operator; an existing id replaces its parameters and inputs (the
 * modify), keeping the id and every outgoing link. Every native operator lands
 * as an ordinary `DataLoading` / `DataProcessing` operator carrying the
 * generated code, plus the typed view in `OperatorPredicate.nativeOp` (never
 * forwarded to the engine).
 */

import { WorkflowState } from "../workflow-state";
import { autoLayoutWorkflow } from "../util/auto-layout";
import { WorkflowUtilService } from "../util/workflow-utils";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import { createToolResult, createErrorResult } from "./tools-utility";
import type { ToolContext } from "./workflow-crud-tools";
import { NATIVE_BY_TYPE, NATIVE_ID_RE, nativeOperatorName, type NativeOpView } from "../native/catalog";
import { compileNativeOp, validateNativeOperator } from "../native/codegen";

/** `inputs: a` / `inputs: left = a, right = b` — the phrase used in receipts and renders. */
export function describeInputs(type: string, inputs: string[]): string {
  if (inputs.length === 0) return "";
  if (type === "Join" && inputs.length === 2) return `inputs: left = ${inputs[0]}, right = ${inputs[1]}`;
  return `inputs: ${inputs.join(", ")}`;
}

/** Display name for the GUI and any summary-style render: the statement's first line. */
export function nativeDisplayName(view: NativeOpView): string {
  const first = (view.source ?? "").split("\n")[0]?.trim();
  const text = first || `${nativeOperatorName(view.type)}: ${JSON.stringify(view.properties)}`;
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
}

function distinctInputs(inputs: string[]): string[] {
  return [...new Set(inputs)];
}

function wireInputs(workflowState: WorkflowState, operatorId: string, inputs: string[]): void {
  const ins = distinctInputs(inputs);
  for (let i = 0; i < ins.length; i++) {
    const src = workflowState.getOperator(ins[i]);
    if (!src) continue;
    const link: OperatorLink = {
      linkID: `${ins[i]}-->${operatorId}`,
      source: { operatorID: ins[i], portID: src.outputPorts[0]?.portID || "output-0" },
      target: { operatorID: operatorId, portID: `input-${i}` },
    };
    workflowState.addLink(link);
  }
}

/** Ancestry facts for engine-side checks: rows from several sources (a glob
 * or file-list scan, or a union) and the scans' file-name columns. */
export function nativeLineage(workflowState: WorkflowState, view: NativeOpView): NonNullable<NativeOpView["lineage"]> {
  const provenance = new Set<string>();
  let multiSource = view.type === "Union";
  const seen = new Set<string>();
  const queue = [...view.inputs];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const up = workflowState.getOperator(id)?.nativeOp;
    if (!up) continue;
    if (up.type === "Union") multiSource = true;
    if (up.type === "Scan") {
      const files = up.properties.files;
      if (Array.isArray(files) ? files.length > 1 : typeof files === "string" && /[*?[]/.test(files))
        multiSource = true;
      if (typeof up.properties.fileColumn === "string") provenance.add(up.properties.fileColumn);
    }
    queue.push(...up.inputs);
  }
  return { multiSource, provenanceColumns: [...provenance] };
}

function consumersOf(workflowState: WorkflowState, operatorId: string): string[] {
  return [
    ...new Set(
      workflowState
        .getAllLinks()
        .filter(l => l.source.operatorID === operatorId)
        .map(l => l.target.operatorID)
    ),
  ];
}

/**
 * Land one definition. Returns the receipt (`added filter operator \`x\`;
 * inputs: y`) or an `[ERROR] …` string; never throws for a model mistake.
 */
export async function applyNativeOperator(
  workflowState: WorkflowState,
  context: ToolContext | undefined,
  id: string,
  view: NativeOpView
): Promise<string> {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;
  if (!workflowUtil) return createErrorResult("Metadata store not available for operator creation");
  const def = NATIVE_BY_TYPE.get(view.type);
  if (!def) return createErrorResult(`\`${id}\`: unknown operator type ${view.type}`);
  if (!NATIVE_ID_RE.test(id)) {
    return createErrorResult(
      `Invalid operator id "${id}": use letters, digits and underscores, starting with a letter.`
    );
  }
  if (context?.settings?.nativeProfileCollection === true) view.profileCollection = true;
  if (view.profileCollection && context?.settings?.nativeProfileScope === "full") view.profileScope = "full";
  if (context?.settings?.nativeChecks === true) view.lineage = nativeLineage(workflowState, view);
  for (const up of view.inputs) {
    if (up === id) return createErrorResult(`\`${id}\`: an operator cannot read its own output`);
    if (!workflowState.getOperator(up)) {
      return createErrorResult(
        `\`${id}\`: input table "${up}" does not exist (inputs are the names of existing operators, or of operators defined in this program).`
      );
    }
    if (!workflowState.getOperator(up)?.nativeOp) {
      return createErrorResult(`\`${id}\`: input "${up}" is not a native operator.`);
    }
  }
  let compiled;
  try {
    await validateNativeOperator(view, id);
    compiled = compileNativeOp(view, id);
  } catch (e: any) {
    return createErrorResult(`\`${id}\`: ${e?.message ?? String(e)}`);
  }
  const existing = workflowState.getOperator(id);
  const phrase = `${def.name} operator \`${id}\`${view.inputs.length ? "; " + describeInputs(def.type, view.inputs) : ""}`;

  if (existing) {
    // MODIFY: same id, new parameters/inputs. Keep the id and outgoing links.
    if (!existing.nativeOp) return createErrorResult(`\`${id}\` is not a native operator; delete it first.`);
    const position = workflowState.getOperatorPosition(id);
    if (compiled.operatorType !== existing.operatorType) {
      // A source becoming a processing operator (or the reverse) changes the
      // engine operator type: replace the node but keep its id and consumers.
      const outgoing = workflowState.getAllLinks().filter(l => l.source.operatorID === id);
      workflowState.deleteOperator(id);
      let replacement: OperatorPredicate;
      try {
        replacement = workflowUtil.getNewOperatorPredicate(compiled.operatorType, nativeDisplayName(view));
      } catch (e: any) {
        return createErrorResult(`\`${id}\`: ${e?.message ?? String(e)}`);
      }
      replacement = {
        ...replacement,
        operatorID: id,
        operatorProperties: { ...replacement.operatorProperties, code: compiled.code },
        nativeOp: view,
      };
      workflowState.addOperator(replacement, position);
      if (compiled.operatorType === "DataProcessing" && distinctInputs(view.inputs).length > 1) {
        workflowState.updateOperatorInputPorts(id, distinctInputs(view.inputs).length);
      }
      wireInputs(workflowState, id, view.inputs);
      for (const link of outgoing)
        workflowState.addLink({
          ...link,
          source: { operatorID: id, portID: replacement.outputPorts[0]?.portID || "output-0" },
        });
      autoLayoutWorkflow(workflowState);
      return createToolResult(`modified ${phrase}`);
    }
    for (const l of workflowState.getLinksConnectedToOperator(id)) {
      if (l.target.operatorID === id) workflowState.deleteLink(l.linkID);
    }
    const next: OperatorPredicate = {
      ...existing,
      operatorProperties: { ...existing.operatorProperties, code: compiled.code },
      customDisplayName: nativeDisplayName(view),
      nativeOp: view,
    };
    workflowState.addOperator(next, position);
    if (compiled.operatorType === "DataProcessing" && distinctInputs(view.inputs).length >= 1) {
      workflowState.updateOperatorInputPorts(id, distinctInputs(view.inputs).length);
    }
    wireInputs(workflowState, id, view.inputs);
    autoLayoutWorkflow(workflowState);
    return createToolResult(`modified ${phrase}`);
  }

  // ADD
  let operator: OperatorPredicate;
  try {
    operator = workflowUtil.getNewOperatorPredicate(compiled.operatorType, nativeDisplayName(view));
  } catch (e: any) {
    return createErrorResult(`\`${id}\`: ${e?.message ?? String(e)}`);
  }
  operator = {
    ...operator,
    operatorID: id,
    operatorProperties: { ...operator.operatorProperties, code: compiled.code },
    nativeOp: view,
  };
  workflowState.addOperator(operator);
  if (compiled.operatorType === "DataProcessing" && distinctInputs(view.inputs).length > 1) {
    workflowState.updateOperatorInputPorts(id, distinctInputs(view.inputs).length);
  }
  wireInputs(workflowState, id, view.inputs);
  autoLayoutWorkflow(workflowState);
  return createToolResult(`added ${phrase}`);
}

/** Delete an operator nothing reads any more. `handled` names consumers the
 * same call removes or re-points, which therefore do not block the delete. */
export function deleteNativeOperator(
  workflowState: WorkflowState,
  id: string,
  handled: ReadonlySet<string> = new Set()
): string {
  const op = workflowState.getOperator(id);
  if (!op) return createErrorResult(`Operator \`${id}\` not found`);
  const consumers = consumersOf(workflowState, id).filter(c => !handled.has(c));
  if (consumers.length > 0) {
    return createErrorResult(
      `\`${id}\` still feeds ${consumers.map(c => `\`${c}\``).join(", ")}; re-point or delete those first.`
    );
  }
  workflowState.deleteOperator(id);
  return createToolResult(`deleted operator \`${id}\``);
}
