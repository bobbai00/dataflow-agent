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
 * Typed-operator tools for GENERAL mode. The agent picks an `operatorType`
 * (e.g. `TableFilter`, `HashJoin`) and supplies properties matching that
 * operator's schema; links to upstream operators are passed via
 * `inputOperatorIds`.
 */

import { z } from "zod";
import { tool } from "ai";
import { WorkflowState } from "../workflow-state";
import { autoLayoutWorkflow } from "../util/auto-layout";
import { WorkflowUtilService } from "../util/workflow-utils";
import type { OperatorLink } from "../../types/workflow";
import {
  createToolResult,
  createErrorResult,
  formatAddOperatorResult,
  formatModifyOperatorResult,
  formatOperatorError,
} from "./tools-utility";
import { formatValidationErrors, formatCompactSchemaForError } from "../util/workflow-system-metadata";
import type { ToolContext } from "./workflow-crud-tools";
import { parseCodeBlock } from "./code-op-tools";

export const TOOL_NAME_ADD_OPERATOR = "addOperator";
export const TOOL_NAME_MODIFY_OPERATOR = "modifyOperator";

function formatInputArgs(args: Record<string, any>): string {
  const compact: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) compact[key] = value;
  }
  return `Input: ${JSON.stringify(compact)}`;
}

/**
 * `inputOperatorIds` values name a source operator, optionally suffixed with
 * the source OUTPUT port index: `"op9"` (port 0) or `"op9:1"` (port 1). Multi-
 * output operators such as `Split` (port 0 = training share, port 1 = the
 * rest) are only reachable through the suffix — without it every consumer
 * silently attached to port 0.
 */
/**
 * `DataProcessing` derives its input-port count from the `def process(<a>, <b>, …)`
 * signature (CODE mode does the same through `createOrModifyOperator`). Without
 * this every GENERAL-mode DataProcessing had exactly one input port, so a
 * two-table `process(orders, n_lines)` could never be wired.
 */
function syncDataProcessingPorts(workflowState: WorkflowState, operatorId: string, code: unknown): string | null {
  if (typeof code !== "string") return null;
  const parsed = parseCodeBlock(code);
  if ("error" in parsed) return parsed.error;
  const op = workflowState.getOperator(operatorId);
  if (op && parsed.type === "DataProcessing" && parsed.numInputPorts !== op.inputPorts.length) {
    workflowState.updateOperatorInputPorts(operatorId, parsed.numInputPorts);
  }
  return null;
}

export function parseSourceRef(ref: string): { operatorId: string; outputPortIndex: number } {
  const m = /^(.*?)(?::(\d+))?$/.exec(ref.trim());
  return { operatorId: m?.[1] ?? ref, outputPortIndex: m?.[2] !== undefined ? parseInt(m[2], 10) : 0 };
}

