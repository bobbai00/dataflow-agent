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

/**
 * The `dataflow` tool: one call per step, two strings.
 *
 *   dataflow({ python, statements })
 *
 * `python` holds definitions; `statements` holds `set`, `delete`, `execute`
 * and `show` lines (native/turn-syntax.ts). The call becomes an action list
 * (tools/dataflow-actions.ts) and its receipt is rendered by statement
 * (native/turn-receipt.ts). There is no answer field: the model answers by
 * replying without a tool call.
 */
import { jsonSchema, tool } from "ai";
import type { RetrievalView } from "../../types/agent";
import { availableRetrievalViews, RETRIEVAL_VIEWS } from "../native/retrieval";
import { mergeTurnFields, parseTurn } from "../native/turn-syntax";
import { prepareActions, rejectedActions, type DataflowActionsResult } from "./dataflow-actions";

export interface DataflowToolInput {
  python: string;
  statements: string;
}

export const DATAFLOW_TOOL_DESCRIPTION =
  "Edit, compute and read the Dataflow. Reply without this tool only to give the final answer.";

export const DATAFLOW_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    python: {
      type: "string",
      description: 'Python definitions to register or replace, or "" when the call defines none.',
    },
    statements: {
      type: "string",
      description:
        'Statements, one per line: set <id>: <op>(...), delete <id>, execute <id>, show result|schema|operator|function|builtin ...; "" when the call only defines functions.',
    },
  },
  required: ["python", "statements"],
} as const;

/** A provider that sends the arguments as text still yields the fields. */
function toolFields(input: unknown): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["python", "statements"])
    if (record[key] !== undefined && typeof record[key] !== "string") return undefined;
  return record;
}

/** Parse a call into the action list the agent runs; a rejected call runs nothing. */
export function prepareDataflowCall(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS,
  answer = false
): DataflowActionsResult {
  const fields = toolFields(input);
  if (!fields) return rejectedActions("dataflow takes an object with the strings python and statements.");
  const parsed = parseTurn(fields, { views, answer });
  if (!parsed.ok) return rejectedActions(parsed.error, { statements: [], ignoredProse: [] });
  const { statements, ignoredProse, actions } = parsed.turn;
  return prepareActions(actions, views, { statements, ignoredProse });
}

/** Several calls in one response run as one call: definitions from every call
 * register first, the set and delete lines apply together, then the requests
 * run in call order. Undefined when a call is not a well-formed dataflow call. */
export function mergeDataflowCalls(
  inputs: readonly unknown[],
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS,
  answer = false
): DataflowActionsResult | undefined {
  const fields = inputs.map(toolFields);
  if (fields.some(field => !field)) return undefined;
  return prepareDataflowCall(mergeTurnFields(fields as Record<string, unknown>[]), views, answer);
}

/** With answer statements, the final answer is a statement of this tool, not a reply without it. */
export const DATAFLOW_TOOL_DESCRIPTION_ANSWER =
  "Edit, compute and read the Dataflow, and give the final answer with an answer statement.";

export function createDataflowTool(
  views: readonly RetrievalView[] = availableRetrievalViews(),
  answer = false,
  optionalPython = false
) {
  const schema = structuredClone(DATAFLOW_TOOL_SCHEMA) as any;
  if (answer)
    schema.properties.statements.description =
      'Statements, one per line: set <id>: <op>(...), delete <id>, execute <id>, show result|schema|operator|function|builtin ..., answer <id> | answer <key>=<id>, ...; "" when the call only defines functions.';
  // An empty `python` costs output tokens on every call that defines nothing.
  if (optionalPython) {
    schema.properties.python.description =
      "Python definitions to register or replace; leave the field out when the call defines none.";
    schema.required = ["statements"];
  }
  return tool({
    description: answer ? DATAFLOW_TOOL_DESCRIPTION_ANSWER : DATAFLOW_TOOL_DESCRIPTION,
    strict: true,
    inputSchema: jsonSchema<DataflowToolInput>(schema),
    execute: async input => prepareDataflowCall(input, views, answer),
  });
}
