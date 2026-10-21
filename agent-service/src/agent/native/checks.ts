/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `check:` lines and scan notes. Every operator carries assumptions about the
 * tables it reads: a scan's first row is a header, and the rows a sum adds are
 * distinct records rather than one record listed by several sources. A scan's
 * findings are notes shown with its result in every setting (scanNoteLines);
 * the others are `check:` lines when nativeChecks is on. Only assumptions
 * whose violation is unambiguous qualify: a join that drops or repeats rows
 * may be doing exactly what was meant, so joins have no check. The runtime tests the
 * assumptions of the operator that just ran on the full tables and records
 * only violations (`operations` in the table profile); this module words them.
 * Nothing here samples, ranks or budgets: an operator with no violation has no
 * line, and each line names what was found and, where the engine found one,
 * the alternative.
 */

import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";

const MAX_LINES = 4;
const json = (x: unknown) => JSON.stringify(x);
const record = (x: unknown): Record<string, any> =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : {};
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(v => json(String(v))) : []);
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** What the parse found about each source's header, worded. */
export function scanLines(operations: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const source of Array.isArray(record(operations.scan).sources) ? record(operations.scan).sources : []) {
    const s = record(source);
    const check = record(s.headerCheck);
    if (!Object.keys(check).length || typeof s.path !== "string") continue;
    const file = `\`${basename(s.path)}\``;
    const suggest = record(check.suggest);
    const alternative = num(suggest.skipLines)
      ? `; skip_lines=${suggest.skipLines} gives the header ${list(suggest.header).join(", ")}`
      : "";
    const headerless = "; a file without a header row needs header=False with names";
    if (Array.isArray(check.dataLike) && check.dataLike.length)
      lines.push(
        `the header of ${file} reads as data (${list(check.dataLike).join(", ")})${alternative || headerless}.`
      );
    else if (Array.isArray(check.valueLike) && check.valueLike.length) {
      const cells = list(check.valueLike);
      lines.push(
        `header ${cells.length === 1 ? `${cells[0]} of ${file} looks like a value of its column` : `cells ${cells.join(", ")} of ${file} look like values of their columns`}${alternative || headerless}.`
      );
    } else if (num(check.blank)) lines.push(`${check.blank} header cells of ${file} are blank${alternative}.`);
    if (num(check.repeats))
      lines.push(
        `the header row of ${file} recurs ${check.repeats} time${check.repeats === 1 ? "" : "s"} among its data rows (stacked tables or repeated headers).`
      );
  }
  return lines;
}

const clip = (text: string, limit = 120) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** Integer and decimal values of one column combined as decimals. */
function widenedLine(widened: unknown, where: string): string[] {
  const columns = Object.keys(record(widened));
  return columns.length
    ? [
        `${columns.length === 1 ? "column" : "columns"} ${list(columns).join(", ")} ${columns.length === 1 ? "is" : "are"} integer in some ${where} and decimal in others; read as decimal (float64).`,
      ]
    : [];
}

/**
 * How a scan read its sources, worded for every setting: these facts decide
 * whether the table is the data at all (a header row that is data, lines
 * before the header, renamed or widened columns, files concatenated without
 * their names). They are shown with the scan's result whenever it is read.
 */
export function scanNoteLines(view: { properties: Record<string, any> }, operations: Record<string, any>): string[] {
  const scan = record(operations.scan);
  const sources = Array.isArray(scan.sources) ? scan.sources.map(record) : [];
  const lines = scanLines(operations).map(line => `note: ${line}`);
  for (const s of sources) {
    if (typeof s.path !== "string") continue;
    const file = `\`${basename(s.path)}\``;
    const preamble = Array.isArray(s.preamble) ? s.preamble.filter((line: unknown) => typeof line === "string") : [];
    if (num(s.autoSkipLines) && s.autoSkipLines > 0)
      lines.push(
        `note: ${file} has ${s.autoSkipLines} line${s.autoSkipLines === 1 ? "" : "s"} before its header, skipped${preamble.length ? `: ${preamble.map((line: string) => json(clip(line))).join("; ")}` : ""}.`
      );
    const renamed = Array.isArray(s.renamedHeaders)
      ? s.renamedHeaders.filter((pair: unknown) => Array.isArray(pair) && pair.length === 2)
      : [];
    if (renamed.length)
      lines.push(
        `note: duplicate header names of ${file} renamed: ${renamed.map(([to, from]: [unknown, unknown]) => `${json(String(from))} → ${json(String(to))}`).join(", ")}.`
      );
  }
  lines.push(...widenedLine(scan.widened, "files").map(line => `note: ${line}`));
  if (scan.preview && num(scan.selectedFiles) && num(scan.omittedFiles) && scan.omittedFiles > 0)
    lines.push(`note: the preview reads ${scan.selectedFiles} of ${scan.selectedFiles + scan.omittedFiles} files.`);
  if (!scan.preview && num(scan.selectedFiles) && scan.selectedFiles > 1 && view.properties.fileColumn === undefined)
    lines.push(
      `note: ${scan.selectedFiles} files are concatenated into this table, and its rows do not record their source file; file_column='file' adds it.`
    );
  return lines;
}

