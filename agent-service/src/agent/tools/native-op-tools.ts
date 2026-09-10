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
 * Tools for NATIVE mode (`agentMode: "native"`): the agent assembles the
 * dataflow from the fixed operator set in `native/catalog.ts`.
 *
 *   addOperators   — add a CHAIN of typed operators in one call (ids are the
 *                    link names; each operator names its inputs by id). The
 *                    whole chain executes once after the turn.
 *   modifyOperator — replace one operator's properties / inputs / summary in
 *                    place; the code is recompiled from the new parameters.
 *
 * Every native operator lands as an ordinary `DataLoading` / `DataProcessing`
 * operator carrying the generated code, plus the typed view in
 * `OperatorPredicate.nativeOp` (never forwarded to the engine).
 */

import Ajv from "ajv";
import { z } from "zod";
import { tool } from "ai";
import { WorkflowState } from "../workflow-state";
import { autoLayoutWorkflow } from "../util/auto-layout";
import { WorkflowUtilService } from "../util/workflow-utils";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import { createToolResult, createErrorResult } from "./tools-utility";
import type { ToolContext } from "./workflow-crud-tools";
import { NATIVE_BY_TYPE, NATIVE_ID_RE, NATIVE_OPERATORS, type NativeOpView } from "../native/catalog";
import { compileNativeOp } from "../native/codegen";

export const TOOL_NAME_ADD_OPERATORS = "addOperators";
export const TOOL_NAME_MODIFY_NATIVE_OPERATOR = "modifyOperator";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<Ajv["compile"]>>();
for (const def of NATIVE_OPERATORS) validators.set(def.type, ajv.compile(def.schema));

function validateProps(type: string, props: unknown): string | undefined {
  const v = validators.get(type);
  if (!v) return `unknown operator type "${type}". Types: ${NATIVE_OPERATORS.map(d => d.type).join(", ")}`;
  if (v(props)) return undefined;
  const errs = (v.errors ?? [])
    .map(e => `${e.instancePath || "properties"} ${e.message ?? ""}`.trim())
    .slice(0, 4)
    .join("; ");
  const def = NATIVE_BY_TYPE.get(type)!;
  return `invalid properties for ${type}: ${errs}. Expected: ${def.signature}`;
}

/** Link `inputs[i]` → this operator's `input-i` port (port order = `process()` parameter order). */
function wireInputs(workflowState: WorkflowState, operatorId: string, inputs: string[]): void {
  for (let i = 0; i < inputs.length; i++) {
    const src = workflowState.getOperator(inputs[i]);
    if (!src) continue;
    const link: OperatorLink = {
      linkID: `${inputs[i]}-->${operatorId}`,
      source: { operatorID: inputs[i], portID: src.outputPorts[0]?.portID || "output-0" },
      target: { operatorID: operatorId, portID: `input-${i}` },
    };
    workflowState.addLink(link);
  }
}

function describe(view: NativeOpView): string {
  const inp = view.inputs.length > 0 ? ` <- ${view.inputs.join(", ")}` : "";
  return `${view.type}${inp}`;
}

export interface NativeOperatorSpec {
  id: string;
  type: string;
  inputs?: string[];
  properties: Record<string, unknown>;
  summary: string;
}

const operatorSpecSchema = z.object({
  id: z
    .string()
    .describe(
      "Operator id: a short snake_case name for what the table IS (e.g. `orders`, `orders_2023`, `total_by_state`). " +
        "Must be a valid identifier — downstream operators reference this table by id."
    ),
  type: z
    .string()
    .describe("One of: " + NATIVE_OPERATORS.map(d => d.type).join(", ") + ". See the operator catalog in your instructions."),
  inputs: z
    .array(z.string())
    .optional()
    .describe(
      "Ids of the upstream operators whose output tables this operator reads, in port order (Join: [left, right]; " +
        "Union: two or more; Scan: none). May name operators created earlier in the same call."
    ),
  properties: z.record(z.any()).describe("The operator's parameters, exactly as in the catalog."),
  summary: z
    .string()
    .describe("One short line naming what the output table is (e.g. 'Identity theft reports, all 52 state files')."),
});

