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
 * Contract flags: judgments the runtime makes from an operator's contract and
 * the whole-table profile of its output. A flag is attached to the table, and
 * every table built from it inherits the flag until an operator resolves it,
 * so the fact reaches the task that builds on the table, not only the step
 * that first observed it.
 *
 * Each flag is grounded in a contract the encoding or the operator states,
 * never in the task: a text column's missing-value tokens (`"nan"`, `"NULL"`,
 * `"N/A"`) are text, not missing values; numbers stored as text do not compare
 * or reduce; a column value equal to the column's name is a header row inside
 * the data; a join without `validate` multiplies rows when keys repeat; a cast
 * with errors="null" makes values missing; a reducer skips nulls, so its
 * denominator is the non-null count; a filter that kept nothing or everything
 * did not select; a map that returned None for every row added no
 * information; a union that aligned schemas filled absent columns with null.
 *
 * `expect` is the model's own contract on a table, checked the same way.
 */
import type { OperatorInfo, TableFlag } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { ProfileColumn } from "./profiles";

export const MISSING_TOKENS = new Set([
  "nan",
  "NaN",
  "NAN",
  "null",
  "NULL",
  "Null",
  "None",
  "NONE",
  "N/A",
  "n/a",
  "NA",
  "na",
  "#N/A",
  "-",
  "--",
  "?",
  "",
]);
const NUMERIC_TEXT = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
const ENCODING = new Set(["LITERAL_MISSING", "NUMERIC_TEXT", "HEADER_IN_DATA"]);
/** Flags a descendant keeps: about a column it still reads as text, or about every row it holds. */
const INHERITED = new Set([...ENCODING, "JOIN_MULTIPLIED", "CAST_LOST", "MAP_ALL_NULL", "UNION_ALIGNED"]);
export const MAX_FLAGS = 6;

export interface Expectation {
  /** A count, or [min, max]. */
  rows?: number | [number, number];
  nonempty?: boolean;
  unique?: string[];
  nonnull?: string[];
  columns?: string[];
}

const record = (x: unknown): Record<string, any> =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : {};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const q = (text: string) => JSON.stringify(text);

/** The whole-table profile, when the engine measured every row of this result. */
function completeProfile(info: OperatorInfo | undefined) {
  const profile = info?.tableProfile;
  if (!profile || profile.status === "unavailable" || !profile.coverage.complete) return undefined;
  if (info?.resultVersion?.id && profile.resultVersion !== info.resultVersion.id) return undefined;
  return profile;
}

function tokensOf(c: ProfileColumn): Array<{ value: string; count: number }> {
  if (c.type !== "str" || !c.frequencies) return [];
  return c.frequencies.values.flatMap(v =>
    v.value.type === "str" && MISSING_TOKENS.has(v.value.value.trim()) ? [{ value: v.value.value, count: v.count }] : []
  );
}

/** The flags an operator's own contract raises on its output, then the ones
 * inherited from its inputs, at most MAX_FLAGS. Pure: profile and counters only. */