export function createAddOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>,
  context?: ToolContext
) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;

  return tool({
    description: `Add a new operator to the workflow. Use getOperatorSchema first to understand required properties.

Examples:
1. Add a source operator (no inputs):
   { "operatorId": "op1", "operatorType": "TableFileScan", "properties": { "fileName": "data.csv" }, "summary": "Load CSV data" }

2. Add an operator with input connections:
   { "operatorId": "op2", "operatorType": "TableFilter", "properties": { "predicates": [...] }, "inputOperatorIds": { "0": ["op1"] }, "summary": "Filter rows by condition" }`,
    inputSchema: z.object({
      operatorId: z
        .string()
        .describe(
          "Name of Operator. Use the format 'op' followed by an incrementing number starting from 1 (e.g., op1, op2, op3)."
        ),
      operatorType: z.string().describe("The operator type (e.g., 'DataProcessing', 'Aggregate')"),
      properties: z.record(z.any()).describe("Properties to set on the operator"),
      inputOperatorIds: z
        .record(z.array(z.string()))
        .optional()
        .describe(
          "Mapping from input port index to an ordered list of source operator IDs that connect to that port. " +
            'E.g. {"0": ["opA", "opB"], "1": ["opC"]} connects opA and opB to input port 0, opC to input port 1. ' +
            "A source id may carry an OUTPUT port suffix to read from a non-default output port of a multi-output " +
            'operator, e.g. {"0": ["op9:1"]} links from op9\'s output port 1 (Split: port 0 = training share, port 1 = rest). ' +
            "Source operators that load files (e.g. CSVFileScan) should NOT have any input operators."
        ),
      summary: z.string().describe("Very brief summary of operator behavior. Within 5 words"),
    }),
    execute: async (args: {
      operatorId: string;
      operatorType: string;
      properties?: Record<string, any>;
      inputOperatorIds?: Record<string, string[]>;
      summary: string;
    }) => {
      try {
        const inputInfo = formatInputArgs(args);

        const schemaEntry = operatorSchemas.get(args.operatorType);
        if (!schemaEntry) {
          return createErrorResult(
            `Unknown operator type: "${args.operatorType}". Available types: ${[...operatorSchemas.keys()].join(", ")}. ${inputInfo}`
          );
        }

        if (context?.metadataStore && args.properties) {
          const validation = context.metadataStore.validateOperatorProperties(args.operatorType, args.properties);
          if (!validation.isValid) {
            const compactSchema = context.metadataStore.getCompactSchema(args.operatorType);
            const schemaStr = compactSchema ? ` Expected: ${formatCompactSchemaForError(compactSchema)}.` : "";
            return createErrorResult(
              `Invalid properties for "${args.operatorType}": ${formatValidationErrors(validation)}.${schemaStr} ${inputInfo}`
            );
          }
        }

        if (!workflowUtil) {
          return createErrorResult(`Metadata store not available for operator creation. ${inputInfo}`);
        }

        if (!/^op\d+$/.test(args.operatorId)) {
          return createErrorResult(
            `Invalid operatorId: "${args.operatorId}". Must follow the format "op" followed by a number (e.g., op1, op2, op3). ${inputInfo}`
          );
        }

        const existing = workflowState.getOperator(args.operatorId);
        if (existing) {
          return createErrorResult(
            `Operator with ID "${args.operatorId}" already exists. Use modifyOperator to update it, or choose a different ID. ${inputInfo}`
          );
        }

        let operator = workflowUtil.getNewOperatorPredicate(args.operatorType, args.summary);
        operator = {
          ...operator,
          operatorID: args.operatorId,
          operatorProperties: { ...operator.operatorProperties, ...args.properties },
        };

        workflowState.addOperator(operator);

        if (operator.operatorType === "DataProcessing") {
          const err = syncDataProcessingPorts(workflowState, operator.operatorID, args.properties?.code);
          if (err) return createErrorResult(`${err} ${inputInfo}`);
        }

        const createdLinkPairs: { source: string; target: string }[] = [];
        if (args.inputOperatorIds) {
          const addedOperator = workflowState.getOperator(operator.operatorID)!;
          for (const [portIndexStr, sourceOpIds] of Object.entries(args.inputOperatorIds)) {
            const targetPortIdx = parseInt(portIndexStr, 10);
            if (isNaN(targetPortIdx) || targetPortIdx < 0) {
              return createErrorResult(
                `Invalid input port index: "${portIndexStr}". Must be a non-negative integer. ${inputInfo}`
              );
            }
            if (targetPortIdx >= addedOperator.inputPorts.length) {
              return createErrorResult(
                `Input port index ${targetPortIdx} out of range. Operator "${args.operatorId}" has ${addedOperator.inputPorts.length} input port(s). ${inputInfo}`
              );
            }
            const targetPortId = addedOperator.inputPorts[targetPortIdx].portID;

            for (const sourceRef of sourceOpIds) {
              const { operatorId: sourceOpId, outputPortIndex } = parseSourceRef(sourceRef);
              const sourceOp = workflowState.getOperator(sourceOpId);
              if (!sourceOp) {
                return createErrorResult(
                  `Source operator "${sourceOpId}" not found. Make sure it exists before referencing it in inputOperatorIds. ${inputInfo}`
                );
              }
              if (sourceOp.outputPorts.length > 0 && outputPortIndex >= sourceOp.outputPorts.length) {
                return createErrorResult(
                  `Output port index ${outputPortIndex} out of range for source "${sourceOpId}" (${sourceOp.outputPorts.length} output port(s)). ${inputInfo}`
                );
              }
              const sourcePortId =
                sourceOp.outputPorts.length > 0
                  ? sourceOp.outputPorts[outputPortIndex].portID
                  : `output-${outputPortIndex}`;

              const linkId = workflowState.generateLinkId();
              const link: OperatorLink = {
                linkID: linkId,
                source: { operatorID: sourceOpId, portID: sourcePortId },
                target: { operatorID: args.operatorId, portID: targetPortId },
              };
              workflowState.addLink(link);
              createdLinkPairs.push({ source: sourceOpId, target: args.operatorId });
            }
          }
        }

        autoLayoutWorkflow(workflowState);

        const finalOperator = workflowState.getOperator(operator.operatorID) || operator;
        const numInputPorts = finalOperator.inputPorts.length;
        const numOutputPorts = finalOperator.outputPorts.length;

        let resultMsg = formatAddOperatorResult(
          operator.operatorID,
          numInputPorts,
          numOutputPorts,
          createdLinkPairs.length > 0 ? createdLinkPairs : undefined
        );

        return createToolResult(resultMsg);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}

export function createModifyOperatorTool(workflowState: WorkflowState, context?: ToolContext) {
  return tool({
    description: `Modify an existing operator's properties, input links, or both.

Examples:
1. Modify properties only:
   { "operatorId": "agg", "properties": { "groupByKeys": ["city"] }, "summary": "Group by city" }

2. Modify input links only (replaces all existing incoming links):
   { "operatorId": "join_op", "inputOperatorIds": { "0": ["users"], "1": ["orders"] }, "summary": "Re-link join inputs" }

3. Modify both properties and links:
   { "operatorId": "filter", "properties": { "predicates": [...] }, "inputOperatorIds": { "0": ["cleaned"] }, "summary": "Update filter and re-link" }`,
    inputSchema: z.object({
      operatorId: z.string().describe("ID of the operator to modify"),
      properties: z.record(z.any()).optional().describe("Properties to update (merged with existing)"),
      inputOperatorIds: z
        .record(z.array(z.string()))
        .optional()
        .describe(
          "Mapping from input port index to an ordered list of source operator IDs. " +
            "If provided, all existing incoming links are deleted and replaced with these. " +
            'E.g. {"0": ["opA", "opB"], "1": ["opC"]} connects opA and opB to input port 0, opC to input port 1.'
        ),
      summary: z.string().describe("Very brief summary of operator behavior after your modification. Within 5 words"),
    }),
    execute: async (args: {
      operatorId: string;
      properties?: Record<string, any>;
      inputOperatorIds?: Record<string, string[]>;
      summary?: string;
    }) => {
      try {
        const inputInfo = formatInputArgs(args);

        const operator = workflowState.getOperator(args.operatorId);
        if (!operator) return createErrorResult(`Operator ${args.operatorId} not found. ${inputInfo}`);

        if (args.properties && context?.metadataStore) {
          const mergedProperties = { ...operator.operatorProperties, ...args.properties };
          const validation = context.metadataStore.validateOperatorProperties(operator.operatorType, mergedProperties);
          if (!validation.isValid) {
            const compactSchema = context.metadataStore.getCompactSchema(operator.operatorType);
            const schemaStr = compactSchema ? ` Expected: ${formatCompactSchemaForError(compactSchema)}.` : "";
            return createErrorResult(
              `Invalid properties for "${operator.operatorType}": ${formatValidationErrors(validation)}.${schemaStr} ${inputInfo}`
            );
          }
        }

        const createdLinkPairs: { source: string; target: string }[] = [];
        const deletedLinkPairs: { source: string; target: string }[] = [];

        if (args.properties) {
          workflowState.updateOperatorProperties(args.operatorId, args.properties);
        }

        if (args.summary) {
          workflowState.updateOperatorDisplayName(args.operatorId, args.summary);
        }

        if (operator.operatorType === "DataProcessing" && args.properties?.code !== undefined) {
          const err = syncDataProcessingPorts(workflowState, args.operatorId, args.properties.code);
          if (err) return createErrorResult(`${err} ${inputInfo}`);
        }
        const currentOperator = workflowState.getOperator(args.operatorId) ?? operator;

        if (args.inputOperatorIds) {
          const currentLinks = workflowState
            .getLinksConnectedToOperator(args.operatorId)
            .filter(link => link.target.operatorID === args.operatorId);
          for (const link of currentLinks) {
            deletedLinkPairs.push({ source: link.source.operatorID, target: link.target.operatorID });
            workflowState.deleteLink(link.linkID);
          }

          for (const [portIndexStr, sourceOpIds] of Object.entries(args.inputOperatorIds)) {
            const targetPortIdx = parseInt(portIndexStr, 10);
            if (isNaN(targetPortIdx) || targetPortIdx < 0) {
              return createErrorResult(
                `Invalid input port index: "${portIndexStr}". Must be a non-negative integer. ${inputInfo}`
              );
            }
            if (targetPortIdx >= currentOperator.inputPorts.length) {
              return createErrorResult(
                `Input port index ${targetPortIdx} out of range. Operator "${args.operatorId}" has ${currentOperator.inputPorts.length} input port(s). ${inputInfo}`
              );
            }
            const targetPortId = currentOperator.inputPorts[targetPortIdx].portID;

            for (const sourceRef of sourceOpIds) {
              const { operatorId: sourceOpId, outputPortIndex } = parseSourceRef(sourceRef);
              const sourceOp = workflowState.getOperator(sourceOpId);
              if (!sourceOp) {
                return createErrorResult(
                  `Source operator "${sourceOpId}" not found. Make sure it exists before referencing it in inputOperatorIds. ${inputInfo}`
                );
              }
              if (sourceOp.outputPorts.length > 0 && outputPortIndex >= sourceOp.outputPorts.length) {
                return createErrorResult(
                  `Output port index ${outputPortIndex} out of range for source "${sourceOpId}" (${sourceOp.outputPorts.length} output port(s)). ${inputInfo}`
                );
              }
              const sourcePortId =
                sourceOp.outputPorts.length > 0
                  ? sourceOp.outputPorts[outputPortIndex].portID
                  : `output-${outputPortIndex}`;

              const linkId = workflowState.generateLinkId();
              const link: OperatorLink = {
                linkID: linkId,
                source: { operatorID: sourceOpId, portID: sourcePortId },
                target: { operatorID: args.operatorId, portID: targetPortId },
              };
              workflowState.addLink(link);
              createdLinkPairs.push({ source: sourceOpId, target: args.operatorId });
            }
          }

          autoLayoutWorkflow(workflowState);
        }

        let resultMsg = formatModifyOperatorResult(
          args.operatorId,
          createdLinkPairs.length > 0 ? createdLinkPairs : undefined,
          deletedLinkPairs.length > 0 ? deletedLinkPairs : undefined
        );

        return createToolResult(resultMsg);
      } catch (error: any) {
        return createErrorResult(formatOperatorError(args.operatorId, error.message || String(error)));
      }
    },
  });
}