/**
 * `addOperators`: add one or more typed operators in dependency order.
 * Operators are validated and compiled one at a time; on the first failure the
 * earlier operators of the batch stay (they are valid), and the error names
 * the failing one so the agent can resubmit from there.
 */
export function createAddOperatorsTool(workflowState: WorkflowState, context?: ToolContext) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;

  return tool({
    description:
      "Add one or more operators to the dataflow in one call (a chain executes once, after your turn). " +
      "Each operator is one relational operation with JSON properties — no code, except the UDF type. " +
      "Later operators in the list may use earlier ones as inputs.\n\n" +
      "Example — load, filter, aggregate:\n" +
      '{"operators": [\n' +
      '  {"id": "sales", "type": "Scan", "properties": {"files": "data/shop/input/sales_*.csv"}, "summary": "All monthly sales files"},\n' +
      '  {"id": "sales_2023", "type": "Filter", "inputs": ["sales"], "properties": {"predicate": "year = 2023 AND region IS NOT NULL"}, "summary": "2023 sales with a region"},\n' +
      '  {"id": "revenue_by_region", "type": "Aggregate", "inputs": ["sales_2023"], "properties": {"groupBy": ["region"], "aggregations": [{"fn": "sum", "col": "amount", "as": "revenue"}]}, "summary": "Revenue per region, 2023"}\n' +
      "]}",
    inputSchema: z.object({
      operators: z.array(operatorSpecSchema).min(1).describe("Operators in dependency order."),
    }),
    execute: async (args: { operators: NativeOperatorSpec[] }) => {
      if (!workflowUtil) return createErrorResult("Metadata store not available for operator creation");
      const created: string[] = [];
      const seenInBatch = new Set<string>();
      for (const spec of args.operators) {
        const where = created.length > 0 ? ` (added before the error: ${created.join(", ")})` : "";
        if (!NATIVE_ID_RE.test(spec.id)) {
          return createErrorResult(
            `Invalid operator id "${spec.id}": use letters, digits and underscores, starting with a letter.${where}`
          );
        }
        if (workflowState.getOperator(spec.id) || seenInBatch.has(spec.id)) {
          return createErrorResult(`Operator "${spec.id}" already exists. Use modifyOperator to change it.${where}`);
        }
        const def = NATIVE_BY_TYPE.get(spec.type);
        if (!def) {
          return createErrorResult(
            `Unknown operator type "${spec.type}" for "${spec.id}". Types: ${NATIVE_OPERATORS.map(d => d.type).join(", ")}.${where}`
          );
        }
        const bad = validateProps(spec.type, spec.properties ?? {});
        if (bad) return createErrorResult(`"${spec.id}": ${bad}.${where}`);
        const inputs = spec.inputs ?? [];
        for (const up of inputs) {
          if (!workflowState.getOperator(up)) {
            return createErrorResult(
              `"${spec.id}": input operator "${up}" does not exist (inputs must be existing operator ids, or ids created earlier in this call).${where}`
            );
          }
        }
        const view: NativeOpView = { type: spec.type, properties: spec.properties ?? {}, inputs };
        let compiled;
        try {
          compiled = compileNativeOp(view);
        } catch (e: any) {
          return createErrorResult(`"${spec.id}": ${e?.message ?? String(e)}.${where}`);
        }
        let operator: OperatorPredicate;
        try {
          operator = workflowUtil.getNewOperatorPredicate(compiled.operatorType, spec.summary);
        } catch (e: any) {
          return createErrorResult(`"${spec.id}": ${e?.message ?? String(e)}.${where}`);
        }
        operator = {
          ...operator,
          operatorID: spec.id,
          operatorProperties: { ...operator.operatorProperties, code: compiled.code },
          nativeOp: view,
        };
        workflowState.addOperator(operator);
        if (compiled.operatorType === "DataProcessing" && inputs.length > 1) {
          workflowState.updateOperatorInputPorts(spec.id, inputs.length);
        }
        wireInputs(workflowState, spec.id, inputs);
        created.push(spec.id);
        seenInBatch.add(spec.id);
      }
      autoLayoutWorkflow(workflowState);
      const lines = created.map(id => {
        const op = workflowState.getOperator(id)!;
        return `- ${id}: ${describe(op.nativeOp!)}`;
      });
      return createToolResult(`Added ${created.length} operator(s):\n${lines.join("\n")}`);
    },
  });
}

