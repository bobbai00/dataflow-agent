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
import type { TaskReference } from "../task-history";
import { NATIVE_OPERATOR_NAMES } from "../native/catalog";

export type DataflowAction =
  | { type: "inspect"; target: "reference"; topic: "operators"; operator_names: string[] }
  | { type: "inspect"; target: "reference"; topic: "example"; example: "single" | "statistics" | "history" }
  | { type: "inspect"; target: "graph" }
  | { type: "inspect"; target: "graph"; operator_ids: string[] }
  | { type: "inspect"; target: "namespace"; names?: string[]; include_implementation?: boolean }
  | { type: "inspect"; target: "schema"; operator_id: string; offset?: number; limit?: number }
  | { type: "inspect"; target: "source"; operator_id: string; offset?: number; limit?: number }
  | { type: "inspect"; target: "operator"; operator_id: string; include_implementation: boolean }
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
  | { type: "fork"; task_id: number; operator_id: string; new_operator_id: string }
  | { type: "edit"; python?: string; changes: string }
  | { type: "execute"; operator_ids?: string[] }
  | { type: "retrieve"; operator_id: string; view: RetrievalView; columns?: string[] }
  | { type: "retrieve"; operator_ids: string[]; view: RetrievalView; columns?: string[] }
  | { type: "answer"; content: string; operator_ids?: string[] }
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
  /** Omitted only for historical expression-mode receipts. */
  protocol?: "registered-python-v1";
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
  /** Action-time provenance; not expanded into ordinary result observations. */
  references?: TaskReference[];
}

