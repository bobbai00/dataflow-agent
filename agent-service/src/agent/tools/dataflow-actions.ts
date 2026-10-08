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
import type { TaskReference, TaskRecord } from "../task-history";
import { NATIVE_OPERATOR_NAMES } from "../native/catalog";

export type DataflowAction =
  | { type: "inspect"; target: "reference"; topic: "operators"; operator_names: string[] }
  | { type: "inspect"; target: "reference"; topic: "example"; example: "single" | "statistics" | "history" }
  | { type: "inspect"; target: "graph" }
  | { type: "inspect"; target: "graph"; operator_ids: string[] }
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
  | { type: "edit"; changes: string }
  | { type: "execute"; operator_ids?: string[] }
  | { type: "retrieve"; operator_id: string; view: RetrievalView; columns?: string[] }
  | { type: "read"; operator_ids: string[]; view: RetrievalView | null; include_implementation: boolean; columns: string[] | null }
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
  /** Sealed at answer time for faithful history export/import. It is not
   * echoed in the model's ordinary Answer observation. */
  task_catalog?: Readonly<TaskRecord>;
  /** Versioned receipt protocol; absent on imported legacy action traces. */
  saved_versions?: true;
  /** Set when this task's results could not be retained in the engine for later `@N` use. */
  retention?: string;
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
      "Actions run in order; decide on returned results in the next call.",
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
          'Apply the statements in changes, with type="edit": assignments that create or replace operators, shared-function definitions, and del. Atomic; does not execute.',
          {
            changes: {
              ...text,
              description:
                "Statements, each starting at the margin: `name = operator(input, ..., parameter=value)` creates name or replaces its definition and inputs, input tables first by name; a call that reads its own name inserts a step; `name = function(input, ..., setting=value)` calls a shared function; `def function(table, ..., setting=default):` with a one-sentence docstring defines or redefines one, and every call follows; `del name, ...` deletes operators. Python indented under an assignment belongs to that operator only. A failing statement is held back with the statements that use it; the rest applies.",
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
          "Compose the final response from executed tables and end the loop: from is a table id, optionally with a projection [key=column:digits, ..., :digits] that names the keys, picks the columns and rounds numbers (:full keeps a value as computed), and optionally a cut over the complete table: top N by column asc|desc, with further columns to break ties; several parts separated by ; (key=table[...]) give one answer key per table. One row gives an object, several rows a list of row objects, one column a list. May follow execute in the same call; a table the runtime cannot answer from (empty, more than 50 rows after any cut, unrounded decimals, a tie at the cut) is refused with the reason.",
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
const SAVED_ACTIONS_SCHEMA = structuredClone(DATAFLOW_ACTIONS_SCHEMA);
SAVED_ACTIONS_SCHEMA.properties.actions.items.anyOf = SAVED_ACTIONS_SCHEMA.properties.actions.items.anyOf.filter(
  a => a.properties.type.const === "edit" ||
    (a.properties.type.const === "execute" && "operator_ids" in a.properties) ||
    (a.properties.type.const === "answer" && "from" in a.properties) ||
    ("target" in a.properties && (a.properties.target as { const: string }).const === "reference")
);
for (const entry of SAVED_ACTIONS_SCHEMA.properties.actions.items.anyOf) {
  entry.description = entry.description.replace("retrieve tables separately", "read tables separately");
  if (entry.properties.type.const === "edit" && "changes" in entry.properties)
    (entry.properties as unknown as { changes: { description: string } }).changes.description =
      "Statements, each starting at the margin: `name = operator(input, ..., parameter=value)` creates name or replaces its definition and inputs, input tables first by name; a call that reads its own name inserts a step; `name = function(input, ..., setting=value)` calls a shared function; `def function(table, ..., setting=default):` with a one-sentence docstring defines or redefines one, and every call follows; `del name, ...` deletes operators. A saved version `name@N` can be an input table. Python indented under an assignment belongs to that operator only. A failing statement is held back with the statements that use it; the rest applies.";
}
SAVED_ACTIONS_SCHEMA.properties.actions.items.anyOf.push(
  action("read", "Read current operators or immutable ID@task versions. Returns definitions, direct inputs, shape and columns; view=null reads definitions only, including failed operators. A non-null view reads saved records without execution. Request implementation only when needed; columns=null keeps all columns.", {
    operator_ids: { type: "array", items: text, minItems: 1, maxItems: 8 },
    view: { anyOf: [{ type: "string", enum: [...RETRIEVAL_VIEWS] }, { type: "null" }] },
    include_implementation: { type: "boolean" },
    columns: { anyOf: [{ type: "array", items: text, minItems: 1 }, { type: "null" }] },
  }),
  action("answer", "Give the final response and declare its completed source tables (current IDs or ID@task). Pass [] only when no table was used. Must be the sole action. Sources record provenance, not correctness.", {
    content: text, operator_ids: { type: "array", items: text, maxItems: 8 },
  })
);
export const dataflowActionsSchema = (stateHistory = false, savedVersions = false) =>
  savedVersions ? SAVED_ACTIONS_SCHEMA : stateHistory ? STATE_ACTIONS_SCHEMA : DATAFLOW_ACTIONS_SCHEMA;
const ajv = new Ajv({ allErrors: true });
const validators = [DATAFLOW_ACTIONS_SCHEMA, STATE_ACTIONS_SCHEMA, SAVED_ACTIONS_SCHEMA].map(schema => ({
  validate: ajv.compile<DataflowActionsInput>(schema),
  actions: schema.properties.actions.items.anyOf.map(schema => ({ schema, validate: ajv.compile(schema) })),
}));

function validationMessage(input: any, stateHistory: boolean, savedVersions = false): string {
  const { validate, actions: actionValidators } = validators[savedVersions ? 2 : stateHistory ? 1 : 0];
  if (savedVersions && input?.actions?.some?.((a: any) => a?.type === "answer" && "content" in a && !("operator_ids" in a)))
    return "Answer requires operator_ids: name the completed tables used, or pass [] when no table was used. No actions ran.";
  if (typeof input?.actions === "string")
    return 'Invalid dataflow arguments: actions must be a JSON array, not a string. Example: {"reasoning":"Run the graph.","actions":[{"type":"execute"}]}. Only edit.changes contains graph text. No actions ran.';
  if (Array.isArray(input?.actions)) {
    for (const [index, item] of input.actions.entries()) {
      const candidates = actionValidators.filter(v => (v.schema.properties.type as any).const === item?.type);
      if (!candidates.length) {
        if (["create", "update", "modify", "delete"].includes(item?.type)) {
          const changes = item.type === "delete" ? "del <name>" : "<name> = <operator>(<input>, ...)";
          return `Action ${index + 1}: ${JSON.stringify(item.type)} is a graph command. Put it inside an edit action: ${JSON.stringify({ type: "edit", changes })}. No actions ran.`;
        }
        return `Action ${index + 1}: unknown action type ${JSON.stringify(item?.type ?? null)}. Use ${savedVersions ? "edit, execute, read, or answer" : "inspect, edit, execute, retrieve, or answer"}. Operators such as scan, process and aggregate belong inside an edit.`;
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
        return `Action ${index + 1} (inspect): target must be ${savedVersions ? "reference" : `graph, operator, reference${stateHistory ? ", state, or task" : ""}`}.`;
      if (!selected.validate(item))
        return `Action ${index + 1} (${item.type}): ${ajv.errorsText(selected.validate.errors?.slice(0, 1))}.`;
    }
  }
  validate(input);
  return `Invalid dataflow arguments: ${ajv.errorsText(validate.errors?.slice(0, 1))}`;
}

export const DATAFLOW_ACTIONS_DESCRIPTION =
  "Work with a dataflow through an ordered list of inspect, edit, execute, retrieve and answer actions, after a brief reasoning sentence. " +
  "actions is a JSON array of objects; edit.changes is a string of statements such as `totals = aggregate(orders, by=[\"region\"], total=sum(\"amount\"))`. " +
  "Edits do not run the graph, and retrieval never executes. A failure skips later actions; completed edits remain. " +
  "An answer with content is the only action of its call; an answer with from is the last.";

/** Validate first. The agent resolves this receipt after creating the step's
 * snapshot, in onStepFinish, before another model request or stop decision.
 * This preserves the same ownership boundary as post-step execution in code mode. */
export function prepareDataflowActions(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS,
  stateHistory = false,
  savedVersions = false
): DataflowActionsResult {
  const result: DataflowActionsResult = {
    kind: "dataflow-actions",
    status: "pending",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
    ...(savedVersions ? { saved_versions: true as const } : {}),
  };
  if (!validators[savedVersions ? 2 : stateHistory ? 1 : 0].validate(input)) {
    result.status = "error";
    result.error = validationMessage(input, stateHistory, savedVersions);
    return result;
  }
  const request = input as DataflowActionsInput;
  if (request.actions.some(a => a.type === "read" && a.columns && new Set(a.columns).size !== a.columns.length)) {
    result.status = "error";
    result.error = "Read requires unique column names. No actions ran.";
    return result;
  }
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
      ((a.type === "execute" || a.type === "answer" || a.type === "read") &&
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
      (a.type === "retrieve" || ((a.type === "inspect" || a.type === "read") && "view" in a && a.view !== null)) &&
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
  /** Reference inspection returns operator contracts and examples; the full
   * prompt already contains them, so only the on-demand prompt offers it. */
  references = false
) {
  const schema = structuredClone(dataflowActionsSchema(stateHistory, stateHistory));
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
      : `Read an existing result: ${views.map(v => descriptions[v]).join("; ")}.${views.includes("full") && views.length > 1 ? ` Look with ${views.includes("sample_stats") ? "sample_stats" : "sample"} first; request full only when you need every row.` : ""} Never executes; missing or stale results need execute.`;
  }
  for (const inspect of schema.properties.actions.items.anyOf.filter(
    a => "view" in a.properties && ("target" in a.properties || a.properties.type.const === "read")
  ))
    (inspect.properties as any).view.anyOf[0].enum = [...views];
  return tool({
    description:
      stateHistory
        ? "Use ordered edit, execute, read and answer actions. Each answered task saves its tables as name@N: read one, use it as an input table or answer from it; saved versions never execute or fall back to current data. Content answers name their source tables, or [] when none was used. A held statement or a failed action skips the later actions; earlier edits remain."
        : DATAFLOW_ACTIONS_DESCRIPTION,
    strict: true,
    inputSchema: jsonSchema<DataflowActionsInput>(schema as any),
    execute: async input => prepareDataflowActions(input, views, stateHistory, stateHistory),
  });
}

/** An edit changed the graph: it succeeded, or it applied the statements
 * around a held one (the action then reports an error so the call stops). */
export function editApplied(item: DataflowActionsResult["actions"][number]): boolean {
  if (item.action.type !== "edit") return false;
  if (item.status === "ok") return true;
  const output = item.output as { held?: unknown[]; applied?: number } | undefined;
  return item.status === "error" && !!output?.held?.length && (output.applied ?? 0) > 0;
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
