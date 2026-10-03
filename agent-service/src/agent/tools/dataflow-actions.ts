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
import { renderActionObservations } from "../native/action-observations";
import type { ObservationFormatSettings } from "../native/observation-format";

export type DataflowAction =
  | { type: "inspect"; target: "graph" }
  | { type: "inspect"; target: "operator"; operator_id: string; include_implementation: boolean }
  | {
      type: "inspect";
      target: "state";
      task_id: number | null;
      operator_id: string | string[];
      include_implementation: boolean;
      view: RetrievalView | null;
    }
  | { type: "fork"; task_id: number; operator_id: string; new_operator_id: string }
  | { type: "edit"; changes: string }
  | { type: "execute"; operator_ids?: string[] }
  | { type: "retrieve"; operator_id: string; view: RetrievalView; columns?: string[] }
  | { type: "answer"; content: string }
  | { type: "answer"; from: string };

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
  /** Frozen settings for this receipt; later settings changes do not rewrite it. */
  format?: ObservationFormatSettings;
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
      "Actions run in order. Wait for the next turn before making a decision based on a returned result. An answer with content is the sole action; an answer with from is the last action.",
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
          "execute",
          "Run only these operators and their upstream dependencies, materializing every operator in that scope and reusing valid cached results. Other branches remain in the graph. Use this for the current task or a historical fork when unrelated branches are unfinished or failed. Returns status and errors; retrieve tables separately.",
          { operator_ids: { type: "array", items: text, minItems: 1 } }
        ),
        action(
          "retrieve",
          "Read an existing result using an available view: full requests all records up to its character cap; sample returns a small record view; sample_stats adds data statistics to the same sample. Enabled flow evidence is added automatically. Never executes. Check completeness; missing or stale outputs require execute.",
          { operator_id: text, view: { type: "string", enum: [...RETRIEVAL_VIEWS] } }
        ),
        action(
          "retrieve",
          "Read an existing result restricted to the named columns, in the same views; use it on a wide table instead of a projection operator when only some columns are needed. Never executes.",
          {
            operator_id: text,
            view: { type: "string", enum: [...RETRIEVAL_VIEWS] },
            columns: { type: "array", items: text, minItems: 1 },
          }
        ),
        action(
          "answer",
          "Return the final response and end the loop. Must be the only action; base the answer on results already received.",
          { content: text }
        ),
        action(
          "answer",
          "Compose the final response from executed tables and end the loop: from is a table id, optionally with a projection [key=column:digits, ..., :digits] that names the keys, picks the columns and rounds numbers (:full keeps a value as computed); several parts separated by ; (key=table[...]) give one answer key per table. One row gives an object, several rows a list of row objects, one column a list. May follow execute in the same call; a table the runtime cannot answer from (empty, over 50 rows, unrounded decimals) is refused with the reason.",
          { from: text }
        ),
      ],
    },
  },
});

const taskId = { type: "integer", minimum: 1 };
const STATE_ACTIONS_SCHEMA = structuredClone(DATAFLOW_ACTIONS_SCHEMA);
STATE_ACTIONS_SCHEMA.properties.actions.items.anyOf.push(
  action(
    "inspect",
    "Inspect named operators at a completed task, including immediate input definitions. Null task lists their version changes and dependency hashes. Set view to null for definitions only, or a result view with a specific task to read saved data in the same call. Never executes or substitutes current state.",
    {
      target: { type: "string", const: "state" },
      task_id: { anyOf: [taskId, { type: "null" }] },
      operator_id: { anyOf: [text, { type: "array", items: text, minItems: 1, maxItems: 8 }] },
      include_implementation: { type: "boolean" },
      view: { anyOf: [{ type: "string", enum: [...RETRIEVAL_VIEWS] }, { type: "null" }] },
    }
  )
);
export const dataflowActionsSchema = (stateHistory = false) =>
  stateHistory ? STATE_ACTIONS_SCHEMA : DATAFLOW_ACTIONS_SCHEMA;
const ajv = new Ajv({ allErrors: true });
const validators = [DATAFLOW_ACTIONS_SCHEMA, STATE_ACTIONS_SCHEMA].map(schema => ({
  validate: ajv.compile<DataflowActionsInput>(schema),
  actions: schema.properties.actions.items.anyOf.map(schema => ({ schema, validate: ajv.compile(schema) })),
}));

function validationMessage(input: any, stateHistory: boolean): string {
  const { validate, actions: actionValidators } = validators[stateHistory ? 1 : 0];
  if (typeof input?.actions === "string")
    return 'Invalid dataflow arguments: actions must be a JSON array, not a string. Example: {"reasoning":"Run the graph.","actions":[{"type":"execute"}]}. Only edit.changes contains graph text. No actions ran.';
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
      const selected =
        candidates.find(v => v.validate(item)) ??
        candidates.find(v =>
          "target" in v.schema.properties
            ? (v.schema.properties as any).target.const === item?.target
            : (v.schema.required as string[]).every(key => item && key in item)
        ) ??
        (item?.type === "inspect" ? undefined : candidates[0]);
      if (!selected)
        return `Action ${index + 1} (inspect): target must be graph, operator${stateHistory ? ", or state" : ""}.`;
      if (!selected.validate(item))
        return `Action ${index + 1} (${item.type}): ${ajv.errorsText(selected.validate.errors?.slice(0, 1))}.`;
    }
  }
  validate(input);
  return `Invalid dataflow arguments: ${ajv.errorsText(validate.errors?.slice(0, 1))}`;
}

