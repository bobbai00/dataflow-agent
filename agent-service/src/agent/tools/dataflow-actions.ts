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

import Ajv from "ajv";
import { jsonSchema, tool } from "ai";
import type { NativeBatchOutcome } from "./native-batch-tools";
import type { RetrievalView } from "../../types/agent";
import { availableRetrievalViews, RETRIEVAL_VIEWS } from "../native/retrieval";

export type DataflowAction =
  | { type: "inspect"; target: "graph" }
  | { type: "inspect"; target: "operator"; operator_id: string; include_implementation: boolean }
  | { type: "edit"; changes: string }
  | { type: "execute" }
  | { type: "retrieve"; operator_id: string; view: RetrievalView }
  | { type: "answer"; content: string };

export interface DataflowActionsInput {
  reasoning: string;
  actions: DataflowAction[];
}

export interface ActionOutcome {
  status: "ok" | "error";
  output: unknown;
}

export interface DataflowActionsResult {
  kind: "dataflow-actions";
  status: "pending" | "completed" | "error";
  actions: Array<{
    index: number;
    action: DataflowAction;
    status: "pending" | "ok" | "error" | "skipped";
    output?: unknown;
  }>;
  // The existing snapshot renderers and access accounting use these receipts.
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
  error?: string;
  answer?: string;
}

const text = { type: "string", minLength: 1, pattern: "\\S" };
const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const action = (type: DataflowAction["type"], description: string, properties = {}) => ({
  ...object({ type: { type: "string", const: type }, ...properties }),
  description,
});

export const DATAFLOW_ACTIONS_SCHEMA = object({
  reasoning: {
    ...text,
    description: "One brief sentence stating the next objective.",
  },
  actions: {
    type: "array",
    minItems: 1,
    maxItems: 32,
    description:
      "Actions run in order. Wait for the next turn before making a decision based on a returned result. An answer must be the only action.",
    items: {
      anyOf: [
        action("inspect", "List operator IDs, kinds, and data edges with their ports. Does not execute.", {
          target: { type: "string", const: "graph" },
        }),
        action(
          "inspect",
          "Read an operator's definition, ports, connections and description. Request its registered Python functions when needed.",
          {
            target: { type: "string", const: "operator" },
            operator_id: text,
            include_implementation: { type: "boolean" },
          }
        ),
        action(
          "edit",
          'Apply operator create/update/delete commands and edge create/delete commands in changes, with type="edit". Atomic; does not execute.',
          {
            changes: {
              ...text,
              description:
                "Graph commands: create operator id: expression; update operator id: expression; delete operator id; create edge source.out -> target.port; delete edge source.out -> target.port. One command per line, without leading spaces; Python functions are indented under their operator. Operator expressions have no upstream table arguments. Update supplies the complete definition and preserves connections. Deleting an operator automatically deletes its incident edges. Edges cannot be updated. A failed Edit applies no changes.",
            },
          }
        ),
        action(
          "execute",
          "Run every component of the graph, including disconnected branches, reusing valid cached results. Repair failed operators and connect or delete unused consumers first. Returns status and errors; retrieve tables separately."
        ),
        action(
          "retrieve",
          "Read an existing result using an available view: full requests all records up to its character cap; sample returns a small record view; sample_stats adds data statistics to the same sample. Enabled flow evidence is added automatically. Never executes. Check completeness; missing or stale outputs require execute.",
          { operator_id: text, view: { type: "string", enum: [...RETRIEVAL_VIEWS] } }
        ),
        action(
          "answer",
          "Return the final response and end the loop. Must be the only action; base the answer on results already received.",
          { content: text }
        ),
      ],
    },
  },
});

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile<DataflowActionsInput>(DATAFLOW_ACTIONS_SCHEMA);
const actionValidators = DATAFLOW_ACTIONS_SCHEMA.properties.actions.items.anyOf.map(schema => ({
  schema,
  validate: ajv.compile(schema),
}));

