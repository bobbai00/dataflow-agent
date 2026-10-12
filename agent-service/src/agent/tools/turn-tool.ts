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
 * (native/turn-receipt.ts). The model answers by replying without a tool
 * call; with AgentSettings.answerField the tool also takes `answer`, an answer
 * composed from the call's tables that ends the request (as the `answer`
 * statement does, native/answer-statement.ts), and `""` to continue.
 */
import { jsonSchema, tool } from "ai";
import type { RetrievalView } from "../../types/agent";
import { availableRetrievalViews, RETRIEVAL_VIEWS } from "../native/retrieval";
import { mergeTurnFields, parseTurn } from "../native/turn-syntax";
import { prepareActions, rejectedActions, type DataflowActionsResult } from "./dataflow-actions";

export interface DataflowToolInput {
  python: string;
  statements: string;
  answer?: string;
}

export interface DataflowToolOptions {
  answerStatement?: boolean;
  answerField?: boolean;
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

export const DATAFLOW_ANSWER_TOOL_DESCRIPTION =
  "Edit, compute and read the Dataflow, and finish a request with `answer`. Reply without this tool only for a final answer the tables cannot hold.";

export const DATAFLOW_ANSWER_STATEMENT_TOOL_DESCRIPTION =
  "Edit, compute and read the Dataflow, and finish a request with the statement `answer <id>`. Reply without this tool only for a final answer the tables cannot hold.";

/** The schema with `answer`; strict tool calls send every field, so `""` means none. */
export function dataflowToolSchema(options: DataflowToolOptions = {}) {
  const schema = structuredClone(DATAFLOW_TOOL_SCHEMA) as any;
  if (!options.answerField) return schema;
  schema.properties.answer = {
    type: "string",
    description:
      'The request\'s final answer over tables this call computes, e.g. {"leaders": top[market, score]} digits=4; the request ends with it. "" when the call does not finish the request.',
  };
  schema.required = [...schema.required, "answer"];
  return schema;
}

/** The answer a call carries in `answer`, or undefined for none. */
function answerFieldText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/^answer(?:\s+|(?=[{\[]))/, "");
  return text && !/^(?:none|null)$/i.test(text) ? text : undefined;
}

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
  for (const key of ["python", "statements", "answer"])
    if (record[key] !== undefined && typeof record[key] !== "string") return undefined;
  return record;
}

/** Parse a call into the action list the agent runs; a rejected call runs nothing. */
export function prepareDataflowCall(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS,
  options: DataflowToolOptions = {}
): DataflowActionsResult {
  let fields = toolFields(input);
  if (!fields) return rejectedActions("dataflow takes an object with the strings python and statements.");
  // The answer field is the call's last statement.
  const answer = options.answerField ? answerFieldText(fields.answer) : undefined;
  if (answer !== undefined) {
    const statements = typeof fields.statements === "string" ? fields.statements.trimEnd() : "";
    fields = { ...fields, statements: `${statements}${statements ? "\n" : ""}answer ${answer}` };
  }
  const parsed = parseTurn(fields, {
    views,
    answerStatement: options.answerStatement || answer !== undefined,
  });
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
  options: DataflowToolOptions = {}
): DataflowActionsResult | undefined {
  const fields = inputs.map(toolFields);
  if (fields.some(field => !field)) return undefined;
  const answers = (fields as Record<string, unknown>[]).map(field => answerFieldText(field.answer)).filter(Boolean);
  const merged = mergeTurnFields(fields as Record<string, unknown>[]);
  return prepareDataflowCall(
    answers.length ? { ...merged, answer: answers[answers.length - 1] } : merged,
    views,
    options
  );
}

export function createDataflowTool(
  views: readonly RetrievalView[] = availableRetrievalViews(),
  options: DataflowToolOptions = {}
) {
  return tool({
    description: options.answerField
      ? DATAFLOW_ANSWER_TOOL_DESCRIPTION
      : options.answerStatement
        ? DATAFLOW_ANSWER_STATEMENT_TOOL_DESCRIPTION
        : DATAFLOW_TOOL_DESCRIPTION,
    strict: true,
    inputSchema: jsonSchema<DataflowToolInput>(dataflowToolSchema(options)),
    execute: async input => prepareDataflowCall(input, views, options),
  });
}
