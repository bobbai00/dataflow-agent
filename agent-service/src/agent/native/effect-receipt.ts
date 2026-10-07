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
 * The effect of an in-place change: after an execute, a table that the last
 * answered task saved and that now has a different result is compared with
 * that saved version. Rows are matched on the table's label columns (text and
 * boolean columns present in both versions); without any, on the whole row.
 * The line states the row counts and, when both versions are complete in
 * memory, which rows entered, which left and how many kept their label but
 * changed values, the way a person checks a change before reporting it.
 */
import type { OperatorInfo } from "../../types/execution";

const COMPLETE_LIMIT = 500;
const SHOWN = 8;

const complete = (info: OperatorInfo) =>
  Array.isArray(info.result) && info.result.length === (info.totalRowCount ?? info.outputTuples);

const keyOf = (row: Record<string, unknown>, columns: string[]) =>
  JSON.stringify(columns.map(column => row[column] ?? null));
const label = (row: Record<string, unknown>, columns: string[]) =>
  columns.map(column => String(row[column] ?? "null")).join(" / ");

/** The columns that name a row in both versions: a unique id-like column of
 * any type first, then a unique text column, then all text and boolean
 * columns together; none when nothing identifies the rows. */
function labelColumns(before: OperatorInfo, after: OperatorInfo): string[] {
  const types = (info: OperatorInfo) => new Map((info.resultSchema ?? []).map(c => [c.name, String(c.type).toLowerCase()]));
  const a = types(before),
    b = types(after);
  const shared = [...a].filter(([name, type]) => b.get(name) === type).map(([name]) => name);
  const rows = [before.result as Record<string, unknown>[], after.result as Record<string, unknown>[]];
  const unique = (columns: string[]) =>
    rows.every(list => new Set(list.map(row => keyOf(row, columns))).size === list.length && list.every(row => columns.every(c => row[c] !== null && row[c] !== undefined)));
  const idLike = shared.filter(name => /(^|_)(id|key|code|name)$/i.test(name) || /^id/i.test(name));
  const text = shared.filter(name => /str|string|bool/.test(a.get(name)!));
  for (const name of [...idLike, ...text.filter(n => !idLike.includes(n))]) if (unique([name])) return [name];
  return text.length && unique(text) ? text : [];
}

/** One receipt line, or undefined when the result is unchanged or unknown. */
export function effectLine(
  address: string,
  before: OperatorInfo | undefined,
  after: OperatorInfo | undefined
): string | undefined {
  const ready = (info?: OperatorInfo) =>
    !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);
  if (!ready(before) || !ready(after)) return undefined;
  if (before!.resultVersion?.id && before!.resultVersion.id === after!.resultVersion?.id) return undefined;
  const rowsBefore = before!.totalRowCount ?? before!.outputTuples;
  const rowsAfter = after!.totalRowCount ?? after!.outputTuples;
  const head = `changed since ${address}: ${rowsBefore} → ${rowsAfter} rows`;
  if (!complete(before!) || !complete(after!) || Math.max(rowsBefore, rowsAfter) > COMPLETE_LIMIT) return `${head}.`;
  const columns = labelColumns(before!, after!);
  const all = [...new Set([...(before!.resultSchema ?? []).map(c => c.name)])].filter(name =>
    (after!.resultSchema ?? []).some(c => c.name === name)
  );
  const keys = columns.length ? columns : all;
  const index = (rows: Record<string, unknown>[]) => new Map(rows.map(row => [keyOf(row, keys), row]));
  const old = index(before!.result as Record<string, unknown>[]);
  const now = index(after!.result as Record<string, unknown>[]);
  if (old.size !== rowsBefore || now.size !== rowsAfter) return `${head}.`; // labels do not identify rows
  const entered = [...now.keys()].filter(key => !old.has(key));
  const left = [...old.keys()].filter(key => !now.has(key));
  const changed = [...now.keys()].filter(
    key => old.has(key) && JSON.stringify(all.map(c => old.get(key)![c])) !== JSON.stringify(all.map(c => now.get(key)![c]))
  );
  // Recomputed to the same rows and values: nothing to report.
  if (!entered.length && !left.length && !changed.length) return undefined;
  const list = (items: string[], rows: Map<string, Record<string, unknown>>) =>
    items
      .slice(0, SHOWN)
      .map(key => label(rows.get(key)!, keys))
      .join(", ") + (items.length > SHOWN ? `, … +${items.length - SHOWN} more` : "");
  const parts = [
    ...(columns.length
      ? [
          entered.length ? `entered (${entered.length}): ${list(entered, now)}` : "",
          left.length ? `left (${left.length}): ${list(left, old)}` : "",
          changed.length ? `${changed.length} kept with new values` : "",
        ]
      : [`${entered.length} rows new, ${left.length} rows gone`]),
  ].filter(Boolean);
  return `${head}; ${parts.join("; ")}${columns.length ? ` (rows matched on ${columns.join(", ")})` : ""}.`;
}