export function contractFlags(
  op: OperatorPredicate,
  info: OperatorInfo,
  inputs: Array<{ id: string; info?: OperatorInfo }>
): TableFlag[] {
  const id = op.operatorID;
  const view = op.nativeOp;
  if (!view || info.error) return [];
  const own: TableFlag[] = [];
  const add = (code: string, text: string, column?: string) =>
    own.push({ code, text, origin: id, ...(column !== undefined ? { column } : {}) });
  const rows = info.totalRowCount;
  const profile = completeProfile(info);
  const columns = profile ? Object.entries(profile.columns).filter(([name]) => !name.startsWith("__")) : [];
  const ops = record(info.tableProfile?.native?.operations);
  const inputRows = (i: number) => inputs[i]?.info?.totalRowCount;
  if (rows === 0 && view.type !== "Parameters") add("EMPTY", "0 rows: everything built on this table is empty");

  // Encoding contracts, measured on every row of the output.
  for (const [name, c] of columns) {
    if (c.type !== "str" || !c.frequencies) continue;
    const tokens = tokensOf(c);
    if (tokens.length)
      add(
        "LITERAL_MISSING",
        `column ${q(name)} holds the text ${tokens.map(t => `${q(t.value)} in ${plural(t.count, "row")}`).join(", ")}: text, not a missing value (null cells in ${q(name)}: ${c.nullCount})`,
        name
      );
    const header = c.frequencies.values.find(
      v => v.value.type === "str" && v.value.value.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (header)
      add(
        "HEADER_IN_DATA",
        `column ${q(name)} contains its own name as a value in ${plural(header.count, "row")}: a header row repeated inside the data`,
        name
      );
    // Tokens and the repeated header are the reasons a numeric column is text;
    // the remaining frequent values decide whether it holds numbers. A key
    // made of digits is flagged too: the fact holds, and nothing reduces a key.
    const values = c.frequencies.values.filter(
      v =>
        v.value.type === "str" &&
        !MISSING_TOKENS.has(v.value.value.trim()) &&
        v.value.value.trim().toLowerCase() !== name.trim().toLowerCase()
    ) as Array<{ value: { type: "str"; value: string }; count: number }>;
    if (values.length >= 3 && values.every(v => NUMERIC_TEXT.test(v.value.value.trim())))
      add(
        "NUMERIC_TEXT",
        `column ${q(name)} holds numbers as text (${values
          .slice(0, 3)
          .map(v => q(v.value.value))
          .join(", ")}, …): comparisons and reducers need a cast`,
        name
      );
  }

  // Operator boundary conditions, from the engine's counters.
  switch (view.type) {
    case "Filter": {
      const before = inputRows(0);
      if (before && rows !== undefined) {
        if (rows === 0) add("FILTER_EMPTY", `filter kept 0 of ${plural(before, "row")}`);
        else if (rows === before) add("FILTER_ALL", `filter kept all ${plural(before, "row")}: the predicate dropped nothing`);
      }
      break;
    }
    case "Join": {
      const left = inputRows(0);
      const right = inputRows(1);
      const validate = typeof view.properties.validate === "string";
      if (view.properties.type !== "cross" && !validate && rows !== undefined && left !== undefined && right !== undefined && rows > Math.max(left, right)) {
        const sides = record(ops.join);
        const multiplicity = Math.max(
          ...Object.values(sides).map(side => Number(record(side).maxMultiplicity) || 0),
          0
        );
        add(
          "JOIN_MULTIPLIED",
          `join produced ${plural(rows, "row")} from ${left} and ${right}: keys repeat on at least one side${multiplicity > 1 ? ` (a key occurs up to ${multiplicity} times)` : ""}, so rows were multiplied`
        );
      }
      break;
    }
    case "Cast": {
      for (const [column, n] of Object.entries(record(ops.conversionFailures)))
        if (typeof n === "number" && n > 0)
          add("CAST_LOST", `cast made ${plural(n, "value")} of ${q(column)} missing: they did not parse`, column);
      break;
    }
    case "Aggregate": {
      const input = completeProfile(inputs[0]?.info);
      if (!input) break;
      const byColumn = new Map<string, string[]>();
      for (const item of Array.isArray(view.properties.aggregations) ? view.properties.aggregations : []) {
        const a = record(item);
        if (typeof a.col !== "string" || a.fn === "count" || a.fn === "first") continue;
        const c = input.columns[a.col];
        if (c && c.nullCount > 0) byColumn.set(a.col, [...(byColumn.get(a.col) ?? []), String(a.fn)]);
      }
      for (const [column, fns] of byColumn) {
        const c = input.columns[column];
        add(
          "AGG_NULLS_IGNORED",
          `${fns.join("/")}(${q(column)}) ignored ${plural(c.nullCount, "null value")} of the input: its denominator is ${c.nonnullCount}, not ${c.rowsProcessed}`
        );
      }
      break;
    }
    case "Map": {
      if (!profile || !rows) break;
      for (const column of Array.isArray(ops.addedColumns) ? ops.addedColumns : []) {
        const c = profile.columns[String(column)];
        if (c && c.rowsProcessed === rows && c.nullCount === rows)
          add("MAP_ALL_NULL", `added column ${q(String(column))} is null in every row`, String(column));
      }
      break;
    }
    case "Union": {
      const missing = Array.isArray(ops.alignedMissingColumns) ? ops.alignedMissingColumns : [];
      missing.forEach((cols: unknown, i: number) => {
        if (Array.isArray(cols) && cols.length)
          add(
            "UNION_ALIGNED",
            `input ${i + 1} has no column ${cols.map(c => q(String(c))).join(", ")}: filled with null in its ${plural(inputRows(i) ?? 0, "row")}`
          );
      });
      break;
    }
  }

  // Inheritance: a flag about a column the output still holds as text, or
  // about every row it holds. The upstream origin wins over a fresh own flag
  // on the same column, so the model reads where the fact came from.
  const schema = new Map((info.resultSchema ?? []).map(f => [f.name, f.type]));
  const key = (flag: TableFlag) => `${flag.code}\0${flag.column ?? ""}`;
  const merged = new Map(own.map(flag => [key(flag), flag]));
  for (const input of inputs)
    for (const flag of input.info?.flags ?? []) {
      if (!INHERITED.has(flag.code)) continue;
      if (flag.column !== undefined) {
        if (schema.size && !schema.has(flag.column)) continue;
        const type = schema.get(flag.column);
        if (ENCODING.has(flag.code) && type !== undefined && type !== "str") continue;
        // The output's own complete profile says the tokens are gone: resolved.
        if (flag.code === "LITERAL_MISSING" && profile) {
          const c = profile.columns[flag.column];
          if (c && c.frequencies && !c.frequencies.truncated && !tokensOf(c).length) continue;
        }
      }
      const k = key(flag);
      const existing = merged.get(k);
      if (existing && existing.origin !== id) continue;
      merged.set(k, flag);
    }
  return [...merged.values()].slice(0, MAX_FLAGS);
}

/** The model's declared contract on a table, checked on its current result. */
export function checkExpectation(id: string, expectation: Expectation, info: OperatorInfo | undefined): TableFlag[] {
  if (!info || info.error) return [{ code: "EXPECT_FAILED", text: `expectation not checked: ${id} has no current result`, origin: id }];
  const failures: string[] = [];
  const met: string[] = [];
  const rows = info.totalRowCount;
  if (expectation.rows !== undefined) {
    const [lo, hi] = Array.isArray(expectation.rows) ? expectation.rows : [expectation.rows, expectation.rows];
    if (rows === undefined) failures.push("row count unknown");
    else if (rows < lo || rows > hi) failures.push(`rows=${rows}, expected ${lo === hi ? lo : `${lo}-${hi}`}`);
    else met.push(`rows=${rows}`);
  }
  if (expectation.nonempty) {
    if (rows === 0) failures.push("0 rows, expected some");
    else if (rows === undefined) failures.push("row count unknown");
    else met.push("nonempty");
  }
  const schema = new Set((info.resultSchema ?? []).map(f => f.name));
  for (const column of expectation.columns ?? []) {
    if (schema.size && !schema.has(column)) failures.push(`no column ${q(column)}`);
    else met.push(`has ${column}`);
  }
  const profile = completeProfile(info);
  const held = info.truncated === false ? ((info.result ?? []) as Array<Record<string, unknown>>) : undefined;
  for (const column of expectation.unique ?? []) {
    const c = profile?.columns[column];
    if (c) {
      if (c.nullCount === 0 && c.distinctCount !== null && c.distinctCount === c.nonnullCount) met.push(`unique ${column}`);
      else failures.push(`${q(column)} is not unique: ${c.distinctCount ?? "?"} distinct of ${plural(c.rowsProcessed, "row")}${c.nullCount ? `, ${c.nullCount} null` : ""}`);
    } else if (held && held.length && column in held[0]) {
      const values = held.map(row => row[column]);
      const distinct = new Set(values.map(v => JSON.stringify(v ?? null))).size;
      if (distinct === values.length && !values.some(v => v === null || v === undefined)) met.push(`unique ${column}`);
      else failures.push(`${q(column)} is not unique: ${distinct} distinct of ${plural(values.length, "row")}`);
    } else failures.push(`unique ${q(column)}: not measurable (no profile of that column)`);
  }
  for (const column of expectation.nonnull ?? []) {
    const c = profile?.columns[column];
    if (c) {
      if (c.nullCount === 0) met.push(`nonnull ${column}`);
      else failures.push(`${q(column)} has ${plural(c.nullCount, "null value")}`);
    } else if (held && held.length && column in held[0]) {
      const nulls = held.filter(row => row[column] === null || row[column] === undefined).length;
      if (nulls === 0) met.push(`nonnull ${column}`);
      else failures.push(`${q(column)} has ${plural(nulls, "null value")}`);
    } else failures.push(`nonnull ${q(column)}: not measurable (no profile of that column)`);
  }
  const flags: TableFlag[] = [];
  if (failures.length) flags.push({ code: "EXPECT_FAILED", text: `expectation failed: ${failures.join("; ")}`, origin: id });
  else if (met.length) flags.push({ code: "EXPECT_OK", text: `expectation met: ${met.join(", ")}`, origin: id });
  return flags;
}

/** One observation line for a flag on `table`. */
export function flagLine(flag: TableFlag, table: string): string {
  const mark = flag.code === "EXPECT_OK" ? "✓" : "⚠";
  return `${mark} ${flag.text}${flag.origin !== table ? ` (from ${flag.origin})` : ""}`;
}

/** Flags that belong to the table itself (raised there, not inherited), for
 * entries and indexes; expectation lines belong to the observation only. */
export function ownFlags(id: string, info: OperatorInfo | undefined): TableFlag[] {
  return (info?.flags ?? []).filter(flag => flag.origin === id && !flag.code.startsWith("EXPECT_"));
}

/** Compute the flags of every table of a workflow in dependency order, writing
 * a table only when it has none yet (results are immutable once earned) or
 * when the call declared an expectation on it. */
export function applyContractFlags(
  workflow: WorkflowContent,
  read: (id: string) => OperatorInfo | undefined,
  write: (id: string, info: OperatorInfo) => void,
  expectations: Record<string, Expectation> = {}
): void {
  const operators = new Map(workflow.operators.map(op => [op.operatorID, op]));
  const indegree = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const id of operators.keys()) indegree.set(id, 0);
  for (const link of workflow.links) {
    if (!operators.has(link.source.operatorID) || !operators.has(link.target.operatorID)) continue;
    indegree.set(link.target.operatorID, (indegree.get(link.target.operatorID) ?? 0) + 1);
    consumers.set(link.source.operatorID, [...(consumers.get(link.source.operatorID) ?? []), link.target.operatorID]);
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of consumers.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const current = new Map<string, OperatorInfo | undefined>();
  const infoOf = (id: string) => (current.has(id) ? current.get(id) : read(id));
  for (const id of order) {
    const op = operators.get(id)!;
    const info = infoOf(id);
    if (!info || info.error || !op.nativeOp) continue;
    const expectation = expectations[id];
    if (info.flags !== undefined && !expectation) continue;
    const inputs = op.nativeOp.inputs.map(input => ({ id: input, info: infoOf(input) }));
    const flags = info.flags === undefined ? contractFlags(op, info, inputs) : info.flags.filter(f => !f.code.startsWith("EXPECT_"));
    const checked = expectation ? [...flags, ...checkExpectation(id, expectation, info)] : flags;
    const updated = { ...info, flags: checked };
    current.set(id, updated);
    write(id, updated);
  }
}
