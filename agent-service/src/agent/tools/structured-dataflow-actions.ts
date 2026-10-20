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

import Ajv, { type ValidateFunction } from "ajv";
import { jsonSchema, tool } from "ai";
import type { RetrievalView } from "../../types/agent";
import type { TaskReference } from "../task-history";
import { NATIVE_OPERATOR_NAMES } from "../native/catalog";
import { availableRetrievalViews, RETRIEVAL_VIEWS } from "../native/retrieval";
import { structuredSetSchemas, type StructuredOperatorDefinition } from "../native/structured-operators";
import type { NativeBatchOutcome } from "./native-batch-tools";

export type JsonDataflowAction =
  | ({ type: "set" } & StructuredOperatorDefinition)
  | { type: "delete"; ids: string[] }
  | { type: "read"; ids: string[]; view: RetrievalView; columns: string[] | null }
  | { type: "answer"; content: string; operator_ids: string[] | null }
  | {
      type: "answer";
      source: { id: string; column: string | null; shape: "scalar" | "list" | "records"; decimals: number | null };
    }
  | { type: "inspect"; target: "graph" }
  | { type: "inspect"; target: "graph"; operator_ids: string[] }
  | { type: "inspect"; target: "operator"; operator_id: string; include_implementation: boolean }
  | { type: "inspect"; target: "reference"; topic: "operators"; operator_names: string[] }
  | { type: "inspect"; target: "reference"; topic: "example"; example: "single" | "statistics" | "history" }
  | { type: "inspect"; target: "task"; task_id: number }
  | {
      type: "inspect";
      target: "task";
      task_id: number;
      operator_id: string | string[] | null;
      include_implementation: boolean;
      view: RetrievalView | null;
    }
  | {
      type: "inspect";
      target: "state";
      task_id: number | null;
      operator_id: string | string[];
      include_implementation: boolean;
      view: RetrievalView | null;
    }
  | { type: "fork"; task_id: number; operator_id: string; new_operator_id: string };

export interface JsonDataflowActionsInput {
  reasoning: string;
  actions: JsonDataflowAction[];
}

/** Preparation is pure: the common runtime fills these receipts after the step
 * snapshot exists. Indexes belong to this call even when several calls run in
 * the same model response. */
export interface JsonDataflowActionsResult {
  kind: "dataflow-actions";
  protocol: "json";
  status: "pending" | "completed" | "error";
  actions: Array<{
    index: number;
    action: JsonDataflowAction;
    status: "pending" | "ok" | "error" | "skipped";
    output?: unknown;
  }>;
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
  error?: string;
  answer?: string;
  references?: TaskReference[];
}

export interface StructuredDataflowToolOptions {
  views?: readonly RetrievalView[];
  stateHistory?: boolean;
  multiTask?: boolean;
  references?: boolean;
}

type Schema = Record<string, any>;
interface ResolvedOptions {
  views: RetrievalView[];
  stateHistory: boolean;
  multiTask: boolean;
  references: boolean;
}

const text = { type: "string", minLength: 1, pattern: "[\\s\\S]*\\S[\\s\\S]*" };
const ids = { type: "array", items: text, minItems: 1 };
const taskId = { type: "integer", minimum: 1 };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const action = (
  type: JsonDataflowAction["type"],
  description: string,
  properties: Record<string, Schema> = {}
): Schema => ({
  ...object({ type: { type: "string", const: type }, ...properties }),
  description,
});

function resolveOptions(options: StructuredDataflowToolOptions): ResolvedOptions {
  const views = [...(options.views ?? availableRetrievalViews())];
  if (!views.length || new Set(views).size !== views.length || views.some(view => !RETRIEVAL_VIEWS.includes(view)))
    throw new Error("Structured dataflow views must be a nonempty unique selection of full, sample or sample_stats.");
  return {
    views,
    stateHistory: options.stateHistory === true,
    multiTask: options.multiTask ?? options.stateHistory === true,
    references: options.references === true,
  };
}