/**
 * `modifyOperator` (native): replace properties and/or inputs of ONE existing
 * operator in place. Properties are replaced whole (not merged) so the
 * operator is always exactly what the last call said.
 */
export function createNativeModifyOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;
  return tool({
    description:
      "Modify an existing operator in place: new properties (replace the whole properties object), new inputs, " +
      "or a new summary. Use this to fix a wrong operator — never add a downstream operator to patch an upstream mistake.\n" +
      'Example: {"operatorId": "sales_2023", "properties": {"predicate": "year = 2023"}, "summary": "2023 sales"}',
    inputSchema: z.object({
      operatorId: z.string().describe("Id of the operator to modify."),
      properties: z.record(z.any()).optional().describe("Complete new properties for this operator's type."),
      inputs: z.array(z.string()).optional().describe("New upstream operator ids in port order (replaces all inputs)."),
      summary: z.string().optional().describe("New one-line summary."),
    }),
    execute: async (args: { operatorId: string; properties?: Record<string, unknown>; inputs?: string[]; summary?: string }) => {
      if (!workflowUtil) return createErrorResult("Metadata store not available");
      const op = workflowState.getOperator(args.operatorId);
      if (!op) return createErrorResult(`Operator ${args.operatorId} not found`);
      if (!op.nativeOp) return createErrorResult(`Operator ${args.operatorId} is not a typed operator`);
      const view: NativeOpView = {
        type: op.nativeOp.type,
        properties: args.properties ?? op.nativeOp.properties,
        inputs: args.inputs ?? op.nativeOp.inputs,
      };
      const bad = validateProps(view.type, view.properties);
      if (bad) return createErrorResult(`"${args.operatorId}": ${bad}`);
      for (const up of view.inputs) {
        if (!workflowState.getOperator(up)) return createErrorResult(`"${args.operatorId}": input operator "${up}" does not exist`);
        if (up === args.operatorId) return createErrorResult(`"${args.operatorId}": an operator cannot read its own output`);
      }
      let compiled;
      try {
        compiled = compileNativeOp(view);
      } catch (e: any) {
        return createErrorResult(`"${args.operatorId}": ${e?.message ?? String(e)}`);
      }
      if (compiled.operatorType !== op.operatorType) {
        return createErrorResult(
          `"${args.operatorId}": this change would turn a ${op.operatorType} into a ${compiled.operatorType}; delete and re-add it instead`
        );
      }
      const position = workflowState.getOperatorPosition(args.operatorId);
      const inputsChanged = args.inputs !== undefined;
      if (inputsChanged) {
        for (const l of workflowState.getLinksConnectedToOperator(args.operatorId)) {
          if (l.target.operatorID === args.operatorId) workflowState.deleteLink(l.linkID);
        }
      }
      const next: OperatorPredicate = {
        ...op,
        operatorProperties: { ...op.operatorProperties, code: compiled.code },
        customDisplayName: args.summary ?? op.customDisplayName,
        nativeOp: view,
      };
      workflowState.addOperator(next, position);
      if (inputsChanged) {
        if (compiled.operatorType === "DataProcessing" && view.inputs.length >= 1) {
          workflowState.updateOperatorInputPorts(args.operatorId, view.inputs.length);
        }
        wireInputs(workflowState, args.operatorId, view.inputs);
        autoLayoutWorkflow(workflowState);
      }
      return createToolResult(`Modified operator ${args.operatorId}: ${describe(view)}`);
    },
  });
}