function repeatedLine(type: string, operations: Record<string, any>): string[] {
  const r = record(operations.repeatedRecords);
  if (!num(r.rows) || !num(r.of) || !num(r.records)) return [];
  const ignoring = Array.isArray(r.ignoring) && r.ignoring.length ? ` apart from ${list(r.ignoring).join(", ")}` : "";
  return [
    `${r.rows} of ${r.of} input rows are ${r.records} records each listed once by ${num(r.sources) ? `${r.sources} different sources` : "several sources"}${ignoring}, e.g. ${json(r.example)}; ${type === "Aggregate" ? "the aggregate counts" : "a sum, mean or count counts"} every copy.`,
  ];
}

function processLines(operations: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const item of Array.isArray(record(operations.process).events) ? record(operations.process).events : []) {
    const e = record(item);
    const at = `inside the function, ${num(e.cell) ? `definition cell ${e.cell}, ` : ""}line ${e.line}:`;
    const ins: number[] = Array.isArray(e.in) ? e.in : [];
    if (e.op === "merge" && e.issue === "empty")
      lines.push(`${at} a merge of ${ins.join(" and ")} rows returned 0 rows.`);
    else if ((e.op === "filter" || e.op === "query") && e.issue === "empty")
      lines.push(`${at} a row selection kept 0 of ${ins[0]} rows.`);
    else if (e.op === "concat" && e.issue === "duplicates")
      lines.push(
        `${at} concatenating ${ins.length} tables: ${e.rows} of ${e.of} rows are ${e.records} records each listed once by several of the tables, e.g. ${json(e.example)}.`
      );
  }
  return lines;
}

/** The violated assumptions of one executed native operator, worded; empty when none. */
export function nativeCheckLines(op: OperatorPredicate, info: OperatorInfo): string[] {
  const view = op.nativeOp;
  const operations = record(info.tableProfile?.native?.operations);
  if (!view || !Object.keys(operations).length) return [];
  // A scan's header findings are always shown with its result (scanNoteLines).
  const lines =
    view.type === "Scan"
      ? []
      : view.type === "Process"
        ? [...repeatedLine(view.type, operations), ...processLines(operations)]
        : view.type === "Aggregate"
          ? repeatedLine(view.type, operations)
          : [];
  return lines.slice(0, MAX_LINES);
}

/**
 * Keys and missing values a pandas user checks by hand, worded with
 * `dataHygiene`: group or partition key values written in several ways, which
 * stay separate groups ("Beauty" and "Beauty "), and null keys on both sides of
 * a join, which match nothing unless nulls_equal=True although pandas merge
 * pairs them. A null key on one side matches nothing in either, so it has no line.
 */
export function hygieneLines(op: OperatorPredicate, info: OperatorInfo): string[] {
  const view = op.nativeOp;
  const operations = record(info.tableProfile?.native?.operations);
  if (!view || !Object.keys(operations).length) return [];
  const lines: string[] = [];
  const unit = view.type === "Window" ? "partition" : "group";
  for (const raw of Array.isArray(operations.keyVariants) ? operations.keyVariants : []) {
    const found = record(raw);
    const examples = (Array.isArray(found.examples) ? found.examples : [])
      .map(record)
      .filter(e => Array.isArray(e.forms) && e.forms.length > 1);
    if (typeof found.column !== "string" || !num(found.values) || !examples.length) continue;
    const shown = examples
      .slice(0, 2)
      .map(e =>
        e.forms
          .map(
            (form: unknown, i: number) =>
              `${json(String(form))} (${Array.isArray(e.rows) && num(e.rows[i]) ? e.rows[i] : "?"} rows)`
          )
          .join(" and ")
      )
      .join("; ");
    lines.push(
      `note: ${json(found.column)} has ${found.values} value${found.values === 1 ? "" : "s"} written in several ways (case, spacing or punctuation), each form its own ${unit}: ${shown}.`
    );
  }
  const join = record(operations.join);
  const left = num(record(join.left).nullKeyRows) ? record(join.left).nullKeyRows : 0;
  const right = num(record(join.right).nullKeyRows) ? record(join.right).nullKeyRows : 0;
  if (view.type === "Join" && join.nullsEqual === false && left > 0 && right > 0)
    lines.push(
      `note: ${left} left and ${right} right rows have a null key; null keys match nothing unless nulls_equal=True (pandas merge pairs them).`
    );
  return lines;
}