// JSON Schema patterns normally search substrings; some provider decoders use
// full-match semantics. Spell out the complete nonblank-string language so
// both interpretations allow ordinary multiword and multiline text.
const text = { type: "string", minLength: 1, pattern: "^[\\s\\S]*\\S[\\s\\S]*$" };
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
    description: "Actions run in order; decide on returned results in the next call.",
    items: {
      anyOf: [
        action(
          "inspect",
          "Read selected operator contracts from the same catalog as the initial prompt. Documentation only; never reads results, executes or edits state.",
          {
            target: { type: "string", const: "reference" },
            topic: { type: "string", const: "operators" },
            operator_names: {
              type: "array",
              items: { type: "string", enum: [...NATIVE_OPERATOR_NAMES] },
              minItems: 1,
              maxItems: 8,
            },
          }
        ),
        action(
          "inspect",
          "Read a worked example adapted to this session's views and features. Documentation only; never executes or changes state. History and statistics examples require their features to be enabled.",
          {
            target: { type: "string", const: "reference" },
            topic: { type: "string", const: "example" },
            example: { type: "string", enum: ["single", "statistics", "history"] },
          }
        ),
        action("inspect", "List operator IDs, kinds, and data edges with their ports. Does not execute.", {
          target: { type: "string", const: "graph" },
        }),
        action(
          "inspect",
          "Inspect only the named current operators and their direct input references, shapes and columns. Expand individual inputs as needed; never executes.",
          {
            target: { type: "string", const: "graph" },
            operator_ids: { type: "array", items: text, minItems: 1, maxItems: 8 },
          }
        ),
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
          'Apply the operator assignments and deletions in changes, with type="edit". Atomic; does not execute.',
          {
            changes: {
              ...text,
              description:
                "Statements, each starting at the margin: `name = operator(inputs, parameters)` creates name or replaces its whole definition; its inputs are the operator names written first in the call, and they become its incoming edges in port order. `del name` deletes an operator and its edges. Python functions are indented under the operator that uses them. Names resolve against the graph after the whole edit. A failed Edit applies no changes.",
            },
          }
        ),
        action(
          "execute",
          "Run the whole graph, reusing valid cached results. Returns status and errors; retrieve tables separately."
        ),
        action(
          "execute",
          "Run only these operators and their upstream dependencies, reusing valid cached results; other branches are left as they are. Returns status and errors; retrieve tables separately.",
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
STATE_ACTIONS_SCHEMA.properties.actions.items.anyOf = STATE_ACTIONS_SCHEMA.properties.actions.items.anyOf.filter(
  a =>
    !(
      "target" in a.properties &&
      (a.properties.target as { const: string }).const === "graph" &&
      !("operator_ids" in a.properties)
    )
);
STATE_ACTIONS_SCHEMA.properties.actions.items.anyOf.push(
  action(
    "inspect",
    "Read an earlier question, answer and dependency links with the local answer computation and references to unchanged saved inputs. Without declared answer roots, list candidates for explicit selection instead of expanding exploratory reads. No Python or result tables in this form. Never executes.",
    {
      target: { type: "string", const: "task" },
      task_id: taskId,
    }
  ),
  action(
    "inspect",
    "Retrieve the task's local answer computation with versioned earlier-input references. Null operator_id uses declared answer roots; absent sources remain unexpanded candidates. Named IDs select an intermediate branch. Expand a saved input by inspecting its owning task and operator ID. include_implementation adds local Python only; view adds selected root results only. Never executes; earlier answers and dependencies do not prove correctness.",
    {
      target: { type: "string", const: "task" },
      task_id: taskId,
      operator_id: { anyOf: [text, { type: "array", items: text, minItems: 1, maxItems: 8 }, { type: "null" }] },
      include_implementation: { type: "boolean" },
      view: { anyOf: [{ type: "string", enum: [...RETRIEVAL_VIEWS] }, { type: "null" }] },
    }
  ),
  action(
    "answer",
    "Return an explanation or answer shape that from cannot express, and identify completed source tables for later task-scoped retrieval. Prefer answer from for tabular answers: it serializes computed values and records sources automatically. Name answer tables, excluding exploratory reads. Availability is checked, not correctness. Must be the only action.",
    { content: text, operator_ids: { type: "array", items: text, minItems: 1, maxItems: 8 } }
  ),
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
    return 'Invalid dataflow arguments: actions must be a JSON array, not a string. Example: {"reasoning":"Run the graph.","actions":[{"type":"execute"}]}. Only edit.changes contains operator definitions. No actions ran.';
  if (Array.isArray(input?.actions)) {
    for (const [index, item] of input.actions.entries()) {
      const candidates = actionValidators.filter(v => (v.schema.properties.type as any).const === item?.type);
      if (!candidates.length) {
        if (["create", "update", "modify", "delete"].includes(item?.type)) {
          const changes = item.type === "delete" ? "del <name>" : "<name> = <operator>(<inputs>, ...)";
          return `Action ${index + 1}: ${JSON.stringify(item.type)} is a graph change. Write it inside an edit action: ${JSON.stringify({ type: "edit", changes })}. No actions ran.`;
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
        return `Action ${index + 1} (inspect): target must be graph, operator, reference${stateHistory ? ", state, or task" : ""}.`;
      if (!selected.validate(item))
        return `Action ${index + 1} (${item.type}): ${ajv.errorsText(selected.validate.errors?.slice(0, 1))}.`;
    }
  }
  validate(input);
  return `Invalid dataflow arguments: ${ajv.errorsText(validate.errors?.slice(0, 1))}`;
}

export const DATAFLOW_ACTIONS_DESCRIPTION =
  "Work with a dataflow through an ordered list of inspect, edit, execute, retrieve and answer actions, after a brief reasoning sentence. " +
  "actions is a JSON array of objects; edit.changes is a string of operator assignments. " +
  "Edits do not run the graph, and retrieval never executes. A failure skips later actions; completed edits remain. " +
  "An answer with content is the only action of its call; an answer with from is the last.";

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
  const request = input as unknown as DataflowActionsInput;
  if (
    request.actions.some(
      a =>
        a.type === "inspect" &&
        a.target === "reference" &&
        a.topic === "operators" &&
        new Set(a.operator_names).size !== a.operator_names.length
    )
  ) {
    result.status = "error";
    result.error = "Reference inspection requires unique operator names. No actions ran.";
    return result;
  }
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
    a =>
      ((a.type === "execute" || a.type === "answer") &&
        "operator_ids" in a &&
        a.operator_ids &&
        new Set(a.operator_ids).size !== a.operator_ids.length) ||
      (a.type === "inspect" &&
        a.target === "graph" &&
        "operator_ids" in a &&
        new Set(a.operator_ids).size !== a.operator_ids.length) ||
      (a.type === "inspect" &&
        a.target === "task" &&
        "operator_id" in a &&
        Array.isArray(a.operator_id) &&
        new Set(a.operator_id).size !== a.operator_id.length)
  );
  if (duplicateSelection !== -1) {
    result.status = "error";
    result.error = `Action ${duplicateSelection + 1}: selected operator IDs must be unique. No actions ran.`;
    return result;
  }
  const unavailable = request.actions.find(
    a =>
      (a.type === "retrieve" || (a.type === "inspect" && "view" in a && a.view !== null)) &&
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

export function createDataflowTool(
  views: readonly RetrievalView[] = availableRetrievalViews(),
  stateHistory = false,
  multiTask = stateHistory,
  /** Reference inspection reads operator contracts and examples; the full
   * prompt already contains them, so only the on-demand prompt offers it. */
  references = false
) {
  const schema = structuredClone(dataflowActionsSchema(stateHistory));
  if (!references)
    schema.properties.actions.items.anyOf = schema.properties.actions.items.anyOf.filter(
      a => !("target" in a.properties && (a.properties.target as { const: string }).const === "reference")
    );
  if (multiTask)
    schema.properties.actions.items.anyOf = schema.properties.actions.items.anyOf.filter(
      a =>
        !(
          "target" in a.properties &&
          (a.properties.target as { const: string }).const === "graph" &&
          !("operator_ids" in a.properties)
        )
    );
  const descriptions = {
    full: "full shows every record up to its character cap",
    sample: "sample shows a few records",
    sample_stats: "sample_stats adds statistics on every column to the sample",
  };
  for (const retrieve of schema.properties.actions.items.anyOf.filter(a => a.properties.type.const === "retrieve")) {
    (retrieve.properties as any).view.enum = [...views];
    const scoped = "columns" in retrieve.properties;
    retrieve.description = scoped
      ? `Read an existing result restricted to the named columns, in the same views (${views.join(", ")}); use it on a wide table when only some columns are needed. Never executes.`
      : `Read an existing result: ${views.map(v => descriptions[v]).join("; ")}.${views.includes("full") && views.length > 1 ? ` Look with ${views.includes("sample_stats") ? "sample_stats" : "sample"} first; request full only when you need every row.` : ""} Never executes; missing or stale results require execute.`;
  }
  for (const inspect of schema.properties.actions.items.anyOf.filter(
    a => "target" in a.properties && "view" in a.properties
  ))
    (inspect.properties as any).view.anyOf[0].enum = [...views];
  return tool({
    description:
      DATAFLOW_ACTIONS_DESCRIPTION +
      (stateHistory
        ? " Saved tasks: inspect target=task returns the local computation and versioned earlier-input references. Expand selected inputs through their owning task or target=state. Python and selected root results are optional. Declare Answer operator_ids or use answer from; missing roots remain candidates without automatic expansion. Graph inspection requires named operator_ids. In an Edit, `name = at(name, task=N)` restores that definition on current inputs and `new_name = at(name, task=N)` copies its saved upstream branch."
        : ""),
    strict: true,
    inputSchema: jsonSchema<DataflowActionsInput>(schema as any),
    execute: async input => prepareDataflowActions(input, views, stateHistory),
  });
}

/** Active registered-Python protocol. The schema above is retained for archived
 * expression-mode sessions and their replay tests, never exposed by native mode. */
export const REGISTERED_DATAFLOW_ACTIONS_SCHEMA = object({
  reasoning: { ...text, description: "One brief sentence stating the next objective." },
  actions: {
    type: "array",
    minItems: 1,
    maxItems: 32,
    description: "Actions run in order; decide on returned results in the next call.",
    items: {
      anyOf: [
        ...(["schema", "source"] as const).flatMap(target => {
          const description =
            target === "schema"
              ? "List exact column names and types from a current completed result, independently of displayed samples. Default: first 200 columns; follow next_offset for more. Never executes."
              : "Discover retained scan source paths and workbook sheet names, with each sheet's first raw preview row. Use scan(preview=1), execute, then this inspection in one call. Raw rows are layout hints, not parsed schemas. Never opens files or executes.";
          return [
            action("inspect", description, { target: { type: "string", const: target }, operator_id: text }),
            action("inspect", description + " Read a zero-based page; limit is 1..200.", {
              target: { type: "string", const: target },
              operator_id: text,
              offset: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: 200 },
            }),
          ];
        }),
        action("inspect", "List current operator IDs, ordered inputs, and result status. Never executes.", {
          target: { type: "string", const: "graph" },
        }),
        action(
          "inspect",
          "Inspect the selected current graph nodes and their direct input references. Never executes.",
          {
            target: { type: "string", const: "graph" },
            operator_ids: { type: "array", items: text, minItems: 1 },
          }
        ),
        action(
          "inspect",
          "Read an instance's definition, current function signature, consumers and result status. Include authored Python source when requested.",
          {
            target: { type: "string", const: "operator" },
            operator_id: text,
            include_implementation: { type: "boolean" },
          }
        ),
        action(
          "inspect",
          "List the shared registered Python definitions, including functions not used by a graph node. Reads saved metadata, never executes Python.",
          {
            target: { type: "string", const: "namespace" },
          }
        ),
        action(
          "inspect",
          "Read selected Python declarations and optionally their authored source. Execution-time variables are not shared or inspected.",
          {
            target: { type: "string", const: "namespace" },
            names: { type: "array", items: text, minItems: 1 },
            include_implementation: { type: "boolean" },
          }
        ),
        action(
          "inspect",
          "Read detailed built-in operator contracts, defaults and accepted settings. Never executes or retrieves data.",
          {
            target: { type: "string", const: "reference" },
            topic: { type: "string", const: "operators" },
            operator_names: {
              type: "array",
              items: {
                type: "string",
                enum: NATIVE_OPERATOR_NAMES.filter(name => !["map", "process"].includes(name)),
              },
              minItems: 1,
            },
          }
        ),
        action(
          "edit",
          "Atomically register Python definitions and edit the graph. Neither field runs graph operators. Use an empty string for an unused field.",
          {
            python: {
              type: "string",
              description:
                "Cumulative imports, helpers and synchronous function definitions. Public functions become operator types.",
            },
            changes: {
              type: "string",
              description:
                "One statement per operator: set id: type(input1, input2, setting=value), or delete id. A set replaces the complete definition. Positional inputs are graph IDs; keywords are settings. Forward references resolve against the final graph.",
            },
          }
        ),
        action(
          "execute",
          "Ensure the whole graph has current results. Report completion or errors; retrieve tables separately."
        ),
        action(
          "execute",
          "Ensure selected operators and ancestors have current results. Other branches do not run. Retrieve tables separately.",
          {
            operator_ids: { type: "array", items: text, minItems: 1 },
          }
        ),
        action(
          "retrieve",
          "Read current results in request order; missing or stale targets have individual errors. Each result has its own budget. Never executes.",
          {
            operator_ids: { type: "array", items: text, minItems: 1 },
            view: { type: "string", enum: [...RETRIEVAL_VIEWS] },
          }
        ),
        action(
          "retrieve",
          "Read selected columns of current results. The view and column selection apply to every target. Never executes.",
          {
            operator_ids: { type: "array", items: text, minItems: 1 },
            view: { type: "string", enum: [...RETRIEVAL_VIEWS] },
            columns: { type: "array", items: text, minItems: 1 },
          }
        ),
        action(
          "answer",
          "Return the final response and finish the turn. Must be the sole action; base the response on results already checked.",
          { content: text }
        ),
      ],
    },
  },
});

const registeredValidator = ajv.compile(REGISTERED_DATAFLOW_ACTIONS_SCHEMA);
export const EMPTY_DATAFLOW_ERROR = "The dataflow is empty. Add an operator before execute.";

export function prepareRegisteredDataflowActions(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS,
  _stateHistory = false
): DataflowActionsResult {
  const result: DataflowActionsResult = {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
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
  // Opus 4.8 sent `actions` as a JSON string twice in the 2026-10-08 layout
  // comparison. Name the shape; never decode or repair the arguments.
  if (typeof (input as any)?.actions === "string")
    return reject(
      'Invalid registered dataflow arguments: actions must be a JSON array, not a string. Example: {"reasoning":"Inspect the graph.","actions":[{"type":"inspect","target":"graph"}]}. Only edit.python and edit.changes contain source strings.'
    );
  if (!registeredValidator(input))
    return reject(`Invalid registered dataflow arguments: ${ajv.errorsText(registeredValidator.errors?.slice(0, 1))}.`);
  const request = input as unknown as DataflowActionsInput;
  for (const action of request.actions) {
    if (action.type === "edit" && !action.python?.trim() && !action.changes.trim())
      return reject("An edit needs nonempty python or changes.");
    const selected =
      "operator_ids" in action
        ? action.operator_ids
        : action.type === "inspect" && action.target === "namespace"
          ? action.names
          : action.type === "inspect" && action.target === "reference" && action.topic === "operators"
            ? action.operator_names
            : undefined;
    if (selected && new Set(selected).size !== selected.length) return reject("Selected names must be unique.");
    if (action.type === "retrieve" && !views.includes(action.view))
      return reject(`Retrieve view ${JSON.stringify(action.view)} is unavailable. Use ${views.join(", ")}.`);
    if (action.type === "answer" && request.actions.length !== 1) return reject("An answer must be the only action.");
  }
  result.actions = structuredClone(request.actions).map((action, i) => ({ index: i + 1, action, status: "pending" }));
  return result;
}

export function createRegisteredDataflowTool(
  views: readonly RetrievalView[] = availableRetrievalViews(),
  stateHistory = false,
  _multiTask = stateHistory
) {
  const schema = structuredClone(REGISTERED_DATAFLOW_ACTIONS_SCHEMA);
  for (const entry of schema.properties.actions.items.anyOf)
    if (entry.properties.type.const === "retrieve") (entry.properties as any).view.enum = [...views];
  return tool({
    description:
      "Work with a Dataflow through ordered inspect, edit, execute, retrieve and answer actions. Python definitions share a namespace; each operator invocation is isolated and exchanges tables only through graph edges. Edits commit atomically and never run the graph. Retrieve accepts multiple operator_ids and never executes. Earlier committed edits survive later failures. After execution failure, later requested executions and reads can continue; edits are skipped, and a skipped edit also blocks subsequent executions. Answer content must be the sole action.",
    strict: true,
    inputSchema: jsonSchema<DataflowActionsInput>(schema as any),
    execute: async input => prepareRegisteredDataflowActions(input, views, stateHistory),
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
  let allowExecution = false;
  for (const item of result.actions) {
    const canContinue =
      (allowReads && (item.action.type === "inspect" || item.action.type === "retrieve")) ||
      (allowExecution && item.action.type === "execute");
    if (result.error && !canContinue) {
      item.status = "skipped";
      item.output = "Not run because an earlier action failed.";
      // A later execution may rely on this planned mutation. Never run it
      // against the old graph after silently skipping the requested edit.
      if (item.action.type === "edit" || item.action.type === "fork") allowExecution = false;
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
    if (item.action.type === "execute" && item.status === "error") {
      allowReads = true;
      allowExecution = result.protocol === "registered-python-v1";
    }
  }
  result.status = result.error ? "error" : "completed";
}

export function renderDataflowActionsResult(result: DataflowActionsResult): string {
  return renderActionObservations(result);
}