/** Schema and validator share one session-filtered contract. Operator parameter
 * unions come directly from the catalog decoder, never from expression text. */
export function structuredDataflowActionsSchema(options: StructuredDataflowToolOptions = {}): Schema {
  const { views, stateHistory, multiTask, references } = resolveOptions(options);
  const view = { type: "string", enum: views };
  const branches: Schema[] = [
    ...structuredSetSchemas(),
    action("delete", "Delete these operators and their edges. Grouped sets and deletes apply atomically.", { ids }),
    action(
      "read",
      "Compute missing or stale selected operators and their ancestors, then read their current results. Available views are shown in view; null columns selects all fields. A failed computation returns its error.",
      { ids, view, columns: nullable(ids) }
    ),
    action(
      "answer",
      "Return final content and end the task. Must be the last action; it may follow a read. Null operator_ids leaves sources unspecified; otherwise identify completed source tables.",
      { content: text, operator_ids: nullable(ids) }
    ),
    action(
      "answer",
      "Compute and serialize the source table as the selected shape, and end the task. Scalar needs one row and one column; list needs column; records returns row objects. Null decimals preserves computed numbers; an integer rounds the final presentation. Must be last.",
      {
        source: object({
          id: text,
          column: {
            ...nullable(text),
            description:
              "Selected source field; list requires a non-null column. Null selects all fields for scalar or records.",
          },
          shape: { type: "string", enum: ["scalar", "list", "records"] },
          decimals: nullable({ type: "integer", minimum: 0, maximum: 15 }),
        }),
      }
    ),
    action("inspect", "Read selected current operator definitions and direct inputs. Never executes.", {
      target: { type: "string", const: "graph" },
      operator_ids: ids,
    }),
    action("inspect", "Read one operator's definition and optionally its Python implementation. Never executes.", {
      target: { type: "string", const: "operator" },
      operator_id: text,
      include_implementation: { type: "boolean" },
    }),
  ];
  if (!multiTask)
    branches.push(
      action("inspect", "List the current graph's operator IDs and connections. Never executes.", {
        target: { type: "string", const: "graph" },
      })
    );
  if (references)
    branches.push(
      action("inspect", "Read contracts from this session's operator catalog. Documentation only.", {
        target: { type: "string", const: "reference" },
        topic: { type: "string", const: "operators" },
        operator_names: {
          type: "array",
          items: { type: "string", enum: [...NATIVE_OPERATOR_NAMES] },
          minItems: 1,
          maxItems: 8,
        },
      }),
      action("inspect", "Read a worked example supported by this session. Documentation only.", {
        target: { type: "string", const: "reference" },
        topic: { type: "string", const: "example" },
        example: {
          type: "string",
          enum: [
            "single",
            ...(views.includes("sample_stats") ? ["statistics"] : []),
            ...(stateHistory ? ["history"] : []),
          ],
        },
      })
    );
  if (stateHistory) {
    const selected = { anyOf: [text, { ...ids, maxItems: 8 }] };
    branches.push(
      action("inspect", "Read a completed task's question, answer and local computation references. Never executes.", {
        target: { type: "string", const: "task" },
        task_id: taskId,
      }),
      action(
        "inspect",
        "Read saved computation definitions and optional saved results. Null operator_id uses declared answer roots. Never executes.",
        {
          target: { type: "string", const: "task" },
          task_id: taskId,
          operator_id: nullable(selected),
          include_implementation: { type: "boolean" },
          view: nullable(view),
        }
      ),
      action(
        "inspect",
        "Inspect selected operators at a completed task. Null task_id lists versions and requires null view. Never executes.",
        {
          target: { type: "string", const: "state" },
          task_id: nullable(taskId),
          operator_id: selected,
          include_implementation: { type: "boolean" },
          view: nullable(view),
        }
      ),
      action(
        "fork",
        "Copy a saved operator and its upstream computation into the current graph under new_operator_id.",
        {
          task_id: taskId,
          operator_id: text,
          new_operator_id: text,
        }
      )
    );
  }
  return object({
    reasoning: { ...text, description: "One brief sentence stating the next objective." },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      description:
        "Actions run in order; answer is unique and last. Decisions depending on returned observations belong in the next model response.",
      items: { anyOf: branches },
    },
  });
}