/**
 * Adjustments the runtime made instead of failing, worded for every executed
 * operator regardless of settings: an output that replaced an existing column,
 * a right-side join column renamed past its suffix, a boolean column reduced
 * as 1/0. The model reads them in the execution receipt.
 */
export function nativeAdjustmentLines(op: OperatorPredicate, info: OperatorInfo): string[] {
  const operations = record(info.tableProfile?.native?.operations);
  if (!op.nativeOp || !Object.keys(operations).length) return [];
  const lines: string[] = [];
  const replaced = Array.isArray(operations.replacedColumns) ? operations.replacedColumns : [];
  if (replaced.length)
    lines.push(
      `note: existing column${replaced.length === 1 ? "" : "s"} ${list(replaced).join(", ")} replaced by the new output.`
    );
  const renamed = Object.entries(record(record(operations.join).renamedRight));
  if (renamed.length)
    lines.push(
      `note: right column${renamed.length === 1 ? "" : "s"} renamed to avoid a collision: ${renamed.map(([from, to]) => `${json(from)} → ${json(String(to))}`).join(", ")}.`
    );
  const bools = Array.isArray(operations.boolAsInt) ? operations.boolAsInt : [];
  if (bools.length)
    lines.push(`note: boolean column${bools.length === 1 ? "" : "s"} ${list(bools).join(", ")} reduced as 1/0.`);
  if (op.nativeOp.type === "Union")
    lines.push(...widenedLine(operations.widened, "inputs").map(line => `note: ${line}`));
  const normalized = record(operations.normalized);
  const utc = Array.isArray(normalized.utc) ? normalized.utc : [];
  if (utc.length)
    lines.push(
      `note: datetime column${utc.length === 1 ? "" : "s"} ${list(utc).join(", ")} had no timezone; read as UTC.`
    );
  const text = Array.isArray(normalized.text) ? normalized.text : [];
  if (text.length)
    lines.push(
      `note: column${text.length === 1 ? "" : "s"} ${list(text).join(", ")} mixed numbers and text; kept as text.`
    );
  return lines;
}

/** Rows a table needs before a column that is 0 or null throughout is worth a
 * note: a ranking of a few rows often holds such a column by design (equal
 * deltas, an unused flag), while a whole working table rarely should. */
const DEGENERATE_MIN_ROWS = 10;

const isZero = (value: { type: string; value: unknown } | null | undefined) =>
  value?.type === "int64" ? value.value === "0" : value?.type === "float64" ? value.value === 0 : false;

/**
 * Columns a Python step added to a working table that are 0 in every row, or
 * null in every row. Everything built on such a column inherits it: on
 * 2026-10-09 an NFL session ranked "largest gaps" that were all 0, and nearly
 * every later score followed. Constant labels, broadcast thresholds and small
 * answer tables are left alone: a rule that took any single value flagged 157
 * columns in a 2026-10-11 Luna campaign, two thirds of them in tables of five
 * rows or fewer. Only a profile of the whole table settles it; a partial
 * profile says nothing.
 */
export function constantColumnLines(
  op: OperatorPredicate,
  info: OperatorInfo,
  inputs: readonly (OperatorInfo | undefined)[]
): string[] {
  const view = op.nativeOp;
  const profile = info.tableProfile;
  const rows = info.totalRowCount ?? info.outputTuples;
  if (!view?.properties.registered || view.type === "Filter" || !profile || !(rows >= DEGENERATE_MIN_ROWS)) return [];
  if (profile.status !== "available" || !profile.coverage.complete || profile.rowCount !== rows) return [];
  const inherited = new Set(inputs.flatMap(input => (input?.resultSchema ?? []).map(field => field.name)));
  const count = rows.toLocaleString("en-US");
  const found = (info.resultSchema ?? [])
    .filter(field => !inherited.has(field.name))
    .flatMap(field => {
      const column = Object.hasOwn(profile.columns, field.name) ? profile.columns[field.name] : undefined;
      if (!column || column.rowsProcessed !== rows) return [];
      if (column.nonnullCount === 0) return [`${json(field.name)} is null in all ${count} rows`];
      if (column.nullCount === 0 && isZero(column.min) && isZero(column.max))
        return [`${json(field.name)} is 0 in all ${count} rows`];
      return [];
    });
  if (!found.length) return [];
  const shown = found.slice(0, 3);
  return [
    `note: column ${shown.join("; column ")}${found.length > shown.length ? `; and ${found.length - shown.length} more such columns` : ""}.`,
  ];
}
