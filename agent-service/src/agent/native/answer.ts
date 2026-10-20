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
 * The `answer` statement (AgentSettings.answerStatement): the final answer
 * rendered from result tables, returned verbatim as the request's reply.
 *
 * Each named table becomes a value by its shape: one row and one column is
 * that cell; one row is an object; any other table is a list of row objects,
 * every row. One table is the answer itself; several are one object, a key per
 * table. A table must be computed and held whole; a larger one is aggregated
 * or limited first.
 */

import type { OperatorInfo } from "../../types/execution";
import type { AnswerFormat } from "./turn-syntax";

export type AnswerRendering = { ok: true; text: string } | { ok: false; error: string };

const completed = (info: OperatorInfo): boolean => !info.error && ["Completed", "CompletedFromCache"].includes(info.state);

/** A cell as JSON can carry it: non-finite numbers become null. */
function cell(value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function tableValue(info: OperatorInfo): unknown {
  const rows = info.result ?? [];
  const columns = info.resultSchema?.length ? info.resultSchema.map(column => column.name) : Object.keys(rows[0] ?? {});
  const row = (record: Record<string, unknown>) => Object.fromEntries(columns.map(name => [name, cell(record[name])]));
  if (rows.length === 1 && columns.length === 1) return cell(rows[0][columns[0]]);
  if (rows.length === 1) return row(rows[0]);
  return rows.map(row);
}

export function renderAnswer(
  spec: { ids: readonly string[]; keys: readonly (string | null)[]; format: AnswerFormat },
  resultOf: (id: string) => OperatorInfo | undefined
): AnswerRendering {
  const values: unknown[] = [];
  for (const id of spec.ids) {
    const info = resultOf(id);
    if (!info || !completed(info))
      return { ok: false, error: `\`${id}\` has no current result${info?.error ? " (its execution failed)" : ""}; fix and run it first.` };
    const total = info.totalRowCount ?? info.outputTuples ?? info.result?.length ?? 0;
    const held = info.result?.length ?? 0;
    if (info.truncated || held < total)
      return {
        ok: false,
        error: `\`${id}\` has ${total.toLocaleString("en-US")} rows and an answer renders every row (${held.toLocaleString("en-US")} are held); aggregate or limit it to the rows the request asks for.`,
      };
    values.push(tableValue(info));
  }
  const value = spec.keys.length === 1 && spec.keys[0] === null ? values[0] : Object.fromEntries(spec.keys.map((key, i) => [key, values[i]]));
  const text = spec.format === "text" && (value === null || typeof value !== "object") ? String(value) : JSON.stringify(value);
  return { ok: true, text };
}
