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
 * The turn tool: the registered protocol as one tool call with three strings.
 *
 *   dataflow({ summary, python, statements })
 *
 * `statements` holds the turn's `set`, `delete`, `execute` and `show` lines
 * (native/turn-syntax.ts); `python` holds definitions. The call becomes the
 * same action list the JSON tool takes, so execution and traces are shared;
 * the receipt is rendered by statement (native/turn-receipt.ts). There is no
 * answer statement: the model answers by replying without a tool call.
 */
import { jsonSchema, tool } from "ai";
import type { RetrievalView } from "../../types/agent";
import { availableRetrievalViews, RETRIEVAL_VIEWS } from "../native/retrieval";
import { parseTurnFields, type TurnReceiptInfo } from "../native/turn-syntax";
import { prepareRegisteredDataflowActions, type DataflowActionsResult } from "./dataflow-actions";

export interface TurnToolInput {
  summary: string;
  python: string;
  statements: string;
}

export const TURN_TOOL_DESCRIPTION =
  "Edit, compute and read the Dataflow with one turn of statements. Reply without this tool only to give the final answer.";

export const TURN_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "One line: the population, definitions and formula this call assumes.",
    },
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
  required: ["summary", "python", "statements"],
} as const;

const EMPTY_INFO: TurnReceiptInfo = {
  statements: [],
  missingSummary: false,
  ignoredProse: [],
  wroteReceipt: false,
  fields: true,
};

function rejected(message: string): DataflowActionsResult {
  return {
    kind: "dataflow-actions",
    protocol: "registered-python-v1",
    status: "error",
    actions: [],
    operators: [],
    observe: [],
    observationErrors: [],
    error: `${message} No actions ran.`,
    turn: EMPTY_INFO,
  };
}

/** A provider that sends the arguments as text, or a model that nests them, still yields the fields. */
function turnFields(input: unknown): Record<string, unknown> | undefined {
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
  for (const key of ["summary", "python", "statements"])
    if (record[key] !== undefined && typeof record[key] !== "string") return undefined;
  return record;
}

/** Parse the fields into the action list the agent runs; a rejected call runs nothing. */
export function prepareTurnToolActions(
  input: unknown,
  views: readonly RetrievalView[] = RETRIEVAL_VIEWS
): DataflowActionsResult {
  const fields = turnFields(input);
  if (!fields) return rejected("dataflow takes an object with the strings summary, python and statements.");
  const parsed = parseTurnFields(fields, { views });
  if (!parsed.ok) return rejected(parsed.error);
  const { turn } = parsed;
  const result = prepareRegisteredDataflowActions(
    { reasoning: turn.summary || "(no summary)", actions: turn.actions },
    views
  );
  result.turn = {
    statements: turn.statements,
    missingSummary: turn.missingSummary,
    ignoredProse: turn.ignoredProse,
    wroteReceipt: false,
    fields: true,
  };
  return result;
}

export function createTurnTool(views: readonly RetrievalView[] = availableRetrievalViews()) {
  return tool({
    description: TURN_TOOL_DESCRIPTION,
    strict: true,
    inputSchema: jsonSchema<TurnToolInput>(structuredClone(TURN_TOOL_SCHEMA) as any),
    execute: async input => prepareTurnToolActions(input, views),
  });
}