const ajv = new Ajv({ allErrors: true });
const validators = new Map<string, ValidateFunction<JsonDataflowActionsInput>>();
function validator(options: ResolvedOptions): ValidateFunction<JsonDataflowActionsInput> {
  const key = JSON.stringify(options);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile<JsonDataflowActionsInput>(structuredDataflowActionsSchema(options));
    validators.set(key, validate);
  }
  return validate;
}

export function prepareStructuredDataflowActions(
  input: unknown,
  options: StructuredDataflowToolOptions = {}
): JsonDataflowActionsResult {
  const result: JsonDataflowActionsResult = {
    kind: "dataflow-actions",
    protocol: "json",
    status: "pending",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
  };
  const reject = (message: string) => {
    result.status = "error";
    result.error = `${message} No actions ran.`;
    return result;
  };
  const validate = validator(resolveOptions(options));
  if (!validate(input)) {
    if (typeof (input as any)?.actions === "string")
      return reject("Invalid structured dataflow arguments: actions must be a JSON array of objects, not a string.");
    return reject(`Invalid structured dataflow arguments: ${ajv.errorsText(validate.errors?.slice(0, 1))}.`);
  }
  const request = input as JsonDataflowActionsInput;
  const answerIndexes = request.actions.flatMap((a, i) => (a.type === "answer" ? [i] : []));
  if (answerIndexes.length > 1 || (answerIndexes.length === 1 && answerIndexes[0] !== request.actions.length - 1))
    return reject("One answer per call, as the last action.");
  for (const [index, item] of request.actions.entries()) {
    const selection =
      item.type === "read" || item.type === "delete"
        ? item.ids
        : item.type === "answer" && "operator_ids" in item
          ? item.operator_ids
          : item.type === "inspect" && "operator_ids" in item
            ? item.operator_ids
            : item.type === "inspect" && "operator_names" in item
              ? item.operator_names
              : item.type === "inspect" && "operator_id" in item && Array.isArray(item.operator_id)
                ? item.operator_id
                : null;
    if (selection && new Set(selection).size !== selection.length)
      return reject(`Action ${index + 1}: selected IDs must be unique.`);
    if (item.type === "read" && item.columns && new Set(item.columns).size !== item.columns.length)
      return reject(`Action ${index + 1}: selected columns must be unique.`);
    if (item.type === "inspect" && item.target === "state" && item.task_id === null && item.view !== null)
      return reject(
        `Action ${index + 1}: listing saved versions requires view=null; select a task before reading results.`
      );
    if (item.type === "answer" && "source" in item && item.source.shape === "list" && item.source.column === null)
      return reject(`Action ${index + 1}: a list source answer requires column.`);
  }
  result.actions = structuredClone(request.actions).map((action, i) => ({ index: i + 1, action, status: "pending" }));
  return result;
}

export function createStructuredDataflowTool(options: StructuredDataflowToolOptions = {}) {
  // Capture options so a caller cannot mutate the declared schema's session
  // contract while an already-created tool uses a different validator.
  const resolved = resolveOptions(options);
  return tool({
    description:
      "Work with a dataflow using typed set, delete, read and answer actions plus inspection. Structure lives in JSON fields; only dedicated operator code fields contain Python. Local validation enforces the complete typed contract before actions run. Actions and multiple calls run in their supplied order. Grouped sets and deletes are atomic; reads compute selected missing or stale results. A failure skips later actions. Answer is unique and last.",
    // The same complete schema is validated locally for every model. Provider
    // grammar compilation is disabled uniformly, without a per-model fallback.
    strict: false,
    inputSchema: jsonSchema<JsonDataflowActionsInput>(structuredDataflowActionsSchema(resolved)),
    execute: async input => prepareStructuredDataflowActions(input, resolved),
  });
}