function validationMessage(input: any): string {
  if (Array.isArray(input?.actions)) {
    for (const [index, item] of input.actions.entries()) {
      const candidates = actionValidators.filter(v => (v.schema.properties.type as any).const === item?.type);
      if (!candidates.length) {
        if (["create", "update", "modify", "delete"].includes(item?.type)) {
          const verb = item.type === "modify" ? "update" : item.type;
          const changes = `${verb} operator <id>${verb === "delete" ? "" : ": <expression>"}`;
          return `Action ${index + 1}: ${JSON.stringify(item.type)} is a graph command. Put it inside an edit action: ${JSON.stringify({ type: "edit", changes })}. No actions ran.`;
        }
        return `Action ${index + 1}: unknown action type ${JSON.stringify(item?.type ?? null)}. Use inspect, edit, execute, retrieve, or answer. Operators such as scan, process and aggregate belong inside an edit.`;
      }
      const selected = candidates.find(
        v => !("target" in v.schema.properties) || (v.schema.properties as any).target.const === item?.target
      );
      if (!selected) return `Action ${index + 1} (inspect): target must be graph or operator.`;
      if (!selected.validate(item))
        return `Action ${index + 1} (${item.type}): ${ajv.errorsText(selected.validate.errors?.slice(0, 1))}.`;
    }
  }
  validate(input);
  return `Invalid dataflow arguments: ${ajv.errorsText(validate.errors?.slice(0, 1))}`;
}

export const DATAFLOW_ACTIONS_DESCRIPTION =
  "Work with a dataflow using an ordered list of inspect, edit, execute, retrieve, or answer actions. " +
  "Start with a brief reasoning description. Edits do not run the graph; retrieval reads existing results. " +
  "Batch actions whose arguments are already known. A failure skips later actions; completed edits remain. " +
  "After an execution failure, inspect and retrieve may still read independent completed results. " +
  "Answer must be the only action in its call.";

/** Validate first. The agent resolves this receipt after creating the step's
 * snapshot, in onStepFinish, before another model request or stop decision.
 * This preserves the same ownership boundary as post-step execution in code mode. */
export function prepareDataflowActions(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS
): DataflowActionsResult {
  const result: DataflowActionsResult = {
    kind: "dataflow-actions",
    status: "pending",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
  };
  if (!validate(input)) {
    result.status = "error";
    result.error = validationMessage(input);
    return result;
  }
  const request = input as DataflowActionsInput;
  const unavailable = request.actions.find(a => a.type === "retrieve" && !views.includes(a.view));
  if (unavailable?.type === "retrieve") {
    result.status = "error";
    result.error = `Retrieve view ${JSON.stringify(unavailable.view)} is unavailable. Use ${views.join(", ")}. No actions ran.`;
    return result;
  }
  if (request.actions.some(a => a.type === "answer") && request.actions.length !== 1) {
    result.status = "error";
    result.error = "Answer must be the only action. Retrieve results in an earlier call before answering.";
    return result;
  }
  result.actions = structuredClone(request.actions).map((a, i) => ({ index: i + 1, action: a, status: "pending" }));
  return result;
}

export function createDataflowTool(views: readonly RetrievalView[] = availableRetrievalViews()) {
  const schema = structuredClone(DATAFLOW_ACTIONS_SCHEMA);
  const retrieve = schema.properties.actions.items.anyOf.find(a => a.properties.type.const === "retrieve")!;
  (retrieve.properties as any).view.enum = [...views];
  const descriptions = {
    full: "full requests all records up to its character cap",
    sample: "sample returns a small record view",
    sample_stats: "sample_stats adds data statistics to the small record view",
  };
  retrieve.description = `Read an existing result: ${views.map(v => descriptions[v]).join("; ")}. Enabled flow evidence is added automatically. Never executes. Check completeness; missing or stale outputs require execute.`;
  return tool({
    description: DATAFLOW_ACTIONS_DESCRIPTION,
    strict: true,
    inputSchema: jsonSchema<DataflowActionsInput>(schema as any),
    execute: async input => prepareDataflowActions(input, views),
  });
}