export const DATAFLOW_ACTIONS_DESCRIPTION =
  "Work with a dataflow using an ordered list of inspect, edit, execute, retrieve, or answer actions. " +
  "Start with a brief reasoning description. actions is a JSON array of objects; edit.changes is a string of graph commands. " +
  "Edits do not run the graph; retrieval reads existing results. " +
  "Batch actions whose arguments are already known. A failure skips later actions; completed edits remain. " +
  "After an execution failure, inspect and retrieve may still read independent completed results. " +
  "An answer with content must be the only action in its call; an answer with from (composed from an executed table) is the last action of its call.";

/** Validate first. The agent resolves this receipt after creating the step's
 * snapshot, in onStepFinish, before another model request or stop decision.
 * This preserves the same ownership boundary as post-step execution in code mode. */
export function prepareDataflowActions(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS,
  stateHistory = false
): DataflowActionsResult {
  const result: DataflowActionsResult = {
    kind: "dataflow-actions",
    status: "pending",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
  };
  if (!validators[stateHistory ? 1 : 0].validate(input)) {
    result.status = "error";
    result.error = validationMessage(input, stateHistory);
    return result;
  }
  const request = input as DataflowActionsInput;
  const invalidHistory = request.actions.find(
    a =>
      a.type === "inspect" &&
      a.target === "state" &&
      ((Array.isArray(a.operator_id) && new Set(a.operator_id).size !== a.operator_id.length) ||
        (a.task_id === null && a.view !== null))
  );
  if (invalidHistory) {
    result.status = "error";
    result.error =
      "History inspection requires unique operator IDs. Use view=null to list versions; select a task before reading a saved result. No actions ran.";
    return result;
  }
  const duplicateSelection = request.actions.findIndex(
    a => a.type === "execute" && a.operator_ids && new Set(a.operator_ids).size !== a.operator_ids.length
  );
  if (duplicateSelection !== -1) {
    result.status = "error";
    result.error = `Action ${duplicateSelection + 1}: execute operator_ids must be unique. No actions ran.`;
    return result;
  }
  const unavailable = request.actions.find(
    a =>
      (a.type === "retrieve" || (a.type === "inspect" && a.target === "state" && a.view !== null)) &&
      !views.includes(a.view as RetrievalView)
  );
  if (unavailable && "view" in unavailable) {
    result.status = "error";
    result.error = `Retrieve view ${JSON.stringify(unavailable.view)} is unavailable. Use ${views.join(", ")}. No actions ran.`;
    return result;
  }
  const answerAt = request.actions.findIndex(a => a.type === "answer");
  if (answerAt !== -1) {
    const answer = request.actions[answerAt];
    if (request.actions.filter(a => a.type === "answer").length > 1 || answerAt !== request.actions.length - 1) {
      result.status = "error";
      result.error = "One answer per call, as the last action. No actions ran.";
      return result;
    }
    if ("content" in answer && request.actions.length !== 1) {
      result.status = "error";
      result.error =
        "An answer with content must be the only action. Retrieve results in an earlier call before answering, or answer with from to compose the answer from an executed table.";
      return result;
    }
  }
  result.actions = structuredClone(request.actions).map((a, i) => ({ index: i + 1, action: a, status: "pending" }));
  return result;
}

export function createDataflowTool(views: readonly RetrievalView[] = availableRetrievalViews(), stateHistory = false) {
  const schema = structuredClone(dataflowActionsSchema(stateHistory));
  const descriptions = {
    full: "full requests records up to its character cap; narrow large tables first",
    sample: "sample checks layout and example values with a small record view",
    sample_stats:
      "sample_stats checks distributions and data quality with a small record view plus independently collected, coverage-labeled statistics",
  };
  for (const retrieve of schema.properties.actions.items.anyOf.filter(a => a.properties.type.const === "retrieve")) {
    (retrieve.properties as any).view.enum = [...views];
    const scoped = "columns" in retrieve.properties;
    retrieve.description = scoped
      ? `Read an existing result restricted to the named columns, in the same views (${views.join(", ")}); use it on a wide table instead of a projection operator when only some columns are needed. Never executes.`
      : `Read an existing result: ${views.map(v => descriptions[v]).join("; ")}. Start with sample_stats when available; request full only for unresolved row associations. Never executes. Check completeness; missing or stale outputs require execute.`;
  }
  for (const inspect of schema.properties.actions.items.anyOf.filter(
    a => "target" in a.properties && (a.properties as any).target.const === "state"
  ))
    (inspect.properties as any).view.anyOf[0].enum = [...views];
  return tool({
    description:
      DATAFLOW_ACTIONS_DESCRIPTION +
      (stateHistory
        ? " Saved task state: answering a task saves every operator's definition and result under that task's number. inspect target=state reads an operator as task N saved it (task_id) or lists its versions (task_id null); in an Edit, `update operator <id> from task <N>` restores that definition in place and `fork operator <id> from task <N> as <new_id>` copies it with the inputs it had at task N."
        : ""),
    strict: true,
    inputSchema: jsonSchema<DataflowActionsInput>(schema as any),
    execute: async input => prepareDataflowActions(input, views, stateHistory),
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
      else if (item.action.type === "answer")
        result.answer = "content" in item.action ? item.action.content : String((outcome.output as any)?.answer ?? "");
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
  return renderActionObservations(result);
}
