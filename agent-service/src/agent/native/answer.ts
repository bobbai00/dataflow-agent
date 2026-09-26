/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `answer_from`: the final answer composed by the runtime from an observed
 * table, so a turn whose last call already built the answer table ends
 * without another model call (the answer call was 43% of a two-call turn's
 * cost). The composition is a fixed, documented mapping from the table's
 * rows to one JSON object; nothing is invented, and a table that cannot be
 * the answer (empty, not completely held, too large) is refused with a reason
 * the model reads in the observation.
 */
import type { OperatorInfo } from "../../types/execution";

export const ANSWER_ROW_LIMIT = 50;
export const ANSWER_CHAR_LIMIT = 4000;
export const ANSWER_MARKER = "Final Answer:";

export type ComposedAnswer = { text: string; json: string } | { reason: string };

function cell(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  return value;
}

/** One row → an object of its columns; several rows → an object keyed by the
 * first column when it is a unique text key, else `{<table>: [row objects]}`;
 * one column over several rows → `{<column>: [values]}`. */
export function composeAnswer(id: string, info: OperatorInfo | undefined): ComposedAnswer {
  if (!info) return { reason: `\`${id}\` has no result` };
  if (info.error) return { reason: `\`${id}\` failed` };
  const held = (info.result ?? []) as Array<Record<string, unknown>>;
  const total = info.totalRowCount ?? held.length;
  if (total === 0) return { reason: `\`${id}\` is empty (0 rows)` };
  if (held.length < total)
    return { reason: `only ${held.length} of ${total} rows of \`${id}\` are held; the answer needs the complete table` };
  if (total > ANSWER_ROW_LIMIT)
    return { reason: `\`${id}\` has ${total} rows; an answer table holds at most ${ANSWER_ROW_LIMIT} (aggregate, project or limit it)` };
  const columns = Object.keys(held[0] ?? {}).filter(name => !name.startsWith("__"));
  if (!columns.length) return { reason: `\`${id}\` has no columns` };
  const rows = held.map(row => Object.fromEntries(columns.map(name => [name, cell(row[name])])));
  let value: unknown;
  if (rows.length === 1) value = rows[0];
  else if (
    columns.length === 2 &&
    rows.every(row => typeof row[columns[0]] === "string") &&
    new Set(rows.map(row => row[columns[0]])).size === rows.length
  )
    value = Object.fromEntries(rows.map(row => [row[columns[0]] as string, row[columns[1]]]));
  else if (columns.length === 1) value = { [columns[0]]: rows.map(row => row[columns[0]]) };
  else value = { [id]: rows };
  const json = JSON.stringify(value);
  if (json.length > ANSWER_CHAR_LIMIT)
    return { reason: `the answer composed from \`${id}\` is ${json.length} characters; keep it under ${ANSWER_CHAR_LIMIT}` };
  return { json, text: `**${ANSWER_MARKER} ${json}**` };
}