export function asDataflowActionsResult(output: unknown): DataflowActionsResult | undefined {
  if (!output || typeof output !== "object") return undefined;
  const r = output as DataflowActionsResult;
  return r.kind === "dataflow-actions" && Array.isArray(r.actions) ? r : undefined;
}

export async function runDataflowActions(
  result: DataflowActionsResult,
  run: (action: DataflowAction, index: number) => Promise<ActionOutcome>
): Promise<void> {
  if (result.status !== "pending") return;
  let allowReads = false;
  for (const item of result.actions) {
    if (result.error && !(allowReads && (item.action.type === "inspect" || item.action.type === "retrieve"))) {
      item.status = "skipped";
      item.output = "Not run because an earlier action failed.";
      continue;
    }
    try {
      const outcome = await run(item.action, item.index);
      item.status = outcome.status;
      item.output = structuredClone(outcome.output);
      if (outcome.status === "error")
        result.error ??= `Action ${item.index} (${item.action.type}) failed: ${typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output)}`;
      else if (item.action.type === "answer") result.answer = item.action.content;
    } catch (error) {
      item.status = "error";
      item.output = error instanceof Error ? error.message : String(error);
      result.error ??= `Action ${item.index} (${item.action.type}) failed: ${item.output}`;
    }
    if (item.action.type === "execute" && item.status === "error") allowReads = true;
  }
  result.status = result.error ? "error" : "completed";
}

export function renderDataflowActionsResult(result: DataflowActionsResult): string {
  if (!result.actions.length) return `[ERROR] ${result.error ?? "No actions were run."}`;
  return result.actions
    .map(item => {
      let body = typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2);
      if (item.output && typeof item.output === "object") {
        const output = item.output as Record<string, any>;
        if (item.action.type === "retrieve" && typeof output.text === "string") {
          body = `Operator ${output.operator_id}${output.revision ? ` (revision ${output.revision})` : ""}\n${output.text}`;
          if (output.view && output.table)
            body = `View ${output.view}: ${output.table.returnedRows}/${output.table.totalRows ?? "?"} rows, ${output.table.columnsShown}/${output.table.totalColumns} columns; ${output.table.complete ? "complete" : "incomplete"}.\n${body}`;
          if (output.superseded_in_call) body = `Historical result; changed later in this call.\n${body}`;
        } else if (item.action.type === "edit" && Array.isArray(output.changes)) {
          body = [
            ...output.changes.map(
              (change: any) =>
                `- ${change.operation.replaceAll("_", " ")}: ${change.operator_id ?? change.edge}${change.deleted_edges?.length ? `\n  automatically deleted edges: ${change.deleted_edges.join("; ")}` : ""}`
            ),
            ...(output.unconnected_inputs?.length
              ? [`Unconnected required inputs: ${output.unconnected_inputs.join(", ")}`]
              : []),
            ...(output.invalidated_results?.length
              ? [`Invalidated results: ${output.invalidated_results.join(", ")}`]
              : []),
          ].join("\n");
        } else if ((item.action.type === "edit" || item.action.type === "execute") && Array.isArray(output.operators)) {
          body = [
            ...output.operators.map(
              (op: any) =>
                `- ${op.id}: ${op.status}${op.message ? ` — ${op.message}` : `, ${op.rows ?? "unknown"} rows; result not requested`}${op.checks?.length ? `\n${op.checks.join("\n")}` : ""}`
            ),
            ...(output.blocked ?? []).map((op: any) => `- ${op.id}: blocked — ${op.message}`),
            ...(output.error ? [`Execution error: ${output.error}`] : []),
          ].join("\n");
        }
      }
      return `${item.index}. ${item.action.type}: ${item.status}\n${body ?? ""}`;
    })
    .join("\n\n");
}
